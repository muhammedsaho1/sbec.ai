# SBEC AI

Snap a page you don't understand. SBEC AI explains it in simple words, reads it aloud and makes a quiz from it.

Bilingual SBEC International · Built by Saho Digital Services.

## What's inside

| File | What it does |
|---|---|
| `index.html` | The whole app: camera, explanations, read-aloud, quiz, sign-in and saved lessons |
| `functions/api/[[path]].js` | Backend on Cloudflare: Gemini AI, voice (Gemini TTS), email sign-in codes and saved lessons (D1) |
| `tts-worker.js` | Offline "Heart" voice (Kokoro-82M) that runs on the learner's phone |
| `voice/kokoro/` | The offline voice files, split into pieces under 20 MB (GitHub and Cloudflare limits) |
| `vendor/kokoro.web.js` | The offline voice engine (kokoro-js 1.2.0) |
| `.github/workflows/add-voice.yml` | Re-downloads the offline voice from Hugging Face, checks it and splits it (Actions → Run workflow) |
| `sw.js`, `manifest.webmanifest`, `icons/` | Make it installable as an app |
| `_headers` | Security and caching headers |

## How the voice works

- **Online:** Google Gemini voice, streamed, so it starts in about 1 second.
- **Offline voice:** the learner taps **Download** on the home screen (or it downloads by itself on Wi-Fi). It is about 90 MB, once. After that SBEC AI reads aloud even without internet.
- If the phone is fast, it uses the offline voice all the time. If it's slow, it uses the Gemini voice online and the offline voice only when there is no internet.

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
