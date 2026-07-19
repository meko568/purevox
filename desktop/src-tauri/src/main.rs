#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

#[cfg(unix)]
use std::os::unix::process::CommandExt;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use serde::{Deserialize, Serialize};
use tauri::{Emitter, Manager, State};

struct RunningJob(Mutex<Option<u32>>);

#[derive(Serialize, Deserialize, Default)]
struct GuiSettings {
    default_output_folder: Option<String>,
}

fn home_dir() -> PathBuf {
    #[cfg(unix)]
    {
        PathBuf::from(std::env::var("HOME").unwrap_or_else(|_| "/".into()))
    }
    #[cfg(windows)]
    {
        PathBuf::from(std::env::var("USERPROFILE").unwrap_or_else(|_| "C:\\".into()))
    }
}

fn settings_path() -> PathBuf {
    home_dir().join(".purevox").join("gui-settings.json")
}

// A relative output name (no folder typed) has to land somewhere — the
// working directory of wherever the app binary happens to be launched
// from is not predictable and definitely not what a user expects. Anchor
// relative paths to the home dir instead, and make sure the spawned
// process's actual cwd matches, so what the GUI checks for "already
// exists" is the same place the file actually lands. This always checks
// the real Windows path natively — WSL path conversion only happens when
// building the actual command line below.
fn resolve_against_home(p: &str) -> PathBuf {
    let path = Path::new(p);
    if path.is_absolute() {
        path.to_path_buf()
    } else {
        home_dir().join(path)
    }
}

#[cfg(unix)]
fn extended_path() -> String {
    // Apps launched from a desktop icon (not a terminal) often get a
    // minimal PATH that skips ~/.local/bin — where pipx installs things
    // like demucs. If purevox (or demucs/ffmpeg inside it) isn't found,
    // the script's `set -e` exits silently with no error text at all.
    let home = std::env::var("HOME").unwrap_or_default();
    let existing_path = std::env::var("PATH").unwrap_or_default();
    format!("{home}/.local/bin:/usr/local/bin:/usr/local/sbin:{existing_path}:/usr/bin:/usr/sbin:/bin:/sbin")
}

// ---- Windows: purevox is a bash script, so it runs through WSL there. ----
#[cfg(windows)]
fn wsl_path(s: &str) -> String {
    // "C:\Users\name\file.mp4" -> "/mnt/c/Users/name/file.mp4". Only
    // touches strings that actually look like a Windows absolute path —
    // job ids, flags, numbers, etc. pass through untouched.
    let b = s.as_bytes();
    if b.len() >= 3 && b[0].is_ascii_alphabetic() && b[1] == b':' && (b[2] == b'\\' || b[2] == b'/') {
        let drive = (b[0] as char).to_ascii_lowercase();
        let rest = s[2..].replace('\\', "/");
        format!("/mnt/{drive}{rest}")
    } else {
        s.to_string()
    }
}

#[cfg(windows)]
fn shell_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

// Builds a single command string to run inside a WSL login shell (-lc),
// so the user's own .bashrc/.profile PATH (pipx installs, etc.) is
// sourced just like a normal WSL terminal session — no separate PATH
// hack needed here the way the Unix build needs one.
#[cfg(windows)]
fn wsl_command_string(args: &[String]) -> String {
    std::iter::once("purevox".to_string())
        .chain(args.iter().map(|a| wsl_path(a)))
        .map(|a| shell_quote(&a))
        .collect::<Vec<_>>()
        .join(" ")
}

fn build_purevox_command(args: &[String]) -> Command {
    #[cfg(unix)]
    {
        let mut cmd = Command::new("purevox");
        cmd.args(args).env("PATH", extended_path()).current_dir(home_dir());
        cmd
    }
    #[cfg(windows)]
    {
        let mut cmd = Command::new("wsl.exe");
        cmd.arg("-e").arg("bash").arg("-lc").arg(wsl_command_string(args));
        cmd
    }
}

// Quick, short-lived calls (-j list, -x delete).
#[tauri::command]
async fn run_purevox(args: Vec<String>) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let output = build_purevox_command(&args)
            .output()
            .map_err(|e| format!("Couldn't launch purevox: {e}. On Windows this needs WSL installed with purevox set up inside it."))?;

        let stdout = String::from_utf8_lossy(&output.stdout).to_string();
        let stderr = String::from_utf8_lossy(&output.stderr).to_string();
        let combined = format!("{stdout}{stderr}");

        if output.status.success() {
            Ok(combined)
        } else if combined.trim().is_empty() {
            Err(format!(
                "purevox exited with no output (status {:?}). Likely a tool it calls (demucs/ffmpeg) wasn't found on PATH, or the script's 'set -e' hit a silent failure. Try running the same command directly in a terminal (or `wsl` on Windows) to see the real error.",
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
// stdin, since a spawned GUI child has no real terminal to type into.
#[tauri::command]
fn start_purevox(app: tauri::AppHandle, state: State<'_, RunningJob>, args: Vec<String>) -> Result<(), String> {
    let mut cmd = build_purevox_command(&args);
    cmd.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());

    // Own process group on Unix: Stop can then kill purevox + every child
    // it spawned (ffmpeg, demucs), not just the top bash process.
    #[cfg(unix)]
    {
        cmd.process_group(0);
    }

    let mut child: Child = cmd
        .spawn()
        .map_err(|e| format!("Couldn't launch purevox: {e}. On Windows this needs WSL installed with purevox set up inside it."))?;

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

#[cfg(unix)]
fn kill_process_tree(pid: u32, force: bool) -> std::io::Result<std::process::ExitStatus> {
    let sig = if force { "-KILL" } else { "-TERM" };
    Command::new("kill").args([sig, &format!("-{pid}")]).status()
}

#[cfg(windows)]
fn kill_process_tree(pid: u32, _force: bool) -> std::io::Result<std::process::ExitStatus> {
    // NOTE: this pid is the Windows-side wsl.exe launcher, not the Linux
    // process inside the WSL VM. Killing it stops the launcher and
    // usually takes the job with it, but isn't 100% guaranteed the way
    // killing a real process group is on Unix — a known limitation of
    // the WSL bridge approach for v1.
    Command::new("taskkill").args(["/PID", &pid.to_string(), "/T", "/F"]).status()
}

#[tauri::command]
fn kill_purevox(state: State<'_, RunningJob>) -> Result<String, String> {
    let pid = state.0.lock().unwrap().take();
    match pid {
        None => Err("Nothing is running right now.".into()),
        Some(pid) => {
            let status = kill_process_tree(pid, false)
                .map_err(|e| format!("Couldn't send stop signal: {e}"))?;

            #[cfg(unix)]
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_secs(2));
                let still_alive = Command::new("kill")
                    .args(["-0", &pid.to_string()])
                    .status()
                    .map(|s| s.success())
                    .unwrap_or(false);
                if still_alive {
                    let _ = kill_process_tree(pid, true);
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
