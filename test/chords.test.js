const CE = require('../src/chords.js');
const SR = 44100, N = 16384, HOP = 0.2;

function fft(re, im) { // radix-2 in place
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
const midiF = (m) => 440 * Math.pow(2, (m - 69) / 12);
// notas MIDI de un acorde de guitarra (raíz grave + intervalos)
function chordNotes(rootPc, ivs) { const base = 40 + ((rootPc - 4 + 12) % 12); return [base, ...ivs.slice(1).map((i) => base + 12 + i), base + 12 + ivs[0] + 12 + 0]; }
function synth(song, noise, melody) {
  const total = song.reduce((a, s) => a + s.dur, 0), len = Math.ceil(total * SR), x = new Float32Array(len);
  let t0 = 0;
  song.forEach((s) => {
    const notes = s.notes;
    for (let i = Math.floor(t0 * SR); i < Math.min(len, Math.floor((t0 + s.dur) * SR)); i++) {
      const t = i / SR; let v = 0;
      notes.forEach((m) => { const f = midiF(m); for (let h = 1; h <= 6; h++) v += Math.sin(2 * Math.PI * f * h * t) / (h * 1.2); });
      if (melody) v += 1.5 * Math.sin(2 * Math.PI * midiF(melody[Math.floor(t * 2) % melody.length]) * t);
      x[i] = v * 0.12 + (noise ? (Math.random() - 0.5) * noise : 0);
    }
    t0 += s.dur;
  });
  return x;
}
function frames(x) {
  const out = [], win = new Float32Array(N); for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (N - 1));
  for (let t = N / SR; t * SR <= x.length; t += HOP) {
    const end = Math.floor(t * SR), re = new Float32Array(N), im = new Float32Array(N);
    for (let i = 0; i < N; i++) re[i] = x[end - N + i] * win[i];
    fft(re, im);
    const mag = new Float32Array(N / 2); for (let k = 0; k < N / 2; k++) mag[k] = Math.hypot(re[k], im[k]);
    let rms = 0; for (let i = end - N; i < end; i++) rms += x[i] * x[i]; rms = Math.sqrt(rms / N);
    out.push({ t: t - N / SR / 2, chroma: CE.chromaFromMag(mag, SR, N, 440), silent: rms < 0.004 });
  }
  return out;
}
const MAJ = [0, 4, 7], MIN = [0, 3, 7], D7 = [0, 4, 7, 10], M7 = [0, 3, 7, 10], MA7 = [0, 4, 7, 11];
const mk = (root, ivs, dur) => ({ notes: chordNotes(root, ivs), dur, label: root + '/' + ivs });

function run(name, song, expected, noise, melody, silenceAtEnd) {
  const x = synth(song, noise, melody);
  const res = CE.decode(frames(x), { sevenths: true });
  const got = res.segments.map((s) => CE.chordName(s.root, s.type, 'es'));
  const ok = JSON.stringify(got) === JSON.stringify(expected);
  console.log((ok ? 'OK  ' : 'FAIL') + ' ' + name + '\n     esperado: ' + expected.join(' ') + '\n     obtenido: ' + got.join(' ') + '   (tonalidad ' + CE.chordName(res.key.tonic, res.key.mode === 'maj' ? 'maj' : 'min', 'es') + ')');
  return ok;
}
let pass = 0, tot = 0; const t = (...a) => { tot++; if (run(...a)) pass++; };
// 1) Am F C G (x2) con algo de ruido
t('Am-F-C-G', [[9, MIN], [5, MAJ], [0, MAJ], [7, MAJ], [9, MIN], [5, MAJ], [0, MAJ], [7, MAJ]].map(([r, i]) => mk(r, i, 2.4)),
  ['Lam', 'Fa', 'Do', 'Sol', 'Lam', 'Fa', 'Do', 'Sol'], 0.01);
// 2) Progresión de la hoja de referencia: Rem7 Sol Do7M Fa7M
t('Rem7-Sol-Do7M-Fa7M', [[2, M7], [7, MAJ], [0, MA7], [5, MA7], [2, M7], [7, MAJ], [0, MA7], [5, MA7]].map(([r, i]) => mk(r, i, 2.4)),
  ['Rem7', 'Sol', 'Do7M', 'Fa7M', 'Rem7', 'Sol', 'Do7M', 'Fa7M'], 0.01);
// 3) Con "voz" (melodía fuerte encima) y más ruido
t('Am-F-C-G con melodía y ruido', [[9, MIN], [5, MAJ], [0, MAJ], [7, MAJ], [9, MIN], [5, MAJ], [0, MAJ], [7, MAJ]].map(([r, i]) => mk(r, i, 2.4)),
  ['Lam', 'Fa', 'Do', 'Sol', 'Lam', 'Fa', 'Do', 'Sol'], 0.05, [76, 74, 72, 79, 69, 71]);
// 4) Blues con dominantes
t('E7-A7-B7', [[4, D7], [4, D7], [9, D7], [4, D7], [11, D7], [9, D7]].map(([r, i]) => mk(r, i, 2.4)),
  ['Mi7', 'La7', 'Mi7', 'Si7', 'La7'], 0.01);
console.log(`\n${pass}/${tot} pruebas OK`);

// 5) Letra: alineación
const lrc = CE.parseLrc('[00:02.50] Yo pienso que\n[00:06.20] No son tan inutiles las noches que te di\n[00:15.00] Te marchas, y que?');
const segs = [{ t0: 0, t1: 2.4, root: 9, type: 'min' }, { t0: 2.4, t1: 4.8, root: 5, type: 'maj' }, { t0: 4.8, t1: 7.2, root: 0, type: 'maj' }, { t0: 7.2, t1: 9.6, root: 7, type: 'maj' }, { t0: 9.6, t1: 12, root: 9, type: 'min' }, { t0: 12, t1: 16, root: 5, type: 'maj' }];
console.log('\n' + CE.sheetText(CE.alignChords(lrc, segs, 0), { notation: 'es' }));
module.exports = { synth, frames, mk, CE, MAJ, MIN, D7, M7, MA7 };
