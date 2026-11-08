// SBEC Voice — our own read-aloud engine. Runs fully on the learner's phone:
// no server, no limits, works offline. Voice: Piper (VITS), about 60 MB, downloaded once.
import * as ort from './vendor/ort/ort.wasm.min.mjs';
import { phonemize } from './vendor/phonemizer.js';

const BASE = '/voice/sbec/';
const MODEL_KEY = BASE + 'model.onnx'; // where the joined model is kept on the phone
const CACHE = 'sbec-voice';
ort.env.wasm.wasmPaths = '/vendor/ort/';
ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 2) - 1)) : 1;

let session = null, cfg = null, loading = null, allowDownload = false;
const queue = []; let busy = false;

async function sha256(buf) {
  const h = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Get the voice onto the phone (once), checking every piece.
async function getModel() {
  const c = await caches.open(CACHE);
  let hit = await c.match(MODEL_KEY), conf = await c.match(BASE + 'voice.json');
  if (hit && conf) return { model: await hit.arrayBuffer(), conf: await conf.json() };
  if (!allowDownload) throw new Error('missing');
  const man = await (await fetch(BASE + 'manifest.json', { cache: 'no-cache' })).json();
  const cr = await fetch(BASE + 'voice.json', { cache: 'no-cache' }); if (!cr.ok) throw new Error('voice settings');
  const confText = await cr.text();
  const total = man.size; let done = 0;
  const report = () => postMessage({ type: 'progress', pct: Math.min(99, Math.round((done / total) * 100)) });
  const out = new Uint8Array(man.size); let off = 0;
  for (const p of man.parts) {
    let ok = false;
    for (let attempt = 0; attempt < 3 && !ok; attempt++) {
      const start = off, before = done;
      try {
        const r = await fetch(BASE + p.file);
        if (!r.ok) throw new Error('piece ' + r.status);
        const rd = r.body.getReader(); let got = 0;
        for (;;) {
          const { value, done: end } = await rd.read(); if (end) break;
          if (got + value.length > p.size) throw new Error('piece too big');
          out.set(value, start + got); got += value.length; done += value.length; report();
        }
        if (got !== p.size || (await sha256(out.subarray(start, start + got))) !== p.sha256) throw new Error('piece check failed');
        off = start + got; ok = true;
      } catch (e) { done = before; off = start; if (attempt === 2) throw e; }
    }
  }
  await c.put(BASE + 'voice.json', new Response(confText, { headers: { 'content-type': 'application/json' } }));
  await c.put(MODEL_KEY, new Response(out, { headers: { 'content-type': 'application/octet-stream' } }));
  return { model: out.buffer, conf: JSON.parse(confText) };
}

// Text -> sound codes the voice understands.
async function toIds(text) {
  const map = cfg.phoneme_id_map, lang = (cfg.espeak && cfg.espeak.voice) || 'en-us';
  const parts = text.match(/[^.,;:!?]+[.,;:!?]*/g) || [text];
  let ph = '';
  for (const part of parts) {
    const m = /([.,;:!?]*)\s*$/.exec(part); const punct = m ? m[1] : '';
    const words = part.slice(0, part.length - (m ? m[0].length : 0)).trim();
    if (!words) { ph = ph.trimEnd() + punct + ' '; continue; }
    const p = (await phonemize(words, lang)).join(' ');
    ph += p + punct + ' ';
  }
  ph = ph.trim();
  const ids = [...map['^'], ...map['_']];
  for (const ch of ph) { const v = map[ch]; if (v) ids.push(...v, ...map['_']); }
  ids.push(...map['$']);
  return ids;
}

async function synth(text, speed) {
  const ids = await toIds(text);
  const inf = cfg.inference || {};
  const feeds = {
    input: new ort.Tensor('int64', BigInt64Array.from(ids.map(BigInt)), [1, ids.length]),
    input_lengths: new ort.Tensor('int64', BigInt64Array.from([BigInt(ids.length)]), [1]),
    scales: new ort.Tensor('float32', Float32Array.from([inf.noise_scale ?? 0.667, (inf.length_scale ?? 1) / (speed || 1), inf.noise_w ?? 0.8]), [3]),
  };
  if (cfg.num_speakers > 1) feeds.sid = new ort.Tensor('int64', BigInt64Array.from([0n]), [1]);
  const r = await session.run(feeds);
  const a = new Float32Array(r.output.data);
  // Even, clear volume (like Piper does).
  let peak = 0; for (let i = 0; i < a.length; i++) { const v = Math.abs(a[i]); if (v > peak) peak = v; }
  const g = Math.min(4, 0.9 / Math.max(peak, 0.01)); for (let i = 0; i < a.length; i++) a[i] *= g;
  return a;
}

function load() {
  if (loading) return loading;
  loading = (async () => {
    const { model, conf } = await getModel();
    cfg = conf;
    postMessage({ type: 'progress', pct: 100 });
    postMessage({ type: 'preparing' });
    session = await ort.InferenceSession.create(model, { executionProviders: ['wasm'], graphOptimizationLevel: 'all' });
    const t0 = performance.now();
    const a = await synth('Hello, I am ready to read for you.');
    const secs = a.length / cfg.audio.sample_rate;
    postMessage({ type: 'ready', speed: secs / ((performance.now() - t0) / 1000) });
  })().catch((e) => { loading = null; postMessage({ type: 'error', message: String(e && e.message || e) }); throw e; });
  return loading;
}

async function pump() {
  if (busy) return; busy = true;
  try {
    while (queue.length) {
      const job = queue.shift();
      try {
        await load();
        const samples = await synth(job.text, job.speed);
        postMessage({ type: 'audio', id: job.id, samples, sr: cfg.audio.sample_rate }, [samples.buffer]);
      } catch (e) { postMessage({ type: 'fail', id: job.id, message: String(e && e.message || e) }); }
    }
  } finally { busy = false; }
}

self.onmessage = (ev) => {
  const m = ev.data || {};
  if (m.type === 'load') { allowDownload = allowDownload || !!m.download; load().catch(() => {}); return; }
  if (m.type === 'clear') { queue.length = 0; return; }
  if (m.type === 'speak') { queue.push(m); pump(); }
};
