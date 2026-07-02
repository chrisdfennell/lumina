// Monocular depth estimation for the 2.5D wallpaper: turns any photo into a
// depth map with MiDaS v2.1 small (ONNX). The ~64 MB model is downloaded on
// first use into userData/models and cached; inference runs on CPU via
// onnxruntime-node and takes well under a second at the model's 256×256 input.
//
// The control renderer does the image decode/resize/normalization (it has a
// canvas) and sends a CHW float tensor over IPC; this module runs the model and
// returns a 256×256 grayscale depth map (255 = near, matching the depth
// shader's white-is-near convention — MiDaS outputs inverse depth, so its
// largest values are the nearest pixels).

const path = require('path');
const fs = require('fs');
const { app } = require('electron');

const MODEL_URL = 'https://github.com/isl-org/MiDaS/releases/download/v2_1/model-small.onnx';
const MODEL_BYTES = 66764249; // release asset size — doubles as a corruption check
const SIZE = 256; // model input/output resolution

const modelPath = () => path.join(app.getPath('userData'), 'models', 'midas-small.onnx');
const modelReady = () => {
  try { return fs.statSync(modelPath()).size === MODEL_BYTES; } catch { return false; }
};

let downloadPromise = null;
async function ensureModel(onProgress) {
  if (modelReady()) return modelPath();
  if (downloadPromise) return downloadPromise;
  downloadPromise = (async () => {
    fs.mkdirSync(path.dirname(modelPath()), { recursive: true });
    const res = await fetch(MODEL_URL);
    if (!res.ok) throw new Error(`model download failed: HTTP ${res.status}`);
    const total = +res.headers.get('content-length') || MODEL_BYTES;
    const tmp = modelPath() + '.part';
    const out = fs.createWriteStream(tmp);
    let got = 0, lastPct = -1;
    for await (const chunk of res.body) {
      out.write(Buffer.from(chunk));
      got += chunk.length;
      const pct = Math.floor((got / total) * 100);
      if (pct !== lastPct && onProgress) { lastPct = pct; onProgress(pct); }
    }
    await new Promise((resolve, reject) => out.end((err) => (err ? reject(err) : resolve())));
    if (!fs.statSync(tmp).size) throw new Error('model download was empty');
    fs.renameSync(tmp, modelPath());
    return modelPath();
  })().finally(() => { downloadPromise = null; });
  return downloadPromise;
}

// onnxruntime-node is a large native module — loaded lazily so app startup
// never pays for it unless depth generation is actually used.
let ort = null;
let sessionPromise = null;
function getSession(onProgress) {
  if (!ort) ort = require('onnxruntime-node');
  if (!sessionPromise) {
    sessionPromise = ensureModel(onProgress).then((p) => ort.InferenceSession.create(p));
    sessionPromise.catch(() => { sessionPromise = null; }); // allow retry after a failure
  }
  return sessionPromise;
}

/**
 * @param {Float32Array} chw normalized CHW input, length 3*SIZE*SIZE
 * @param {(pct:number)=>void} [onDownloadProgress] model-download progress (first use only)
 * @returns {Promise<Uint8ClampedArray>} SIZE×SIZE grayscale depth, 255 = near
 */
async function estimateDepth(chw, onDownloadProgress) {
  if (!(chw instanceof Float32Array) || chw.length !== 3 * SIZE * SIZE) {
    throw new Error('bad tensor input');
  }
  const session = await getSession(onDownloadProgress);
  const input = new ort.Tensor('float32', chw, [1, 3, SIZE, SIZE]);
  const results = await session.run({ [session.inputNames[0]]: input });
  const data = results[session.outputNames[0]].data;
  let min = Infinity, max = -Infinity;
  for (let i = 0; i < data.length; i++) {
    if (data[i] < min) min = data[i];
    if (data[i] > max) max = data[i];
  }
  const range = max - min || 1;
  const gray = new Uint8ClampedArray(SIZE * SIZE);
  for (let i = 0; i < gray.length; i++) gray[i] = Math.round(((data[i] - min) / range) * 255);
  return gray;
}

module.exports = { estimateDepth, modelReady, SIZE };
