# SBEC AI

Snap a page you don't understand. SBEC AI explains it in simple words, reads it aloud in the "Heart" voice and makes a quiz from it.

Built by Saho Digital Services.

## What's inside

| File | What it does |
|---|---|
| `index.html` | The whole app: camera, explanations, read-aloud, quiz, sign-in and saved lessons |
| `tts-worker.js` | Runs the Kokoro "Heart" voice on the learner's phone (downloads ~90 MB once, then cached) |
| `vendor/kokoro.web.js` | The voice engine (kokoro-js 1.2.0) |
| `functions/api/[[path]].js` | Backend on Cloudflare: Gemini AI, email sign-in codes and saved lessons (D1) |
| `sw.js`, `manifest.webmanifest`, `icons/` | Make it installable as an app |
| `_headers` | Security headers, plus the settings that let the voice run faster |

## Deploy on Cloudflare Pages

1. Put all these files in a GitHub repo, keeping the folders as they are.
2. In Cloudflare, go to **Workers & Pages → Create → Pages → Connect to Git** and pick the repo.
   - Framework preset: **None**
   - Build command: *(leave empty)*
   - Build output directory: `/`
3. Create the database: **Storage & Databases → D1 → Create** and name it `sbec-ai`.
4. Open the Pages project and go to **Settings → Bindings → Add → D1 database**.
   - Variable name: `DB`
   - Database: `sbec-ai`
5. Go to **Settings → Variables and Secrets** and add these:
   - `GEMINI_API_KEY` (secret): get it from <https://aistudio.google.com/apikey>
   - `BREVO_API_KEY` (secret): sends the sign-in code emails
   - `EMAIL_FROM` (text): a sender address that is verified in Brevo
   - Optional:
     - `GEMINI_MODEL`: default is `gemini-flash-latest`
     - `ANON_DAILY`: lessons per day for guests, default 25
     - `USER_DAILY`: lessons per day for signed-in users, default 150
6. Go to **Deployments** and click **Retry deployment**, so it picks up the settings.
7. Open `https://<project>.pages.dev/api/health`. It should show `"ai":true,"email":true`.

The database tables are created automatically the first time the app is used.
