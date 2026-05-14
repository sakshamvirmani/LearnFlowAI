# LearnFlow AI

A Chrome extension that watches your face while you watch YouTube — detecting when you're confused, frustrated, or bored, and instantly serving up AI-powered help tailored to that exact moment in the video.

---

## What it does

LearnFlow AI runs in the background as you watch educational YouTube videos. It uses your webcam to read facial expressions in real time and triggers contextual learning interventions when it detects a negative learning signal.

| Detected emotion | AI response |
|---|---|
| Confused | Plain-language summary of the current concept |
| Frustrated | Micro quiz to reinforce understanding |
| Bored | Surprising fun fact + real-world example |

You can also skip the camera entirely and use **Manual Mode**, where action chips let you request help on demand: Summary, Quiz, Fun Fact, Break Down, Key Points, or Encourage Me.

At the end of a session, LearnFlow generates a recap of what you covered and how engaged you were.

---

## Features

- **Real-time emotion detection** via [face-api.js](https://github.com/justadudewhohacks/face-api.js) (runs entirely in the browser — no video is sent anywhere)
- **Context-aware AI responses** anchored to the transcript at your current timestamp, not the video as a whole
- **Two modes**: Camera Mode (automatic) or Manual Mode (on-demand action chips)
- **Sensitivity tuning**: Low / Balanced / High presets, with per-emotion threshold sliders
- **Cooldown control**: Prevents alert fatigue (30 s → 5 min options)
- **Session analytics**: Heatmap of emotion triggers per session
- **Quiz score tracking**: Streak counter across a session
- **Response history**: Last 20 AI responses, downloadable as JSON
- **LLM provider toggle**: Groq cloud (default) or a local LLM via LM Studio

---

## Setup

### 1. Get a Groq API key

Sign up for free at [console.groq.com](https://console.groq.com) and create an API key.

### 2. Add your key

Open `background.js` and replace the placeholder on line 1:

```js
const GROQ_API_KEY = "YOUR_GROQ_API_KEY_HERE";
```

### 3. Load the extension in Chrome

1. Go to `chrome://extensions`
2. Enable **Developer mode** (top-right toggle)
3. Click **Load unpacked**
4. Select the `learnflow-ai` folder

### 4. Use it

1. Navigate to any YouTube video
2. Click the LearnFlow AI icon in your toolbar
3. Choose **Camera Mode** or **Manual Mode**
4. Toggle the extension on — that's it

---

## Optional: Local LLM (no API key needed)

LearnFlow supports [LM Studio](https://lmstudio.ai) as a local backend. Start a local server on port 1234 and flip the flag in `background.js`:

```js
const USE_LOCAL_LLM = true;
```

---

## Project structure

```
learnflow-ai/
├── background.js          # Service worker — LLM calls, settings, message routing
├── manifest.json          # Chrome extension manifest (MV3)
├── content/
│   ├── content.js         # YouTube page script — camera, emotion detection, overlays
│   └── content.css        # Overlay and chip styles
├── popup/
│   ├── popup.html         # Extension popup UI
│   ├── popup.js           # Popup logic
│   └── popup.css          # Popup styles
├── lib/
│   └── face-api.min.js    # Bundled face-api.js (browser, no external fetch)
├── models/
│   ├── tiny_face_detector_model-*        # Lightweight face detector
│   └── face_expression_model-*           # Expression classifier
└── icons/
    ├── icon16.png
    ├── icon48.png
    └── icon128.png
```

---

## Privacy

- Your camera feed is processed **entirely on-device** using face-api.js. No video frames leave your browser.
- Only the video title, a short transcript excerpt, and the detected emotion are sent to the LLM provider (Groq or local).
- No data is collected by this extension beyond what Chrome stores locally on your machine.

---

## License

MIT © [Saksham Virmani](https://github.com/sakshamvirmani)

This project is open source under the MIT License. You are free to use, modify, and distribute it, but **you must retain the original copyright notice and attribution** in all copies or substantial portions of the software.
