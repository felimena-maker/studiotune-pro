// Compara configuraciones del motor sobre audio sintético difícil (el audio se genera una sola vez).
const CE = require('../src/chords.js');
const B = require('./bench.js');
const { SR, N } = B;
const SCEN = {
  clean: { noise: 0.01 },
  speaker: { noise: 0.03, voice: 1.2, drums: 0.6, noBass: true, detune: -30 },
  mix: { noise: 0.03, voice: 1.5, drums: 0.8, kick: true, detune: 20 },
  brutal: { noise: 0.06, voice: 3.5, drums: 1.6, kick: true, noBass: true, detune: -42 },
};
const NSONGS = parseInt(process.env.NSONGS || '5', 10);
const data = [];
for (const sev of [false, true]) for (const [name, sc] of Object.entries(SCEN)) for (let s = 0; s < NSONGS; s++) {
  const song = B.makeSong(2000 + s, sev);
  data.push({ sev, name, song, sp: B.spectra(B.synth(song, sc, 50 + s)) });
}
console.error('audio generado: ' + data.length + ' pistas');

function evalVariant(label, o) {
  const agg = {};
  data.forEach((d) => {
    const key = (d.sev ? 'sept' : 'triad') + ' ' + d.name;
    const frames = d.sp.map((f) => (CE.extractPeaks
      ? { t: f.t, peaks: CE.extractPeaks(f.mag, SR, N, o.peaks), silent: f.silent }
      : { t: f.t, chroma: CE.chromaFromMag(f.mag, SR, N, 440), silent: f.silent }));
    const res = CE.decode(frames, o.decode);
    const sc = B.score(d.song, res.segments);
    const a = agg[key] || (agg[key] = { root: 0, tri: 0, exact: 0, n: 0 });
    a.root += sc.root; a.tri += sc.tri; a.exact += sc.exact; a.n++;
  });
  const row = (k) => { const a = agg[k]; return `${(a.root / a.n * 100).toFixed(0).padStart(3)}/${(a.tri / a.n * 100).toFixed(0).padStart(3)}/${(a.exact / a.n * 100).toFixed(0).padStart(3)}`; };
  const hard = Object.keys(agg).filter((k) => !k.includes('clean'));
  const avgTri = hard.reduce((s, k) => s + agg[k].tri / agg[k].n, 0) / hard.length;
  const avgEx = hard.reduce((s, k) => s + agg[k].exact / agg[k].n, 0) / hard.length;
  console.log(`${label.padEnd(26)} | BRUTAL triad-songs ${row("triad brutal")}  sept-songs ${row("sept brutal")} || todo difícil: tríada ${(avgTri * 100).toFixed(1)} exacto ${(avgEx * 100).toFixed(1)}`);
}
console.log('formato: raíz/tríada/exacto (%)');
const variants = JSON.parse(process.env.VARIANTS || 'null') || [
  ['sevenths=false (por defecto)', { decode: { sevenths: false } }],
  ['sevenths=true', { decode: { sevenths: true } }],
  ['smooth 1', { decode: { sevenths: false, smooth: 1 } }],
  ['smooth 3', { decode: { sevenths: false, smooth: 3 } }],
  ['penalty 3', { decode: { sevenths: false, penalty: 3 } }],
  ['diatonic .12', { decode: { sevenths: false, diatonic: 0.12 } }],
  ['prominence 1 (sin filtro)', { decode: { sevenths: false }, peaks: { prominence: 1 } }],
  ['prominence 4', { decode: { sevenths: false }, peaks: { prominence: 4 } }],
  ['sin afinación (tuning 0)', { decode: { sevenths: false, tuning: 0 } }],
];
variants.forEach(([l, o]) => evalVariant(l, o));
