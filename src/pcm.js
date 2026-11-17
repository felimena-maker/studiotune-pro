/**
 * PcmAnalyzer — convierte una grabación PCM completa en la lista de "frames" que consume ChordEngine.decode.
 * Funciona en el navegador y en Node (para pruebas).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./chords.js'));
  else root.PcmAnalyzer = factory(root.ChordEngine);
})(typeof self !== 'undefined' ? self : this, function (CE) {
  'use strict';

  function makeFFT(n) {
    const levels = Math.log2(n) | 0;
    const rev = new Uint32Array(n);
    for (let i = 0; i < n; i++) { let r = 0; for (let b = 0; b < levels; b++) r |= ((i >> b) & 1) << (levels - 1 - b); rev[i] = r; }
    const cos = new Float32Array(n / 2), sin = new Float32Array(n / 2);
    for (let i = 0; i < n / 2; i++) { cos[i] = Math.cos(2 * Math.PI * i / n); sin[i] = -Math.sin(2 * Math.PI * i / n); }
    return function (re, im) {
      for (let i = 0; i < n; i++) { const j = rev[i]; if (j > i) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; } }
      for (let size = 2; size <= n; size <<= 1) {
        const half = size >> 1, step = n / size;
        for (let i = 0; i < n; i += size) {
          for (let j = i, k = 0; j < i + half; j++, k += step) {
            const l = j + half;
            const tr = re[l] * cos[k] - im[l] * sin[k], ti = re[l] * sin[k] + im[l] * cos[k];
            re[l] = re[j] - tr; im[l] = im[j] - ti; re[j] += tr; im[j] += ti;
          }
        }
      }
    };
  }

  const _cache = {};
  function getFFT(n) {
    if (!_cache[n]) {
      const win = new Float32Array(n);
      for (let i = 0; i < n; i++) win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (n - 1));
      _cache[n] = { fft: makeFFT(n), win, re: new Float32Array(n), im: new Float32Array(n), mag: new Float32Array(n / 2) };
    }
    return _cache[n];
  }

  /** Int16 little-endian (ArrayBuffer o Int16Array) → Float32Array en -1..1 */
  function toFloat(pcm) {
    const i16 = pcm instanceof Int16Array ? pcm : new Int16Array(pcm.buffer || pcm, pcm.byteOffset || 0, ((pcm.byteLength || pcm.length * 2) >> 1));
    const out = new Float32Array(i16.length);
    for (let i = 0; i < i16.length; i++) out[i] = i16[i] / 32768;
    return out;
  }

  /** Analiza una ventana de N muestras → { peaks, rms } */
  function analyzeWindow(x, start, sr, n) {
    const c = getFFT(n);
    let sum = 0;
    for (let i = 0; i < n; i++) { const v = x[start + i]; sum += v * v; c.re[i] = v * c.win[i]; c.im[i] = 0; }
    c.fft(c.re, c.im);
    for (let k = 0; k < n / 2; k++) c.mag[k] = Math.hypot(c.re[k], c.im[k]);
    return { peaks: CE.extractPeaks(c.mag, sr, n), rms: Math.sqrt(sum / n) };
  }

  function frameSize(sr) { return sr >= 30000 ? 16384 : 8192; }

  /**
   * Procesa toda la grabación. Asíncrono para no bloquear la interfaz; onProgress(0..1).
   * o.silence: umbral de RMS por debajo del cual el frame se considera silencio.
   */
  async function analyze(x, sr, o, onProgress) {
    o = o || {};
    const n = frameSize(sr), hop = Math.round((o.hop || 0.2) * sr), thr = o.silence != null ? o.silence : 0.003;
    const frames = [];
    let count = 0;
    const total = Math.max(1, Math.floor((x.length - n) / hop) + 1);
    for (let pos = 0; pos + n <= x.length; pos += hop) {
      const r = analyzeWindow(x, pos, sr, n);
      frames.push({ t: (pos + n / 2) / sr, peaks: r.peaks, silent: r.rms < thr, rms: r.rms });
      if (++count % 25 === 0) {
        if (onProgress) onProgress(count / total);
        await new Promise((res) => setTimeout(res, 0));
      }
    }
    if (onProgress) onProgress(1);
    return frames;
  }

  /** Instante (s) en que empieza el sonido: primeros 5 bloques de 20 ms seguidos con RMS > thr. null si no hay. */
  function findOnset(x, sr, thr) {
    thr = thr || 0.003;
    const blk = Math.round(sr * 0.02); let run = 0, first = -1;
    for (let b = 0; (b + 1) * blk <= x.length; b++) {
      let s = 0; for (let i = b * blk; i < (b + 1) * blk; i++) s += x[i] * x[i];
      if (Math.sqrt(s / blk) > thr) { if (run === 0) first = b; if (++run >= 5) return first * blk / sr; }
      else run = 0;
    }
    return null;
  }

  /** Base64 de PCM16 little-endian → Float32Array */
  function base64ToFloat(b64) {
    const bin = atob(b64), n = bin.length >> 1, out = new Float32Array(n);
    for (let i = 0; i < n; i++) { let v = bin.charCodeAt(2 * i) | (bin.charCodeAt(2 * i + 1) << 8); if (v & 0x8000) v -= 0x10000; out[i] = v / 32768; }
    return out;
  }

  return { analyze, analyzeWindow, findOnset, toFloat, base64ToFloat, frameSize };
});
