// =====================================================================
//  SBEC AI — API (Cloudflare Pages Function)
//  Saho Digital Services
//
//  Routes (all under /api/):
//    POST   explain          stream an explanation of a snapped page (and follow-ups)
//    POST   quiz             make a short quiz from a lesson
//    POST   auth/start       email a 6-digit sign-in code
//    POST   auth/verify      check the code, return a long-lived session token
//    GET    me               who is signed in
//    POST   auth/logout      end this device's session
//    GET    snaps            list saved lessons (signed-in only)
//    POST   snaps            save / update a lesson (signed-in only)
//    GET    snaps/:id        open one saved lesson
//    DELETE snaps/:id        delete one saved lesson
//
//  Cloudflare settings needed (Pages > Settings):
//    D1 binding        SBEC_DB         (any D1 database — tables are created automatically)
//    Secret            GEMINI_API_KEY  (Google AI Studio key)
//    Secret            BREVO_API_KEY   (sends the sign-in code emails)
//    Variable          EMAIL_FROM      (a sender address verified in Brevo)
//    Optional          GEMINI_MODEL    (default: gemini-flash-latest)
//    Optional          ANON_DAILY      (lessons per day without sign-in, default 25)
//    Optional          USER_DAILY      (lessons per day when signed in, default 150)
// =====================================================================

const JSONH = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };
const ok = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: JSONH });
const fail = (error, status = 400) => new Response(JSON.stringify({ error }), { status, headers: JSONH });

const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models/';
const MAX_IMAGE_CHARS = 2_800_000;   // ~2 MB jpeg as base64
const SESSION_DAYS = 365;

// ---------------------------------------------------------------- schema
let schemaReady = false;
async function ensureSchema(db) {
  if (schemaReady) return;
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT UNIQUE NOT NULL, created_at TEXT DEFAULT (datetime('now')))`),
    db.prepare(`CREATE TABLE IF NOT EXISTS login_codes (email TEXT PRIMARY KEY, code_hash TEXT NOT NULL, expires_at INTEGER NOT NULL, attempts INTEGER DEFAULT 0)`),
    db.prepare(`CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL, created_at TEXT DEFAULT (datetime('now')), expires_at INTEGER NOT NULL)`),
    db.prepare(`CREATE TABLE IF NOT EXISTS snaps (id TEXT PRIMARY KEY, user_id INTEGER NOT NULL, title TEXT, level TEXT, thumb TEXT, image TEXT, messages TEXT, created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')))`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_snaps_user ON snaps(user_id, updated_at)`),
    db.prepare(`CREATE TABLE IF NOT EXISTS usage (k TEXT NOT NULL, day TEXT NOT NULL, n INTEGER DEFAULT 0, PRIMARY KEY (k, day))`),
  ]);
  schemaReady = true;
}

// ---------------------------------------------------------------- helpers
async function sha256(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}
function randomToken() {
  const b = new Uint8Array(32); crypto.getRandomValues(b);
  return btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function randomCode() {
  const b = new Uint32Array(1); crypto.getRandomValues(b);
  return String(b[0] % 1000000).padStart(6, '0');
}
const today = () => new Date().toISOString().slice(0, 10);
const clientIp = (req) => req.headers.get('cf-connecting-ip') || req.headers.get('x-forwarded-for') || 'local';
const validEmail = (e) => typeof e === 'string' && e.length <= 200 && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e);

async function readJson(req) { try { return await req.json(); } catch { return {}; } }

async function currentUser(env, req) {
  const h = req.headers.get('authorization') || '';
  if (!h.startsWith('Bearer ')) return null;
  const th = await sha256(h.slice(7));
  const row = await env.DB.prepare(
    `SELECT u.id, u.email FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ?`
  ).bind(th, Date.now()).first();
  return row || null;
}

// Count one use; returns false when the daily limit is reached.
async function takeQuota(env, key, limit) {
  const day = today();
  const row = await env.DB.prepare(
    `INSERT INTO usage (k, day, n) VALUES (?, ?, 1) ON CONFLICT(k, day) DO UPDATE SET n = n + 1 RETURNING n`
  ).bind(key, day).first();
  return (row?.n || 1) <= limit;
}

// ---------------------------------------------------------------- AI prompts
const LEVELS = {
  kid: 'The learner is a young child (about 8-11 years old). Use very simple words, short sentences, friendly comparisons from everyday life, and lots of encouragement.',
  student: 'The learner is a secondary-school student. Explain clearly in plain language, define any hard words, and give a worked example where useful.',
  advanced: 'The learner is an advanced student. Be precise and thorough, include the reasoning and any formulas, but stay clear and well organised.',
};

function systemPrompt(level) {
  return `You are SBEC AI, a warm, patient and brilliant personal tutor. A learner has photographed a page (from a textbook, notes, worksheet or exam) that they do not understand. Your job is to make it make sense.

${LEVELS[level] || LEVELS.student}

How to answer the FIRST time you see a page:
- Line 1 must be exactly: TITLE: <a short title of the topic, max 6 words>
- Then use these sections with markdown "## " headings:
  ## What this page is about
  ## Explained simply
  ## Key points
  ## Example
  ## Quick check
- "Key points" is a short bulleted list. "Quick check" is ONE short question for the learner to try (do not give the answer).
- If the learner asked about a specific part, focus on that part first.
- If it is a maths or science problem, solve it step by step with numbered steps.

For FOLLOW-UP messages: answer directly and conversationally, no TITLE line and no fixed sections, keep it focused.

Always:
- Your words will also be READ ALOUD, so write naturally speakable text. Never use LaTeX, never use $ signs for maths, never draw tables. Write maths in plain text, for example "3/4", "x squared", "2 x 5 = 10".
- Keep paragraphs short. Be encouraging, never make the learner feel slow.
- If the photo is blurry, cut off or unreadable, say so kindly and ask for a clearer photo instead of guessing.
- If the image is not study material, still help briefly, then invite them to snap a page from their lessons.
- Answer in English.`;
}

function geminiContents(image, messages, question) {
  // messages: [{role:'user'|'model', text}]  (history of this lesson, oldest first)
  const contents = [];
  const firstUserParts = [];
  if (image) {
    const m = /^data:(image\/[a-z+.-]+);base64,(.+)$/i.exec(image);
    if (m) firstUserParts.push({ inline_data: { mime_type: m[1], data: m[2] } });
  }
  const hist = Array.isArray(messages) ? messages.slice(-24) : [];
  if (!hist.length) {
    firstUserParts.push({ text: question ? `Please explain this page. My question: ${question}` : 'Please explain this page to me.' });
    contents.push({ role: 'user', parts: firstUserParts });
    return contents;
  }
  hist.forEach((m, i) => {
    const role = m.role === 'model' ? 'model' : 'user';
    const parts = [];
    if (i === 0 && role === 'user') parts.push(...firstUserParts);
    parts.push({ text: String(m.text || '').slice(0, 8000) || '...' });
    contents.push({ role, parts });
  });
  if (contents[0].role !== 'user') contents.unshift({ role: 'user', parts: [...firstUserParts, { text: 'Please explain this page to me.' }] });
  return contents;
}

async function callGemini(env, body, stream) {
  // Try the main model first; if Google says it is busy (or it is too slow), fall back to other Flash models.
  const base = env.GEMINI_BASE || GEMINI_BASE;
  const models = [...new Set([env.GEMINI_MODEL, 'gemini-flash-latest', 'gemini-3.6-flash', 'gemini-3.5-flash', 'gemini-flash-lite-latest', 'gemini-3.5-flash-lite'].filter(Boolean))];
  const send = async (model, b, ms) => {
    const url = `${base}${encodeURIComponent(model)}:${stream ? 'streamGenerateContent?alt=sse' : 'generateContent'}`;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), ms);
    try {
      return await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': env.GEMINI_API_KEY }, body: JSON.stringify(b), signal: ac.signal });
    } catch (e) {
      return new Response(JSON.stringify({ error: { message: 'Gemini did not respond in time' } }), { status: 504 });
    } finally { clearTimeout(timer); }
  };
  let last = null;
  for (let k = 0; k < models.length; k++) {
    const model = models[k];
    const ms = k === models.length - 1 ? 40000 : 20000;
    let res = await send(model, body, ms);
    if (res.status === 400 && body.generationConfig?.thinkingConfig) {
      // Older models don't accept thinkingLevel — retry without it.
      const b2 = JSON.parse(JSON.stringify(body)); delete b2.generationConfig.thinkingConfig;
      res = await send(model, b2, ms);
    }
    if (res.ok) return res;
    last = res;
    if (![404, 429, 500, 502, 503, 504].includes(res.status)) return res;
    console.log('gemini busy, trying next model', model, res.status);
  }
  return last;
}

function friendlyAiError(status, text) {
  let detail = '';
  try { detail = (JSON.parse(text).error || {}).message || ''; } catch { detail = String(text || '').slice(0, 160); }
  detail = ` [AI ${status}${detail ? ': ' + detail.slice(0, 180) : ''}]`;
  if (status === 429) return 'SBEC AI is very busy right now. Please try again in a minute.' + detail;
  if (status === 400 && /image|inline|mime/i.test(text)) return 'That photo could not be read. Please try another photo.' + detail;
  if (status === 403 || status === 401) return 'The AI key is not set up correctly. Please tell the administrator.' + detail;
  return 'The AI could not answer right now. Please try again.' + detail;
}

// ---------------------------------------------------------------- routes
async function explain(env, req, ctx) {
  if (!env.GEMINI_API_KEY) return fail('The AI is not configured yet (missing GEMINI_API_KEY).', 500);
  const b = await readJson(req);
  const image = typeof b.image === 'string' ? b.image : null;
  if (image && image.length > MAX_IMAGE_CHARS) return fail('That photo is too large. Please try again.', 413);
  if (!image && !(Array.isArray(b.messages) && b.messages.length)) return fail('Please snap or choose a photo first.');
  const level = LEVELS[b.level] ? b.level : 'student';

  const user = await currentUser(env, req);
  const isNewLesson = !(Array.isArray(b.messages) && b.messages.some(m => m.role === 'model'));
  if (isNewLesson) {
    const allowed = user
      ? await takeQuota(env, 'u:' + user.id, parseInt(env.USER_DAILY || '150'))
      : await takeQuota(env, 'ip:' + clientIp(req), parseInt(env.ANON_DAILY || '25'));
    if (!allowed) return fail(user ? 'You have reached today\'s limit. Come back tomorrow!' : 'You have used today\'s free lessons. Sign in with your email to get more.', 429);
  } else {
    // follow-ups are cheaper but still limited
    const allowed = await takeQuota(env, (user ? 'fu:' + user.id : 'fip:' + clientIp(req)), parseInt(env.FOLLOWUP_DAILY || '400'));
    if (!allowed) return fail('Too many questions today. Please come back tomorrow.', 429);
  }

  const gbody = {
    system_instruction: { parts: [{ text: systemPrompt(level) }] },
    contents: geminiContents(image, b.messages, (b.question || '').toString().slice(0, 500)),
    generationConfig: { maxOutputTokens: 2048, thinkingConfig: { thinkingLevel: 'low' } },
  };
  const upstream = await callGemini(env, gbody, true);
  if (!upstream.ok || !upstream.body) {
    const t = await upstream.text().catch(() => '');
    console.log('gemini error', upstream.status, t.slice(0, 500));
    return fail(friendlyAiError(upstream.status, t), 502);
  }

  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const enc = new TextEncoder();
  const pump = (async () => {
    const reader = upstream.body.getReader();
    const dec = new TextDecoder();
    let buf = '', sent = 0;
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
          if (!line.startsWith('data:')) continue;
          const data = line.slice(5).trim();
          if (!data || data === '[DONE]') continue;
          try {
            const j = JSON.parse(data);
            const parts = j?.candidates?.[0]?.content?.parts || [];
            for (const p of parts) {
              if (p.thought || typeof p.text !== 'string') continue;
              sent += p.text.length;
              await writer.write(enc.encode(p.text));
            }
            const fr = j?.candidates?.[0]?.finishReason;
            if (fr === 'SAFETY' && !sent) await writer.write(enc.encode('Sorry, I can\'t help with that photo. Try snapping a page from your lessons.'));
          } catch { /* ignore partial json */ }
        }
      }
      if (!sent) await writer.write(enc.encode('Sorry, I could not read that. Please try a clearer photo.'));
    } catch (e) {
      try { await writer.write(enc.encode('\n\n(The connection was interrupted. Please try again.)')); } catch {}
    } finally {
      try { await writer.close(); } catch {}
    }
  })();
  ctx.waitUntil(pump);
  return new Response(readable, { headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'x-accel-buffering': 'no' } });
}

async function quiz(env, req) {
  if (!env.GEMINI_API_KEY) return fail('The AI is not configured yet.', 500);
  const b = await readJson(req);
  const lesson = String(b.lesson || '').slice(0, 12000);
  const image = typeof b.image === 'string' && b.image.length <= MAX_IMAGE_CHARS ? b.image : null;
  if (!lesson && !image) return fail('Nothing to make a quiz from yet.');
  const user = await currentUser(env, req);
  const allowed = await takeQuota(env, (user ? 'q:' + user.id : 'qip:' + clientIp(req)), parseInt(env.QUIZ_DAILY || '60'));
  if (!allowed) return fail('Too many quizzes today. Come back tomorrow!', 429);
  const level = LEVELS[b.level] ? b.level : 'student';

  const parts = [];
  if (image) { const m = /^data:(image\/[a-z+.-]+);base64,(.+)$/i.exec(image); if (m) parts.push({ inline_data: { mime_type: m[1], data: m[2] } }); }
  parts.push({ text: `Make a quiz of exactly 5 multiple-choice questions that check understanding of this lesson. ${LEVELS[level]} Each question has 4 short options and exactly one correct answer. Vary which option is correct. Add a one-sentence friendly explanation for the answer. No LaTeX.\n\nLESSON:\n${lesson}` });

  const gbody = {
    contents: [{ role: 'user', parts }],
    generationConfig: {
      maxOutputTokens: 2048,
      thinkingConfig: { thinkingLevel: 'low' },
      responseMimeType: 'application/json',
      responseSchema: {
        type: 'OBJECT',
        properties: {
          questions: {
            type: 'ARRAY',
            items: {
              type: 'OBJECT',
              properties: {
                question: { type: 'STRING' },
                options: { type: 'ARRAY', items: { type: 'STRING' } },
                answer: { type: 'INTEGER' },
                why: { type: 'STRING' },
              },
              required: ['question', 'options', 'answer', 'why'],
            },
          },
        },
        required: ['questions'],
      },
    },
  };
  const res = await callGemini(env, gbody, false);
  const t = await res.text();
  if (!res.ok) { console.log('quiz error', res.status, t.slice(0, 400)); return fail(friendlyAiError(res.status, t), 502); }
  try {
    const j = JSON.parse(t);
    const txt = (j.candidates?.[0]?.content?.parts || []).filter(p => !p.thought).map(p => p.text || '').join('');
    const data = JSON.parse(txt);
    const qs = (data.questions || []).filter(q => q && q.question && Array.isArray(q.options) && q.options.length >= 2)
      .slice(0, 5).map(q => ({ question: String(q.question), options: q.options.slice(0, 4).map(String), answer: Math.max(0, Math.min((q.options.length || 4) - 1, parseInt(q.answer) || 0)), why: String(q.why || '') }));
    if (!qs.length) throw new Error('empty');
    return ok({ questions: qs });
  } catch (e) {
    return fail('Could not make a quiz this time. Please try again.', 502);
  }
}

async function authStart(env, req) {
  const b = await readJson(req);
  const email = String(b.email || '').trim().toLowerCase();
  if (!validEmail(email)) return fail('Please enter a valid email address.');
  if (!(await takeQuota(env, 'code:' + email, 6)) || !(await takeQuota(env, 'codeip:' + clientIp(req), 20)))
    return fail('Too many codes requested. Please try again later.', 429);
  const code = randomCode();
  await env.DB.prepare(
    `INSERT INTO login_codes (email, code_hash, expires_at, attempts) VALUES (?, ?, ?, 0)
     ON CONFLICT(email) DO UPDATE SET code_hash = excluded.code_hash, expires_at = excluded.expires_at, attempts = 0`
  ).bind(email, await sha256(email + ':' + code), Date.now() + 15 * 60 * 1000).run();

  if (!env.BREVO_API_KEY || !env.EMAIL_FROM) {
    if (env.DEV === '1') return ok({ sent: true, devCode: code });
    return fail('Email sign-in is not configured yet. You can still use SBEC AI without signing in.', 500);
  }
  const html = `<!doctype html><html><body style="margin:0;background:#f4f3ff;font-family:Arial,Helvetica,sans-serif">
  <div style="max-width:460px;margin:24px auto;background:#fff;border-radius:18px;padding:32px;text-align:center">
    <div style="font-size:22px;font-weight:800;color:#4f46e5">SBEC AI</div>
    <p style="color:#333;font-size:16px">Your sign-in code is</p>
    <div style="font-size:38px;letter-spacing:10px;font-weight:800;color:#111;margin:10px 0 18px">${code}</div>
    <p style="color:#666;font-size:14px">It expires in 15 minutes. If you did not ask for this, you can ignore this email.</p>
  </div></body></html>`;
  const r = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: { 'api-key': env.BREVO_API_KEY, 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ sender: { name: 'SBEC AI', email: env.EMAIL_FROM }, to: [{ email }], subject: `${code} is your SBEC AI code`, htmlContent: html, textContent: `Your SBEC AI sign-in code is ${code}. It expires in 15 minutes.` }),
  });
  if (!r.ok) { console.log('brevo', r.status, (await r.text()).slice(0, 300)); return fail('Could not send the email. Please check the address and try again.', 502); }
  return ok({ sent: true });
}

async function authVerify(env, req) {
  const b = await readJson(req);
  const email = String(b.email || '').trim().toLowerCase();
  const code = String(b.code || '').replace(/\D/g, '');
  if (!validEmail(email) || code.length !== 6) return fail('Please enter the 6-digit code.');
  const row = await env.DB.prepare(`SELECT code_hash, expires_at, attempts FROM login_codes WHERE email = ?`).bind(email).first();
  if (!row || row.expires_at < Date.now()) return fail('That code has expired. Please ask for a new one.');
  if (row.attempts >= 5) return fail('Too many wrong tries. Please ask for a new code.');
  if (row.code_hash !== await sha256(email + ':' + code)) {
    await env.DB.prepare(`UPDATE login_codes SET attempts = attempts + 1 WHERE email = ?`).bind(email).run();
    return fail('That code is not right. Please check and try again.');
  }
  await env.DB.prepare(`DELETE FROM login_codes WHERE email = ?`).bind(email).run();
  await env.DB.prepare(`INSERT INTO users (email) VALUES (?) ON CONFLICT(email) DO NOTHING`).bind(email).run();
  const user = await env.DB.prepare(`SELECT id, email FROM users WHERE email = ?`).bind(email).first();
  const token = randomToken();
  await env.DB.prepare(`INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)`)
    .bind(await sha256(token), user.id, Date.now() + SESSION_DAYS * 86400000).run();
  return ok({ token, email: user.email });
}

async function logout(env, req) {
  const h = req.headers.get('authorization') || '';
  if (h.startsWith('Bearer ')) await env.DB.prepare(`DELETE FROM sessions WHERE token_hash = ?`).bind(await sha256(h.slice(7))).run();
  return ok({ ok: true });
}

async function listSnaps(env, user) {
  const { results } = await env.DB.prepare(
    `SELECT id, title, level, thumb, created_at, updated_at FROM snaps WHERE user_id = ? ORDER BY updated_at DESC LIMIT 300`
  ).bind(user.id).all();
  return ok({ snaps: results || [] });
}

async function saveSnap(env, req, user) {
  const b = await readJson(req);
  const id = String(b.id || '');
  if (!/^[a-zA-Z0-9-]{8,64}$/.test(id)) return fail('Invalid lesson id.');
  const messages = JSON.stringify((Array.isArray(b.messages) ? b.messages : []).slice(-60).map(m => ({ role: m.role === 'model' ? 'model' : 'user', text: String(m.text || '').slice(0, 20000) })));
  const title = String(b.title || 'Lesson').slice(0, 120);
  const level = LEVELS[b.level] ? b.level : 'student';
  const thumb = typeof b.thumb === 'string' && b.thumb.length < 120000 ? b.thumb : null;
  const image = typeof b.image === 'string' && b.image.length < MAX_IMAGE_CHARS ? b.image : null;
  const existing = await env.DB.prepare(`SELECT user_id FROM snaps WHERE id = ?`).bind(id).first();
  if (existing && existing.user_id !== user.id) return fail('Not allowed.', 403);
  if (existing) {
    await env.DB.prepare(`UPDATE snaps SET title = ?, level = ?, messages = ?, thumb = COALESCE(?, thumb), image = COALESCE(?, image), updated_at = datetime('now') WHERE id = ?`)
      .bind(title, level, messages, thumb, image, id).run();
  } else {
    await env.DB.prepare(`INSERT INTO snaps (id, user_id, title, level, thumb, image, messages) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .bind(id, user.id, title, level, thumb, image, messages).run();
  }
  return ok({ saved: true });
}

async function getSnap(env, user, id) {
  const row = await env.DB.prepare(`SELECT id, title, level, image, thumb, messages, created_at, updated_at FROM snaps WHERE id = ? AND user_id = ?`).bind(id, user.id).first();
  if (!row) return fail('Lesson not found.', 404);
  let messages = []; try { messages = JSON.parse(row.messages || '[]'); } catch {}
  return ok({ snap: { ...row, messages } });
}

async function deleteSnap(env, user, id) {
  await env.DB.prepare(`DELETE FROM snaps WHERE id = ? AND user_id = ?`).bind(id, user.id).run();
  return ok({ deleted: true });
}

// ---------------------------------------------------------------- read-aloud voice (Google Gemini TTS)
function pcmToWav(pcm, rate) {
  const h = new ArrayBuffer(44); const v = new DataView(h);
  const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); v.setUint32(4, 36 + pcm.length, true); w(8, 'WAVE'); w(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  w(36, 'data'); v.setUint32(40, pcm.length, true);
  const out = new Uint8Array(44 + pcm.length); out.set(new Uint8Array(h), 0); out.set(pcm, 44); return out;
}
// Streamed voice: sends raw 16-bit PCM pieces as soon as Google makes them, so playback starts sooner.
async function ttsStream(env, req, ctx) {
  if (!env.GEMINI_API_KEY) return fail('Voice is not configured.', 500);
  const b = await readJson(req);
  const text = String(b.text || '').replace(/\s+/g, ' ').trim().slice(0, 700);
  if (!text) return fail('Nothing to read.');
  const voice = env.TTS_VOICE || 'Sulafat';
  const cacheKey = new Request('https://sbec-tts.cache/' + await sha256(voice + '|' + text));
  const cache = caches.default;
  const hit = await cache.match(cacheKey);
  if (hit) return hit;
  if (!(await takeQuota(env, 'tts:' + clientIp(req), parseInt(env.TTS_DAILY || '800')))) return fail('Voice limit reached for today.', 429);
  const base = env.GEMINI_BASE || GEMINI_BASE;
  const models = [...new Set([env.TTS_MODEL, 'gemini-3.8-flash-lite-tts', 'gemini-3.8-flash-tts', 'gemini-3.1-flash-tts-preview', 'gemini-2.5-flash-preview-tts'].filter(Boolean))];
  const body = { contents: [{ parts: [{ text }] }], generationConfig: { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } } } };
  let lastStatus = 0;
  for (const model of models) {
    const ac = new AbortController(); const tm = setTimeout(() => ac.abort(), 12000);
    let r;
    try { r = await fetch(`${base}${encodeURIComponent(model)}:streamGenerateContent?alt=sse`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': env.GEMINI_API_KEY }, body: JSON.stringify(body), signal: ac.signal }); }
    catch (e) { clearTimeout(tm); lastStatus = 504; continue; }
    if (!r.ok || !r.body) { clearTimeout(tm); lastStatus = r.status; try { await r.text(); } catch (e) {} if ([400, 404, 429, 500, 502, 503, 504].includes(r.status)) continue; break; }
    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();
    const t0 = Date.now();
    const pump = (async () => {
      const reader = r.body.getReader(); const dec = new TextDecoder();
      let buf = '', all = [], total = 0, first = 0;
      try {
        for (;;) {
          const { value, done } = await reader.read(); if (done) break;
          buf += dec.decode(value, { stream: true });
          let i;
          while ((i = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
            if (!line.startsWith('data:')) continue;
            let j; try { j = JSON.parse(line.slice(5)); } catch (e) { continue; }
            for (const p of (j.candidates?.[0]?.content?.parts || [])) {
              const inl = p.inlineData || p.inline_data; if (!inl || !inl.data) continue;
              const bin = atob(inl.data); const u = new Uint8Array(bin.length);
              for (let k = 0; k < bin.length; k++) u[k] = bin.charCodeAt(k);
              if (!first) first = Date.now() - t0;
              all.push(u); total += u.length; await writer.write(u);
            }
          }
        }
        if (total > 0) {
          const pcm = new Uint8Array(total); let o = 0; for (const u of all) { pcm.set(u, o); o += u.length; }
          await cache.put(cacheKey, new Response(pcmToWav(pcm, 24000), { headers: { 'content-type': 'audio/wav', 'cache-control': 'public, max-age=2592000', 'x-tts-model': model } }));
        }
        console.log('tts stream', model, 'first', first, 'ms total', total);
      } catch (e) { console.log('tts stream error', String(e)); }
      finally { clearTimeout(tm); try { await writer.close(); } catch (e) {} }
    })();
    ctx.waitUntil(pump);
    return new Response(readable, { headers: { 'content-type': 'audio/L16;rate=24000', 'cache-control': 'no-store', 'x-tts-model': model } });
  }
  return fail('Voice is busy right now. [' + lastStatus + ']', 502);
}

async function tts(env, req, ctx) {
  if (!env.GEMINI_API_KEY) return fail('Voice is not configured.', 500);
  const b = await readJson(req);
  const text = String(b.text || '').replace(/\s+/g, ' ').trim().slice(0, 700);
  if (!text) return fail('Nothing to read.');
  const voice = env.TTS_VOICE || 'Sulafat';
  // Same sentence read again? Serve it from Cloudflare's cache instantly.
  const cacheKey = new Request('https://sbec-tts.cache/' + await sha256(voice + '|' + text));
  const cache = caches.default;
  const hit = await cache.match(cacheKey);
  if (hit) return hit;
  if (!(await takeQuota(env, 'tts:' + clientIp(req), parseInt(env.TTS_DAILY || '800')))) return fail('Voice limit reached for today.', 429);
  const base = env.GEMINI_BASE || GEMINI_BASE;
  const models = [...new Set([env.TTS_MODEL, 'gemini-3.8-flash-lite-tts', 'gemini-3.8-flash-tts', 'gemini-3.1-flash-tts-preview', 'gemini-2.5-flash-preview-tts'].filter(Boolean))];
  const body = { contents: [{ parts: [{ text }] }], generationConfig: { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } } } };
  let lastStatus = 0, lastMsg = '';
  for (const model of models) {
    const ac = new AbortController(); const tm = setTimeout(() => ac.abort(), 15000);
    let r;
    try { r = await fetch(`${base}${encodeURIComponent(model)}:generateContent`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': env.GEMINI_API_KEY }, body: JSON.stringify(body), signal: ac.signal }); }
    catch (e) { lastStatus = 504; lastMsg = 'timeout'; continue; }
    finally { clearTimeout(tm); }
    if (!r.ok) { lastStatus = r.status; lastMsg = (await r.text()).slice(0, 200); if ([400, 404, 429, 500, 502, 503, 504].includes(r.status)) continue; break; }
    const j = await r.json();
    const part = (j.candidates?.[0]?.content?.parts || []).find(p => p.inlineData || p.inline_data);
    const inl = part && (part.inlineData || part.inline_data);
    if (!inl || !inl.data) { lastStatus = 502; lastMsg = 'no audio'; continue; }
    const rate = parseInt((/rate=(\d+)/.exec(inl.mimeType || inl.mime_type || '') || [])[1] || '24000');
    const bin = atob(inl.data); const pcm = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) pcm[i] = bin.charCodeAt(i);
    const res = new Response(pcmToWav(pcm, rate), { headers: { 'content-type': 'audio/wav', 'cache-control': 'public, max-age=2592000', 'x-tts-model': model } });
    ctx.waitUntil(cache.put(cacheKey, res.clone()));
    return res;
  }
  console.log('tts failed', lastStatus, lastMsg);
  return fail('Voice is busy right now. [' + lastStatus + ']', 502);
}

// ---------------------------------------------------------------- entry
export async function onRequest(ctx) {
  const req = ctx.request;
  // The D1 database binding is called SBEC_DB (DB is kept as a fallback name).
  const env = Object.assign({}, ctx.env, ctx.env.SBEC_DB ? { DB: ctx.env.SBEC_DB } : {});
  const url = new URL(req.url);
  const path = url.pathname.replace(/^\/api\/?/, '').replace(/\/+$/, '');
  const method = req.method.toUpperCase();
  if (method === 'OPTIONS') return new Response(null, { status: 204 });
  if (path === 'health' && url.searchParams.get('ai') === '1') {
    // AI self-test: tries the configured model with a tiny prompt and lists available Flash models.
    const out = { model: env.GEMINI_MODEL || 'gemini-flash-latest', tests: [] };
    const base = env.GEMINI_BASE || GEMINI_BASE;
    const tryCall = async (label, body) => {
      const t0 = Date.now(); const ac = new AbortController(); const tm = setTimeout(() => ac.abort(), 25000);
      try {
        const r = await fetch(`${base}${encodeURIComponent(out.model)}:generateContent`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': env.GEMINI_API_KEY }, body: JSON.stringify(body), signal: ac.signal });
        const t = await r.text(); let msg = '';
        try { const j = JSON.parse(t); msg = j.error ? j.error.message : (j.candidates?.[0]?.content?.parts || []).filter(p => !p.thought).map(p => p.text).join('').slice(0, 80); } catch { msg = t.slice(0, 120); }
        out.tests.push({ label, status: r.status, ms: Date.now() - t0, msg: String(msg).slice(0, 200) });
      } catch (e) { out.tests.push({ label, status: 'timeout/error', ms: Date.now() - t0, msg: String(e && e.message || e) }); }
      finally { clearTimeout(tm); }
    };
    const hi = [{ role: 'user', parts: [{ text: 'Say hi in 3 words.' }] }];
    const which = (url.searchParams.get('t') || 'plain,low,max,sys,schema,stream').split(',');
    if (which.includes('plain')) await tryCall('plain', { contents: hi });
    if (which.includes('low')) await tryCall('thinking-low', { contents: hi, generationConfig: { thinkingConfig: { thinkingLevel: 'low' } } });
    if (which.includes('max')) await tryCall('maxTokens', { contents: hi, generationConfig: { maxOutputTokens: 2048, thinkingConfig: { thinkingLevel: 'low' } } });
    if (which.includes('sys')) await tryCall('system', { system_instruction: { parts: [{ text: systemPrompt('kid') }] }, contents: hi, generationConfig: { thinkingConfig: { thinkingLevel: 'low' } } });
    if (which.includes('schema')) await tryCall('schema', { contents: hi, generationConfig: { thinkingConfig: { thinkingLevel: 'low' }, responseMimeType: 'application/json', responseSchema: { type: 'OBJECT', properties: { reply: { type: 'STRING' } }, required: ['reply'] } } });
    if (which.includes('stream')) {
      const t0 = Date.now(); const ac = new AbortController(); const tm = setTimeout(() => ac.abort(), 25000);
      try {
        const r = await fetch(`${base}${encodeURIComponent(out.model)}:streamGenerateContent?alt=sse`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': env.GEMINI_API_KEY }, body: JSON.stringify({ contents: hi, generationConfig: { thinkingConfig: { thinkingLevel: 'low' } } }), signal: ac.signal });
        const headersMs = Date.now() - t0;
        const rd = r.body.getReader(); const first = await rd.read(); const firstMs = Date.now() - t0;
        let txt = new TextDecoder().decode(first.value || new Uint8Array());
        try { await rd.cancel(); } catch {}
        out.tests.push({ label: 'stream', status: r.status, headersMs, firstMs, msg: txt.slice(0, 160) });
      } catch (e) { out.tests.push({ label: 'stream', status: 'timeout/error', ms: Date.now() - t0, msg: String(e && e.message || e) }); }
      finally { clearTimeout(tm); }
    }
    try {
      const r = await fetch('https://generativelanguage.googleapis.com/v1beta/models?pageSize=200', { headers: { 'x-goog-api-key': env.GEMINI_API_KEY } });
      const j = await r.json(); out.listStatus = r.status;
      out.flashModels = (j.models || []).map(m => m.name.replace('models/', '')).filter(n => /flash/.test(n)).slice(0, 40);
      if (j.error) out.listError = j.error.message;
    } catch (e) { out.listError = String(e); }
    return ok(out);
  }
  if (path === 'health') {
    const db = env.DB && typeof env.DB.prepare === 'function';
    let dbOk = false, dbError = null;
    if (db) { try { await ensureSchema(env.DB); dbOk = true; } catch (e) { dbError = String(e && e.message || e); } }
    return ok({ ok: dbOk && !!env.GEMINI_API_KEY, ai: !!env.GEMINI_API_KEY, email: !!(env.BREVO_API_KEY && env.EMAIL_FROM),
      database: db ? (dbOk ? 'connected' : 'error') : (env.DB ? 'DB is set as a text variable — it must be a D1 binding' : 'missing — add a D1 binding named DB'),
      dbError });
  }
  if (!env.DB) return fail('Database is not connected (add a D1 binding named DB).', 500);
  if (typeof env.DB.prepare !== 'function') return fail('DB must be a D1 database binding (Settings > Bindings), not a text variable.', 500);

  try {
    await ensureSchema(env.DB);
    if (path === 'explain' && method === 'POST') return await explain(env, req, ctx);
    if (path === 'quiz' && method === 'POST') return await quiz(env, req);
    if (path === 'tts' && method === 'POST') return await tts(env, req, ctx);
    if (path === 'tts-stream' && method === 'POST') return await ttsStream(env, req, ctx);
    if (path === 'auth/start' && method === 'POST') return await authStart(env, req);
    if (path === 'auth/verify' && method === 'POST') return await authVerify(env, req);
    if (path === 'auth/logout' && method === 'POST') return await logout(env, req);

    const user = await currentUser(env, req);
    if (path === 'me') return ok({ user: user ? { email: user.email } : null });
    if (!user) return fail('Please sign in to use your saved lessons.', 401);
    if (path === 'snaps' && method === 'GET') return await listSnaps(env, user);
    if (path === 'snaps' && method === 'POST') return await saveSnap(env, req, user);
    const m = /^snaps\/([a-zA-Z0-9-]{8,64})$/.exec(path);
    if (m && method === 'GET') return await getSnap(env, user, m[1]);
    if (m && method === 'DELETE') return await deleteSnap(env, user, m[1]);
    return fail('Not found.', 404);
  } catch (e) {
    console.log('api error', path, e && e.stack || e);
    return fail('Something went wrong: ' + String(e && e.message || e).slice(0, 200), 500);
  }
}
