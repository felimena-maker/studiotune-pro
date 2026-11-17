const CE = require('../src/chords.js');
const P = require('../src/pcm.js');
const SR = 44100;
const midiF = (m) => 440 * Math.pow(2, (m - 69) / 12);
const prog = [[2, [0, 3, 7, 10]], [7, [0, 4, 7]], [0, [0, 4, 7, 11]], [5, [0, 4, 7, 11]]];
const LEAD = 3.0, DUR = 2.4, LOOPS = 2;
const len = Math.floor((LEAD + DUR * prog.length * LOOPS + 1) * SR);
const x = new Float32Array(len);
let seed = 7; const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
for (let n = 0; n < prog.length * LOOPS; n++) {
  const [root, ivs] = prog[n % prog.length], t0 = LEAD + n * DUR;
  const base = 40 + ((root - 4 + 12) % 12);
  const notes = [base, ...ivs.slice(1).map((i) => base + 12 + i), base + 24];
  for (let i = Math.floor(t0 * SR); i < Math.floor((t0 + DUR) * SR); i++) {
    const t = i / SR; let v = 0;
    notes.forEach((m) => { for (let h = 1; h <= 6; h++) v += Math.sin(2 * Math.PI * midiF(m) * h * t) / (h * 1.2); });
    // voz con vibrato
    const vm = 72 + [0, 2, 4, 7][Math.floor(t * 2) % 4]; v += 1.3 * Math.sin(2 * Math.PI * midiF(vm) * (1 + 0.005 * Math.sin(2 * Math.PI * 5 * t)) * t);
    x[i] = v * 0.1 + (rnd() - 0.5) * 0.03;
  }
}
// batería
for (let t = LEAD; t < len / SR - 0.1; t += 0.25) for (let i = Math.floor(t * SR); i < Math.floor((t + 0.04) * SR); i++) x[i] += (rnd() - 0.5) * 0.4 * Math.exp(-(i / SR - t) * 60);
// a Int16 y vuelta (como llega del archivo)
const i16 = new Int16Array(len); for (let i = 0; i < len; i++) i16[i] = Math.max(-32768, Math.min(32767, Math.round(x[i] * 32767)));
const f = P.toFloat(i16);
const t0 = Date.now();
(async () => {
  const onset = P.findOnset(f, SR, 0.003);
  const frames = await P.analyze(f, SR, { silence: 0.002 });
  const ms = Date.now() - t0;
  const res = CE.decode(frames, { sevenths: true });
  const names = res.segments.map((s) => CE.chordName(s.root, s.type, 'es') + '@' + (s.t0 - onset).toFixed(1));
  console.log('onset detectado: ' + onset.toFixed(2) + ' s (real ' + LEAD + ')');
  console.log('frames: ' + frames.length + ', tiempo de análisis: ' + ms + ' ms');
  console.log('acordes (tiempo relativo al inicio):\n  ' + names.join('  '));
  const exp = ['Rem7', 'Sol', 'Do7M', 'Fa7M', 'Rem7', 'Sol', 'Do7M', 'Fa7M'];
  const got = res.segments.map((s) => CE.chordName(s.root, s.type, 'es'));
  console.log(JSON.stringify(got) === JSON.stringify(exp) ? 'OK  secuencia exacta' : 'FAIL secuencia: ' + got.join(' '));
  console.log('base64 ida y vuelta:', P.base64ToFloat(Buffer.from(i16.buffer.slice(0, 8)).toString('base64')).length === 4 ? 'OK' : 'FAIL');
})();
