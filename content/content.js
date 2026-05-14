const CONFIG = {
  detectionIntervalMs: 2500,
  emotionWindowSize: 5,
  cooldownMs: 2 * 60 * 1000,
  minConfidence: 0.6,
  targetEmotions: ["confused", "frustrated", "bored"],
  emotionThresholds: {
    confused: 3,
    frustrated: 3,
    bored: 3
  },
  showCameraPreview: true,
  cameraPreviewOpacity: 0.7,
  showEmotionIndicator: false,
  manualBarMode: "actions"
};

const INTENT_BY_EMOTION = {
  confused: "summary",
  frustrated: "quiz",
  bored: "funfact"
};

const EMOTION_LABELS = {
  confused: "Confused",
  frustrated: "Frustrated",
  bored: "Bored",
  manual: "Manual",
  session: "Session"
};

const state = {
  isEnabled: false,
  popupOpen: false,
  modeChosen: false,
  currentMode: "camera",
  modelsLoaded: false,
  detecting: false,
  starting: false,
  emotionWindow: [],
  lastTriggerTime: {},
  adaptiveCooldownMultiplier: {},
  streamElement: null,
  previewContainer: null,
  emotionDot: null,
  detectionInterval: null,
  overlayVisible: false,
  cameraError: null,
  statusChip: null,
  utilityStack: null,
  manualBar: null,
  themeObserver: null,
  pauseReasons: {},
  emotionScores: { confused: 0, frustrated: 0, bored: 0 },
  session: createFreshSession(),
  activeContext: null
};

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.type === "LEARNFLOW_STATUS") {
    sendResponse(getLiveStatus());
    return true;
  }

  if (request.type === "GET_SESSION_ANALYTICS") {
    sendResponse(getSessionAnalytics());
    return true;
  }

  if (request.type === "SETTINGS_UPDATED") {
    applySettings(request.settings || {}).then(() => sendResponse({ success: true }));
    return true;
  }

  if (request.type === "POPUP_OPENED") {
    state.popupOpen = true;
    pauseForReason("popup", { retry: true });
    updateStatusChip();
    sendResponse({ success: true });
    return true;
  }

  if (request.type === "POPUP_CLOSED") {
    state.popupOpen = false;
    releasePauseReason("popup");
    updateStatusChip();
    sendResponse({ success: true });
    return true;
  }

  if (request.type === "SESSION_MODE_UPDATED") {
    applySessionMode(request.mode || "camera").then(() => sendResponse({ success: true }));
    return true;
  }

  if (request.type === "OPEN_MANUAL_BAR") {
    const opened = showManualBar(true);
    sendResponse({ success: opened });
    return true;
  }

  if (request.type === "RESET_SESSION") {
    resetCurrentSession();
    sendResponse({ success: true });
    return true;
  }

});

async function initialize() {
  injectUtilityStack();
  injectStatusChip();
  injectSidebarDOM();
  injectManualBar();
  bindKeyboardShortcuts();
  bindVideoEndListener();
  observeTheme();
  resetSessionIfVideoChanged();

  const settings = await getSettings();
  await applySettings(settings || {});
}

function createFreshSession() {
  return {
    videoId: "",
    videoTitle: "",
    emotionCounts: { confused: 0, frustrated: 0, bored: 0 },
    responses: [],
    quiz: { attempts: 0, correct: 0 },
    transcriptSegments: null,
    summaryShown: false
  };
}

async function applySessionMode(mode) {
  state.modeChosen = true;
  state.currentMode = mode === "manual" ? "manual" : "camera";

  if (state.currentMode === "manual") {
    await pauseLearnFlow(false);
    showManualBar(state.isEnabled);
  } else {
    showManualBar(false);
    if (state.isEnabled) {
      await ensureLearnFlowStarted();
    }
  }

  updateStatusChip();
}

async function loadModels() {
  if (state.modelsLoaded) return;

  const MODEL_URL = chrome.runtime.getURL("models");

  await Promise.all([
    faceapi.nets.tinyFaceDetector.loadFromUri(MODEL_URL),
    faceapi.nets.faceExpressionNet.loadFromUri(MODEL_URL)
  ]);

  state.modelsLoaded = true;
  updateStatusChip();
}

async function startWebcam() {
  if (state.streamElement && state.streamElement.srcObject) {
    applyPreviewSettings();
    return;
  }

  const stream = await navigator.mediaDevices.getUserMedia({
    video: { width: 320, height: 240, facingMode: "user" },
    audio: false
  });

  const container = document.createElement("div");
  container.id = "learnflow-camera-preview";

  const video = document.createElement("video");
  video.srcObject = stream;
  video.autoplay = true;
  video.playsInline = true;
  video.muted = true;

  const dot = document.createElement("span");
  dot.className = "lf-emotion-dot";
  dot.setAttribute("aria-hidden", "true");

  container.append(video, dot);
  document.body.appendChild(container);

  state.previewContainer = container;
  state.streamElement = video;
  state.emotionDot = dot;
  state.cameraError = null;

  await new Promise((resolve) => {
    video.onloadedmetadata = resolve;
  });

  await video.play().catch(() => {});
  applyPreviewSettings();
  updateUtilityLayout();
  updateStatusChip();
}

function startDetectionLoop() {
  if (state.detectionInterval) return;

  state.detecting = true;
  updateStatusChip();

  state.detectionInterval = setInterval(async () => {
    if (!state.isEnabled || state.currentMode !== "camera" || !state.streamElement || state.overlayVisible) return;

    try {
      const detection = await faceapi
        .detectSingleFace(state.streamElement, new faceapi.TinyFaceDetectorOptions({ scoreThreshold: CONFIG.minConfidence }))
        .withFaceExpressions();

      if (!detection) return;

      const rawEmotion = classifyEmotion(detection.expressions);
      if (!rawEmotion) return;

      updateEmotionWindow(rawEmotion);
      updateEmotionIndicator(rawEmotion);
      checkTrigger();
    } catch (err) {
      console.warn("[LearnFlow] Detection error:", err);
    }
  }, CONFIG.detectionIntervalMs);
}

function classifyEmotion(expressions) {
  const boosted = {
    angry:     expressions.angry     * 3.5,
    disgusted: expressions.disgusted * 3.5,
    surprised: expressions.surprised * 3.0,
    fearful:   expressions.fearful   * 3.0,
    sad:       expressions.sad       * 2.5,
    neutral:   expressions.neutral,
  };

  const confused    = (boosted.disgusted + boosted.surprised) / 2;
  const frustrated  = (boosted.angry     + boosted.disgusted) / 2;
  const bored       = boosted.neutral * 0.6 + boosted.sad * 0.4;

  const scores = { confused, frustrated, bored };

  const sorted = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  const dominant = sorted[0];

  return dominant[1] > 0.20 ? dominant[0] : null;
}

// REPLACE WITH:
function updateEmotionWindow(emotion) {
  // Still keep window for indicator updates
  state.emotionWindow.push(emotion);
  if (state.emotionWindow.length > CONFIG.emotionWindowSize) {
    state.emotionWindow.shift();
  }

  const DECAY = 0.75;
  const GAIN_STRONG = 2.5;
  const GAIN_BORED = 1.5;

  for (const e of CONFIG.targetEmotions) {
    state.emotionScores[e] = (state.emotionScores[e] || 0) * DECAY;
  }

  if (emotion === "bored") {
    state.emotionScores.bored += GAIN_BORED;
  } else {
    state.emotionScores[emotion] = (state.emotionScores[emotion] || 0) + GAIN_STRONG;
  }
}

function checkTrigger() {
  // Need at least a few ticks before we start evaluating
  if (state.emotionWindow.length < 3) return;

  // Score needed to fire = threshold setting (2–5) mapped to score units
  // threshold 3 (default) → needs score ~4.0, which takes ~5 detections
  const SCORE_SCALE = 1.0;

  for (const emotion of CONFIG.targetEmotions) {
    const threshold = (CONFIG.emotionThresholds[emotion] || 3) * SCORE_SCALE;
    const score = state.emotionScores[emotion] || 0;

    if (score >= threshold) {
      const lastTrigger = state.lastTriggerTime[emotion] || 0;
      const now = Date.now();
      const cooldown = CONFIG.cooldownMs * (state.adaptiveCooldownMultiplier[emotion] || 1);

      if (now - lastTrigger > cooldown) {
        state.lastTriggerTime[emotion] = now;
        // Reset all scores after firing so we start fresh
        state.emotionScores = { confused: 0, frustrated: 0, bored: 0 };
        state.emotionWindow = [];
        state.session.emotionCounts[emotion] += 1;
        triggerResponse({ emotion, intent: INTENT_BY_EMOTION[emotion], source: "camera" });
        return;
      }
    }
  }
}

async function getYouTubeContext() {
  resetSessionIfVideoChanged();

  const titleEl = document.querySelector("h1.ytd-video-primary-info-renderer yt-formatted-string, h1.ytd-watch-metadata yt-formatted-string");
  const videoTitle = titleEl ? titleEl.innerText.trim() : "Unknown video";

  const channelEl = document.querySelector("#channel-name a, ytd-channel-name a");
  const channelName = channelEl ? channelEl.innerText.trim() : "";

  const descEl = document.querySelector("#description-text, #meta-contents #description, ytd-text-inline-expander");
  const description = descEl ? descEl.innerText.trim().slice(0, 500) : "";

  const video = getActiveVideo();
  const currentTime = video ? video.currentTime : 0;
  const transcript = await getTranscriptWindow(currentTime);
  const videoTopic = `${videoTitle} (channel: ${channelName}). ${description}`.slice(0, 600);

  state.session.videoTitle = videoTitle;

  return {
    videoTitle,
    videoId: getVideoId(),
    url: location.href,
    videoTopic,
    transcript,
    currentTime: Math.round(currentTime),
    transcriptWindowSeconds: transcript ? 30 : 0
  };
}

async function triggerResponse({ emotion = "", intent = "summary", source = "camera" }) {
  const trigger = emotion || intent;

  showLoadingOverlay(trigger, intent);

  try {
    const context = await getYouTubeContext();
    state.activeContext = { emotion, intent, source, ...context };

    const response = await chrome.runtime.sendMessage({
      type: "GET_AI_RESPONSE",
      payload: { emotion, intent, source, ...context }
    });

    if (!response || response.error) {
      showErrorOverlay(response?.error || "Failed to get a LearnFlow response.");
      return;
    }

    showResponseOverlay(trigger, response.data, { emotion, intent, source, ...context });
    recordResponse({ emotion, intent, source, context, data: response.data });
  } catch (err) {
    console.warn("[LearnFlow] Response trigger failed:", err);
    showErrorOverlay("LearnFlow could not build a response for this moment.");
  }
}

function injectSidebarDOM() {
  const existing = document.getElementById("learnflow-sidebar");
  if (existing) return;

  const sidebar = document.createElement("div");
  sidebar.id = "learnflow-sidebar";
  sidebar.innerHTML = `
    <div id="lf-header">
      <span id="lf-emotion-badge"></span>
      <span id="lf-title">LearnFlow AI</span>
      <button id="lf-close-btn" aria-label="Close">x</button>
    </div>
    <div id="lf-body"></div>
    <div id="lf-footer">
      <button class="lf-feedback-btn" data-val="helpful">Helpful</button>
      <button class="lf-feedback-btn" data-val="not-helpful">Not helpful</button>
    </div>
  `;

  document.body.appendChild(sidebar);

  document.getElementById("lf-close-btn").addEventListener("click", closeOverlay);
  document.querySelectorAll(".lf-feedback-btn").forEach((btn) => {
    btn.addEventListener("click", (event) => handleFeedback(event.target.dataset.val));
  });
  applySidebarTheme();
}

function showLoadingOverlay(trigger, intent) {
  state.overlayVisible = true;
  const sidebar = document.getElementById("learnflow-sidebar");
  sidebar.classList.add("visible");

  const badge = document.getElementById("lf-emotion-badge");
  const body = document.getElementById("lf-body");
  const label = humanizeLabel(trigger || intent);

  badge.textContent = label;
  badge.className = `lf-badge lf-badge-${trigger || intent}`;
  body.innerHTML = `<div class="lf-loading"><div class="lf-spinner"></div><p>Generating ${readableIntent(intent).toLowerCase()}...</p></div>`;
}

function showResponseOverlay(trigger, data, meta = {}) {
  const body = document.getElementById("lf-body");

  if (data.type === "summary") {
    if (meta.intent === "keypoints" || meta.intent === "breakdown") {
      renderKeyPointsCard(body, data, meta.intent);
      return;
    }

    body.innerHTML = `
      <div class="lf-card lf-summary">
        <h3>${escapeHTML(humanizeLabel(data.title || meta.intent || "Quick Summary"))}</h3>
        <p>${escapeHTML(data.content || "")}</p>
      </div>`;
  } else if (data.type === "quiz") {
    pauseForReason("quiz");
    renderQuiz(body, data, meta);
  } else if (data.type === "funfact") {
    body.innerHTML = `
      <div class="lf-card lf-funfact">
        <h3>Did you know?</h3>
        <p>${escapeHTML(data.fact || "")}</p>
        <div class="lf-example">
          <strong>Real world: ${escapeHTML(data.example?.title || "")}</strong>
          <p>${escapeHTML(data.example?.description || "")}</p>
        </div>
      </div>`;
  } else if (data.type === "session_summary") {
    renderSessionSummary(data);
  }
}

function renderKeyPointsCard(body, data, intent = "keypoints") {
  const points = Array.isArray(data.points) && data.points.length
    ? data.points
        .map((point) => String(point || "").replace(/^\d+[.)]\s*/, "").trim())
        .filter(Boolean)
    : toBulletPoints(data.content || "").map((point) =>
        String(point || "").replace(/^\d+[.)]\s*/, "").trim()
      );

  const listTag = intent === "breakdown" ? "ol" : "ul";

  body.innerHTML = `
    <div class="lf-card lf-summary">
      <h3>${escapeHTML(humanizeLabel(data.title || (intent === "breakdown" ? "Break it down" : "Key Points")))}</h3>
      <${listTag}>${points.map((point) => `<li>${escapeHTML(point)}</li>`).join("")}</${listTag}>
    </div>`;
}

function toBulletPoints(text) {
  const cleaned = String(text || "").trim();
  if (!cleaned) return ["No key points available yet."];

  const newlinePoints = cleaned
    .split(/\n+/)
    .map((line) => line.replace(/^[-*•]\s*/, "").trim())
    .filter(Boolean);

  if (newlinePoints.length > 1) {
    return newlinePoints;
  }

  const sentencePoints = cleaned
    .split(/(?<=[.!?])\s+/)
    .map((line) => line.replace(/^[-*•]\s*/, "").trim())
    .filter(Boolean);

  return sentencePoints.length ? sentencePoints : [cleaned];
}

function renderQuiz(body, data, meta) {
  const optionsHTML = (data.options || []).map((opt, index) =>
    `<button class="lf-quiz-option" data-index="${index}">${escapeHTML(opt)}</button>`
  ).join("");

  body.innerHTML = `
    <div class="lf-card lf-quiz">
      <h3>Quick Check</h3>
      <p class="lf-question">${escapeHTML(data.question || "")}</p>
      <div class="lf-quiz-options">${optionsHTML}</div>
      <div class="lf-explanation" hidden>
        <p class="lf-answer-line"></p>
        <p><strong>Explanation:</strong> ${escapeHTML(data.explanation || "")}</p>
      </div>
    </div>`;

  body.querySelectorAll(".lf-quiz-option").forEach((btn) => {
    btn.addEventListener("click", (event) => {
      const chosen = parseInt(event.currentTarget.dataset.index, 10);
      const correct = Number(data.correct || 0);
      const isCorrect = chosen === correct;

      body.querySelectorAll(".lf-quiz-option").forEach((button, index) => {
        button.disabled = true;
        if (index === correct) button.classList.add("lf-correct");
        else if (index === chosen) button.classList.add("lf-wrong");
      });

      const explanation = body.querySelector(".lf-explanation");
      explanation.hidden = false;
      explanation.querySelector(".lf-answer-line").textContent = isCorrect
        ? "Correct."
        : `Correct answer: ${data.options?.[correct] || "Option " + (correct + 1)}`;

      state.session.quiz.attempts += 1;
      if (isCorrect) state.session.quiz.correct += 1;
      chrome.runtime.sendMessage({ type: "LOG_QUIZ_RESULT", correct: isCorrect });
      releasePauseReason("quiz");
    });
  });
}

function renderSessionSummary(data) {
  const body = document.getElementById("lf-body");
  const bullets = Array.isArray(data.bullets) ? data.bullets.slice(0, 3) : [];
  const counts = state.session.emotionCounts;
  const responseItems = state.session.responses.slice(-5).map((item) =>
    `<li>${escapeHTML(readableIntent(item.responseType))}: ${escapeHTML(item.preview)}</li>`
  ).join("");

  body.innerHTML = `
    <div class="lf-card lf-session-summary">
      <h3>Session summary</h3>
      <div class="lf-summary-counts">
        <span>Confused ${counts.confused}</span>
        <span>Frustrated ${counts.frustrated}</span>
        <span>Bored ${counts.bored}</span>
      </div>
      <ul>${bullets.map((item) => `<li>${escapeHTML(item)}</li>`).join("")}</ul>
      ${data.takeaway ? `<p>${escapeHTML(data.takeaway)}</p>` : ""}
      ${responseItems ? `<h4>Responses shown</h4><ul>${responseItems}</ul>` : ""}
    </div>`;
}

function showErrorOverlay(errorMsg) {
  const body = document.getElementById("lf-body");
  body.innerHTML = `<div class="lf-error"><p>${escapeHTML(errorMsg)}</p></div>`;
}

function closeOverlay() {
  const sidebar = document.getElementById("learnflow-sidebar");
  if (sidebar) {
    sidebar.classList.remove("visible");
  }

  state.overlayVisible = false;
  releasePauseReason("quiz");
}

function handleFeedback(value) {
  if (value === "not-helpful" && state.activeContext?.emotion) {
    const emotion = state.activeContext.emotion;
    const current = state.adaptiveCooldownMultiplier[emotion] || 1;
    state.adaptiveCooldownMultiplier[emotion] = Math.min(3, current * 1.5);
    state.emotionWindow = [];
    showNotification("Not helpful: LearnFlow will wait longer before repeating this emotion-based prompt.");
  } else if (value === "helpful") {
    showNotification("Helpful: LearnFlow will keep this kind of help as-is.");
  }

  closeOverlay();
}

function showNotification(message) {
  const element = document.createElement("div");
  element.className = "lf-toast";
  element.textContent = message;
  document.body.appendChild(element);
  setTimeout(() => element.remove(), 5000);
}

async function applySettings(settings = {}) {
  CONFIG.cooldownMs = Number(settings.cooldownMs || settings.cooldownMinutes || CONFIG.cooldownMs);
  CONFIG.emotionThresholds = {
    confused: clampThreshold(settings.emotionThresholds?.confused ?? settings.sensitivity ?? CONFIG.emotionThresholds.confused),
    frustrated: clampThreshold(settings.emotionThresholds?.frustrated ?? settings.sensitivity ?? CONFIG.emotionThresholds.frustrated),
    bored: clampThreshold(settings.emotionThresholds?.bored ?? settings.sensitivity ?? CONFIG.emotionThresholds.bored)
  };
  CONFIG.showCameraPreview = settings.showCameraPreview !== false;
  CONFIG.cameraPreviewOpacity = clampOpacity(settings.cameraPreviewOpacity ?? CONFIG.cameraPreviewOpacity);
  CONFIG.showEmotionIndicator = settings.showEmotionIndicator === true;
  CONFIG.manualBarMode = settings.manualBarMode === "emotions" ? "emotions" : "actions";

  state.isEnabled = settings.enabled !== false;
  state.modeChosen = settings.modeChosen === true;
  state.currentMode = settings.currentMode === "manual" ? "manual" : "camera";

  applyPreviewSettings();

  if (!state.isEnabled) {
    await pauseLearnFlow(true);
    showManualBar(false);
    updateStatusChip();
    return;
  }

  if (!state.modeChosen) {
    await pauseLearnFlow(false);
    showManualBar(false);
    updateStatusChip();
    return;
  }

  if (state.currentMode === "manual") {
    await pauseLearnFlow(false);
    showManualBar(true);
    updateStatusChip();
    return;
  }

  showManualBar(false);
  await ensureLearnFlowStarted();
  updateStatusChip();
}

async function ensureLearnFlowStarted() {
  if (state.starting || state.detecting || state.currentMode !== "camera") {
    updateStatusChip();
    return;
  }

  state.starting = true;
  state.cameraError = null;
  updateStatusChip();

  try {
    await loadModels();
    await startWebcam();
    startDetectionLoop();
    console.log("[LearnFlow] Initialized successfully");
  } catch (err) {
    state.cameraError = err.message;
    console.error("[LearnFlow] Init error:", err);
    showNotification("LearnFlow: Camera/model setup failed. Open the popup to review status.");
  } finally {
    state.starting = false;
    updateStatusChip();
  }
}

async function pauseLearnFlow(clearEnabled = true) {
  if (clearEnabled) {
    state.isEnabled = false;
  }

  state.detecting = false;
  state.starting = false;
  state.emotionWindow = [];
  state.lastTriggerTime = {};
  state.cameraError = null;

  if (state.detectionInterval) {
    clearInterval(state.detectionInterval);
    state.detectionInterval = null;
  }

  if (state.streamElement) {
    const stream = state.streamElement.srcObject;
    if (stream) {
      stream.getTracks().forEach((track) => track.stop());
    }
    state.streamElement.remove();
    state.streamElement = null;
  }

  if (state.previewContainer) {
    state.previewContainer.remove();
    state.previewContainer = null;
    state.emotionDot = null;
  }

  if (state.overlayVisible && clearEnabled) {
    closeOverlay();
  }

  updateUtilityLayout();
  updateStatusChip();
}

function injectUtilityStack() {
  if (state.utilityStack) return;

  const stack = document.createElement("div");
  stack.id = "learnflow-utility-stack";
  document.body.appendChild(stack);
  state.utilityStack = stack;
}

function injectStatusChip() {
  if (state.statusChip) return;

  const chip = document.createElement("div");
  chip.id = "learnflow-status-chip";
  chip.innerHTML = `
    <span class="lf-chip-dot"></span>
    <span class="lf-chip-text"></span>
  `;

  document.body.appendChild(chip);
  state.statusChip = chip;
  updateUtilityLayout();
  updateStatusChip();
}

function updateUtilityLayout() {
  if (!state.utilityStack) return;

  if (state.statusChip && state.statusChip.parentElement !== state.utilityStack) {
    state.utilityStack.appendChild(state.statusChip);
  }

  if (state.previewContainer && state.previewContainer.parentElement !== state.utilityStack) {
    state.utilityStack.appendChild(state.previewContainer);
  }
}

function getStatusSnapshot() {
  if (!state.isEnabled) {
    return { tone: "paused", text: "Paused" };
  }

  if (!state.modeChosen) {
    return { tone: "waiting", text: "Choose a mode" };
  }

  if (!getActiveVideo()) {
    return { tone: "waiting", text: "Waiting for video" };
  }

  if (state.currentMode === "manual") {
    return { tone: "ready", text: "Manual mode ready" };
  }

  if (state.cameraError) {
    return { tone: "missing", text: "Camera unavailable" };
  }

  if (state.starting || !state.modelsLoaded) {
    return { tone: "waiting", text: "Loading models" };
  }

  if (!state.streamElement || !state.streamElement.srcObject || !state.detecting) {
    return { tone: "waiting", text: "Starting camera" };
  }

  return { tone: "ready", text: "Watching for learning signals" };
}

function updateStatusChip() {
  if (!state.statusChip) return;

  const snapshot = getStatusSnapshot();
  state.statusChip.dataset.state = snapshot.tone;
  state.statusChip.dataset.popupOpen = state.popupOpen ? "true" : "false";
  state.statusChip.querySelector(".lf-chip-text").textContent = snapshot.text;
}

function getLiveStatus() {
  const snapshot = getStatusSnapshot();

  return {
    enabled: state.isEnabled,
    popupOpen: state.popupOpen,
    modeChosen: state.modeChosen,
    currentMode: state.currentMode,
    modelsLoaded: state.modelsLoaded,
    hasCamera: Boolean(state.streamElement && state.streamElement.srcObject),
    cameraPreviewVisible: Boolean(state.previewContainer && CONFIG.showCameraPreview),
    cameraError: state.cameraError,
    videoFound: Boolean(getActiveVideo()),
    detecting: state.detecting,
    chipTone: snapshot.tone,
    chipText: snapshot.text
  };
}

function getSessionAnalytics() {
  resetSessionIfVideoChanged();

  return {
    videoTitle: state.session.videoTitle || getCurrentVideoTitle(),
    emotionCounts: { ...state.session.emotionCounts },
    responses: [...state.session.responses],
    quiz: { ...state.session.quiz },
    currentMode: state.currentMode
  };
}

function resetCurrentSession() {
  const currentVideoId = getVideoId();
  const currentVideoTitle = getCurrentVideoTitle();

  state.session = createFreshSession();
  state.session.videoId = currentVideoId;
  state.session.videoTitle = currentVideoTitle;
  state.emotionWindow = [];
  state.emotionScores = { confused: 0, frustrated: 0, bored: 0 }; // ← add this
  state.lastTriggerTime = {};
  state.adaptiveCooldownMultiplier = {};
}

function getSettings() {
  return chrome.runtime.sendMessage({ type: "GET_SETTINGS" });
}

function applyPreviewSettings() {
  if (!state.previewContainer) return;

  state.previewContainer.style.display = CONFIG.showCameraPreview ? "block" : "none";
  state.previewContainer.style.opacity = String(CONFIG.cameraPreviewOpacity);
  if (state.emotionDot) {
    state.emotionDot.style.display = CONFIG.showEmotionIndicator ? "block" : "none";
  }
}

function updateEmotionIndicator(emotion) {
  if (!state.emotionDot || !CONFIG.showEmotionIndicator) return;
  state.emotionDot.dataset.emotion = emotion;
}

function injectManualBar() {
  if (state.manualBar) return;

  const bar = document.createElement("div");
  bar.id = "learnflow-manual-bar";
  document.body.appendChild(bar);
  state.manualBar = bar;
  renderManualBar();
}

function renderManualBar() {
  if (!state.manualBar) return;

  const buttons = CONFIG.manualBarMode === "emotions"
    ? `
      <button data-emotion="confused">Confused</button>
      <button data-emotion="frustrated">Frustrated</button>
      <button data-emotion="bored">Bored</button>
    `
    : `
      <button data-intent="summary">Summary</button>
      <button data-intent="quiz">Quiz</button>
      <button data-intent="funfact">Fun Fact</button>
      <button data-intent="breakdown">Break Down</button>
      <button data-intent="keypoints">Key Points</button>
      <button data-intent="encourage">Encourage Me</button>
    `;

  state.manualBar.innerHTML = `
    ${buttons}
    <button data-action="close" aria-label="Close">x</button>
  `;

  state.manualBar.querySelectorAll("[data-intent], [data-emotion]").forEach((button) => {
    button.addEventListener("click", () => {
      if (!canUseManualBar()) {
        showManualBar(false);
        return;
      }

      const emotion = button.dataset.emotion || "";
      const intent = emotion ? INTENT_BY_EMOTION[emotion] : button.dataset.intent;
      triggerResponse({ emotion, intent, source: "manual" });
    });
  });

  state.manualBar.querySelector("[data-action='close']").addEventListener("click", () => showManualBar(false));
}

function canUseManualBar() {
  return state.isEnabled && state.modeChosen && state.currentMode === "manual";
}

function showManualBar(visible) {
  if (!state.manualBar) {
    injectManualBar();
  }

  if (!state.manualBar) return false;

  if (!visible || !canUseManualBar()) {
    state.manualBar.classList.remove("visible");
    return false;
  }

  renderManualBar();
  state.manualBar.classList.add("visible");
  return true;
}

function bindKeyboardShortcuts() {
  if (document.documentElement.dataset.learnflowKeysBound === "true") return;
  document.documentElement.dataset.learnflowKeysBound = "true";

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && state.overlayVisible) {
      closeOverlay();
      return;
    }

    const isManualShortcut = event.shiftKey && (event.altKey || event.metaKey) && event.key.toLowerCase() === "l";
    if (isManualShortcut) {
      event.preventDefault();
      showManualBar(true);
    }
  });
}

function bindVideoEndListener() {
  const video = getActiveVideo();
  if (!video || video.dataset.learnflowEndedBound === "true") return;

  video.dataset.learnflowEndedBound = "true";
  video.addEventListener("ended", showEndOfVideoSummary);
}

async function showEndOfVideoSummary() {
  resetSessionIfVideoChanged();
  if (state.session.summaryShown) return;

  state.session.summaryShown = true;
  const context = await getYouTubeContext();
  const wholeTranscript = await getTranscriptWindow(Number.POSITIVE_INFINITY, true);

  showLoadingOverlay("session", "session_summary");
  const response = await chrome.runtime.sendMessage({
    type: "GET_AI_RESPONSE",
    payload: {
      intent: "session_summary",
      source: "session",
      ...context,
      transcript: wholeTranscript || context.transcript,
      emotionCounts: state.session.emotionCounts,
      responses: state.session.responses
    }
  });

  if (!response || response.error) {
    showErrorOverlay(response?.error || "Failed to build the session summary.");
    return;
  }

  showResponseOverlay("session", response.data, { intent: "session_summary", source: "session", ...context });
  recordResponse({ intent: "session_summary", source: "session", context, data: response.data });
}

function pauseForReason(reason, options = {}) {
  const video = getActiveVideo();
  if (!video) {
    if (options.retry) {
      retryPauseForReason(reason);
    }
    return;
  }

  if (state.pauseReasons[reason]) return;

  const wasPlaying = !video.paused && !video.ended;
  state.pauseReasons[reason] = { pausedByUs: wasPlaying };

  if (wasPlaying) {
    video.pause();
  }
}

function retryPauseForReason(reason) {
  let attempts = 0;
  const timer = setInterval(() => {
    if (!state.popupOpen && reason === "popup") {
      clearInterval(timer);
      return;
    }

    attempts += 1;
    const video = getActiveVideo();
    if (video || attempts >= 10) {
      clearInterval(timer);
    }
    if (video && !state.pauseReasons[reason]) {
      pauseForReason(reason);
    }
  }, 150);
}

function releasePauseReason(reason) {
  const entry = state.pauseReasons[reason];
  if (!entry) return;

  delete state.pauseReasons[reason];
  const hasOtherPauseReason = Object.keys(state.pauseReasons).length > 0;

  if (entry.pausedByUs && !hasOtherPauseReason) {
    const video = getActiveVideo();
    if (video && video.paused && !video.ended) {
      video.play().catch(() => {});
    }
  }
}

async function getTranscriptWindow(currentTime, wholeVideo = false) {
  const segments = await ensureTranscriptSegments();
  if (!segments.length) return "";

  if (wholeVideo) {
    return segments.map((segment) => segment.text).join(" ").slice(0, 3500);
  }

  const start = Math.max(0, currentTime - 15);
  const end = currentTime + 15;
  const windowText = segments
    .filter((segment) => segment.seconds >= start && segment.seconds <= end)
    .map((segment) => segment.text)
    .join(" ")
    .slice(0, 1000);

  if (windowText) return windowText;

  const nearest = segments
    .map((segment) => ({ ...segment, distance: Math.abs(segment.seconds - currentTime) }))
    .sort((a, b) => a.distance - b.distance)
    .slice(0, 4)
    .sort((a, b) => a.seconds - b.seconds);

  return nearest.map((segment) => segment.text).join(" ").slice(0, 1000);
}

async function ensureTranscriptSegments() {
  resetSessionIfVideoChanged();

  if (Array.isArray(state.session.transcriptSegments) && state.session.transcriptSegments.length) {
    return state.session.transcriptSegments;
  }

  const captionSegments = await getTranscriptSegmentsFromPlayerResponse();
  if (captionSegments.length) {
    state.session.transcriptSegments = captionSegments;
    return captionSegments;
  }

  const wasOpen = Boolean(findTranscriptPanel());
  let openedByLearnFlow = false;

  if (!wasOpen) {
    openedByLearnFlow = await openTranscriptPanel();
    if (openedByLearnFlow) {
      await waitFor(() => Boolean(findTranscriptPanel()), 3500);
    }
  }

  const rowsReady = await waitFor(() => getTranscriptRows().length > 0, 5000);
  const rows = rowsReady ? getTranscriptRows() : [];
  const segments = rows.map(parseTranscriptRow).filter(Boolean);

  if (openedByLearnFlow) {
    closeTranscriptPanel();
  }

  if (segments.length) {
    state.session.transcriptSegments = segments;
  }

  return segments;
}

async function getTranscriptSegmentsFromPlayerResponse() {
  try {
    const playerResponse = getYouTubePlayerResponse();
    const tracks = playerResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
    const track = pickCaptionTrack(tracks) || await getCaptionTrackFromTimedTextList();

    if (!track?.baseUrl) return [];

    const url = new URL(track.baseUrl);
    url.searchParams.set("fmt", "json3");

    const response = await fetch(url.toString());
    if (!response.ok) return [];

    const data = await parseJSONResponse(response);
    if (!data || !Array.isArray(data.events)) return [];

    const segments = (data.events || [])
      .filter((event) => Array.isArray(event.segs) && Number.isFinite(event.tStartMs))
      .map((event) => ({
        seconds: event.tStartMs / 1000,
        text: event.segs.map((segment) => segment.utf8 || "").join("").replace(/\s+/g, " ").trim()
      }))
      .filter((segment) => segment.text);

    return segments;
  } catch (err) {
    console.warn("[LearnFlow] Caption transcript fetch failed:", err);
    return [];
  }
}

async function parseJSONResponse(response) {
  const raw = await response.text();
  if (!raw.trim()) return null;

  const contentType = response.headers.get("content-type") || "";
  if (contentType.includes("xml") || contentType.includes("html")) {
    return null;
  }

  try {
    return JSON.parse(raw);
  } catch (err) {
    const snippet = raw.slice(0, 120).trim();
    throw new Error(`Invalid JSON response${snippet ? `: ${snippet}` : ""}`, { cause: err });
  }
}

async function getCaptionTrackFromTimedTextList() {
  const videoId = getVideoId();
  if (!videoId || videoId === location.href) return null;

  try {
    const listUrl = new URL("https://www.youtube.com/api/timedtext");
    listUrl.searchParams.set("type", "list");
    listUrl.searchParams.set("v", videoId);

    const response = await fetch(listUrl.toString());
    if (!response.ok) return null;

    const xml = await response.text();
    const doc = new DOMParser().parseFromString(xml, "text/xml");
    const tracks = Array.from(doc.querySelectorAll("track")).map((track) => {
      const url = new URL("https://www.youtube.com/api/timedtext");
      url.searchParams.set("v", videoId);
      url.searchParams.set("lang", track.getAttribute("lang_code") || "");

      const name = track.getAttribute("name");
      const kind = track.getAttribute("kind");
      if (name) url.searchParams.set("name", name);
      if (kind) url.searchParams.set("kind", kind);

      return {
        baseUrl: url.toString(),
        languageCode: track.getAttribute("lang_code") || "",
        kind: kind || ""
      };
    });

    return pickCaptionTrack(tracks);
  } catch (err) {
    console.warn("[LearnFlow] Timedtext track lookup failed:", err);
    return null;
  }
}

function getYouTubePlayerResponse() {
  if (window.ytInitialPlayerResponse) {
    return window.ytInitialPlayerResponse;
  }

  for (const script of document.scripts) {
    const text = script.textContent || "";
    const match = /ytInitialPlayerResponse\s*=\s*/.exec(text);
    if (!match) continue;

    const raw = extractBalancedJSONObject(text, match.index + match[0].length);
    if (!raw) continue;

    try {
      return JSON.parse(raw);
    } catch (err) {
      console.warn("[LearnFlow] Failed to parse player response:", err);
    }
  }

  return null;
}

function extractBalancedJSONObject(text, startIndex) {
  const firstBrace = text.indexOf("{", startIndex);
  if (firstBrace === -1) return "";

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = firstBrace; index < text.length; index += 1) {
    const char = text[index];

    if (escaped) {
      escaped = false;
      continue;
    }

    if (char === "\\") {
      escaped = true;
      continue;
    }

    if (char === "\"") {
      inString = !inString;
      continue;
    }

    if (inString) continue;

    if (char === "{") depth += 1;
    if (char === "}") depth -= 1;

    if (depth === 0) {
      return text.slice(firstBrace, index + 1);
    }
  }

  return "";
}

function pickCaptionTrack(tracks) {
  if (!Array.isArray(tracks) || !tracks.length) return null;

  return tracks.find((track) => track.languageCode?.startsWith("en") && track.kind !== "asr")
    || tracks.find((track) => track.languageCode?.startsWith("en"))
    || tracks.find((track) => track.kind !== "asr")
    || tracks[0];
}

function findTranscriptPanel() {
  return document.querySelector(`
    ytd-transcript-renderer,
    ytd-transcript-search-panel-renderer,
    ytd-engagement-panel-section-list-renderer[target-id='engagement-panel-searchable-transcript']
  `);
}

function getTranscriptRows() {
  return Array.from(document.querySelectorAll(`
    ytd-transcript-segment-renderer,
    ytd-transcript-segment-list-renderer ytd-transcript-segment-renderer,
    ytd-transcript-segment-list-renderer [role="button"]
  `)).filter((row) => /\d{1,2}:\d{2}/.test(row.textContent || ""));
}

function parseTranscriptRow(row) {
  const rawText = (row.innerText || row.textContent || "").replace(/\s+/g, " ").trim();
  const timeEl = row.querySelector(".segment-timestamp, [class*='timestamp']");
  const textEl = row.querySelector(".segment-text, yt-formatted-string.segment-text, [class*='segment-text']");
  const fallbackTime = rawText.match(/(?:\d{1,2}:)?\d{1,2}:\d{2}/)?.[0] || "";
  const timeText = timeEl ? timeEl.textContent.trim() : fallbackTime;
  const text = (textEl ? textEl.textContent : rawText.replace(timeText, "")).replace(/\s+/g, " ").trim();
  const seconds = parseTimestamp(timeText);

  if (!text || seconds === null) return null;
  return { seconds, text };
}

async function openTranscriptPanel() {
  clickDescriptionExpander();
  await sleep(250);

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const transcriptButton = findTranscriptButton();

    if (transcriptButton) {
      transcriptButton.click();
      const opened = await waitFor(() => Boolean(findTranscriptPanel()) || getTranscriptRows().length > 0, 2500);
      if (opened) return true;
    }

    clickDescriptionExpander();
    await sleep(350);
  }

  return false;
}

function findTranscriptButton() {
  const transcriptSection = document.querySelector("ytd-video-description-transcript-section-renderer");
  const sectionButton = transcriptSection?.querySelector("button, tp-yt-paper-button");
  if (sectionButton && isVisible(sectionButton)) return sectionButton;

  const candidates = Array.from(document.querySelectorAll("button, tp-yt-paper-button, ytd-button-renderer"));
  const transcriptButton = candidates.find((button) => {
    const label = `${button.textContent || ""} ${button.getAttribute("aria-label") || ""}`.replace(/\s+/g, " ").trim();
    return isVisible(button) && /\b(show transcript|transcript)\b/i.test(label) && !/\bsearch\b/i.test(label);
  });

  if (!transcriptButton) return false;
  return transcriptButton.querySelector("button") || transcriptButton;
}

function clickDescriptionExpander() {
  const descriptionRoot = document.querySelector("#description, #description-inline-expander, ytd-watch-metadata") || document;
  const expanders = Array.from(descriptionRoot.querySelectorAll(`
    #description-inline-expander #expand,
    ytd-text-inline-expander #expand,
    tp-yt-paper-button#expand,
    button[aria-label*='Show more' i]
  `));
  const expander = expanders.find(isVisible);
  if (expander) expander.click();
}

function closeTranscriptPanel() {
  const panel = findTranscriptPanel();
  const closeButton = panel?.querySelector("button[aria-label*='Close' i], yt-icon-button button[aria-label*='Close' i]");
  if (closeButton) closeButton.click();
}

function parseTimestamp(value) {
  const parts = value.split(":").map((part) => Number(part.trim()));
  if (parts.some((part) => !Number.isFinite(part))) return null;
  return parts.reduce((total, part) => total * 60 + part, 0);
}

function waitFor(predicate, timeoutMs) {
  return new Promise((resolve) => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (predicate() || Date.now() - started > timeoutMs) {
        clearInterval(timer);
        resolve(predicate());
      }
    }, 150);
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isVisible(element) {
  if (!element) return false;
  const rect = element.getBoundingClientRect();
  const style = window.getComputedStyle(element);
  return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
}

function recordResponse({ emotion = "", intent = "", source = "camera", context = {}, data = {} }) {
  const responseType = data.type || intent || "response";
  const preview = responsePreview(data);
  const entry = {
    timestamp: Date.now(),
    videoTitle: context.videoTitle || getCurrentVideoTitle(),
    videoId: context.videoId || getVideoId(),
    url: context.url || location.href,
    source,
    trigger: emotion || intent || source,
    responseType,
    preview
  };

  state.session.responses.push(entry);
  chrome.runtime.sendMessage({ type: "LOG_RESPONSE", entry });
}

function responsePreview(data) {
  if (data.type === "summary") {
    if (Array.isArray(data.points) && data.points.length) return data.points.join(" ");
    return data.content || data.title || "";
  }
  if (data.type === "quiz") return data.question || "";
  if (data.type === "funfact") return data.fact || "";
  if (data.type === "session_summary") return Array.isArray(data.bullets) ? data.bullets.join(" ") : data.takeaway || "";
  if (data.type === "quiz_result") return data.result || "";
  return JSON.stringify(data).slice(0, 300);
}

function observeTheme() {
  if (state.themeObserver) return;

  state.themeObserver = new MutationObserver(applySidebarTheme);
  state.themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["dark", "system-icons", "style", "class"] });
  applySidebarTheme();
}

function applySidebarTheme() {
  const sidebar = document.getElementById("learnflow-sidebar");
  if (!sidebar) return;

  const dark = document.documentElement.hasAttribute("dark") || document.querySelector("html[dark], ytd-app[dark]");
  sidebar.classList.toggle("lf-theme-dark", Boolean(dark));
  sidebar.classList.toggle("lf-theme-light", !dark);
}

function resetSessionIfVideoChanged() {
  const videoId = getVideoId();
  if (state.session.videoId === videoId) return;

  state.session = createFreshSession();
  state.session.videoId = videoId;
  state.session.videoTitle = getCurrentVideoTitle();
  state.adaptiveCooldownMultiplier = {};
  state.pauseReasons = {};
  bindVideoEndListener();
}

function getVideoId() {
  try {
    return new URL(location.href).searchParams.get("v") || location.href;
  } catch (err) {
    return location.href;
  }
}

function getCurrentVideoTitle() {
  const titleEl = document.querySelector("h1.ytd-video-primary-info-renderer yt-formatted-string, h1.ytd-watch-metadata yt-formatted-string");
  return titleEl ? titleEl.innerText.trim() : document.title.replace(" - YouTube", "") || "Unknown video";
}

function getActiveVideo() {
  return document.querySelector("video.html5-main-video") || document.querySelector("video");
}

function readableIntent(intent) {
  const labels = {
    summary: "Summary",
    quiz: "Quiz",
    funfact: "Fun Fact",
    session_summary: "Session Summary",
    quiz_answer: "Quiz Answer",
    breakdown: "Break Down",
    keypoints: "Key Points",
    encourage: "Encourage Me"
  };
  return labels[intent] || humanizeLabel(intent || "Response");
}

function humanizeLabel(value) {
  const normalized = String(value || "")
    .replace(/_/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .trim()
    .toLowerCase();

  const aliases = {
    funfact: "Fun Fact",
    keypoints: "Key Points",
    session: "Session",
    manual: "Manual",
    quiz_answer: "Quiz Answer",
    session_summary: "Session Summary"
  };

  if (aliases[value]) return aliases[value];
  if (!normalized) return "Response";

  return normalized.replace(/\b\w/g, (char) => char.toUpperCase());
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

function clampThreshold(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 3;
  return Math.max(2, Math.min(5, Math.round(number)));
}

function clampOpacity(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0.7;
  return Math.max(0.2, Math.min(1, number));
}

chrome.storage.onChanged.addListener((changes, areaName) => {
  const relevantKeys = [
    "enabled",
    "sensitivity",
    "cooldownMinutes",
    "cooldownMs",
    "sensitivityPreset",
    "emotionThresholds",
    "showCameraPreview",
    "cameraPreviewOpacity",
    "showEmotionIndicator",
    "manualBarMode"
  ];
  const hasRelevantChange = relevantKeys.some((key) => key in changes);

  if (!hasRelevantChange || !["sync", "local", "session"].includes(areaName)) return;

  getSettings().then(applySettings).catch((err) => {
    console.warn("[LearnFlow] Failed to refresh settings:", err);
  });
});

let lastUrl = location.href;
new MutationObserver(() => {
  const currentUrl = location.href;
  if (currentUrl !== lastUrl) {
    lastUrl = currentUrl;
    if (currentUrl.includes("youtube.com/watch")) {
      setTimeout(initialize, 1500);
    }
  }
}).observe(document, { subtree: true, childList: true });

if (location.href.includes("youtube.com/watch")) {
  setTimeout(initialize, 2000);
}
