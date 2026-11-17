const { synth, frames, mk, CE, MAJ, MIN, D7, M7, MA7 } = require('./chords.test.js');
const cases = [
  ['Am F C G', [[9,MIN],[5,MAJ],[0,MAJ],[7,MAJ],[9,MIN],[5,MAJ],[0,MAJ],[7,MAJ]], 0.01],
  ['Dm7 G C7M F7M', [[2,M7],[7,MAJ],[0,MA7],[5,MA7],[2,M7],[7,MAJ],[0,MA7],[5,MA7]], 0.01],
  ['Am F C G voz', [[9,MIN],[5,MAJ],[0,MAJ],[7,MAJ],[9,MIN],[5,MAJ],[0,MAJ],[7,MAJ]], 0.05, [76,74,72,79,69,71]],
  ['E7 A7 E7 B7 A7', [[4,D7],[9,D7],[4,D7],[11,D7],[9,D7]], 0.01],
  ['Em C G D', [[4,MIN],[0,MAJ],[7,MAJ],[2,MAJ],[4,MIN],[0,MAJ],[7,MAJ],[2,MAJ]], 0.03, [71,67,74,69]],
  ['Am7 D7 G7M C7M', [[9,M7],[2,D7],[7,MA7],[0,MA7],[9,M7],[2,D7],[7,MA7],[0,MA7]], 0.02],
  ['C Am Dm G7', [[0,MAJ],[9,MIN],[2,MIN],[7,D7],[0,MAJ],[9,MIN],[2,MIN],[7,D7]], 0.03, [76,72,69,74]],
];
const data = cases.map(([n, p, noise, mel]) => {
  const x = synth(p.map(([r, i]) => mk(r, i, 2.4)), noise, mel); // sin etiquetas: se compara con la secuencia fuente
  return { n, f: frames(x), exp: p.map(([r, i]) => CE.chordName(r, i === MAJ ? 'maj' : i === MIN ? 'min' : i === D7 ? '7' : i === M7 ? 'm7' : 'maj7', 'es')) };
});
const res = [];
for (const tb of [0, 0.02, 0.03, 0.04, 0.05, 0.07]) for (const sw of [0.7, 0.85, 1.0]) {
  CE.configure({ triadBias: tb, seventhWeight: sw });
  let ok = 0, exactRoots = 0; const detail = [];
  data.forEach((d) => {
    const got = CE.decode(d.f).segments.map((s) => CE.chordName(s.root, s.type, 'es'));
    if (JSON.stringify(got) === JSON.stringify(d.exp)) ok++;
    // acierto parcial: coincidencia posición a posición
    let m = 0; d.exp.forEach((e, i) => { if (got[i] === e) m++; }); exactRoots += m / d.exp.length;
    detail.push(got.length === d.exp.length ? '' : '(' + got.length + '/' + d.exp.length + ')');
  });
  res.push({ tb, sw, ok, score: exactRoots.toFixed(2) });
}
res.sort((a, b) => b.score - a.score).slice(0, 8).forEach((r) => console.log(JSON.stringify(r)));
