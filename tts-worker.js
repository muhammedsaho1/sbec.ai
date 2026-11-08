// SBEC AI — voice worker. Runs the Kokoro "Heart" voice on the learner's own device.
// The model (~90 MB) downloads once, then the browser keeps it for next time.
import { KokoroTTS } from './vendor/kokoro.web.js';

const MODEL_ID = 'onnx-community/Kokoro-82M-v1.0-ONNX';
const VOICE = 'af_heart';
let tts = null;
let loading = null;
const queue = [];
let busy = false;

function load() {
  if (loading) return loading;
  const files = {};
  loading = KokoroTTS.from_pretrained(MODEL_ID, {
    dtype: 'q8',
    device: 'wasm',
    progress_callback: (p) => {
      if (p && p.status === 'progress' && p.file) {
        files[p.file] = { loaded: p.loaded || 0, total: p.total || 0 };
        let l = 0, t = 0;
        for (const f of Object.values(files)) { l += f.loaded; t += f.total; }
        if (t > 0) postMessage({ type: 'progress', pct: Math.min(99, Math.round((l / t) * 100)) });
      }
    },
  }).then((m) => { tts = m; postMessage({ type: 'ready' }); return m; })
    .catch((e) => { loading = null; postMessage({ type: 'error', message: String(e && e.message || e) }); throw e; });
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
        postMessage({ type: 'audio', id: job.id, gen: job.gen, samples, sr: audio.sampling_rate || 24000 }, [samples.buffer]);
      } catch (e) {
        postMessage({ type: 'fail', id: job.id, gen: job.gen, message: String(e && e.message || e) });
      }
    }
  } finally { busy = false; }
}

self.onmessage = (ev) => {
  const m = ev.data || {};
  if (m.type === 'load') { load().catch(() => {}); return; }
  if (m.type === 'clear') { queue.length = 0; return; }
  if (m.type === 'speak') { queue.push(m); pump(); }
};
