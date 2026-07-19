const { invoke } = window.__TAURI__.core;
const { open } = window.__TAURI__.dialog;
const { listen } = window.__TAURI__.event;

// ---- state ----
let inputFiles = [];      // files mode
let inDir = null;         // folder mode
let mode = "files";       // "files" | "folder"
let dryRun = false;
let audioOnly = false;
let selectedJobIds = new Set();
let isRunning = false;
let hasConflict = false;
let overrideConfirmed = false;

const $ = (id) => document.getElementById(id);
const log = $("log");

function appendLog(text) {
  log.textContent = (log.textContent === "Ready." ? "" : log.textContent + "\n") + text;
  log.scrollTop = log.scrollHeight;
}

$("btn-clear-log").addEventListener("click", () => {
  log.textContent = "Ready.";
});

// ---- live output + completion events from the long-running commands ----
listen("purevox-log", (event) => appendLog(event.payload));

listen("purevox-done", (event) => {
  setRunningUI(false);
  appendLog(event.payload ? "=== Finished ===" : "=== Stopped / failed — see log above ===");
  $("btn-jobs").click(); // pick up final state (job cleared on success, or still pending)
});

function setRunningUI(running) {
  isRunning = running;
  $("btn-stop").disabled = !running;
  $("run-btn").disabled = running || !canRun();
  $("btn-resume").disabled = running || selectedJobIds.size === 0;
  $("btn-delete").disabled = running || selectedJobIds.size === 0;
  $("run-btn").textContent = running ? "Processing… (window stays usable)" : "Remove Music";
}

$("btn-stop").addEventListener("click", async () => {
  try {
    const result = await invoke("kill_purevox");
    appendLog("!! " + result);
  } catch (e) {
    appendLog("!! " + e);
  }
  // Don't wait on the "purevox-done" event to unlock the UI — the user
  // asked to stop, so reflect that right away instead of depending on
  // however long the backend takes to fully reap the process.
  setRunningUI(false);
  $("btn-jobs").click();
});

// ---- core: quick calls (jobs list, delete) ----
async function runPurevoxSync(args, { onSuccess } = {}) {
  appendLog(`$ purevox ${args.join(" ")}`);
  try {
    const result = await invoke("run_purevox", { args });
    appendLog(result.trim() || "(no output)");
    if (onSuccess) onSuccess(result);
  } catch (e) {
    appendLog("!! " + e);
  }
}

// ---- core: long-running calls (process / resume) ----
async function startPurevoxAsync(args) {
  appendLog(`$ purevox ${args.join(" ")}`);
  setRunningUI(true);
  try {
    await invoke("start_purevox", { args });
    // no mid-run Jobs auto-refresh here on purpose — a concurrent
    // 'purevox -j' call while the job is still registering can race with
    // it and delete the folder before state.json is written. Live
    // progress already streams into the log below; Jobs list updates
    // once the run finishes (or click Jobs manually any time).
  } catch (e) {
    appendLog("!! " + e);
    setRunningUI(false);
  }
}

// ---- toolbar: Jobs / Resume / Delete ----
function parseJobs(text) {
  const jobs = [];
  const blocks = text.split(/\n(?=\[\d+\])/);
  for (const block of blocks) {
    const idMatch = block.match(/^\[(\d+)\]/);
    if (!idMatch) continue;
    const inputMatch = block.match(/input:\s*(.+)/);
    const progressMatch = block.match(/progress:\s*(.+)/);
    jobs.push({
      id: idMatch[1],
      input: inputMatch ? inputMatch[1].trim() : "(unknown)",
      progress: progressMatch ? progressMatch[1].trim() : "",
    });
  }
  return jobs;
}

function renderJobs(jobs) {
  const list = $("job-list");
  list.innerHTML = "";
  if (jobs.length === 0) {
    list.innerHTML = '<p class="empty-hint">No pending jobs.</p>';
    selectedJobIds.clear();
    updateJobButtons();
    return;
  }
  for (const job of jobs) {
    const row = document.createElement("div");
    row.className = "job-row" + (selectedJobIds.has(job.id) ? " selected" : "");
    row.dataset.id = job.id;
    row.innerHTML = `
      <span class="job-name" title="${job.input}">[${job.id}] ${job.input.split("/").pop()}</span>
      <span class="job-progress">${job.progress}</span>
    `;
    row.addEventListener("click", () => {
      if (selectedJobIds.has(job.id)) {
        selectedJobIds.delete(job.id);
        row.classList.remove("selected");
      } else {
        selectedJobIds.add(job.id);
        row.classList.add("selected");
      }
      updateJobButtons();
    });
    list.appendChild(row);
  }
}

function updateJobButtons() {
  const hasSelection = selectedJobIds.size > 0;
  $("btn-resume").disabled = !hasSelection || isRunning;
  $("btn-delete").disabled = !hasSelection || isRunning;
}

$("btn-jobs").addEventListener("click", async () => {
  await runPurevoxSync(["-j"], {
    onSuccess: (result) => renderJobs(parseJobs(result)),
  });
});

$("btn-resume").addEventListener("click", async () => {
  const ids = [...selectedJobIds];
  await startPurevoxAsync(["-r", ...ids]);
});

$("btn-delete").addEventListener("click", async () => {
  const ids = [...selectedJobIds];
  await runPurevoxSync(["-x", ...ids], {
    onSuccess: () => $("btn-jobs").click(),
  });
});

// ---- toolbar: Dry Run toggle ----
$("btn-dryrun").addEventListener("click", () => {
  dryRun = !dryRun;
  $("btn-dryrun").classList.toggle("active", dryRun);
});

// ---- mode switch: Files vs Folder ----
$("mode-files").addEventListener("click", () => setMode("files"));
$("mode-folder").addEventListener("click", () => setMode("folder"));

function setMode(next) {
  mode = next;
  $("mode-files").classList.toggle("active", mode === "files");
  $("mode-folder").classList.toggle("active", mode === "folder");
  $("files-mode").classList.toggle("hidden", mode !== "files");
  $("folder-mode").classList.toggle("hidden", mode !== "folder");
  refreshConflicts();
}

// ---- files mode: input picking + single/batch output UI ----
const VIDEO_EXT = /\.(mp4|mkv|mov|avi|webm)$/i;
const AUDIO_EXT = /\.(mp3|wav|m4a|flac|aac|ogg|wma)$/i;

$("pick-input").addEventListener("click", async () => {
  const result = await open({
    multiple: true,
    filters: [{ name: "Media", extensions: ["mp4", "mkv", "mov", "avi", "webm", "mp3", "wav", "m4a", "flac", "aac", "ogg", "wma"] }],
  });
  if (result) {
    inputFiles = Array.isArray(result) ? result : [result];
    $("input-list").textContent = inputFiles.map((f) => f.split("/").pop()).join(", ");
    renderOutputBlocks();
    refreshConflicts();
  }
});

function renderOutputBlocks() {
  const single = inputFiles.length === 1;
  $("single-output-block").classList.toggle("hidden", !single);
  $("batch-output-block").classList.toggle("hidden", single);
  if (!single && inputFiles.length > 1) renderBatchNameRows();
}

function defaultNameFor(inputPath) {
  const base = inputPath.split("/").pop();
  const withoutExt = base.replace(/\.[^/.]+$/, "");
  return withoutExt + (audioOnly ? ".mp3" : ".mp4");
}

function renderBatchNameRows() {
  const container = $("batch-name-rows");
  const existing = {};
  container.querySelectorAll(".batch-name-input").forEach((el) => {
    existing[el.dataset.input] = el.value;
  });
  container.innerHTML = "";
  for (const inputPath of inputFiles) {
    const row = document.createElement("div");
    row.className = "batch-row";
    const shortName = inputPath.split("/").pop();
    const value = existing[inputPath] ?? defaultNameFor(inputPath);
    row.innerHTML = `
      <span class="batch-in-name" title="${inputPath}">${shortName} →</span>
      <input type="text" class="text-input batch-name-input" data-input="${inputPath}" value="${value}" />
    `;
    row.querySelector("input").addEventListener("input", refreshConflicts);
    container.appendChild(row);
  }
}

$("btn-audio-only").addEventListener("click", () => {
  audioOnly = !audioOnly;
  $("btn-audio-only").classList.toggle("active", audioOnly);
  updateOutputPreview();
  if (inputFiles.length > 1) renderBatchNameRows();
  refreshConflicts();
});

function resolveSingleOutput() {
  const rawName = $("output-name").value.trim();
  if (!rawName) return null;
  const hasExt = VIDEO_EXT.test(rawName) || AUDIO_EXT.test(rawName);
  const name = hasExt ? rawName : rawName + (audioOnly ? ".mp3" : ".mp4");
  const folder = $("single-output-folder").value.trim();
  return folder ? `${folder.replace(/\/+$/, "")}/${name}` : name;
}

function updateOutputPreview() {
  const resolved = resolveSingleOutput();
  $("output-preview").textContent = resolved ? `Will save as: ${resolved}` : "Type an output name above.";
}

$("output-name").addEventListener("input", () => {
  updateOutputPreview();
  refreshConflicts();
});

$("single-output-folder").addEventListener("input", () => {
  updateOutputPreview();
  refreshConflicts();
});

function resolveBatchOutputs() {
  const folder = $("output-folder-path").value.trim();
  if (!folder) return null;
  const rows = [...document.querySelectorAll(".batch-name-input")];
  if (rows.length !== inputFiles.length) return null;
  const names = rows.map((el) => el.value.trim());
  if (names.some((n) => !n)) return null;
  return names.map((n) => `${folder.replace(/\/+$/, "")}/${n}`);
}

$("output-folder-path").addEventListener("input", refreshConflicts);

// ---- default output folder (settings) ----
async function loadDefaultFolder() {
  try {
    const folder = await invoke("get_default_output_folder");
    if (folder) {
      $("output-folder-path").value = folder;
      $("out-dir-name").value = folder;
      $("single-output-folder").value = folder;
      updateOutputPreview();
    }
  } catch (e) {
    // no default saved yet — fine
  }
}

$("btn-save-default-folder").addEventListener("click", async () => {
  const folder = $("output-folder-path").value.trim();
  if (!folder) return;
  try {
    await invoke("set_default_output_folder", { folder });
    appendLog(`Saved "${folder}" as the default output folder.`);
  } catch (e) {
    appendLog("!! " + e);
  }
});

// ---- overwrite detection ----
let conflictCheckToken = 0;

async function refreshConflicts() {
  const token = ++conflictCheckToken;

  if (mode !== "files") {
    hasConflict = false;
    $("overwrite-warning").classList.add("hidden");
    updateRunButton();
    return;
  }

  let outputs = null;
  if (inputFiles.length === 1) {
    const single = resolveSingleOutput();
    outputs = single ? [single] : null;
  } else if (inputFiles.length > 1) {
    outputs = resolveBatchOutputs();
  }

  if (!outputs || outputs.length === 0) {
    hasConflict = false;
    $("overwrite-warning").classList.add("hidden");
    updateRunButton();
    return;
  }

  try {
    const flags = await invoke("check_exists", { paths: outputs });
    if (token !== conflictCheckToken) return; // a newer check started while this one was in flight — ignore stale result
    const conflicting = outputs.filter((_, i) => flags[i]);
    hasConflict = conflicting.length > 0;
    if (hasConflict) {
      $("overwrite-text").textContent =
        "Already exists, will be overwritten: " + conflicting.map((p) => p.split("/").pop()).join(", ");
      $("overwrite-warning").classList.remove("hidden");
    } else {
      $("overwrite-warning").classList.add("hidden");
      overrideConfirmed = false;
      $("override-confirm").checked = false;
    }
  } catch (e) {
    if (token !== conflictCheckToken) return;
    hasConflict = false;
    $("overwrite-warning").classList.add("hidden");
  }
  updateRunButton();
}

$("override-confirm").addEventListener("change", (e) => {
  overrideConfirmed = e.target.checked;
  updateRunButton();
});

// ---- folder mode ----
$("pick-in-dir").addEventListener("click", async () => {
  const result = await open({ directory: true });
  if (result) {
    inDir = result;
    $("in-dir-path").textContent = inDir;
    updateRunButton();
  }
});

$("out-dir-name").addEventListener("input", updateRunButton);

function canRun() {
  if (mode === "folder") return !!(inDir && $("out-dir-name").value.trim());
  if (inputFiles.length === 0) return false;
  const namesReady = inputFiles.length === 1 ? !!resolveSingleOutput() : !!resolveBatchOutputs();
  if (!namesReady) return false;
  return !hasConflict || overrideConfirmed;
}

function updateRunButton() {
  $("run-btn").disabled = isRunning || !canRun();
}

// ---- Run ----
$("run-btn").addEventListener("click", async () => {
  const args = [];

  if (mode === "files") {
    if (inputFiles.length === 1) {
      args.push("-i", inputFiles[0], "-o", resolveSingleOutput());
    } else {
      const outputs = resolveBatchOutputs();
      args.push("-i", ...inputFiles, "-o", ...outputs);
    }
  } else {
    args.push("-d", inDir, "-o", $("out-dir-name").value.trim());
  }

  const chunkVal = $("chunk-min").value;
  if (chunkVal) args.push("-c", chunkVal);

  const runLimitVal = $("run-limit").value;
  if (runLimitVal) args.push("-q", runLimitVal);

  if (dryRun) args.push("-n");

  if (dryRun) {
    await runPurevoxSync(args);
  } else {
    await startPurevoxAsync(args);
  }
});

// ---- init ----
loadDefaultFolder();
$("btn-jobs").click();
