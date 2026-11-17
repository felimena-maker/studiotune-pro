/**
 * ChordShapes — posiciones de guitarra (afinación estándar) para los acordes que reconoce ChordEngine
 * y su dibujo en SVG. Cuerdas de grave a aguda: 6ª..1ª. Valor 'x' = cuerda sin tocar, 0 = al aire.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ChordShapes = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const TUNING = [4, 9, 2, 7, 11, 4]; // E A D G B E (clases de altura)
  const X = 'x';

  // Plantillas móviles. 0 = cejilla/dedo índice a la altura f (o cuerda al aire si f = 0).
  const E_SHAPE = { // raíz en la 6ª cuerda
    maj: [0, 2, 2, 1, 0, 0], min: [0, 2, 2, 0, 0, 0], '7': [0, 2, 0, 1, 0, 0], maj7: [0, 2, 1, 1, 0, 0], m7: [0, 2, 0, 0, 0, 0],
  };
  const A_SHAPE = { // raíz en la 5ª cuerda
    maj: [X, 0, 2, 2, 2, 0], min: [X, 0, 2, 2, 1, 0], '7': [X, 0, 2, 0, 2, 0], maj7: [X, 0, 2, 1, 2, 0], m7: [X, 0, 2, 0, 1, 0],
  };

  // Posiciones abiertas más cómodas que la cejilla equivalente: clave "tipo|raíz".
  const OPEN = {
    'maj|0': [X, 3, 2, 0, 1, 0], '7|0': [X, 3, 2, 3, 1, 0], 'maj7|0': [X, 3, 2, 0, 0, 0],
    'maj|7': [3, 2, 0, 0, 0, 3], '7|7': [3, 2, 0, 0, 0, 1], 'maj7|7': [3, 2, 0, 0, 0, 2],
    'maj|2': [X, X, 0, 2, 3, 2], '7|2': [X, X, 0, 2, 1, 2], 'min|2': [X, X, 0, 2, 3, 1], 'm7|2': [X, X, 0, 2, 1, 1], 'maj7|2': [X, X, 0, 2, 2, 2],
    'maj7|5': [X, X, 3, 2, 1, 0], '7|11': [X, 2, 1, 2, 0, 2],
  };

  function fromTemplate(tpl, f) {
    const frets = tpl.map((v) => (v === X ? X : (v === 0 ? f : v + f)));
    const sounding = frets.map((v, i) => (v === X ? -1 : i)).filter((i) => i >= 0);
    return { frets, barre: f > 0 ? { fret: f, from: sounding[0], to: sounding[sounding.length - 1] } : null };
  }

  /** Mejor posición para un acorde. root 0..11 (Do=0), type: 'maj' | 'min' | '7' | 'maj7' | 'm7'. */
  function shapeFor(rootPc, type) {
    const r = ((rootPc % 12) + 12) % 12;
    const open = OPEN[type + '|' + r];
    if (open) return { frets: open.slice(), barre: null };
    const fE = (r - 4 + 12) % 12, fA = (r - 9 + 12) % 12;
    const cand = [];
    if (E_SHAPE[type]) cand.push([fE, fromTemplate(E_SHAPE[type], fE)]);
    if (A_SHAPE[type]) cand.push([fA + 0.01, fromTemplate(A_SHAPE[type], fA)]);
    cand.sort((a, b) => a[0] - b[0]);
    return cand[0][1];
  }

  /** Notas (clases de altura) que suenan en una posición. */
  function pitchClasses(frets) {
    const out = [];
    frets.forEach((f, i) => { if (f !== X) out.push((TUNING[i] + f) % 12); });
    return out;
  }

  /** Ventana de trastes que se dibuja: { base, rows:5 } */
  function windowOf(shape) {
    const fr = shape.frets.filter((f) => f !== X && f > 0);
    if (!fr.length) return { base: 1 };
    const mn = Math.min(...fr), mx = Math.max(...fr);
    return { base: mx <= 5 ? 1 : mn };
  }

  /**
   * SVG del diagrama. opts: { w (ancho px), color, dot, text }
   * El viewBox es 60×76 (cuerdas 6ª..1ª de izquierda a derecha).
   */
  function svg(shape, opts) {
    opts = opts || {};
    const w = opts.w || 60, h = Math.round(w * 76 / 60);
    const stroke = opts.stroke || '#a1a1aa', dot = opts.dot || '#34d399', txt = opts.text || '#a1a1aa';
    const x0 = 11, dx = 7.6, y0 = 17, dy = 11.5, win = windowOf(shape), base = win.base;
    const sx = (i) => x0 + i * dx;
    const fy = (fret) => y0 + (fret - base + 0.5) * dy;
    let s = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 60 76" width="${w}" height="${h}" role="img" aria-label="Posición del acorde">`;
    // cejuela o número de traste
    if (base === 1) s += `<rect x="${x0 - 0.8}" y="${y0 - 2}" width="${5 * dx + 1.6}" height="2.6" fill="${stroke}"/>`;
    else s += `<text x="${x0 - 3}" y="${y0 + dy * 0.5 + 3}" font-size="8" fill="${txt}" text-anchor="end" font-family="monospace">${base}</text>`;
    // trastes
    for (let k = 0; k <= 5; k++) s += `<line x1="${x0}" y1="${y0 + k * dy}" x2="${x0 + 5 * dx}" y2="${y0 + k * dy}" stroke="${stroke}" stroke-width="0.8"/>`;
    // cuerdas
    for (let i = 0; i < 6; i++) s += `<line x1="${sx(i)}" y1="${y0}" x2="${sx(i)}" y2="${y0 + 5 * dy}" stroke="${stroke}" stroke-width="0.9"/>`;
    // cejilla
    if (shape.barre) {
      const b = shape.barre;
      s += `<rect x="${sx(b.from) - 3}" y="${fy(b.fret) - 3.4}" width="${sx(b.to) - sx(b.from) + 6}" height="6.8" rx="3.4" fill="${dot}"/>`;
    }
    // puntos y marcas de cuerda al aire / muda
    shape.frets.forEach((f, i) => {
      if (f === X) s += `<text x="${sx(i)}" y="10" font-size="9" fill="${txt}" text-anchor="middle" font-family="monospace">×</text>`;
      else if (f === 0) s += `<circle cx="${sx(i)}" cy="7" r="2.6" fill="none" stroke="${txt}" stroke-width="1"/>`;
      else if (!(shape.barre && f === shape.barre.fret)) s += `<circle cx="${sx(i)}" cy="${fy(f)}" r="3.3" fill="${dot}"/>`;
    });
    return s + '</svg>';
  }

  return { shapeFor, pitchClasses, svg, TUNING };
});
