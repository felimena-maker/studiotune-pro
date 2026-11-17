/**
 * ChordEngine — reconocimiento de acordes y alineación con letra (sin dependencias).
 * Funciona en el navegador/WebView y en Node (para pruebas).
 *
 * Tubería: espectro → picos (con filtro de ruido/armónicos) → afinación de la grabación
 *          → croma de 12 notas → plantillas de acordes + Viterbi + tonalidad.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ChordEngine = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ---------------------------------------------------------------- Tipos de acorde
  const TYPES = [
    { id: 'maj',  ivs: [0, 4, 7],     w: [1, 0.85, 0.95], bias: 0.03, ext: false },
    { id: 'min',  ivs: [0, 3, 7],     w: [1, 0.85, 0.95], bias: 0.03, ext: false },
    { id: '7',    ivs: [0, 4, 7, 10], w: [1, 0.80, 0.85, 0.85], bias: 0, ext: true },
    { id: 'maj7', ivs: [0, 4, 7, 11], w: [1, 0.80, 0.85, 0.85], bias: 0, ext: true },
    { id: 'm7',   ivs: [0, 3, 7, 10], w: [1, 0.80, 0.85, 0.85], bias: 0, ext: true },
  ];
  const NT = TYPES.length;

  let TEMPLATES = [];
  function buildTemplates() {
    TEMPLATES = TYPES.map((t) => {
      const per = [];
      for (let r = 0; r < 12; r++) {
        const v = new Float32Array(12);
        t.ivs.forEach((iv, k) => { v[(r + iv) % 12] = t.w[k]; });
        let n = 0; for (let i = 0; i < 12; i++) n += v[i] * v[i];
        n = Math.sqrt(n);
        for (let i = 0; i < 12; i++) v[i] /= n;
        per.push(v);
      }
      return per;
    });
  }
  buildTemplates();

  /** Ajuste fino: sesgo de tríadas y de séptimas. */
  function configure(o) {
    TYPES.forEach((t) => {
      if (o.triadBias != null && !t.ext) t.bias = o.triadBias;
      if (o.seventhBias != null && t.ext) t.bias = o.seventhBias;
      if (o.seventhWeight != null && t.ext) t.w[3] = o.seventhWeight;
    });
    buildTemplates();
  }

  // ---------------------------------------------------------------- Nombres
  const NAMES = {
    es: ['Do', 'Do#', 'Re', 'Mib', 'Mi', 'Fa', 'Fa#', 'Sol', 'Lab', 'La', 'Sib', 'Si'],
    en: ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'],
  };
  const SUFFIX = {
    es: { maj: '', min: 'm', '7': '7', maj7: '7M', m7: 'm7' },
    en: { maj: '', min: 'm', '7': '7', maj7: 'maj7', m7: 'm7' },
  };
  function chordName(root, typeId, notation, transpose) {
    const n = notation === 'en' ? 'en' : 'es';
    const r = (((root + (transpose || 0)) % 12) + 12) % 12;
    return NAMES[n][r] + SUFFIX[n][typeId];
  }

  // ---------------------------------------------------------------- Picos espectrales
  /**
   * Extrae los picos tonales de un espectro de magnitudes lineales.
   * - exige que el pico sobresalga del "suelo" local (descarta ruido de batería),
   * - interpola la frecuencia con precisión sub-bin,
   * - atenúa los picos agudos que son armónicos de un pico grave mucho más fuerte.
   * Devuelve { f: Float32Array, w: Float32Array }.
   */
  function extractPeaks(mag, sampleRate, fftSize, o) {
    o = o || {};
    const fmin = o.fmin || 90, fmax = o.fmax || 2400, prom = o.prominence != null ? o.prominence : 2.5;
    const binHz = sampleRate / fftSize, L = mag.length;
    const kmin = Math.max(14, Math.floor(fmin / binHz)), kmax = Math.min(L - 15, Math.ceil(fmax / binHz));
    const f = [], w = [];
    let max = 0;
    for (let k = kmin; k <= kmax; k++) if (mag[k] > max) max = mag[k];
    if (max <= 0) return { f: new Float32Array(0), w: new Float32Array(0) };
    const cum = new Float64Array(L + 1);
    for (let i = 0; i < L; i++) cum[i + 1] = cum[i] + mag[i];
    const thr = max * 0.02;
    const peakAt = (fr, minMag) => {
      const k0 = Math.round(fr / binHz), wd = Math.max(1, Math.round(fr * 0.02 / binHz));
      for (let k = Math.max(1, k0 - wd); k <= Math.min(L - 2, k0 + wd); k++) {
        if (mag[k] >= minMag && mag[k] >= mag[k - 1] && mag[k] >= mag[k + 1]) return true;
      }
      return false;
    };
    for (let k = kmin; k <= kmax; k++) {
      const b = mag[k];
      if (b < thr || b < mag[k - 1] || b < mag[k + 1]) continue;
      // suelo local: media de ±12 bins excluyendo ±2 alrededor del pico
      const sum = (cum[k + 13] - cum[k - 12]) - (cum[k + 3] - cum[k - 2]);
      const floor = sum / 20;
      if (b < prom * floor) continue;
      const a = mag[k - 1], c = mag[k + 1], den = a - 2 * b + c;
      const d = den !== 0 ? 0.5 * (a - c) / den : 0;
      const fr = (k + d) * binHz;
      let wt = Math.log1p(15 * b / max);
      if (fr > 400 && (peakAt(fr / 3, b * 1.5) || peakAt(fr / 5, b * 1.5) || peakAt(fr / 7, b * 1.5))) wt *= 0.35;
      f.push(fr); w.push(wt);
    }
    return { f: Float32Array.from(f), w: Float32Array.from(w) };
  }

  /** Desviación de afinación de la grabación respecto a A4=440 (en cents, -50..50). */
  function estimateTuning(peaksList) {
    const hist = new Float64Array(100);
    peaksList.forEach((p) => {
      if (!p) return;
      for (let i = 0; i < p.f.length; i++) {
        const fr = p.f[i]; if (fr < 120 || fr > 2000) continue;
        const midi = 69 + 12 * Math.log2(fr / 440);
        const dev = (midi - Math.round(midi)) * 100; // -50..50
        hist[Math.min(99, Math.max(0, Math.floor(dev + 50)))] += p.w[i];
      }
    });
    // suavizado circular y máximo
    const sm = new Float64Array(100); let tot = 0;
    for (let i = 0; i < 100; i++) { sm[i] = hist[(i + 99) % 100] + hist[i] * 2 + hist[(i + 1) % 100]; tot += sm[i]; }
    let bi = 0; for (let i = 1; i < 100; i++) if (sm[i] > sm[bi]) bi = i;
    if (tot <= 0 || sm[bi] / (tot / 100) < 1.25) return 0; // sin evidencia clara
    return bi + 0.5 - 50;
  }

  /** Croma normalizado (12 clases de altura) a partir de picos, con corrección de afinación en cents. */
  function chromaFromPeaks(p, cents) {
    const chroma = new Float32Array(12);
    for (let i = 0; i < p.f.length; i++) {
      const midi = 69 + 12 * Math.log2(p.f[i] / 440) - (cents || 0) / 100;
      const r = Math.round(midi), dev = Math.abs(midi - r);
      if (dev > 0.45) continue;
      chroma[((r % 12) + 12) % 12] += p.w[i] * (1 - dev);
    }
    return normalize(chroma);
  }

  /** Compatibilidad: croma directo de un espectro. */
  function chromaFromMag(mag, sampleRate, fftSize, a4) {
    return chromaFromPeaks(extractPeaks(mag, sampleRate, fftSize), 1200 * Math.log2((a4 || 440) / 440));
  }

  function normalize(v) {
    let n = 0; for (let i = 0; i < 12; i++) n += v[i] * v[i];
    n = Math.sqrt(n);
    if (n < 1e-9) return v;
    for (let i = 0; i < 12; i++) v[i] /= n;
    return v;
  }

  /** Mejor acorde para un croma normalizado. */
  function bestChord(chroma, limit, includeExt) {
    const all = [];
    for (let t = 0; t < NT; t++) {
      if (includeExt === false && TYPES[t].ext) continue;
      for (let r = 0; r < 12; r++) {
        const tp = TEMPLATES[t][r];
        let s = 0; for (let i = 0; i < 12; i++) s += chroma[i] * tp[i];
        all.push({ root: r, type: TYPES[t].id, score: s + TYPES[t].bias });
      }
    }
    all.sort((a, b) => b.score - a.score);
    return { root: all[0].root, type: all[0].type, score: all[0].score, ranking: all.slice(0, limit || 3) };
  }

  // ---------------------------------------------------------------- Tonalidad
  const KS_MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
  const KS_MINOR = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

  function pearson(a, b) {
    let ma = 0, mb = 0; for (let i = 0; i < 12; i++) { ma += a[i]; mb += b[i]; }
    ma /= 12; mb /= 12;
    let num = 0, da = 0, db = 0;
    for (let i = 0; i < 12; i++) { const x = a[i] - ma, y = b[i] - mb; num += x * y; da += x * x; db += y * y; }
    return num / (Math.sqrt(da * db) || 1);
  }
  function estimateKey(sum) {
    let best = { tonic: 0, mode: 'maj', r: -2 };
    for (let tonic = 0; tonic < 12; tonic++) {
      for (const [mode, prof] of [['maj', KS_MAJOR], ['min', KS_MINOR]]) {
        const rot = []; for (let i = 0; i < 12; i++) rot.push(prof[(i - tonic + 12) % 12]);
        const r = pearson(sum, rot);
        if (r > best.r) best = { tonic, mode, r };
      }
    }
    return best;
  }
  function diatonicSet(key) {
    const set = new Set();
    const T = key.mode === 'maj' ? key.tonic : (key.tonic + 3) % 12;
    const add = (off, ...types) => types.forEach((t) => set.add(t + '|' + ((T + off) % 12)));
    add(0, 'maj', 'maj7'); add(2, 'min', 'm7'); add(4, 'min', 'm7');
    add(5, 'maj', 'maj7'); add(7, 'maj', '7'); add(9, 'min', 'm7');
    if (key.mode === 'min') { set.add('maj|' + ((key.tonic + 7) % 12)); set.add('7|' + ((key.tonic + 7) % 12)); }
    return set;
  }

  // ---------------------------------------------------------------- Viterbi
  const DEFAULTS = { penalty: 2.2, minDur: 0.9, smooth: 2, diatonic: 0.08, sevenths: false };

  /**
   * frames: [{ t, peaks?:{f,w}, chroma?:Float32Array(12), silent }]
   * Devuelve { segments:[{t0,t1,root,type,score,alts}], key, tuning }
   */
  function decode(frames, opts) {
    const o = Object.assign({}, DEFAULTS, opts || {});
    const F = frames.length;
    if (F === 0) return { segments: [], key: null, tuning: 0 };
    const A = 6, P = o.penalty;
    const hop = F > 1 ? (frames[F - 1].t - frames[0].t) / (F - 1) : 0.2;

    // 0) afinación de la grabación y croma de cada frame
    let tuning = 0;
    if (frames[0].peaks) tuning = o.tuning != null ? o.tuning : estimateTuning(frames.filter((f) => !f.silent).map((f) => f.peaks));
    const chromas = frames.map((f) => (f.peaks ? chromaFromPeaks(f.peaks, tuning) : f.chroma));

    // 1) suavizado temporal triangular (±smooth frames)
    const sm = chromas.map((_, i) => {
      const v = new Float32Array(12);
      for (let j = Math.max(0, i - o.smooth); j <= Math.min(F - 1, i + o.smooth); j++) {
        if (frames[j].silent) continue;
        const wt = o.smooth + 1 - Math.abs(i - j);
        for (let k = 0; k < 12; k++) v[k] += chromas[j][k] * wt;
      }
      return normalize(v);
    });

    // 2) tonalidad global
    const sum = new Float32Array(12);
    frames.forEach((f, i) => { if (!f.silent) for (let k = 0; k < 12; k++) sum[k] += sm[i][k]; });
    const key = estimateKey(sum);
    const diat = diatonicSet(key);

    // 3) Viterbi (coste de cambio uniforme => O(F·S))
    const S = 12 * NT + 1;
    const active = new Uint8Array(S); active[0] = 1;
    for (let t = 0; t < NT; t++) if (o.sevenths || !TYPES[t].ext) for (let r = 0; r < 12; r++) active[1 + t * 12 + r] = 1;
    const emis = new Float32Array(S);
    let prev = new Float32Array(S), cur = new Float32Array(S);
    const back = new Array(F);
    for (let i = 0; i < F; i++) {
      if (frames[i].silent) { emis.fill(0); emis[0] = A * 1.0; }
      else {
        emis[0] = A * 0.30;
        for (let t = 0; t < NT; t++) for (let r = 0; r < 12; r++) {
          const s0 = 1 + t * 12 + r;
          if (!active[s0]) { emis[s0] = -1e6; continue; }
          const tp = TEMPLATES[t][r];
          let s = 0; for (let k = 0; k < 12; k++) s += sm[i][k] * tp[k];
          s += TYPES[t].bias;
          if (diat.has(TYPES[t].id + '|' + r)) s += o.diatonic;
          emis[s0] = A * s;
        }
      }
      const bp = new Uint8Array(S);
      if (i === 0) { for (let s = 0; s < S; s++) cur[s] = emis[s]; }
      else {
        let bi = 0; for (let s = 1; s < S; s++) if (prev[s] > prev[bi]) bi = s;
        const bestVal = prev[bi] - P;
        for (let s = 0; s < S; s++) {
          if (prev[s] >= bestVal) { cur[s] = prev[s] + emis[s]; bp[s] = s; }
          else { cur[s] = bestVal + emis[s]; bp[s] = bi; }
        }
      }
      back[i] = bp;
      const tmp = prev; prev = cur; cur = tmp;
    }
    let st = 0; for (let s = 1; s < S; s++) if (prev[s] > prev[st]) st = s;
    const path = new Array(F);
    for (let i = F - 1; i >= 0; i--) { path[i] = st; st = back[i][st]; }

    // 4) segmentos + limpieza de duraciones mínimas
    let segs = [];
    for (let i = 0; i < F; i++) {
      const last = segs[segs.length - 1];
      if (last && last.state === path[i]) last.i1 = i;
      else segs.push({ state: path[i], i0: i, i1: i });
    }
    let changed = true;
    while (changed && segs.length > 1) {
      changed = false;
      for (let k = 0; k < segs.length; k++) {
        const dur = (segs[k].i1 - segs[k].i0 + 1) * hop;
        if (dur < o.minDur && segs.length > 1) {
          const into = k > 0 ? k - 1 : k + 1;
          if (into < k) segs[into].i1 = segs[k].i1; else segs[into].i0 = segs[k].i0;
          segs.splice(k, 1);
          for (let m = segs.length - 1; m > 0; m--) {
            if (segs[m].state === segs[m - 1].state) { segs[m - 1].i1 = segs[m].i1; segs.splice(m, 1); }
          }
          changed = true; break;
        }
      }
    }
    const segments = [];
    segs.forEach((s) => {
      if (s.state === 0) return;
      const t = Math.floor((s.state - 1) / 12), r = (s.state - 1) % 12;
      let sc = 0; const avg = new Float32Array(12);
      for (let i = s.i0; i <= s.i1; i++) {
        let d = 0; for (let k = 0; k < 12; k++) { d += sm[i][k] * TEMPLATES[t][r][k]; avg[k] += sm[i][k]; } sc += d;
      }
      const alts = bestChord(normalize(avg), 7).ranking
        .filter((a) => !(a.root === r && a.type === TYPES[t].id)).slice(0, 6)
        .map((a) => ({ root: a.root, type: a.type }));
      segments.push({
        t0: frames[s.i0].t - hop / 2, t1: frames[s.i1].t + hop / 2,
        root: r, type: TYPES[t].id, score: sc / (s.i1 - s.i0 + 1), alts,
      });
    });
    return { segments, key, tuning };
  }

  // ---------------------------------------------------------------- Letra (LRC)
  function parseLrc(text) {
    const out = [];
    (text || '').split(/\r?\n/).forEach((line) => {
      const re = /\[(\d+):(\d+(?:\.\d+)?)\]/g;
      const stamps = []; let m, last = 0;
      while ((m = re.exec(line)) !== null) { stamps.push(parseInt(m[1], 10) * 60 + parseFloat(m[2])); last = re.lastIndex; }
      if (!stamps.length) return;
      const txt = line.slice(last).trim();
      stamps.forEach((t) => out.push({ t, text: txt }));
    });
    out.sort((a, b) => a.t - b.t);
    return out;
  }

  function plainToRows(text) {
    return (text || '').split(/\r?\n/).map((l) => ({ text: l.trim(), chords: [] }));
  }

  function wordStarts(text) {
    const starts = [0]; const re = /\s+/g; let m;
    while ((m = re.exec(text)) !== null) { if (re.lastIndex < text.length) starts.push(re.lastIndex); }
    return starts;
  }

  /** Coloca los acordes sobre las líneas de letra sincronizada. */
  function alignChords(lrc, segments, offset) {
    offset = offset || 0;
    const segs = segments.map((s, i) => ({ t0: s.t0 - offset, t1: s.t1 - offset, root: s.root, type: s.type, idx: i, removed: !!s.removed })).filter((s) => !s.removed);
    const lines = lrc.filter((l) => l.text !== '');
    const rows = [];
    const firstT = lines.length ? lines[0].t : Infinity;
    const intro = segs.filter((s) => s.t1 > 0 && s.t1 <= firstT + 0.3).map((s) => ({ pos: 0, root: s.root, type: s.type, idx: s.idx }));
    if (intro.length) rows.push({ t: 0, text: '', intro: true, chords: dedupe(intro) });

    for (let i = 0; i < lines.length; i++) {
      const ts = lines[i].t;
      const nextLine = lrc.find((l) => l.t > ts + 0.01);
      const te = nextLine ? nextLine.t : ts + 6;
      const text = lines[i].text;
      const sung = Math.min(te - ts, Math.max(2, text.length * 0.12));
      const starts = wordStarts(text);
      const chords = [];
      const active = segs.find((s) => s.t0 <= ts + 0.3 && s.t1 > ts + 0.3);
      if (active) chords.push({ pos: 0, root: active.root, type: active.type, idx: active.idx });
      segs.forEach((s) => {
        if (s.t0 > ts + 0.3 && s.t0 < te - 0.1) {
          const frac = Math.min(1, (s.t0 - ts) / sung);
          const idx = Math.round(frac * text.length);
          let pos = text.length;
          if (frac < 1) pos = starts.reduce((b, p) => (Math.abs(p - idx) < Math.abs(b - idx) ? p : b), starts[0]);
          chords.push({ pos, root: s.root, type: s.type, idx: s.idx });
        }
      });
      rows.push({ t: ts, text, chords: dedupe(chords) });
    }
    return rows;
  }

  function dedupe(chords) {
    const out = [];
    chords.forEach((c) => {
      const l = out[out.length - 1];
      if (l && l.root === c.root && l.type === c.type) return;
      out.push(c);
    });
    return out;
  }

  /** Texto plano estilo cancionero: acordes encima de la letra. */
  function sheetText(rows, opts) {
    opts = opts || {};
    const out = [];
    rows.forEach((r) => {
      if (r.intro) {
        out.push('[Intro] ' + r.chords.map((c) => chordName(c.root, c.type, opts.notation, opts.transpose)).join('  '));
        out.push('');
        return;
      }
      if (r.chords && r.chords.length) {
        let line = '';
        r.chords.forEach((c) => {
          const nm = chordName(c.root, c.type, opts.notation, opts.transpose);
          if (line.length > 0 && line.length >= c.pos) line += ' ';
          while (line.length < c.pos) line += ' ';
          line += nm;
        });
        out.push(line);
      }
      out.push(r.text);
    });
    return out.join('\n').replace(/\n{3,}/g, '\n\n');
  }

  /** Acordes distintos ordenados por duración total. */
  function summarize(segments, notation, transpose) {
    const m = new Map();
    segments.filter((s) => !s.removed).forEach((s) => {
      const k = s.type + '|' + s.root;
      const e = m.get(k) || { root: s.root, type: s.type, dur: 0 };
      e.dur += s.t1 - s.t0; m.set(k, e);
    });
    return [...m.values()].sort((a, b) => b.dur - a.dur)
      .map((e) => ({ name: chordName(e.root, e.type, notation, transpose), root: e.root, type: e.type, dur: e.dur }));
  }

  return {
    TYPES, NAMES, DEFAULTS, configure, chordName, extractPeaks, estimateTuning, chromaFromPeaks, chromaFromMag,
    bestChord, normalize, estimateKey, decode, parseLrc, plainToRows, alignChords, sheetText, summarize,
  };
});
