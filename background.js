// Get a free API key at https://console.groq.com
const GROQ_API_KEY = "YOUR_GROQ_API_KEY_HERE";

// [LearnFlow AI] LLM provider switch
const USE_LOCAL_LLM = false; // flip to false to use Groq

const API_URL = USE_LOCAL_LLM
  ? "http://localhost:1234/v1/chat/completions"
  : "https://api.groq.com/openai/v1/chat/completions";

const headers = USE_LOCAL_LLM
  ? { "Content-Type": "application/json" }
  : { "Content-Type": "application/json", "Authorization": `Bearer ${GROQ_API_KEY}` };

const MODEL = USE_LOCAL_LLM ? "llama-3.2-3b-instruct" : "llama-3.1-8b-instant";

const DEFAULT_EMOTION_THRESHOLDS = {
  confused: 3,
  frustrated: 3,
  bored: 3
};

const DEFAULT_SETTINGS = {
  enabled: false,
  cooldownMs: 2 * 60 * 1000,
  sensitivityPreset: "balanced",
  emotionThresholds: DEFAULT_EMOTION_THRESHOLDS,
  showCameraPreview: true,
  cameraPreviewOpacity: 0.7,
  showEmotionIndicator: true,
  manualBarMode: "actions",
  onboardingComplete: false
};

const DEFAULT_QUIZ_STATS = {
  totalCorrect: 0,
  totalAttempts: 0,
  currentStreak: 0
};

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.type === "GET_AI_RESPONSE") {
    handleAIRequest(request.payload || {}).then(sendResponse);
    return true;
  }

  if (request.type === "GET_SETTINGS") {
    getStoredSettings().then(sendResponse);
    return true;
  }

  if (request.type === "SAVE_SETTINGS") {
    saveSettings(request.payload || {}).then((settings) => sendResponse({ success: true, settings }));
    return true;
  }

  if (request.type === "SET_ENABLED_STATE") {
    saveSettings({ enabled: request.enabled }).then((settings) => sendResponse({ success: true, settings }));
    return true;
  }

  if (request.type === "LEARNFLOW_STATUS") {
    handleStatusRequest().then(sendResponse);
    return true;
  }

  if (request.type === "POPUP_OPENED") {
    relayPopupState(true).then(() => sendResponse({ success: true }));
    return true;
  }

  if (request.type === "POPUP_CLOSED") {
    relayPopupState(false).then(() => sendResponse({ success: true }));
    return true;
  }

  if (request.type === "OPEN_MANUAL_BAR") {
    getStoredSettings().then((settings) => {
      if (!settings.enabled || settings.currentMode !== "manual") {
        sendResponse({ success: false });
        return;
      }

      relayToActiveYouTubeTab({ type: "OPEN_MANUAL_BAR" }).then(() => sendResponse({ success: true }));
    });
    return true;
  }

  if (request.type === "SET_SESSION_MODE") {
    setSessionMode(request.mode).then(sendResponse);
    return true;
  }

  if (request.type === "GET_SESSION_MODE") {
    getSessionMode().then(sendResponse);
    return true;
  }

  if (request.type === "GET_SESSION_ANALYTICS") {
    handleSessionAnalyticsRequest().then(sendResponse);
    return true;
  }

  if (request.type === "LOG_RESPONSE") {
    logResponse(request.entry || {}).then(sendResponse);
    return true;
  }

  if (request.type === "GET_HISTORY") {
    getHistory().then(sendResponse);
    return true;
  }

  if (request.type === "CLEAR_HISTORY") {
    clearHistory().then(sendResponse);
    return true;
  }

  if (request.type === "RESET_CURRENT_SESSION") {
    relayToActiveYouTubeTab({ type: "RESET_SESSION" }).then((result) => sendResponse({ success: Boolean(result) }));
    return true;
  }

  if (request.type === "LOG_QUIZ_RESULT") {
    logQuizResult(Boolean(request.correct)).then(sendResponse);
    return true;
  }

  if (request.type === "GET_QUIZ_STATS") {
    getQuizStats().then(sendResponse);
    return true;
  }
});

chrome.commands.onCommand.addListener((command) => {
  if (command === "open-manual-bar") {
    getStoredSettings().then((settings) => {
      if (!settings.enabled || settings.currentMode !== "manual") {
        return;
      }

      relayToActiveYouTubeTab({ type: "OPEN_MANUAL_BAR" });
    });
  }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status !== "loading") return;
  saveSettings({ enabled: false }).catch(() => {});
});

async function handleAIRequest(payload) {
  const intent = normalizeIntent(payload.intent, payload.emotion);
  const prompt = buildPrompt(intent, payload);
  const maxTokens = intent === "session_summary" ? 650 : 450;

  try {
    const parsed = await requestJSONCompletion({
      prompt,
      maxTokens,
      intent
    });
    return { success: true, data: normalizeAIResponse(intent, parsed), intent };
  } catch (err) {
    return { error: "Failed to get response: " + err.message };
  }
}

async function requestJSONCompletion({ prompt, maxTokens, intent }) {
  try {
    return await sendCompletionRequest({
      prompt,
      maxTokens,
      strictJSON: true
    });
  } catch (err) {
    if (!shouldRetryWithoutStrictJSON(err)) {
      throw err;
    }

    return sendCompletionRequest({
      prompt: `${prompt}

Return exactly one JSON object and no surrounding prose.`,
      maxTokens,
      strictJSON: false
    });
  }
}

async function sendCompletionRequest({ prompt, maxTokens, strictJSON }) {
  const requestBody = {
    model: MODEL,
    messages: [
      {
        role: "system",
        content: "You are a helpful learning assistant. Always respond with valid JSON only, no markdown, no explanation outside the JSON."
      },
      { role: "user", content: prompt }
    ],
    max_tokens: maxTokens,
    temperature: 0.2
  };

  if (strictJSON && !USE_LOCAL_LLM) {
    requestBody.response_format = { type: "json_object" };
  }

  const response = await fetch(API_URL, {
    method: "POST",
    headers,
    body: JSON.stringify(requestBody)
  });

  const data = await response.json();
  if (!response.ok || data.error) {
    console.warn("[LearnFlow AI] LLM API error:", data);

    const apiMessage =
      data.error?.message ||
      data.error?.error ||
      data.error ||
      data.message ||
      response.statusText ||
      "Unknown model error";

    const error = new Error(String(apiMessage));
    error.apiError = data.error || data;
    throw error;
  }


  const content = data.choices?.[0]?.message?.content || "";
  return parseJSONObjectFromText(content);
}

// [LearnFlow AI] Retry once when the local model returns malformed JSON
function shouldRetryWithoutStrictJSON(err) {
  const message = String(err?.message || "");
  const apiError = err?.apiError || {};
  return apiError.code === "failed_generation"
    || message.includes("Failed to generate JSON")
    || message.includes("failed_generation")
    || message.includes("Expected ',' or '}' after property value in JSON")
    || message.includes("Unexpected end of JSON input")
    || message.includes("Unterminated string in JSON")
    || message.includes("Bad control character in string literal in JSON")
    || message.includes("Unexpected non-whitespace character after JSON");
}

function parseJSONObjectFromText(text) {
  const raw = String(text || "").trim();
  if (!raw) {
    throw new Error("The model returned an empty response.");
  }

  try {
    return JSON.parse(raw);
  } catch (initialError) {
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) {
      throw initialError;
    }

    return JSON.parse(match[0]);
  }
}

function normalizeAIResponse(intent, data) {
  if (intent === "keypoints" || intent === "breakdown") {
    const points = Array.isArray(data.points)
      ? data.points.map((point) => String(point || "").trim()).filter(Boolean)
      : [];

    if (points.length) {
      return {
        type: "summary",
        title: data.title || (intent === "breakdown" ? "Break it down" : "Key Points"),
        points,
        content: points.map((point, index) =>
          intent === "breakdown" ? point.replace(/^\d+[.)]\s*/, "") : `- ${point}`

        ).join("\n")
      };
    }
  }

  return data;
}

function normalizeIntent(intent, emotion) {
  if (intent) return intent;
  if (emotion === "frustrated") return "quiz";
  if (emotion === "bored") return "funfact";
  return "summary";
}

function buildPrompt(intent, payload) {
  const videoTitle = payload.videoTitle || "Unknown video";
  const videoTopic = payload.videoTopic || "";
  const timestamp = Number.isFinite(Number(payload.currentTime)) ? formatTimestamp(Number(payload.currentTime)) : "the current timestamp";
  const transcript = payload.transcript
    ? `Primary source: the learner is at ${timestamp}. Use only this nearby transcript excerpt for the specific concept: "${payload.transcript}"`
    : "Recent transcript was unavailable. Fall back to the title and description only when necessary.";
  const source = payload.source === "manual" ? "The learner manually requested help." : payload.emotion ? `Detected learner emotion: ${payload.emotion}.` : "";

  const context = `The learner is watching a YouTube video titled "${videoTitle}".
Background context: ${videoTopic}.
${transcript}
${source}
If a transcript excerpt is available, do not give a generic whole-video answer. Anchor the response to that excerpt.`;

  if (intent === "quiz") {
    return `${context}

Create a quick micro-quiz with 1 multiple-choice question that checks the exact concept from the transcript window.
Keep it simple and encouraging.
Respond ONLY with JSON: { "type": "quiz", "question": "...", "options": ["A", "B", "C", "D"], "correct": 0, "explanation": "..." }
(correct is the index of the correct answer)`;
  }

  if (intent === "funfact") {
    return `${context}

Re-engage the learner with 1 surprising fun fact and 1 real-world example connected to this exact moment in the video.
Respond ONLY with JSON: { "type": "funfact", "fact": "...", "example": { "title": "...", "description": "..." } }`;
  }

  if (intent === "breakdown") {
    return `${context}

Break down the current concept into small, plain-language numbered steps for a stuck learner.
Respond ONLY with JSON: { "type": "summary", "title": "Break it down", "points": ["...", "...", "..."] }`;
  }

  if (intent === "keypoints") {
    return `${context}

Extract the most important takeaways from this exact part of the video as short bullet-ready study notes.
Respond ONLY with JSON: { "type": "summary", "title": "Key Points", "points": ["...", "...", "..."] }`;
  }

  if (intent === "encourage") {
    return `${context}

Write a short encouraging learning nudge that helps the learner continue without being generic. Include one practical next step.
Respond ONLY with JSON: { "type": "summary", "title": "Keep going", "content": "..." }`;
  }

  if (intent === "session_summary") {
    const counts = JSON.stringify(payload.emotionCounts || {});
    const responses = JSON.stringify(payload.responses || []);

    return `${context}
Emotion trigger counts during this video: ${counts}
Responses already shown: ${responses}

Create an end-of-video learning recap.
Respond ONLY with JSON: { "type": "session_summary", "bullets": ["...", "...", "..."], "takeaway": "..." }`;
  }

  return `${context}

Provide a clear, concise summary of the core concept being discussed right now.
Respond ONLY with a JSON object: { "type": "summary", "title": "...", "content": "..." }`;
}

function formatTimestamp(seconds) {
  const rounded = Math.max(0, Math.round(seconds));
  const mins = Math.floor(rounded / 60);
  const secs = String(rounded % 60).padStart(2, "0");
  return `${mins}:${secs}`;
}

async function handleStatusRequest() {
  const activeTab = await getActiveTab();

  if (!activeTab || !activeTab.id) {
    return { ok: false, reason: "NO_ACTIVE_TAB" };
  }

  if (!isYouTubeWatchPage(activeTab.url)) {
    return { ok: false, reason: "UNSUPPORTED_PAGE" };
  }

  const live = await sendMessageToTab(activeTab.id, { type: "LEARNFLOW_STATUS" });

  return {
    ok: true,
    tabId: activeTab.id,
    live: live || null
  };
}

async function handleSessionAnalyticsRequest() {
  const activeTab = await getActiveTab();

  if (!activeTab || !activeTab.id || !isYouTubeWatchPage(activeTab.url)) {
    return { ok: false, reason: "NO_ACTIVE_TAB" };
  }

  const analytics = await sendMessageToTab(activeTab.id, { type: "GET_SESSION_ANALYTICS" });
  return { ok: true, analytics: analytics || null };
}

async function saveSettings(partialSettings) {
  const current = await getStoredSettings();
  const normalized = normalizeSettings({ ...current, ...partialSettings });

  await setSessionStorage({ enabled: normalized.enabled });
  await setSyncStorage({
    cooldownMs: normalized.cooldownMs,
    sensitivityPreset: normalized.sensitivityPreset,
    emotionThresholds: normalized.emotionThresholds,
    showCameraPreview: normalized.showCameraPreview,
    cameraPreviewOpacity: normalized.cameraPreviewOpacity,
    showEmotionIndicator: normalized.showEmotionIndicator,
    manualBarMode: normalized.manualBarMode,
    onboardingComplete: normalized.onboardingComplete,
    modeChosen: normalized.modeChosen,
    currentMode: normalized.currentMode
  });

  await relayToActiveYouTubeTab({ type: "SETTINGS_UPDATED", settings: normalized });
  return normalized;
}

async function setSessionMode(mode) {
  const currentMode = mode === "manual" ? "manual" : "camera";
  await setSessionStorage({ modeChosen: true, currentMode });
  await setSyncStorage({ modeChosen: true, currentMode });
  await relayToActiveYouTubeTab({ type: "SESSION_MODE_UPDATED", mode: currentMode });
  return { success: true, modeChosen: true, currentMode };
}

async function getSessionMode() {
  const sessionData = await getSessionStorage(["modeChosen", "currentMode"]);
  const syncData = await getSyncStorage(["modeChosen", "currentMode"]);
  const data = sessionData.modeChosen ? sessionData : syncData;
  const modeChosen = Boolean(data.modeChosen);

  return {
    modeChosen,
    currentMode: modeChosen ? (data.currentMode === "manual" ? "manual" : "camera") : null
  };
}

async function logResponse(entry) {
  const data = await getLocalStorage(["responseHistory"]);
  const responseHistory = Array.isArray(data.responseHistory) ? data.responseHistory : [];
  const nextEntry = {
    timestamp: entry.timestamp || Date.now(),
    videoTitle: entry.videoTitle || "Unknown video",
    videoId: entry.videoId || "",
    url: entry.url || "",
    source: entry.source || "camera",
    trigger: entry.trigger || entry.emotion || entry.intent || "unknown",
    responseType: entry.responseType || entry.intent || "response",
    preview: String(entry.preview || "").slice(0, 500)
  };

  const next = [nextEntry, ...responseHistory].slice(0, 20);
  await setLocalStorage({ responseHistory: next });
  return { success: true, responseHistory: next };
}

async function getHistory() {
  const data = await getLocalStorage(["responseHistory"]);
  return { responseHistory: Array.isArray(data.responseHistory) ? data.responseHistory : [] };
}

async function clearHistory() {
  await setLocalStorage({ responseHistory: [] });
  return { success: true, responseHistory: [] };
}

async function logQuizResult(correct) {
  const current = await getQuizStats();
  const quizStats = {
    totalCorrect: current.totalCorrect + (correct ? 1 : 0),
    totalAttempts: current.totalAttempts + 1,
    currentStreak: correct ? current.currentStreak + 1 : 0
  };

  await setLocalStorage({ quizStats });
  return { success: true, quizStats };
}

async function getQuizStats() {
  const data = await getLocalStorage(["quizStats"]);
  return { ...DEFAULT_QUIZ_STATS, ...(data.quizStats || {}) };
}

async function relayPopupState(isOpen) {
  await relayToActiveYouTubeTab({ type: isOpen ? "POPUP_OPENED" : "POPUP_CLOSED" });
}

async function relayToActiveYouTubeTab(message) {
  const activeTab = await getActiveTab();

  if (!activeTab || !activeTab.id || !isYouTubeWatchPage(activeTab.url)) {
    return null;
  }

  return sendMessageToTab(activeTab.id, message);
}

function isYouTubeWatchPage(url) {
  return typeof url === "string" && url.startsWith("https://www.youtube.com/watch");
}

function getActiveTab() {
  return new Promise((resolve) => {
      chrome.tabs.query({ active: true, lastFocusedWindow: true }, (tabs) => {
      resolve(tabs[0] || null);
    });
  });
}

function getSyncStorage(keys) {
  return new Promise((resolve) => {
    chrome.storage.sync.get(keys, resolve);
  });
}

function setSyncStorage(values) {
  return new Promise((resolve) => {
    chrome.storage.sync.set(values, resolve);
  });
}

function getLocalStorage(keys) {
  return new Promise((resolve) => {
    chrome.storage.local.get(keys, resolve);
  });
}

function setLocalStorage(values) {
  return new Promise((resolve) => {
    chrome.storage.local.set(values, resolve);
  });
}

function getSessionStorage(keys) {
  return new Promise((resolve) => {
    chrome.storage.session.get(keys, resolve);
  });
}

function setSessionStorage(values) {
  return new Promise((resolve) => {
    chrome.storage.session.set(values, resolve);
  });
}

async function getStoredSettings() {
  const syncData = await getSyncStorage([
    "sensitivity",
    "cooldownMinutes",
    "cooldownMs",
    "sensitivityPreset",
    "emotionThresholds",
    "showCameraPreview",
    "cameraPreviewOpacity",
    "showEmotionIndicator",
    "manualBarMode",
    "onboardingComplete"
  ]);
  const sessionData = await getSessionStorage(["enabled"]);
  const sessionMode = await getSessionMode();

  return normalizeSettings({
    ...DEFAULT_SETTINGS,
    ...syncData,
    enabled: sessionData.enabled === true,
    modeChosen: sessionMode.modeChosen,
    currentMode: sessionMode.currentMode
  });
}

function normalizeSettings(raw) {
  const legacyThreshold = Number(raw.sensitivity || DEFAULT_SETTINGS.emotionThresholds.confused);
  const emotionThresholds = {
    confused: clampThreshold(raw.emotionThresholds?.confused ?? legacyThreshold),
    frustrated: clampThreshold(raw.emotionThresholds?.frustrated ?? legacyThreshold),
    bored: clampThreshold(raw.emotionThresholds?.bored ?? legacyThreshold)
  };

  return {
    ...DEFAULT_SETTINGS,
    ...raw,
    enabled: raw.enabled !== false,
    cooldownMs: Number(raw.cooldownMs || raw.cooldownMinutes || DEFAULT_SETTINGS.cooldownMs),
    sensitivityPreset: raw.sensitivityPreset || inferSensitivityPreset(emotionThresholds),
    emotionThresholds,
    showCameraPreview: raw.showCameraPreview !== false,
    cameraPreviewOpacity: clampOpacity(raw.cameraPreviewOpacity ?? DEFAULT_SETTINGS.cameraPreviewOpacity),
    showEmotionIndicator: raw.showEmotionIndicator === true,
    manualBarMode: raw.manualBarMode === "emotions" ? "emotions" : "actions",
    onboardingComplete: Boolean(raw.onboardingComplete),
    modeChosen: Boolean(raw.modeChosen),
    currentMode: raw.currentMode === "manual" ? "manual" : "camera"
  };
}

function inferSensitivityPreset(thresholds) {
  const values = Object.values(thresholds);
  if (values.every((value) => value <= 2)) return "high";
  if (values.every((value) => value >= 4)) return "low";
  return "balanced";
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

function sendMessageToTab(tabId, message) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, message, (response) => {
      if (chrome.runtime.lastError) {
        resolve(null);
        return;
      }

      resolve(response ?? null);
    });
  });
}
