// SBEC AI — offline voice worker. Runs the "Heart" voice (Kokoro-82M) on the learner's own phone.
// The voice files live in this app (/voice/kokoro/), split into pieces under 20 MB.
// They download once (about 90 MB), get checked, and are kept on the phone for offline use.
import { KokoroTTS } from './vendor/kokoro.web.js';

const MODEL_ID = 'onnx-community/Kokoro-82M-v1.0-ONNX';
const VOICE = 'af_heart';
const HF = 'https://huggingface.co/' + MODEL_ID + '/resolve/main/';
const LOCAL = '/voice/kokoro/';
const MODEL_URL = HF + 'onnx/model_quantized.onnx';
let tts = null;
let loading = null;
const queue = [];
let busy = false;
let allowDownload = false;

async function sha256(buf) {
  const h = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Put our own copy of the voice into the caches the voice engine reads from,
// so it never needs to go to the internet for it.
async function prefill() {
  const tc = await caches.open('transformers-cache');
  const vc = await caches.open('kokoro-voices');
  const have = (await tc.match(MODEL_URL)) && (await tc.match(HF + 'config.json')) && (await tc.match(HF + 'tokenizer.json')) &&
    (await tc.match(HF + 'tokenizer_config.json')) && (await vc.match(HF + 'voices/' + VOICE + '.bin'));
  if (have) return;
  if (!allowDownload) throw new Error('missing');
  const man = await (await fetch(LOCAL + 'manifest.json', { cache: 'no-cache' })).json();
  const total = man.size + 600000;
  let done = 0;
  const report = () => postMessage({ type: 'progress', pct: Math.min(99, Math.round((done / total) * 100)) });
  for (const f of ['config.json', 'tokenizer.json', 'tokenizer_config.json']) {
    const r = await fetch(LOCAL + f); if (!r.ok) throw new Error('voice file ' + f);
    await tc.put(HF + f, new Response(await r.blob(), { headers: { 'content-type': 'application/json' } }));
  }
  const vr = await fetch(LOCAL + VOICE + '.bin'); if (!vr.ok) throw new Error('voice file');
  await vc.put(HF + 'voices/' + VOICE + '.bin', new Response(await vr.arrayBuffer(), { headers: { 'content-type': 'application/octet-stream' } }));
  if (await tc.match(MODEL_URL)) return;
  const blobs = [];
  for (const p of man.parts) {
    let buf = null;
    for (let attempt = 0; attempt < 3 && !buf; attempt++) {
      try {
        const r = await fetch(LOCAL + p.file);
        if (!r.ok) throw new Error('piece ' + r.status);
        const rd = r.body.getReader(); const chunks = []; let got = 0;
        for (;;) {
          const { value, done: end } = await rd.read(); if (end) break;
          chunks.push(value); got += value.length; done += value.length; report();
        }
        const b = new Uint8Array(got); let o = 0; for (const c of chunks) { b.set(c, o); o += c.length; }
        if (got !== p.size || (await sha256(b)) !== p.sha256) { done -= got; throw new Error('piece check failed'); }
        buf = b;
      } catch (e) { if (attempt === 2) throw e; }
    }
    blobs.push(new Blob([buf]));
  }
  const model = new Blob(blobs, { type: 'application/octet-stream' });
  if (model.size !== man.size) throw new Error('voice size mismatch');
  await tc.put(MODEL_URL, new Response(model, { headers: { 'content-type': 'application/octet-stream', 'content-length': String(model.size) } }));
}

function load() {
  if (loading) return loading;
  loading = (async () => {
    await prefill();
    postMessage({ type: 'progress', pct: 100 });
    postMessage({ type: 'preparing' });
    tts = await KokoroTTS.from_pretrained(MODEL_ID, { dtype: 'q8', device: 'wasm' });
    // Warm up once and measure how fast this phone makes speech.
    const t0 = performance.now();
    const a = await tts.generate('Hello, I am ready.', { voice: VOICE });
    const secs = (a.audio.length / (a.sampling_rate || 24000));
    postMessage({ type: 'ready', speed: secs / ((performance.now() - t0) / 1000) });
    return tts;
  })().catch((e) => { loading = null; postMessage({ type: 'error', message: String(e && e.message || e) }); throw e; });
  return loading;
}

async function pump() {
  if (busy) return;
  busy = true;
  try {
    while (queue.length) {
      const job = queue.shift();
      try {
        await load();
        const audio = await tts.generate(job.text, { voice: VOICE, speed: job.speed || 1 });
        const samples = audio.audio instanceof Float32Array ? audio.audio : new Float32Array(audio.audio);
        postMessage({ type: 'audio', id: job.id, samples, sr: audio.sampling_rate || 24000 }, [samples.buffer]);
      } catch (e) {
        postMessage({ type: 'fail', id: job.id, message: String(e && e.message || e) });
      }
    }
  } finally { busy = false; }
}

self.onmessage = (ev) => {
  const m = ev.data || {};
  if (m.type === 'load') { allowDownload = !!m.download; load().catch(() => {}); return; }
  if (m.type === 'clear') { queue.length = 0; return; }
  if (m.type === 'speak') { queue.push(m); pump(); }
};
