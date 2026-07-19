#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::io::{BufRead, BufReader, Write};
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Mutex;
use serde::{Deserialize, Serialize};
use tauri::{Emitter, Manager, State};

struct RunningJob(Mutex<Option<u32>>);

#[derive(Serialize, Deserialize, Default)]
struct GuiSettings {
    default_output_folder: Option<String>,
}

fn settings_path() -> PathBuf {
    let home = std::env::var("HOME").unwrap_or_default();
    Path::new(&home).join(".purevox").join("gui-settings.json")
}

fn extended_path() -> String {
    // Apps launched from a desktop icon (not a terminal) often get a
    // minimal PATH that skips ~/.local/bin — where pipx installs things
    // like demucs. If purevox (or demucs/ffmpeg inside it) isn't found,
    // the script's `set -e` exits silently with no error text at all.
    let home = std::env::var("HOME").unwrap_or_default();
    let existing_path = std::env::var("PATH").unwrap_or_default();
    format!("{home}/.local/bin:/usr/local/bin:/usr/local/sbin:{existing_path}:/usr/bin:/usr/sbin:/bin:/sbin")
}

fn home_dir() -> PathBuf {
    PathBuf::from(std::env::var("HOME").unwrap_or_else(|_| "/".into()))
}

// A relative output name (no folder typed) has to land somewhere — the
// working directory of wherever the app binary happens to be launched
// from is not predictable (e.g. src-tauri/ in dev mode) and definitely
// not what a user expects. Anchor relative paths to $HOME instead, and
// make sure the spawned process's actual cwd matches, so what the GUI
// checks for "already exists" is the same place the file actually lands.
fn resolve_against_home(p: &str) -> PathBuf {
    let path = Path::new(p);
    if path.is_absolute() {
        path.to_path_buf()
    } else {
        home_dir().join(path)
    }
}

// Quick, short-lived calls (-j list, -x delete).
#[tauri::command]
async fn run_purevox(args: Vec<String>) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let output = Command::new("purevox")
            .args(&args)
            .env("PATH", extended_path())
            .current_dir(home_dir())
            .output()
            .map_err(|e| format!("Couldn't launch purevox: {e}. Is it installed and on your PATH?"))?;

        let stdout = String::from_utf8_lossy(&output.stdout).to_string();
        let stderr = String::from_utf8_lossy(&output.stderr).to_string();
        let combined = format!("{stdout}{stderr}");

        if output.status.success() {
            Ok(combined)
        } else if combined.trim().is_empty() {
            Err(format!(
                "purevox exited with no output (status {:?}). Likely a tool it calls (demucs/ffmpeg) wasn't found on PATH, or the script's 'set -e' hit a silent failure. Try running the same command directly in a terminal to see the real error.",
                output.status.code()
            ))
        } else {
            Err(combined)
        }
    })
    .await
    .map_err(|e| format!("Internal task error: {e}"))?
}

// Long-running calls (processing / resuming). Streams stdout+stderr live
// via "purevox-log" events, signals completion via "purevox-done".
// Also pre-answers the CLI's interactive overwrite prompts (y / o) on
// stdin, since a spawned GUI child has no real terminal to type into —
// left unanswered, `read` would either hang or auto-cancel, and either
// way the job would silently die with nothing to show or stop.
// The frontend is expected to have already confirmed overwrite with the
// user (Override button) before calling this.
#[tauri::command]
fn start_purevox(app: tauri::AppHandle, state: State<'_, RunningJob>, args: Vec<String>) -> Result<(), String> {
    let mut child = Command::new("purevox")
        .args(&args)
        .env("PATH", extended_path())
        .current_dir(home_dir())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .process_group(0) // own process group: Stop can kill purevox + every child it spawned
        .spawn()
        .map_err(|e| format!("Couldn't launch purevox: {e}. Is it installed and on your PATH?"))?;

    let pid = child.id();
    *state.0.lock().unwrap() = Some(pid);

    if let Some(mut stdin) = child.stdin.take() {
        // "y" answers a single-file overwrite prompt, "o" answers the
        // batch "overwrite all / skip conflicts / cancel" prompt. Extra
        // unused lines are harmless if no prompt ever comes up.
        let _ = stdin.write_all(b"y\no\n");
    }

    let stdout = child.stdout.take().expect("piped stdout");
    let stderr = child.stderr.take().expect("piped stderr");

    let app_out = app.clone();
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            let _ = app_out.emit("purevox-log", line);
        }
    });

    let app_err = app.clone();
    std::thread::spawn(move || {
        for line in BufReader::new(stderr).lines().map_while(Result::ok) {
            let _ = app_err.emit("purevox-log", line);
        }
    });

    std::thread::spawn(move || {
        let status = child.wait();
        let running_job = app.state::<RunningJob>();
        *running_job.0.lock().unwrap() = None;
        let success = matches!(status, Ok(s) if s.success());
        let _ = app.emit("purevox-done", success);
    });

    Ok(())
}

#[tauri::command]
fn kill_purevox(state: State<'_, RunningJob>) -> Result<String, String> {
    let pid = state.0.lock().unwrap().take();
    match pid {
        None => Err("Nothing is running right now.".into()),
        Some(pid) => {
            let status = Command::new("kill")
                .args(["-TERM", &format!("-{pid}")])
                .status()
                .map_err(|e| format!("Couldn't send stop signal: {e}"))?;

            // Give it a couple seconds to exit gracefully, then force-kill
            // the whole group if it's still around — otherwise a stubborn
            // child process (e.g. a demucs worker) can leave the wait()
            // thread blocked forever and the UI stuck on "Processing".
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_secs(2));
                let still_alive = Command::new("kill")
                    .args(["-0", &pid.to_string()])
                    .status()
                    .map(|s| s.success())
                    .unwrap_or(false);
                if still_alive {
                    let _ = Command::new("kill").args(["-KILL", &format!("-{pid}")]).status();
                }
            });

            if status.success() {
                Ok("Stop signal sent.".into())
            } else {
                Err("Couldn't stop the process (it may have already finished).".into())
            }
        }
    }
}

// Lets the GUI check for existing outputs before running, so it can show
// an Override control instead of relying on the CLI's own interactive
// (and, for a GUI, unusable) y/n prompt.
#[tauri::command]
fn check_exists(paths: Vec<String>) -> Vec<bool> {
    paths.iter().map(|p| resolve_against_home(p).exists()).collect()
}

#[tauri::command]
fn get_default_output_folder() -> Option<String> {
    let data = std::fs::read_to_string(settings_path()).ok()?;
    serde_json::from_str::<GuiSettings>(&data).ok()?.default_output_folder
}

#[tauri::command]
fn set_default_output_folder(folder: String) -> Result<(), String> {
    let path = settings_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let settings = GuiSettings { default_output_folder: Some(folder) };
    let json = serde_json::to_string_pretty(&settings).map_err(|e| e.to_string())?;
    std::fs::write(path, json).map_err(|e| e.to_string())
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .manage(RunningJob(Mutex::new(None)))
        .invoke_handler(tauri::generate_handler![
            run_purevox,
            start_purevox,
            kill_purevox,
            check_exists,
            get_default_output_folder,
            set_default_output_folder
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
