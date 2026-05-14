const PRESET_THRESHOLDS = {
  low: { confused: 4, frustrated: 4, bored: 4 },
  balanced: { confused: 3, frustrated: 3, bored: 3 },
  high: { confused: 2, frustrated: 2, bored: 2 }
};

const apiKeyEl = document.getElementById("api-key");
const enabledEl = document.getElementById("enabled-toggle");
const cooldownEl = document.getElementById("cooldown");
const saveBtn = document.getElementById("save-btn");
const saveKeyBtn = document.getElementById("save-key-btn");
const statusMsg = document.getElementById("status-msg");
const apiKeyMsg = document.getElementById("api-key-msg");
const presetLabel = document.getElementById("preset-label");
const showCameraPreviewEl = document.getElementById("show-camera-preview");
const cameraOpacityEl = document.getElementById("camera-opacity");
const cameraOpacityLabel = document.getElementById("camera-opacity-label");
const showEmotionIndicatorEl = document.getElementById("show-emotion-indicator");
const manualBarModeSectionEl = document.getElementById("manual-bar-mode-section");
const sensitivitySectionEl = document.getElementById("sensitivity-section");
const thresholdSectionEl = document.getElementById("threshold-section");
const cooldownSectionEl = document.getElementById("cooldown-section");
const cameraPreviewSectionEl = document.getElementById("camera-preview-section");


const thresholdEls = {
  confused: document.getElementById("threshold-confused"),
  frustrated: document.getElementById("threshold-frustrated"),
  bored: document.getElementById("threshold-bored")
};

const thresholdLabelEls = {
  confused: document.getElementById("threshold-confused-label"),
  frustrated: document.getElementById("threshold-frustrated-label"),
  bored: document.getElementById("threshold-bored-label")
};

const extensionStatusEl = document.getElementById("extension-status");
const apiKeyStatusEl = document.getElementById("api-key-status");
const pageStatusEl = document.getElementById("page-status");
const cameraStatusEl = document.getElementById("camera-status");
const modelStatusEl = document.getElementById("model-status");
const videoStatusEl = document.getElementById("video-status");
const modeStatusEl = document.getElementById("mode-status");

const headerToggleEl = document.getElementById("header-toggle");
const onboardingIntroEl = document.getElementById("onboarding-intro");
const onboardingGroqEl = document.getElementById("onboarding-groq");
const modeChooserEl = document.getElementById("mode-chooser");
const apiKeySectionEl = document.getElementById("api-key-section");
const mainAppEl = document.getElementById("main-app");
const introNextBtn = document.getElementById("intro-next-btn");
const groqNextBtn = document.getElementById("groq-next-btn");
const editApiKeyBtn = document.getElementById("edit-api-key-btn");
const changeModeBtn = document.getElementById("change-mode-btn");
const deleteApiKeyBtn = document.getElementById("delete-api-key-btn");
const deleteApiConfirmEl = document.getElementById("delete-api-confirm");
const confirmDeleteApiKeyBtn = document.getElementById("confirm-delete-api-key-btn");
const cancelDeleteApiKeyBtn = document.getElementById("cancel-delete-api-key-btn");
const showManualBarBtn = document.getElementById("show-manual-bar-btn");
const historyListEl = document.getElementById("history-list");
const downloadHistoryBtn = document.getElementById("download-history-btn");
const clearHistoryBtn = document.getElementById("clear-history-btn");
const clearSessionBtn = document.getElementById("clear-session-btn");
const sessionMetaEl = document.getElementById("session-meta");
const quizScoreEl = document.getElementById("quiz-score");
const quizStreakEl = document.getElementById("quiz-streak");

let onboardingComplete = false;
let currentMode = "camera";
let liveModeChosen = false;
let modeChosen = false;
let activePreset = "balanced";
let manualBarMode = "actions";

document.addEventListener("DOMContentLoaded", initializePopup);
window.addEventListener("pagehide", () => {
  chrome.runtime.sendMessage({ type: "POPUP_CLOSED" });
});

introNextBtn.addEventListener("click", () => showView("groq"));
groqNextBtn.addEventListener("click", () => showView("api"));

document.querySelectorAll("#mode-chooser .mode-card").forEach((button) => {
  button.addEventListener("click", async () => {
    const mode = button.dataset.mode;

    if (mode === "manual") {
      showView("manual-bar-mode");
      return;
    }

    await setMode("camera");
    showView("main");
    await refreshAll();
  });
});

document.querySelectorAll(".tab-btn").forEach((button) => {
  button.addEventListener("click", () => showTab(button.dataset.tab));
});

document.querySelectorAll("#manual-bar-mode button").forEach((button) => {
  button.addEventListener("click", async () => {
    manualBarMode = button.dataset.manualBarMode === "emotions" ? "emotions" : "actions";
    await sendRuntimeMessage({ type: "SAVE_SETTINGS", payload: { manualBarMode, onboardingComplete } });
    await setMode("manual");
    showView("main");
    await refreshAll();
  });
});

document.querySelectorAll("#sensitivity-preset button").forEach((button) => {
  button.addEventListener("click", () => {
    setPreset(button.dataset.preset, true);
  });
});

Object.values(thresholdEls).forEach((input) => {
  input.addEventListener("input", () => {
    activePreset = inferPresetFromThresholds();
    updatePresetUI();
    updateThresholdLabels();
  });
});

cameraOpacityEl.addEventListener("input", updateCameraOpacityLabel);

editApiKeyBtn.addEventListener("click", () => {
  apiKeyMsg.textContent = "";
  deleteApiConfirmEl.classList.add("hidden");
  showView("edit-api");
  apiKeyEl.focus();
});

changeModeBtn.addEventListener("click", () => showView("mode"));

showManualBarBtn.addEventListener("click", async () => {
  if (!enabledEl.checked) {
    flashMessage(statusMsg, "Turn LearnFlow on to use the manual bar.", "waiting");
    return;
  }

  const response = await sendRuntimeMessage({ type: "OPEN_MANUAL_BAR" });

  if (response?.success) {
    flashMessage(statusMsg, "Manual bar shown on YouTube.", "ready");
    return;
  }

  flashMessage(statusMsg, "Manual bar is only available in Manual Mode while LearnFlow is on.", "waiting");
});

enabledEl.addEventListener("change", async () => {
  const enabled = enabledEl.checked;

  setStatusState(extensionStatusEl, enabled ? "Ready" : "Paused", enabled ? "ready" : "paused");
  flashMessage(statusMsg, enabled ? "LearnFlow resumed." : "LearnFlow paused.", enabled ? "ready" : "waiting");

  await sendRuntimeMessage({ type: "SET_ENABLED_STATE", enabled });
  await refreshLiveStatus();
});

downloadHistoryBtn.addEventListener("click", async () => {
  const response = await sendRuntimeMessage({ type: "GET_HISTORY" });
  const items = response?.responseHistory || [];

  if (!items.length) {
    flashMessage(statusMsg, "No history to download yet.", "waiting");
    return;
  }

  const text = buildHistoryExport(items);
  const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `learnflow-history-${new Date().toISOString().slice(0, 10)}.txt`;
  link.click();
  URL.revokeObjectURL(url);

  flashMessage(statusMsg, "History downloaded.", "ready");
});

clearHistoryBtn.addEventListener("click", async () => {
  await sendRuntimeMessage({ type: "CLEAR_HISTORY" });
  await refreshHistory();
  flashMessage(statusMsg, "Saved history cleared.", "ready");
});

clearSessionBtn.addEventListener("click", async () => {
  await sendRuntimeMessage({ type: "RESET_CURRENT_SESSION" });
  await refreshSessionAnalytics();
  flashMessage(statusMsg, "Current session cleared.", "ready");
});

saveKeyBtn.addEventListener("click", async () => {
  const apiKey = apiKeyEl.value.trim();

  if (!apiKey) {
    apiKeyMsg.textContent = "Paste your Groq API key first.";
    apiKeyMsg.style.color = "#b91c1c";
    setStatusState(apiKeyStatusEl, "Missing", "missing");
    return;
  }

  await sendRuntimeMessage({ type: "SAVE_API_KEY", apiKey });
  onboardingComplete = true;
  setStatusState(apiKeyStatusEl, "Saved", "ready");
  deleteApiKeyBtn.classList.remove("hidden");
  flashMessage(apiKeyMsg, "API key saved.", "ready");
  showView("mode");
  await refreshAll();
});

deleteApiKeyBtn.addEventListener("click", () => {
  deleteApiConfirmEl.classList.remove("hidden");
});

cancelDeleteApiKeyBtn.addEventListener("click", () => {
  deleteApiConfirmEl.classList.add("hidden");
});

confirmDeleteApiKeyBtn.addEventListener("click", async () => {
  await sendRuntimeMessage({ type: "DELETE_API_KEY" });
  apiKeyEl.value = "";
  deleteApiConfirmEl.classList.add("hidden");
  deleteApiKeyBtn.classList.add("hidden");
  setStatusState(apiKeyStatusEl, "Missing", "missing");
  flashMessage(apiKeyMsg, "API key deleted.", "missing");
  showView("api");
  await refreshLiveStatus();
});

saveBtn.addEventListener("click", async () => {
  const settings = {
    enabled: enabledEl.checked,
    cooldownMs: parseInt(cooldownEl.value, 10),
    sensitivityPreset: activePreset,
    emotionThresholds: getThresholds(),
    showCameraPreview: showCameraPreviewEl.checked,
    cameraPreviewOpacity: parseFloat(cameraOpacityEl.value),
    showEmotionIndicator: showEmotionIndicatorEl.checked,
    manualBarMode,
    onboardingComplete
  };

  await sendRuntimeMessage({ type: "SAVE_SETTINGS", payload: settings });
  flashMessage(statusMsg, "Preferences saved. Reload the YouTube page for changes to take effect.", "ready", 5000);
  await refreshLiveStatus();
});

async function initializePopup() {
  await sendRuntimeMessage({ type: "POPUP_OPENED" });

  const settings = await sendRuntimeMessage({ type: "GET_SETTINGS" });
  const sessionMode = await sendRuntimeMessage({ type: "GET_SESSION_MODE" });

  modeChosen = Boolean(sessionMode?.modeChosen || settings?.modeChosen);
  liveModeChosen = modeChosen;
  currentMode = sessionMode?.currentMode || settings?.currentMode || "camera";
  onboardingComplete = Boolean(settings?.onboardingComplete || settings?.apiKey);
  applySettingsToForm(settings || {});

  updateModeStatus();
  updateControlsVisibility();
  showView(resolveInitialView(settings || {}));
  await refreshAll();
}

function resolveInitialView(settings) {
  if (!onboardingComplete) return "intro";
  if (!settings.apiKey) return "api";
  if (!modeChosen) return "mode";
  return "main";
}

function applySettingsToForm(settings) {
  apiKeyEl.value = settings.apiKey || "";
  deleteApiKeyBtn.classList.toggle("hidden", !settings.apiKey);
  enabledEl.checked = settings.enabled !== false;
  cooldownEl.value = String(settings.cooldownMs || settings.cooldownMinutes || 120000);
  activePreset = settings.sensitivityPreset || "balanced";
  manualBarMode = settings.manualBarMode === "emotions" ? "emotions" : "actions";

  const thresholds = {
    ...PRESET_THRESHOLDS.balanced,
    ...(settings.emotionThresholds || {})
  };

  for (const emotion of Object.keys(thresholdEls)) {
    thresholdEls[emotion].value = String(clampThreshold(thresholds[emotion]));
  }

  showCameraPreviewEl.checked = settings.showCameraPreview !== false;
  cameraOpacityEl.value = String(settings.cameraPreviewOpacity ?? 0.7);
  showEmotionIndicatorEl.checked = settings.showEmotionIndicator === true;

  updatePresetUI();
  updateManualBarModeUI();
  updateThresholdLabels();
  updateCameraOpacityLabel();
  updateControlsVisibility();
  setStatusState(extensionStatusEl, enabledEl.checked ? "Ready" : "Paused", enabledEl.checked ? "ready" : "paused");
  setStatusState(apiKeyStatusEl, settings.apiKey ? "Saved" : "Missing", settings.apiKey ? "ready" : "missing");
}

async function setMode(mode) {
  const response = await sendRuntimeMessage({ type: "SET_SESSION_MODE", mode });
  modeChosen = Boolean(response?.modeChosen);
  currentMode = response?.currentMode || mode;
  updateModeStatus();
  updateControlsVisibility();
}

function showView(view) {
  onboardingIntroEl.classList.add("hidden");
  onboardingGroqEl.classList.add("hidden");
  modeChooserEl.classList.add("hidden");
  apiKeySectionEl.classList.add("hidden");
  manualBarModeSectionEl.classList.add("hidden");
  mainAppEl.classList.add("hidden");
  headerToggleEl.classList.add("hidden");

  if (view === "intro") {
    onboardingIntroEl.classList.remove("hidden");
    return;
  }

  if (view === "groq") {
    onboardingGroqEl.classList.remove("hidden");
    return;
  }

  if (view === "api") {
    apiKeySectionEl.classList.remove("hidden");
    return;
  }

  if (view === "edit-api") {
    apiKeySectionEl.classList.remove("hidden");
    mainAppEl.classList.remove("hidden");
    headerToggleEl.classList.remove("hidden");
    return;
  }

  if (view === "mode") {
    modeChooserEl.classList.remove("hidden");
    return;
  }

  if (view === "manual-bar-mode") {
    manualBarModeSectionEl.classList.remove("hidden");
    return;
  }

  updateControlsVisibility();
  mainAppEl.classList.remove("hidden");
  headerToggleEl.classList.remove("hidden");
}


function showTab(tab) {
  document.querySelectorAll(".tab-btn").forEach((button) => {
    button.classList.toggle("active", button.dataset.tab === tab);
  });
  document.querySelectorAll(".tab-panel").forEach((panel) => {
    panel.classList.toggle("hidden", panel.id !== `tab-${tab}`);
  });

  if (tab === "session") refreshSessionAnalytics();
  if (tab === "history") refreshHistory();
}

function setPreset(preset, applyThresholds) {
  activePreset = preset;
  if (applyThresholds) {
    const thresholds = PRESET_THRESHOLDS[preset] || PRESET_THRESHOLDS.balanced;
    for (const emotion of Object.keys(thresholdEls)) {
      thresholdEls[emotion].value = String(thresholds[emotion]);
    }
  }
  updatePresetUI();
  updateThresholdLabels();
}

function updatePresetUI() {
  document.querySelectorAll("#sensitivity-preset button").forEach((button) => {
    button.classList.toggle("active", button.dataset.preset === activePreset);
  });

  const labels = {
    low: "Low: fewer interruptions, trigger after 4 of 5 readings.",
    balanced: "Balanced: trigger after 3 of 5 readings.",
    high: "High: faster help, trigger after 2 of 5 readings."
  };
  presetLabel.textContent = labels[activePreset] || "Custom thresholds active.";
}

function updateThresholdLabels() {
  for (const emotion of Object.keys(thresholdEls)) {
    thresholdLabelEls[emotion].textContent = `Trigger after ${thresholdEls[emotion].value} of 5 readings`;
  }
}

function updateCameraOpacityLabel() {
  cameraOpacityLabel.textContent = `${Math.round(parseFloat(cameraOpacityEl.value) * 100)}% opacity`;
}

function getThresholds() {
  return {
    confused: clampThreshold(thresholdEls.confused.value),
    frustrated: clampThreshold(thresholdEls.frustrated.value),
    bored: clampThreshold(thresholdEls.bored.value)
  };
}

function inferPresetFromThresholds() {
  const current = getThresholds();
  for (const [preset, thresholds] of Object.entries(PRESET_THRESHOLDS)) {
    const matches = Object.keys(current).every((emotion) => current[emotion] === thresholds[emotion]);
    if (matches) return preset;
  }
  return "custom";
}

async function refreshAll() {
  await refreshLiveStatus();
  await refreshSessionAnalytics();
  await refreshHistory();
  await refreshQuizStats();
}

async function refreshLiveStatus() {
  const status = await sendRuntimeMessage({ type: "LEARNFLOW_STATUS" });

  if (!status || !status.ok) {
    const reason = status?.reason || "UNKNOWN";

    setStatusState(extensionStatusEl, enabledEl.checked ? "Waiting" : "Paused", enabledEl.checked ? "waiting" : "paused");
    setStatusState(apiKeyStatusEl, apiKeyEl.value.trim() ? "Saved" : "Missing", apiKeyEl.value.trim() ? "ready" : "missing");
    setStatusState(pageStatusEl, reason === "UNSUPPORTED_PAGE" ? "Unsupported page" : "No active tab", "missing");
    setStatusState(cameraStatusEl, !modeChosen || currentMode === "manual" ? "Off" : "Waiting", !modeChosen || currentMode === "manual" ? "paused" : "waiting");
    setStatusState(modelStatusEl, !modeChosen || currentMode === "manual" ? "Off" : "Waiting", !modeChosen || currentMode === "manual" ? "paused" : "waiting");
    setStatusState(videoStatusEl, "Waiting", "waiting");
    updateModeStatus();
    return;
  }

  if (!status.live) {
    setStatusState(extensionStatusEl, enabledEl.checked ? "Waiting" : "Paused", enabledEl.checked ? "waiting" : "paused");
    setStatusState(apiKeyStatusEl, apiKeyEl.value.trim() ? "Saved" : "Missing", apiKeyEl.value.trim() ? "ready" : "missing");
    setStatusState(pageStatusEl, "YouTube watch page", "ready");
    setStatusState(cameraStatusEl, !modeChosen || currentMode === "manual" ? "Off" : "Waiting", !modeChosen || currentMode === "manual" ? "paused" : "waiting");
    setStatusState(modelStatusEl, !modeChosen || currentMode === "manual" ? "Off" : "Waiting", !modeChosen || currentMode === "manual" ? "paused" : "waiting");
    setStatusState(videoStatusEl, "Waiting", "waiting");
    updateModeStatus();
    return;
  }

  const live = status.live;
  modeChosen = live.modeChosen === true;
  liveModeChosen = modeChosen;
  currentMode = live.currentMode || currentMode;
  updateModeStatus();
  updateControlsVisibility();

  setStatusState(
    extensionStatusEl,
    !live.enabled ? "Paused" : live.chipTone === "ready" ? "Ready" : "Waiting",
    !live.enabled ? "paused" : live.chipTone === "ready" ? "ready" : "waiting"
  );

  setStatusState(apiKeyStatusEl, live.hasApiKey ? "Saved" : "Missing", live.hasApiKey ? "ready" : "missing");
  setStatusState(pageStatusEl, "YouTube watch page", "ready");
  setStatusState(
    cameraStatusEl,
    !live.modeChosen || live.currentMode === "manual" ? "Off" : live.cameraError ? "Blocked" : live.hasCamera ? "Ready" : "Waiting",
    !live.modeChosen || live.currentMode === "manual" ? "paused" : live.cameraError ? "missing" : live.hasCamera ? "ready" : "waiting"
  );
  setStatusState(
    modelStatusEl,
    !live.modeChosen || live.currentMode === "manual" ? "Off" : live.modelsLoaded ? "Ready" : "Waiting",
    !live.modeChosen || live.currentMode === "manual" ? "paused" : live.modelsLoaded ? "ready" : "waiting"
  );
  setStatusState(videoStatusEl, live.videoFound ? "Ready" : "Missing", live.videoFound ? "ready" : "missing");
}

async function refreshSessionAnalytics() {
  const response = await sendRuntimeMessage({ type: "GET_SESSION_ANALYTICS" });
  const analytics = response?.analytics;
  const counts = analytics?.emotionCounts || { confused: 0, frustrated: 0, bored: 0 };
  const max = Math.max(1, ...Object.values(counts));

  sessionMetaEl.textContent = "Current session resets when you switch videos or reload the page.";

  for (const emotion of ["confused", "frustrated", "bored"]) {
    const count = counts[emotion] || 0;
    document.getElementById(`count-${emotion}`).textContent = String(count);
    document.querySelector(`.heat-row[data-emotion="${emotion}"] .heat-track span`).style.width = `${Math.max(8, (count / max) * 100)}%`;
  }
}

async function refreshQuizStats() {
  const stats = await sendRuntimeMessage({ type: "GET_QUIZ_STATS" });
  quizScoreEl.textContent = `${stats?.totalCorrect || 0} / ${stats?.totalAttempts || 0}`;
  quizStreakEl.textContent = String(stats?.currentStreak || 0);
}

async function refreshHistory() {
  const response = await sendRuntimeMessage({ type: "GET_HISTORY" });
  const items = response?.responseHistory || [];

  if (!items.length) {
    historyListEl.innerHTML = `<p class="empty-state">No responses yet.</p>`;
    return;
  }

  historyListEl.innerHTML = items.map((item) => `
    <article class="history-item">
      <div>
        <strong>${escapeHTML(item.videoTitle || "Unknown video")}</strong>
        <time>${formatTime(item.timestamp)}</time>
      </div>
      <span>${escapeHTML(humanizeLabel(item.trigger || item.responseType || "response"))} - ${escapeHTML(humanizeLabel(item.source || "camera"))}</span>
      <p>${escapeHTML(item.preview || "")}</p>
    </article>
  `).join("");
}

function updateModeStatus() {
  modeStatusEl.textContent = liveModeChosen ? (currentMode === "manual" ? "Manual Mode" : "Camera Mode") : "Choose Mode";
  showManualBarBtn.classList.toggle("hidden", !liveModeChosen || currentMode !== "manual" || !enabledEl.checked);
}

function updateManualBarModeUI() {
  document.querySelectorAll("#manual-bar-mode button").forEach((button) => {
    button.classList.toggle("active", button.dataset.manualBarMode === manualBarMode);
  });
}

function updateControlsVisibility() {
  const isManualMode = currentMode === "manual";
  manualBarModeSectionEl.classList.add("hidden");
  sensitivitySectionEl.classList.toggle("hidden", isManualMode);
  thresholdSectionEl.classList.toggle("hidden", isManualMode);
  cooldownSectionEl.classList.toggle("hidden", isManualMode);
  cameraPreviewSectionEl.classList.toggle("hidden", isManualMode);
}

function setStatusState(element, text, tone) {
  element.textContent = text;
  element.classList.remove("status-ready", "status-waiting", "status-missing", "status-paused");
  element.classList.add(`status-${tone}`);
}

function flashMessage(element, text, tone, timeout = 2500) {
  element.textContent = text;
  element.style.color =
    tone === "ready" ? "#15803d" :
    tone === "missing" ? "#b91c1c" :
    "#a16207";

  window.clearTimeout(element._clearTimer);
  element._clearTimer = window.setTimeout(() => {
    element.textContent = "";
  }, timeout);
}

function sendRuntimeMessage(message) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) {
        resolve(null);
        return;
      }

      resolve(response ?? null);
    });
  });
}

function clampThreshold(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 3;
  return Math.max(2, Math.min(5, Math.round(number)));
}

function formatTime(timestamp) {
  if (!timestamp) return "";
  return new Date(timestamp).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function humanizeLabel(value) {
  const raw = String(value || "").trim();
  const aliases = {
    funfact: "Fun Fact",
    keypoints: "Key Points",
    session_summary: "Session Summary"
  };

  if (aliases[raw]) return aliases[raw];

  return raw
    .replace(/_/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .replace(/\b\w/g, (char) => char.toUpperCase()) || "Response";
}

function buildHistoryExport(items) {
  const header = [
    "LearnFlow History Export",
    `Exported: ${new Date().toLocaleString()}`,
    `Entries: ${items.length}`,
    ""
  ];

  const rows = items.map((item, index) => [
    `${index + 1}. ${item.videoTitle || "Unknown video"}`,
    `Time: ${formatTime(item.timestamp)}`,
    `Trigger: ${humanizeLabel(item.trigger || item.responseType || "response")}`,
    `Source: ${humanizeLabel(item.source || "camera")}`,
    `URL: ${item.url || ""}`,
    `Preview: ${item.preview || ""}`,
    ""
  ].join("\n"));

  return [...header, ...rows].join("\n");
}

function escapeHTML(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#039;"
  }[char]));
}
