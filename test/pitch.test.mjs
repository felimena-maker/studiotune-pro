import { shift } from '../src/pitch.entry.mjs';
const sr = 44100, secs = 4, n = sr * secs;
const L = new Float32Array(n), R = new Float32Array(n);
for (let i = 0; i < n; i++) { const v = 0.4 * Math.sin(2 * Math.PI * 440 * i / sr); L[i] = v; R[i] = v; }
function freqOf(x, from, to) { // cruces por cero ascendentes
  let c = 0, first = -1, last = -1;
  for (let i = from + 1; i < to; i++) if (x[i - 1] < 0 && x[i] >= 0) { c++; if (first < 0) first = i; last = i; }
  return (c - 1) * sr / (last - first);
}
for (const st of [2, -3, 0]) {
  const t0 = Date.now();
  const r = await shift([L, R], sr, st);
  const ms = Date.now() - t0;
  const f = freqOf(r.left, Math.floor(sr * 1), Math.floor(sr * 3));
  const want = 440 * Math.pow(2, st / 12);
  console.log(`${String(st).padStart(2)} semitonos: esperado ${want.toFixed(1)} Hz, obtenido ${f.toFixed(1)} Hz | duración ${(r.frames / sr).toFixed(2)} s (entrada ${secs}) | ${ms} ms para ${secs} s (${(secs * 1000 / ms).toFixed(1)}× tiempo real)`);
}
