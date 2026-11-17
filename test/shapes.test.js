const S = require('../src/shapes.js');
const CE = require('../src/chords.js');
const IV = { maj: [0, 4, 7], min: [0, 3, 7], '7': [0, 4, 7, 10], maj7: [0, 4, 7, 11], m7: [0, 3, 7, 10] };
let bad = 0, n = 0;
for (const type of Object.keys(IV)) for (let r = 0; r < 12; r++) {
  n++;
  const sh = S.shapeFor(r, type), pcs = S.pitchClasses(sh.frets);
  const chord = IV[type].map((i) => (r + i) % 12);
  const set = new Set(pcs);
  const name = CE.chordName(r, type, 'en');
  const errs = [];
  chord.forEach((c, k) => { if (k !== 2 && !set.has(c)) errs.push('falta ' + c); });           // la quinta puede omitirse
  pcs.forEach((p) => { if (!chord.includes(p)) errs.push('nota ajena ' + p); });
  // bajo = nota más grave que suena
  const bassIdx = sh.frets.findIndex((f) => f !== 'x'); const bass = (S.TUNING[bassIdx] + sh.frets[bassIdx]) % 12;
  if (!chord.includes(bass)) errs.push('bajo ajeno');
  if (bass !== r && !(type === 'maj7' && false)) errs.push('bajo no es la raíz (' + bass + ')');
  const mx = Math.max(...sh.frets.filter((f) => f !== 'x'));
  if (mx > 12) errs.push('traste ' + mx);
  if (errs.length) { bad++; console.log('FAIL', name, sh.frets.join(' '), errs.join('; ')); }
}
console.log(`${n - bad}/${n} posiciones correctas`);
console.log('ejemplos:', ['maj|0', 'min|9', 'maj|5', 'min|11', '7|4', 'maj7|10'].map((k) => { const [t, r] = k.split('|'); return CE.chordName(+r, t, 'en') + ' ' + S.shapeFor(+r, t).frets.join(''); }).join('  '));
const svg = S.svg(S.shapeFor(5, 'maj'), { w: 60 });
console.log('svg ok:', svg.startsWith('<svg') && svg.endsWith('</svg>'), svg.length, 'bytes');
