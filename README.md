# SBEC AI

Snap a page you don't understand. SBEC AI explains it in simple words, reads it aloud and makes a quiz from it.

Bilingual SBEC International · Built by Saho Digital Services.

## What's inside

| File | What it does |
|---|---|
| `index.html` | The whole app: camera, explanations, read-aloud, quiz, sign-in and saved lessons |
| `functions/api/[[path]].js` | Backend on Cloudflare: Gemini AI, voice (Gemini TTS), email sign-in codes and saved lessons (D1) |
| `sbec-voice.js` | **SBEC Voice**: our own read-aloud engine that runs on each phone (no server, no limits, works offline) |
| `voice/sbec/` | The voice (Piper, about 60 MB), split into pieces under 20 MB (GitHub and Cloudflare limits) |
| `vendor/ort/`, `vendor/phonemizer.js` | Engine parts: ONNX Runtime Web 1.22.0 and phonemizer 1.2.1 |
| `.github/workflows/add-sbec-voice.yml` | Puts the engine and voice in the repo. To change the voice: Actions → Add SBEC Voice → Run workflow |
| `sw.js`, `manifest.webmanifest`, `icons/` | Make it installable as an app |
| `_headers` | Security and caching headers |

## How the voice works

- **SBEC Voice (main):** the learner downloads it once, either by tapping **Download** or automatically after adding the app to the home screen. After that, every phone makes its own speech: no server, no limits for any number of users, and it works offline.
- **Before the download, or on very slow phones:** the Google Gemini voice reads aloud online. If Google is busy, the phone's own voice takes over.

## Cloudflare settings

- D1 binding: `SBEC_DB` → database `sbec-ai`
- Variables and Secrets:
  - `GEMINI_API_KEY` (secret)
  - `BREVO_API_KEY` (secret)
  - `EMAIL_FROM` (text)
- Optional:
  - `GEMINI_MODEL`
  - `TTS_VOICE` (default `Sulafat`)
  - `TTS_MODEL`
  - `TTS_DAILY` (default 800)
  - `ANON_DAILY` (default 25)
  - `USER_DAILY` (default 150)

To check it's working, open `/api/health`. It should show `"ai":true,"email":true`.

The database tables are created automatically the first time the app is used.
