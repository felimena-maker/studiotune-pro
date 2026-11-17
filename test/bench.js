/**
 * Banco de pruebas de reconocimiento de acordes con "canciones" sintéticas difíciles.
 * Uso: node test/bench.js [--quiet]
 * Escenarios: clean | speaker (voz+batería+sin graves+afinación desviada) | mix (voz+batería+graves+séptimas)
 */
const CE = require('../src/chords.js');
const SR = 22050, N = 8192, HOP = 0.2;

// ---- utilidades
function rng(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }
function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) { let bit = n >> 1; for (; j & bit; bit >>= 1) j ^= bit; j ^= bit; if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; } }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len, wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) { let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k, b = i + k + len / 2;
        const tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
        const ncr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = ncr; } } }
}
const midiF = (m, cents) => 440 * Math.pow(2, (m - 69 + (cents || 0) / 100) / 12);
const IV = { maj: [0, 4, 7], min: [0, 3, 7], '7': [0, 4, 7, 10], maj7: [0, 4, 7, 11], m7: [0, 3, 7, 10] };
const FAMILY = { maj: 'M', '7': 'M', maj7: 'M', min: 'm', m7: 'm' };

// ---- generador de canciones
function makeSong(seed, sevenths) {
  const r = rng(seed), key = Math.floor(r() * 12);
  const degs = [[0, 'maj', 'maj7'], [2, 'min', 'm7'], [4, 'min', 'm7'], [5, 'maj', 'maj7'], [7, 'maj', '7'], [9, 'min', 'm7']];
  const chords = []; let t = 0;
  for (let i = 0; i < 12; i++) {
    const d = degs[Math.floor(r() * degs.length)];
    const type = sevenths && r() < 0.5 ? d[2] : d[1];
    const dur = 2 + Math.floor(r() * 5) * 0.5;
    chords.push({ root: (key + d[0]) % 12, type, t0: t, t1: t + dur }); t += dur;
  }
  // evitar repetir el mismo acorde dos veces seguidas
  for (let i = 1; i < chords.length; i++) if (chords[i].root === chords[i - 1].root && chords[i].type === chords[i - 1].type) chords[i].root = (chords[i].root + 7) % 12;
  return { chords, dur: t, key };
}
function synth(song, sc, seed) {
  const r = rng(seed + 99), len = Math.floor(song.dur * SR), x = new Float32Array(len);
  const cents = sc.detune || 0;
  song.chords.forEach((c) => {
    const base = 40 + ((c.root - 4 + 12) % 12);
    const notes = [base, ...IV[c.type].slice(1).map((i) => base + 12 + i), base + 24];
    if (sc.noBass) notes.length && (notes[0] = notes[0] + 12); // el altavoz del móvil no reproduce los graves: sube el bajo una octava
    for (let i = Math.floor(c.t0 * SR); i < Math.min(len, Math.floor(c.t1 * SR)); i++) {
      const t = i / SR; let v = 0;
      notes.forEach((m, ni) => {
        const f = midiF(m, cents);
        for (let h = 1; h <= 6; h++) {
          const fh = f * h; if (fh > 4000 || (sc.noBass && fh < 180)) continue;
          v += Math.sin(2 * Math.PI * fh * t) / (h * 1.2);
        }
      });
      x[i] = v * 0.12;
    }
  });
  if (sc.voice) { // melodía cantada con vibrato, notas de la escala, 4 armónicos
    const scale = [0, 2, 4, 5, 7, 9, 11];
    let t = 0; const notes = [];
    while (t < song.dur) { const d = 0.35 + r() * 0.5; const ch = song.chords.find((c) => c.t0 <= t && c.t1 > t) || song.chords[0]; notes.push({ t0: t, t1: t + d, m: 60 + ((ch.root + scale[Math.floor(r() * 7)]) % 12) + (r() < 0.3 ? 12 : 0) }); t += d; }
    notes.forEach((n) => {
      for (let i = Math.floor(n.t0 * SR); i < Math.min(len, Math.floor(n.t1 * SR)); i++) {
        const tt = i / SR; const vib = 1 + 0.006 * Math.sin(2 * Math.PI * 5.5 * tt);
        const f = midiF(n.m, cents) * vib; let v = 0;
        for (let h = 1; h <= 4; h++) v += Math.sin(2 * Math.PI * f * h * tt) / h;
        x[i] += v * sc.voice * 0.12;
      }
    });
  }
  if (sc.drums) { // hi-hat (ruido blanco) cada 0.25 s y bombo (60 Hz) cada 0.5 s
    for (let tt = 0; tt < song.dur; tt += 0.25) for (let i = Math.floor(tt * SR); i < Math.min(len, Math.floor((tt + 0.04) * SR)); i++) x[i] += (r() - 0.5) * sc.drums * Math.exp(-(i / SR - tt) * 60);
    if (sc.kick) for (let tt = 0; tt < song.dur; tt += 0.5) for (let i = Math.floor(tt * SR); i < Math.min(len, Math.floor((tt + 0.15) * SR)); i++) x[i] += 0.6 * Math.sin(2 * Math.PI * 60 * (i / SR)) * Math.exp(-(i / SR - tt) * 18);
  }
  for (let i = 0; i < len; i++) x[i] += (r() - 0.5) * (sc.noise || 0.01);
  return x;
}
function spectra(x) {
  const out = [], win = new Float32Array(N); for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (N - 1));
  for (let t = N / SR; t * SR <= x.length; t += HOP) {
    const end = Math.floor(t * SR), re = new Float32Array(N), im = new Float32Array(N);
    for (let i = 0; i < N; i++) re[i] = x[end - N + i] * win[i];
    fft(re, im);
    const mag = new Float32Array(N / 2); for (let k = 0; k < N / 2; k++) mag[k] = Math.hypot(re[k], im[k]);
    let rms = 0; for (let i = end - N; i < end; i++) rms += x[i] * x[i]; rms = Math.sqrt(rms / N);
    out.push({ t: t - N / SR / 2, mag, silent: rms < 0.004 });
  }
  return out;
}

// ---- evaluación
function score(song, segments) {
  let tot = 0, root = 0, tri = 0, exact = 0;
  for (let t = 0.5; t < song.dur - 0.5; t += 0.1) {
    const tr = song.chords.find((c) => c.t0 <= t && c.t1 > t); if (!tr) continue;
    const pr = segments.find((s) => !s.removed && s.t0 <= t && s.t1 > t);
    tot++;
    if (!pr) continue;
    if (pr.root === tr.root) { root++; if (FAMILY[pr.type] === FAMILY[tr.type]) { tri++; if (pr.type === tr.type) exact++; } }
  }
  return { root: root / tot, tri: tri / tot, exact: exact / tot };
}

const SCEN = {
  clean:   { noise: 0.01, label: 'limpio (guitarra sola)' },
  speaker: { noise: 0.03, voice: 1.2, drums: 0.6, noBass: true, detune: -30, label: 'altavoz móvil: voz + batería + sin graves + afinación -30¢' },
  mix:     { noise: 0.03, voice: 1.5, drums: 0.8, kick: true, detune: 20, label: 'mezcla: voz fuerte + batería + bombo + afinación +20¢' },
};

function run(opts) {
  opts = opts || {};
  const songs = opts.songs || 8, results = {};
  for (const [name, sc] of Object.entries(SCEN)) {
    const agg = { root: 0, tri: 0, exact: 0 };
    for (let s = 0; s < songs; s++) {
      const song = makeSong(1000 + s, !!opts.sevenths);
      const sp = spectra(synth(song, sc, s));
      const dec = (opts.decode || ((frames) => CE.decode(frames, opts.decodeOpts)))(sp, song);
      const sc2 = score(song, dec.segments);
      agg.root += sc2.root; agg.tri += sc2.tri; agg.exact += sc2.exact;
    }
    results[name] = { root: agg.root / songs, tri: agg.tri / songs, exact: agg.exact / songs, label: sc.label };
  }
  return results;
}

// decodificación estándar con la API vigente del motor
function standardDecode(sp, opts) {
  if (CE.extractPeaks) {
    const frames = sp.map((f) => ({ t: f.t, peaks: CE.extractPeaks(f.mag, SR, N), silent: f.silent }));
    return CE.decode(frames, opts);
  }
  const frames = sp.map((f) => ({ t: f.t, chroma: CE.chromaFromMag(f.mag, SR, N, 440), silent: f.silent }));
  return CE.decode(frames, opts);
}

if (require.main === module) {
  for (const sev of [false, true]) {
    console.log(`\n=== canciones ${sev ? 'CON séptimas' : 'solo tríadas'} ===`);
    const res = run({ sevenths: sev, decode: (sp) => standardDecode(sp, { sevenths: true }) });
    for (const [k, v] of Object.entries(res)) console.log(`${k.padEnd(8)} raíz ${(v.root * 100).toFixed(0).padStart(3)}%   tríada ${(v.tri * 100).toFixed(0).padStart(3)}%   exacto ${(v.exact * 100).toFixed(0).padStart(3)}%   — ${v.label}`);
  }
}
module.exports = { run, standardDecode, makeSong, synth, spectra, score, SR, N };
