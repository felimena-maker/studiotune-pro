/**
 * Pestaña "Transcribir acordes" (estilo reproductor):
 *   Biblioteca → Añadir canción (importar archivo / grabar / demo) → Reproductor con acordes y letra sincronizados.
 */
(function () {
  'use strict';
  const CE = window.ChordEngine;
  const P = window.PcmAnalyzer;
  const SH = window.ChordShapes;
  const $ = (id) => document.getElementById(id);

  const T = {
    sub: 'lib',
    lyrics: null, candidates: [], editingLyrics: false,
    notation: 'es', transpose: 0, sevenths: true, source: 'internal',
    // grabación nativa
    listening: false, nativeSource: null, handles: [], timer: null, t0: 0, maxRms: 0, hinted: false, busy: false,
    ema: new Float32Array(12), pendingOffset: null,
    // canción abierta
    song: null, frames: null, framesSongId: null,
    diagrams: (function () { try { return localStorage.getItem('studiotune_diagrams') !== '0'; } catch (e) { return true; } })(),
  };
  const PL = { audio: null, url: null, origUrl: null, cache: {}, channels: null, sr: 44100, shiftTimer: 0, blob: null, raf: 0, list: [], rows: [], curIdx: -2, lineIdx: -2, speedIdx: 2, loopA: null, loopB: null, seeking: false };
  const SPEEDS = [0.5, 0.75, 1, 1.25];

  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmtTime = (s) => { s = Math.max(0, s || 0); return Math.floor(s / 60) + ':' + String(Math.floor(s % 60)).padStart(2, '0'); };
  const keyLabel = (k) => k ? CE.chordName(k.tonic, k.mode === 'maj' ? 'maj' : 'min', T.notation, 0) + (k.mode === 'maj' ? ' mayor' : ' menor') : '';
  const setStatus = (m) => { $('tr-status').textContent = m || ''; };

  function toast(msg) {
    const el = $('tr-toast'); el.textContent = msg; el.classList.remove('hidden');
    clearTimeout(toast.h); toast.h = setTimeout(() => el.classList.add('hidden'), 2800);
  }

  /** Plugin nativo de captura (solo dentro de la app Android). */
  function nativeAC() {
    const cap = window.Capacitor;
    if (!cap || !cap.isNativePlatform || !cap.isNativePlatform() || !cap.nativePromise) return null;
    if (!nativeAC.p) nativeAC.p = {
      start: (o) => cap.nativePromise('AudioCapture', 'start', o || {}),
      stop: () => cap.nativePromise('AudioCapture', 'stop', {}),
      status: () => cap.nativePromise('AudioCapture', 'status', {}),
      openUrl: (u) => cap.nativePromise('AudioCapture', 'openUrl', { url: u }),
    };
    return nativeAC.p;
  }

  // ================================================================== Navegación
  function showView(name) {
    $('view-tuner').classList.toggle('hidden', name !== 'tuner');
    $('view-transcribe').classList.toggle('hidden', name !== 'transcribe');
    $('tuner-controls').classList.toggle('hidden', name !== 'tuner');
    const on = 'bg-emerald-500 text-zinc-950 shadow-neon-emerald', off = 'text-zinc-400 hover:text-zinc-200';
    $('tab-tuner').className = 'py-2 rounded-xl text-sm font-semibold transition-all ' + (name === 'tuner' ? on : off);
    $('tab-transcribe').className = 'py-2 rounded-xl text-sm font-semibold transition-all ' + (name === 'transcribe' ? on : off);
    if (name === 'transcribe') {
      if (typeof state !== 'undefined') {
        if (state.isListening) stopMicrophone();
        if (state.isSimulating) toggleSimulationMode(false);
      }
      showSub(T.sub);
    } else {
      if (T.listening) stopListening(true);
      pausePlayback();
    }
  }

  function showSub(name) {
    T.sub = name;
    $('tr-lib').classList.toggle('hidden', name !== 'lib');
    $('tr-new').classList.toggle('hidden', name !== 'new');
    $('tr-player').classList.toggle('hidden', name !== 'player');
    if (name !== 'player') pausePlayback();
    if (name === 'lib') renderLibrary();
    if (name === 'new') updateNewScreen();
    window.scrollTo(0, 0);
  }

  // ================================================================== Persistencia
  const LIB_KEY = 'studiotune_songs_v2', OLD_KEY = 'studiotune_songs';
  function loadLib() {
    try {
      let l = JSON.parse(localStorage.getItem(LIB_KEY) || 'null');
      if (!l) { // migración de la versión anterior (sin audio)
        const old = JSON.parse(localStorage.getItem(OLD_KEY) || '[]');
        l = old.map((o, i) => ({
          id: (o.id || Date.now()) + i, title: o.lyrics ? o.lyrics.title : 'Solo acordes', artist: o.lyrics ? o.lyrics.artist : '',
          date: o.date || '', duration: o.result && o.result.segments.length ? o.result.segments[o.result.segments.length - 1].t1 : 0,
          lyrics: o.lyrics || null, result: o.result, offset: o.offset || 0, hasAudio: false,
        }));
      }
      return l;
    } catch (e) { return []; }
  }
  function saveLib(l) { try { localStorage.setItem(LIB_KEY, JSON.stringify(l)); } catch (e) { toast('No se pudo guardar la biblioteca'); } }
  function persistSong() {
    if (!T.song) return;
    const lib = loadLib().filter((s) => s.id !== T.song.id);
    lib.unshift(T.song);
    saveLib(lib.slice(0, 40));
  }

  function idb() {
    return new Promise((res, rej) => {
      const r = indexedDB.open('studiotune', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('audio');
      r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
    });
  }
  async function putAudio(id, blob) {
    const db = await idb();
    return new Promise((res, rej) => { const tx = db.transaction('audio', 'readwrite'); tx.objectStore('audio').put(blob, id); tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
  }
  async function getAudio(id) {
    const db = await idb();
    return new Promise((res, rej) => { const rq = db.transaction('audio').objectStore('audio').get(id); rq.onsuccess = () => res(rq.result || null); rq.onerror = () => rej(rq.error); });
  }
  async function delAudio(id) {
    try { const db = await idb(); db.transaction('audio', 'readwrite').objectStore('audio').delete(id); } catch (e) { /* noop */ }
  }

  // ================================================================== Biblioteca
  function renderLibrary() {
    const lib = loadLib(), box = $('tr-lib-list');
    $('tr-lib-empty').classList.toggle('hidden', lib.length > 0);
    box.innerHTML = '';
    lib.forEach((s) => {
      const row = document.createElement('div');
      row.className = 'flex items-stretch gap-2';
      const key = s.result && s.result.key ? keyLabel(s.result.key) : '';
      row.innerHTML = `<button class="flex-1 min-w-0 text-left px-3.5 py-3 rounded-2xl bg-zinc-900/90 border border-zinc-800 hover:border-emerald-500/60 active:scale-[0.99] transition">
          <div class="text-sm font-bold text-zinc-100 truncate">${esc(s.title || 'Sin título')}</div>
          <div class="text-[11px] font-mono text-zinc-400 truncate">${esc(s.artist ? s.artist + ' · ' : '')}${esc(fmtTime(s.duration))}${key ? ' · ' + esc(key) : ''}${s.hasAudio ? '' : ' · sin audio'}</div>
        </button>
        <button class="w-11 rounded-2xl bg-zinc-800/70 text-zinc-500 hover:text-rose-300" aria-label="Borrar">✕</button>`;
      row.children[0].onclick = () => openSong(s.id);
      row.children[1].onclick = () => deleteSong(s.id);
      box.appendChild(row);
    });
  }

  function deleteSong(id) {
    if (!window.confirm('¿Borrar esta canción de tu biblioteca?')) return;
    saveLib(loadLib().filter((s) => s.id !== id));
    delAudio(id);
    if (T.song && T.song.id === id) { T.song = null; T.frames = null; }
    showSub('lib');
  }

  async function openSong(id) {
    const s = loadLib().find((x) => x.id === id);
    if (!s) return;
    T.frames = null; T.framesSongId = null;
    let blob = null;
    if (s.hasAudio) { try { blob = await getAudio(id); } catch (e) { blob = null; } }
    openPlayer(s, blob);
  }

  // ================================================================== Pantalla "Añadir"
  function updateNewScreen() {
    const editing = T.editingLyrics;
    $('tr-new-title').textContent = editing ? 'Letra de la canción' : 'Añadir canción';
    $('tr-audio-section').classList.toggle('hidden', editing);
    const native = !!nativeAC();
    $('tr-record-box').classList.toggle('hidden', !native);
    $('tr-link-box').classList.toggle('hidden', !native);
    $('tr-src-box').classList.toggle('hidden', !native);
    updateSourceUI(); updateChosen(); updateListenUI();
  }

  const HELP = {
    internal: 'Android pedirá permiso para capturar el audio del teléfono. Después abre Spotify o YouTube, reproduce la canción y vuelve aquí para detener. Algunas apps bloquean esta captura: si no llega audio, usa el micrófono.',
    mic: 'Graba con el micrófono mientras suena la canción (aquí o en otro aparato). Puedes cambiar de app: la grabación sigue en segundo plano.',
  };
  function updateSourceUI() {
    $('tr-src-help').textContent = HELP[T.source];
    const on = 'flex-1 py-2 rounded-xl text-xs font-semibold bg-emerald-500 text-zinc-950 transition-all';
    const off = 'flex-1 py-2 rounded-xl text-xs font-semibold text-zinc-400 hover:text-zinc-200 transition-all';
    $('src-internal').className = T.source === 'internal' ? on : off;
    $('src-mic').className = T.source === 'mic' ? on : off;
  }

  function updateListenUI() {
    const mic = $('tr-mic'), span = mic.querySelector('span');
    const idle = 'w-full flex items-center justify-center gap-2 px-4 py-3 rounded-2xl text-sm font-semibold bg-zinc-800 text-zinc-100 border border-zinc-700 hover:bg-zinc-700 active:scale-[0.98] transition';
    const rec = 'w-full flex items-center justify-center gap-2 px-4 py-3 rounded-2xl text-sm font-semibold bg-rose-500 text-white shadow-neon-rose active:scale-[0.98] transition';
    mic.className = T.listening ? rec : idle;
    mic.disabled = T.busy;
    span.textContent = T.busy ? 'Analizando…' : (T.listening ? 'Detener y transcribir' : 'Grabar canción');
    $('tr-monitor').classList.toggle('hidden', !T.listening);
    $('tr-import').disabled = T.busy || T.listening;
    $('tr-link').disabled = T.busy || T.listening; $('tr-link').classList.toggle('opacity-40', T.busy || T.listening);
    $('tr-demo').disabled = T.busy || T.listening;
    [$('tr-import'), $('tr-demo')].forEach((b) => b.classList.toggle('opacity-40', b.disabled));
    $('tr-mark').classList.toggle('hidden', !(T.listening && T.lyrics && T.lyrics.synced));
    if (!T.listening) { $('tr-live').textContent = '—'; $('tr-live').className = 'text-5xl font-extrabold text-zinc-600'; $('tr-level').style.width = '0%'; }
  }

  // ------------------------------------------------------------------ Letra (LRCLIB)
  async function httpGet(url) {
    const r = await fetch(url);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.text();
  }
  function cleanYoutube(title, author) {
    const t = (title || '')
      .replace(/\([^)]*\)|\[[^\]]*\]/g, ' ')
      .replace(/\b(official\s*(music\s*)?video|lyric\s*video|video\s*oficial|audio\s*oficial|letra|lyrics?|hd|4k|remaster(ed)?)\b/gi, ' ')
      .replace(/\s+/g, ' ').trim();
    let artist = '', name = t;
    const m = t.split(/\s[-–—]\s/);
    if (m.length >= 2) { artist = m[0].trim(); name = m.slice(1).join(' - ').trim(); }
    else artist = (author || '').replace(/\s*-\s*Topic$/i, '').replace(/VEVO$/i, '').trim();
    return { artist, title: name };
  }
  async function resolveInput(text) {
    text = text.trim();
    if (/(youtube\.com|youtu\.be)/i.test(text)) {
      const j = JSON.parse(await httpGet('https://www.youtube.com/oembed?format=json&url=' + encodeURIComponent(text)));
      const r = cleanYoutube(j.title, j.author_name);
      return { q: (r.artist + ' ' + r.title).trim(), from: 'YouTube: ' + j.title };
    }
    if (/open\.spotify\.com\/(intl-[a-z]+\/)?track\//i.test(text)) {
      const html = await httpGet(text.split('?')[0]);
      const t = (html.match(/<meta property="og:title" content="([^"]*)"/) || [])[1];
      const d = (html.match(/<meta property="og:description" content="([^"]*)"/) || [])[1] || '';
      if (!t) throw new Error('No se pudo leer el enlace de Spotify');
      return { q: ((d.split(' · ')[0] || '') + ' ' + t).replace(/&amp;/g, '&').trim(), from: 'Spotify: ' + t };
    }
    return { q: text, from: '' };
  }

  async function searchLyrics() {
    const input = $('tr-query').value.trim();
    if (!input) return;
    const msg = $('tr-search-msg'), box = $('tr-results');
    box.innerHTML = ''; msg.textContent = 'Buscando…';
    try {
      const r = await resolveInput(input);
      if (r.from) msg.textContent = 'Detectado → ' + r.from;
      const list = JSON.parse(await httpGet('https://lrclib.net/api/search?q=' + encodeURIComponent(r.q)));
      T.candidates = list.filter((x) => x.syncedLyrics || x.plainLyrics).sort((a, b) => (!!b.syncedLyrics - !!a.syncedLyrics)).slice(0, 8);
      if (!T.candidates.length) { msg.textContent = 'No se encontró letra para «' + r.q + '». Prueba con "artista título".'; return; }
      msg.textContent = (r.from ? msg.textContent + ' · ' : '') + 'Elige la versión que coincide con tu canción:';
      T.candidates.forEach((c, i) => {
        const b = document.createElement('button');
        b.className = 'text-left px-3 py-2 rounded-xl bg-zinc-900/90 border border-zinc-800 hover:border-emerald-500/60 active:scale-[0.99] transition';
        b.innerHTML = `<div class="text-sm font-semibold text-zinc-100">${esc(c.trackName)}</div>
          <div class="text-[11px] font-mono text-zinc-400">${esc(c.artistName)} · ${fmtTime(c.duration || 0)} · ${c.syncedLyrics ? '<span class="text-emerald-400">✓ sincronizada</span>' : '<span class="text-amber-400">sin sincronizar</span>'}</div>`;
        b.onclick = () => chooseCandidate(i);
        box.appendChild(b);
      });
    } catch (e) {
      console.warn(e);
      msg.textContent = 'No se pudo buscar (¿sin conexión?). Puedes transcribir solo los acordes.';
    }
  }

  function chooseCandidate(i) {
    const c = T.candidates[i];
    T.lyrics = {
      title: c.trackName, artist: c.artistName, duration: c.duration, synced: !!c.syncedLyrics,
      lrc: c.syncedLyrics ? CE.parseLrc(c.syncedLyrics) : [], plain: c.plainLyrics || '',
    };
    $('tr-results').innerHTML = ''; $('tr-search-msg').textContent = '';
    if (T.editingLyrics && T.song) { // aplicar a la canción abierta
      T.song.lyrics = T.lyrics; T.song.title = T.lyrics.title || T.song.title; T.song.artist = T.lyrics.artist || T.song.artist;
      persistSong(); T.editingLyrics = false; T.lyrics = null;
      openPlayer(T.song, PL.blob || null);
      return;
    }
    updateChosen();
  }

  function updateChosen() {
    const el = $('tr-chosen');
    if (!T.lyrics) { el.classList.add('hidden'); return; }
    el.classList.remove('hidden');
    el.innerHTML = `<div class="min-w-0"><div class="text-sm font-bold text-emerald-300 truncate">${esc(T.lyrics.title)}</div>
      <div class="text-[11px] font-mono text-zinc-400 truncate">${esc(T.lyrics.artist)} · ${T.lyrics.synced ? 'letra sincronizada' : 'letra sin sincronizar'}</div></div>
      <button id="tr-clear-lyrics" class="text-xs text-zinc-400 hover:text-zinc-200 px-2 py-1 rounded-lg bg-zinc-800/70">Quitar</button>`;
    $('tr-clear-lyrics').onclick = () => { T.lyrics = null; updateChosen(); updateListenUI(); };
    updateListenUI();
  }

  // ================================================================== Entradas de audio
  function mixToMono(buf) {
    if (buf.numberOfChannels === 1) return buf.getChannelData(0);
    const n = buf.length, out = new Float32Array(n), ch = [];
    for (let c = 0; c < buf.numberOfChannels; c++) ch.push(buf.getChannelData(c));
    for (let i = 0; i < n; i++) { let s = 0; for (let c = 0; c < ch.length; c++) s += ch[c][i]; out[i] = s / ch.length; }
    return out;
  }

  function pcmToWav(i16, sr) {
    const n = i16.length, buf = new ArrayBuffer(44 + n * 2), v = new DataView(buf);
    const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
    w(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); w(8, 'WAVE'); w(12, 'fmt '); v.setUint32(16, 16, true);
    v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, sr, true); v.setUint32(28, sr * 2, true);
    v.setUint16(32, 2, true); v.setUint16(34, 16, true); w(36, 'data'); v.setUint32(40, n * 2, true);
    new Int16Array(buf, 44, n).set(i16);
    return new Blob([buf], { type: 'audio/wav' });
  }

  async function importFile(file) {
    if (T.busy || T.listening) return;
    T.busy = true; updateListenUI(); setStatus('Leyendo «' + file.name + '»…');
    try {
      const ab = await file.arrayBuffer();
      const Ctx = window.AudioContext || window.webkitAudioContext, ctx = new Ctx();
      let buf;
      try { buf = await ctx.decodeAudioData(ab); } finally { try { ctx.close(); } catch (e) { /* noop */ } }
      await analyzeAndOpen({ title: file.name.replace(/\.[^.]+$/, ''), x: mixToMono(buf), sr: buf.sampleRate, blob: file, silence: 0.002, offset: 0 });
    } catch (e) {
      console.warn(e); T.busy = false; updateListenUI(); setStatus(''); toast('No se pudo leer ese archivo de audio');
    }
  }

  /** Analiza el audio, crea la canción, la guarda y abre el reproductor. */
  async function analyzeAndOpen(o) {
    T.busy = true; updateListenUI();
    try {
      const frames = await P.analyze(o.x, o.sr, { silence: o.silence }, (p) => setStatus('Analizando… ' + Math.round(p * 100) + ' %'));
      const result = CE.decode(frames, { sevenths: T.sevenths });
      const song = {
        id: Date.now(), title: (T.lyrics && T.lyrics.title) || o.title, artist: (T.lyrics && T.lyrics.artist) || '',
        date: new Date().toLocaleDateString('es'), duration: o.x.length / o.sr, lyrics: T.lyrics, result, offset: o.offset || 0, hasAudio: false,
      };
      try { await putAudio(song.id, o.blob); song.hasAudio = true; } catch (e) { console.warn('sin audio guardado', e); }
      T.frames = frames; T.framesSongId = song.id; T.song = song;
      persistSong();
      T.lyrics = null;
      if (!result.segments.length) toast('No se detectaron acordes en este audio');
      openPlayer(song, o.blob);
    } finally {
      T.busy = false; setStatus(''); updateListenUI();
    }
  }

  // ---- demo: se sintetiza con OfflineAudioContext (instantáneo) y sigue el mismo camino que un archivo importado
  async function runDemo() {
    if (T.busy || T.listening) return;
    T.busy = true; updateListenUI(); setStatus('Generando canción de ejemplo…');
    try {
      const sr = 44100, dur = 20.5, DUR = 2.4;
      const oc = new OfflineAudioContext(1, Math.floor(sr * dur), sr);
      const prog = [[2, [0, 3, 7, 10]], [7, [0, 4, 7]], [0, [0, 4, 7, 11]], [5, [0, 4, 7, 11]]];
      const master = oc.createGain(); master.gain.value = 0.9; master.connect(oc.destination);
      for (let n = 0; n < prog.length * 2; n++) {
        const [root, ivs] = prog[n % prog.length], t0 = 0.3 + n * DUR, base = 40 + ((root - 4 + 12) % 12);
        [base, ...ivs.slice(1).map((i) => base + 12 + i), base + 24].forEach((m) => {
          const o = oc.createOscillator(), f = oc.createBiquadFilter(), g = oc.createGain();
          o.type = 'sawtooth'; o.frequency.value = 440 * Math.pow(2, (m - 69) / 12);
          f.type = 'lowpass'; f.frequency.value = 1600;
          g.gain.setValueAtTime(0.0001, t0); g.gain.linearRampToValueAtTime(0.07, t0 + 0.02);
          g.gain.exponentialRampToValueAtTime(0.03, t0 + DUR - 0.05); g.gain.linearRampToValueAtTime(0.0001, t0 + DUR);
          o.connect(f); f.connect(g); g.connect(master); o.start(t0); o.stop(t0 + DUR + 0.05);
        });
      }
      const rendered = await oc.startRendering();
      const x = rendered.getChannelData(0), i16 = new Int16Array(x.length);
      for (let i = 0; i < x.length; i++) i16[i] = Math.max(-32768, Math.min(32767, Math.round(x[i] * 32767)));
      T.lyrics = {
        title: 'Canción de ejemplo', artist: 'Demo', duration: 20, synced: true, demo: true, plain: '',
        lrc: CE.parseLrc('[00:00.70] Esta es una línea de ejemplo\n[00:05.10] para ver cómo se alinean los acordes\n[00:09.90] sobre la letra de cualquier canción\n[00:14.70] cuando la letra viene sincronizada\n[00:19.30] '),
      };
      await analyzeAndOpen({ title: 'Canción de ejemplo', x, sr, blob: pcmToWav(i16, sr), silence: 0.002, offset: 0 });
    } catch (e) {
      console.warn(e); T.busy = false; updateListenUI(); setStatus(''); toast('No se pudo generar la demo');
    }
  }

  // ================================================================== Grabación nativa (sigue en segundo plano)
  async function startNative(source, extra) {
    const AC = nativeAC();
    T.ema.fill(0); T.maxRms = 0; T.hinted = false; T.pendingOffset = null;
    try { await AC.start(Object.assign({ source }, extra || {})); }
    catch (e) { toast((e && e.message) || 'No se pudo iniciar la captura'); return; }
    T.nativeSource = source; T.listening = true; T.t0 = performance.now();
    T.handles = [
      window.Capacitor.addListener('AudioCapture', 'level', onNativeLevel),
      window.Capacitor.addListener('AudioCapture', 'window', onNativeWindow),
      window.Capacitor.addListener('AudioCapture', 'error', (e) => toast((e && e.message) || 'Error de captura')),
      window.Capacitor.addListener('AudioCapture', 'finished', () => { if (T.listening) stopNative(false); }),
    ];
    T.timer = setInterval(() => { $('tr-time').textContent = fmtTime((performance.now() - T.t0) / 1000); }, 500);
    updateListenUI();
    toast(source === 'internal' ? 'Grabando: abre Spotify o YouTube y reproduce' : 'Grabando con el micrófono');
  }

  function onNativeLevel(e) {
    $('tr-level').style.width = Math.min(100, Math.round(e.rms * 420)) + '%';
    if (e.rms > T.maxRms) T.maxRms = e.rms;
    if (T.nativeSource === 'internal' && e.seconds > 25 && T.maxRms < 1e-4 && !T.hinted) {
      T.hinted = true; toast('No llega audio. Si ya suena, esa app bloquea la captura: usa el micrófono');
    }
  }
  function onNativeWindow(e) {
    try { const r = P.analyzeWindow(P.base64ToFloat(e.data), 0, 44100, 16384); showLive(r.peaks, r.rms < 0.003); } catch (err) { /* opcional */ }
  }
  function showLive(peaks, silent) {
    const chroma = CE.chromaFromPeaks(peaks, 0);
    for (let i = 0; i < 12; i++) T.ema[i] = silent ? T.ema[i] * 0.5 : T.ema[i] * 0.6 + chroma[i] * 0.4;
    const ev = CE.normalize(Float32Array.from(T.ema));
    const bars = $('tr-bars').children; for (let i = 0; i < 12; i++) bars[i].firstChild.style.height = Math.round(ev[i] * 100) + '%';
    const live = $('tr-live');
    if (silent) { live.textContent = '·'; live.className = 'text-5xl font-extrabold text-zinc-600'; return; }
    const b = CE.bestChord(ev, 1);
    if (b.score > 0.75) { live.textContent = CE.chordName(b.root, b.type, T.notation, T.transpose); live.className = 'text-5xl font-extrabold text-emerald-400'; }
    else { live.textContent = '…'; live.className = 'text-5xl font-extrabold text-zinc-500'; }
  }

  /** Si el enlace es de YouTube/Spotify y no hay letra elegida, usa la primera versión sincronizada que encuentre. */
  async function autoPickLyrics(text) {
    const r = await resolveInput(text);
    const list = JSON.parse(await httpGet('https://lrclib.net/api/search?q=' + encodeURIComponent(r.q)));
    const c = list.filter((x) => x.syncedLyrics)[0] || list.filter((x) => x.plainLyrics)[0];
    if (!c) return;
    T.candidates = [c]; chooseCandidate(0); toast('Letra: ' + c.trackName + ' — ' + c.artistName);
  }

  async function captureFromLink() {
    if (T.busy || T.listening || !nativeAC()) return;
    const raw = $('tr-query').value.trim();
    if (!/(youtube\.com|youtu\.be|open\.spotify\.com\/(intl-[a-z]+\/)?track\/)/i.test(raw)) { toast('Pega primero un enlace de YouTube o Spotify en «Letra»'); return; }
    if (!T.lyrics) { try { await autoPickLyrics(raw); } catch (e) { console.warn(e); } }
    const dur = T.lyrics && T.lyrics.duration ? T.lyrics.duration : 0;
    T.source = 'internal'; updateSourceUI();
    await startNative('internal', { autoStop: true, maxSeconds: dur ? dur + 25 : 600 });
    if (T.listening) {
      try { await nativeAC().openUrl(raw); } catch (e) { toast('Abre el enlace tú mismo: la grabación ya está en marcha'); }
    }
  }

  function stopListening(silent) {
    if (!T.listening) return;
    return stopNative(silent);
  }

  async function stopNative(silent) {
    const AC = nativeAC();
    T.listening = false; clearInterval(T.timer);
    T.handles.forEach((h) => { try { h.remove(); } catch (e) { /* noop */ } }); T.handles = [];
    let info = null;
    try { info = await AC.stop(); } catch (e) { info = null; }
    if (silent) { updateListenUI(); return; }
    if (!info || info.samples < 44100 * 3) { updateListenUI(); toast('Muy poco audio grabado'); return; }
    T.busy = true; updateListenUI();
    try {
      setStatus('Leyendo la grabación…');
      const resp = await fetch(window.Capacitor.convertFileSrc('file://' + info.path));
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      const buf = await resp.arrayBuffer();
      let i16 = new Int16Array(buf, 0, buf.byteLength >> 1);
      const internal = T.nativeSource === 'internal';
      let x = P.toFloat(i16);
      const onset = internal ? P.findOnset(x, info.sampleRate, 0.003) : null;
      if (internal && onset != null && T.lyrics && T.lyrics.duration > 30) { // recortar lo que suene después de la canción (p. ej. el siguiente tema)
        const end = Math.min(x.length, Math.round((onset + T.lyrics.duration + 3) * info.sampleRate));
        x = x.subarray(0, end); i16 = i16.subarray(0, end);
      }
      let offset = 0;
      if (T.lyrics && T.lyrics.synced) {
        if (T.pendingOffset != null) offset = T.pendingOffset;
        else if (internal && onset != null) { offset = Math.round(onset * 2) / 2; toast('Sincronía automática: la música empieza a los ' + onset.toFixed(1) + ' s'); }
      }
      await analyzeAndOpen({
        title: 'Grabación ' + new Date().toLocaleString('es', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }),
        x, sr: info.sampleRate, blob: pcmToWav(i16, info.sampleRate), silence: internal ? 0.002 : 0.004, offset,
      });
    } catch (err) {
      console.warn(err); T.busy = false; setStatus(''); updateListenUI(); toast('No se pudo analizar la grabación');
    }
  }

  // ================================================================== Reproductor
  function openPlayer(song, blob) {
    T.song = song; T.transpose = 0; T.notation = song.notation || T.notation;
    PL.loopA = PL.loopB = null; PL.curIdx = -2; PL.lineIdx = -2; PL.blob = blob || null;
    $('pl-loop').textContent = 'A-B';
    showSub('player');
    setupAudio(blob);
    $('pl-title').textContent = song.title || 'Sin título';
    renderPlayer();
  }

  function setupAudio(blob) {
    teardownAudio();
    const has = !!blob;
    $('pl-transport').classList.toggle('hidden', !has);
    $('pl-noaudio').classList.toggle('hidden', has);
    if (!has) return;
    PL.url = URL.createObjectURL(blob); PL.origUrl = PL.url;
    const a = new Audio();
    a.preload = 'auto'; a.src = PL.url;
    try { a.preservesPitch = true; a.webkitPreservesPitch = true; } catch (e) { /* noop */ }
    a.playbackRate = SPEEDS[PL.speedIdx];
    a.addEventListener('loadedmetadata', () => { $('pl-seek').max = a.duration || T.song.duration; $('pl-dur').textContent = fmtTime(a.duration || T.song.duration); });
    a.addEventListener('play', () => { updatePlayBtn(); cancelAnimationFrame(PL.raf); PL.raf = requestAnimationFrame(tickPlayer); });
    a.addEventListener('pause', updatePlayBtn);
    a.addEventListener('ended', () => { updatePlayBtn(); });
    PL.audio = a;
    $('pl-seek').max = T.song.duration; $('pl-seek').value = 0; $('pl-dur').textContent = fmtTime(T.song.duration);
    updatePlayBtn();
  }

  function teardownAudio() {
    cancelAnimationFrame(PL.raf);
    if (PL.audio) { try { PL.audio.pause(); PL.audio.removeAttribute('src'); PL.audio.load(); } catch (e) { /* noop */ } PL.audio = null; }
    clearTimeout(PL.shiftTimer); shiftToken++;
    if (PL.url) { URL.revokeObjectURL(PL.url); PL.url = null; PL.origUrl = null; }
    Object.keys(PL.cache).forEach((k) => URL.revokeObjectURL(PL.cache[k]));
    PL.cache = {}; PL.channels = null;
    setPlStatus('');
  }

  // ---- cambio de tono del audio (SoundTouch, fuera de tiempo real, con caché por semitono)
  let shiftToken = 0;
  function setPlStatus(m) { const el = $('pl-status'); el.textContent = m || ''; el.classList.toggle('hidden', !m); }

  async function getChannels() {
    if (PL.channels) return PL.channels;
    const ab = await PL.blob.arrayBuffer();
    const Ctx = window.AudioContext || window.webkitAudioContext, ctx = new Ctx();
    let buf;
    try { buf = await ctx.decodeAudioData(ab); } finally { try { ctx.close(); } catch (e) { /* noop */ } }
    PL.sr = buf.sampleRate;
    PL.channels = [buf.getChannelData(0), buf.numberOfChannels > 1 ? buf.getChannelData(1) : buf.getChannelData(0)];
    return PL.channels;
  }

  function stereoWav(l, r, sr) {
    const n = l.length, buf = new ArrayBuffer(44 + n * 4), v = new DataView(buf);
    const w = (o, str) => { for (let i = 0; i < str.length; i++) v.setUint8(o + i, str.charCodeAt(i)); };
    w(0, 'RIFF'); v.setUint32(4, 36 + n * 4, true); w(8, 'WAVE'); w(12, 'fmt '); v.setUint32(16, 16, true);
    v.setUint16(20, 1, true); v.setUint16(22, 2, true); v.setUint32(24, sr, true); v.setUint32(28, sr * 4, true);
    v.setUint16(32, 4, true); v.setUint16(34, 16, true); w(36, 'data'); v.setUint32(40, n * 4, true);
    const o = new Int16Array(buf, 44, n * 2);
    for (let i = 0; i < n; i++) {
      o[2 * i] = Math.max(-32768, Math.min(32767, Math.round(l[i] * 32767)));
      o[2 * i + 1] = Math.max(-32768, Math.min(32767, Math.round(r[i] * 32767)));
    }
    return new Blob([buf], { type: 'audio/wav' });
  }

  async function shiftedUrl(semi, token) {
    if (semi === 0) return PL.origUrl;
    if (PL.cache[semi]) return PL.cache[semi];
    setPlStatus('Cambiando el tono…');
    try {
      const ch = await getChannels();
      const r = await window.PitchShift.shift(ch, PL.sr, semi, (p) => { if (token === shiftToken) setPlStatus('Cambiando el tono… ' + Math.round(p * 100) + ' %'); });
      if (token !== shiftToken) return null;
      PL.cache[semi] = URL.createObjectURL(stereoWav(r.left, r.right, PL.sr));
      return PL.cache[semi];
    } catch (e) { console.warn(e); toast('No se pudo cambiar el tono del audio'); return null; }
    finally { if (token === shiftToken) setPlStatus(''); }
  }

  async function applyAudioShift() {
    if (!PL.audio || !PL.blob) return;
    const token = ++shiftToken, url = await shiftedUrl(T.transpose, token);
    if (!url || token !== shiftToken || !PL.audio) return;
    const a = PL.audio, t = a.currentTime, wasPlaying = !a.paused;
    a.pause(); a.src = url;
    a.addEventListener('loadedmetadata', () => { a.currentTime = t; if (wasPlaying) a.play().catch(() => { /* noop */ }); }, { once: true });
    a.load();
  }
  function scheduleAudioShift() { clearTimeout(PL.shiftTimer); PL.shiftTimer = setTimeout(applyAudioShift, 700); }
  function pausePlayback() { if (PL.audio && !PL.audio.paused) PL.audio.pause(); }

  const ICON_PLAY = '<svg class="w-6 h-6 ml-0.5" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>';
  const ICON_PAUSE = '<svg class="w-6 h-6" viewBox="0 0 24 24" fill="currentColor"><path d="M6 5h4v14H6zM14 5h4v14h-4z"/></svg>';
  function updatePlayBtn() { $('pl-play').innerHTML = PL.audio && !PL.audio.paused ? ICON_PAUSE : ICON_PLAY; }

  function tickPlayer() {
    const a = PL.audio; if (!a) return;
    let t = a.currentTime;
    if (PL.loopA != null && PL.loopB != null && t >= PL.loopB) { a.currentTime = PL.loopA; t = PL.loopA; }
    updatePlayhead(t);
    if (!a.paused) PL.raf = requestAnimationFrame(tickPlayer);
  }

  const chordNm = (s) => CE.chordName(s.root, s.type, T.notation, T.transpose);
  /** SVG del diagrama de un acorde (ya transpuesto). */
  const dgSvg = (s, w) => SH.svg(SH.shapeFor(s.root + T.transpose, s.type), { w });

  function curIndexAt(t) {
    let idx = -1;
    for (let i = 0; i < PL.list.length; i++) { if (PL.list[i].s.t0 <= t + 0.05) idx = i; else break; }
    if (idx >= 0 && t > PL.list[idx].s.t1 + 1.5) return -1;
    return idx;
  }

  const chipClass = (active) => 'shrink-0 px-2.5 py-1 rounded-xl border font-mono font-bold text-[13px] leading-tight text-center transition ' +
    (active ? 'bg-emerald-500 text-zinc-950 border-emerald-400 scale-105' : 'bg-zinc-900 text-zinc-300 border-zinc-800');

  function updatePlayhead(t) {
    if (!PL.seeking) $('pl-seek').value = t;
    $('pl-t').textContent = fmtTime(t);
    // acorde actual / anterior / siguiente
    const idx = curIndexAt(t);
    if (idx !== PL.curIdx) {
      PL.curIdx = idx;
      const L = PL.list;
      $('pl-cur').textContent = idx >= 0 ? chordNm(L[idx].s) : '—';
      $('pl-cur').className = 'min-w-[8rem] text-center text-5xl font-extrabold leading-none py-1 ' + (idx >= 0 ? 'text-emerald-400' : 'text-zinc-600');
      $('pl-prev').textContent = idx > 0 ? chordNm(L[idx - 1].s) : '';
      $('pl-next').textContent = idx + 1 < L.length ? chordNm(L[idx + 1].s) : '';
      const dc = $('pl-dg-cur'), dn = $('pl-dg-next');
      dc.innerHTML = idx >= 0 ? dgSvg(L[idx].s, 56) : '';
      dn.innerHTML = idx + 1 < L.length ? '<div class="text-[10px] font-mono text-zinc-500 leading-none mb-0.5">' + esc(chordNm(L[idx + 1].s)) + '</div>' + dgSvg(L[idx + 1].s, 40) : '';
      const chips = $('pl-strip').children;
      for (let i = 0; i < chips.length; i++) chips[i].className = chipClass(i === idx);
      if (idx >= 0 && chips[idx]) {
        const st = $('pl-strip'), c = chips[idx];
        st.scrollTo({ left: c.offsetLeft - st.clientWidth / 2 + c.clientWidth / 2, behavior: 'smooth' });
      }
    }
    // línea de letra actual
    if (PL.rows.length) {
      const songT = t - (T.song.offset || 0);
      let li = -1;
      for (let i = 0; i < PL.rows.length; i++) { if (parseFloat(PL.rows[i].dataset.t) <= songT + 0.05) li = i; else break; }
      if (li !== PL.lineIdx) {
        if (PL.rows[PL.lineIdx]) PL.rows[PL.lineIdx].classList.remove('bg-emerald-500/10');
        if (PL.rows[li]) {
          PL.rows[li].classList.add('bg-emerald-500/10');
          if (PL.audio && !PL.audio.paused) PL.rows[li].scrollIntoView({ block: 'center', behavior: 'smooth' });
        }
        PL.lineIdx = li;
      }
    }
  }

  function seekTo(t) {
    if (!PL.audio) return;
    PL.audio.currentTime = Math.max(0, Math.min(t, PL.audio.duration || T.song.duration));
    updatePlayhead(PL.audio.currentTime);
  }

  // ---- hoja de acordes + letra
  function chordBtn(c) { return `<button class="tr-chord font-mono font-bold text-emerald-400 text-sm active:scale-95" data-seg="${c.idx}">${esc(CE.chordName(c.root, c.type, T.notation, T.transpose))}</button>`; }
  const piece = (chord, text) =>
    `<span class="inline-flex flex-col align-bottom"><span class="h-5 pr-2 whitespace-pre">${chord || '&nbsp;'}</span><span class="whitespace-pre-wrap text-zinc-200 text-[15px] min-w-[0.6rem]">${text ? esc(text) : '&nbsp;'}</span></span>`;
  function rowHtml(r) {
    if (r.intro) {
      return `<div class="tr-row mb-2 p-1.5 rounded-lg flex flex-wrap gap-x-3 items-baseline" data-t="-1"><span class="text-[10px] uppercase tracking-wider text-zinc-500 font-mono">Intro</span>${r.chords.map(chordBtn).join('')}</div>`;
    }
    if (!r.text) return '<div class="h-2"></div>';
    let html = `<div class="tr-row mb-1.5 p-1.5 rounded-lg leading-snug transition-colors" data-t="${r.t}">`;
    const first = r.chords.length ? r.chords[0].pos : r.text.length;
    if (first > 0) html += piece('', r.text.slice(0, first));
    r.chords.forEach((c, i) => {
      const end = i + 1 < r.chords.length ? r.chords[i + 1].pos : r.text.length;
      html += piece(chordBtn(c), r.text.slice(c.pos, Math.max(end, c.pos)));
    });
    return html + '</div>';
  }

  function currentRows() {
    const s = T.song;
    if (s.lyrics && s.lyrics.synced) return CE.alignChords(s.lyrics.lrc, s.result.segments, s.offset || 0);
    return null;
  }

  function renderPlayer() {
    const s = T.song; if (!s) return;
    const segs = s.result.segments;
    PL.list = []; segs.forEach((seg, idx) => { if (!seg.removed) PL.list.push({ idx, s: seg }); });

    $('pl-sub').textContent = [s.artist, keyLabel(s.result.key), fmtTime(s.duration)].filter(Boolean).join(' · ');
    $('tr-key').textContent = s.result.key ? 'Tonalidad: ' + keyLabel(s.result.key) + (Math.abs(s.result.tuning || 0) >= 8 ? ' · afinación ' + (s.result.tuning > 0 ? '+' : '') + Math.round(s.result.tuning) + '¢' : '') : '';
    $('tr-transpose-val').textContent = (T.transpose > 0 ? '+' : '') + T.transpose;
    $('tr-notation').textContent = T.notation === 'es' ? 'Do Re Mi' : 'C D E';
    $('tr-sevenths').textContent = 'Séptimas: ' + (T.sevenths ? 'sí' : 'no');
    $('tr-used').innerHTML = CE.summarize(segs, T.notation, T.transpose).slice(0, 16)
      .map((u) => `<div class="flex flex-col items-center px-2 pt-1 pb-0.5 rounded-xl bg-zinc-900 border border-zinc-800"><span class="font-mono font-bold text-xs text-emerald-300">${esc(u.name)}</span>${dgSvg(u, 50)}</div>`).join('');
    applyDiagramMode();

    // tira de acordes
    const strip = $('pl-strip'); strip.innerHTML = '';
    PL.list.forEach((it) => {
      const b = document.createElement('button');
      b.className = chipClass(false);
      b.innerHTML = `${esc(chordNm(it.s))}<div class="text-[9px] font-normal opacity-60">${fmtTime(it.s.t0)}</div>`;
      b.onclick = () => seekTo(it.s.t0);
      strip.appendChild(b);
    });
    if (!PL.list.length) strip.innerHTML = '<div class="text-xs text-zinc-500 py-2">No se detectaron acordes.</div>';

    // hoja
    const sheet = $('tr-sheet'), rows = currentRows();
    let html = '';
    if (rows) html = rows.map(rowHtml).join('');
    else {
      html = '<div class="text-[11px] text-zinc-500 mb-2 font-mono">' + (s.lyrics ? 'La letra no está sincronizada: se muestra la progresión de acordes.' : 'Progresión de acordes detectada:') + '</div><div class="flex flex-wrap gap-x-3 gap-y-2 mb-4">' +
        PL.list.map((it) => `<span class="inline-flex flex-col items-center"><span class="text-[9px] text-zinc-600 font-mono">${fmtTime(it.s.t0)}</span>${chordBtn({ root: it.s.root, type: it.s.type, idx: it.idx })}</span>`).join('') + '</div>';
      if (s.lyrics && s.lyrics.plain) html += '<div class="whitespace-pre-wrap text-zinc-300 text-[15px] leading-snug">' + esc(s.lyrics.plain) + '</div>';
      if (!PL.list.length) html = '<div class="text-sm text-zinc-400">No se detectaron acordes. Revisa que el audio tuviera música y vuelve a intentarlo.</div>';
    }
    sheet.innerHTML = html;
    PL.rows = rows ? Array.from(sheet.querySelectorAll('.tr-row')).filter((r) => parseFloat(r.dataset.t) >= 0) : [];
    sheet.querySelectorAll('.tr-chord').forEach((b) => { b.onclick = (e) => { e.stopPropagation(); openChordMenu(parseInt(b.dataset.seg, 10)); }; });
    PL.rows.forEach((r) => { r.onclick = () => { if (PL.audio) seekTo(parseFloat(r.dataset.t) + (s.offset || 0)); }; });

    // sincronía
    const synced = !!(s.lyrics && s.lyrics.synced);
    $('sync-box').classList.toggle('hidden', !synced);
    $('tr-offset').value = s.offset || 0; updateOffsetLabel();

    PL.curIdx = -2; PL.lineIdx = -2;
    updatePlayhead(PL.audio ? PL.audio.currentTime : 0);
  }

  function applyDiagramMode() {
    const on = T.diagrams;
    $('pl-dg-cur').classList.toggle('hidden', !on);
    $('pl-dg-next').classList.toggle('hidden', !on);
    $('pl-prev').classList.toggle('hidden', on);
    $('pl-next').classList.toggle('hidden', on);
    $('pl-dg').className = 'w-9 h-9 shrink-0 rounded-xl flex items-center justify-center border active:scale-95 ' + (on ? 'bg-emerald-500/20 border-emerald-500/50 text-emerald-300' : 'bg-zinc-800 border-zinc-700/70 text-zinc-100');
  }

  function updateOffsetLabel() { const o = (T.song && T.song.offset) || 0; $('tr-offset-val').textContent = (o > 0 ? '+' : '') + o.toFixed(1) + ' s'; }
  function setOffset(v) { T.song.offset = Math.max(-30, Math.min(120, v)); persistSong(); renderPlayer(); }

  // ---- edición de un acorde
  function openChordMenu(idx) {
    const seg = T.song.result.segments[idx]; if (!seg) return;
    const pop = $('tr-pop'), list = $('tr-pop-list');
    $('tr-pop-title').textContent = 'Acorde detectado: ' + chordNm(seg) + ' (' + fmtTime(seg.t0) + ')';
    list.innerHTML = '';
    (seg.alts || []).forEach((a) => {
      const b = document.createElement('button');
      b.className = 'px-3 py-2 rounded-xl bg-zinc-800 border border-zinc-700 font-mono font-bold text-emerald-300 active:scale-95';
      b.textContent = CE.chordName(a.root, a.type, T.notation, T.transpose);
      b.onclick = () => { const old = { root: seg.root, type: seg.type }; seg.root = a.root; seg.type = a.type; seg.alts = [old, ...seg.alts.filter((x) => x !== a)]; pop.classList.add('hidden'); persistSong(); renderPlayer(); };
      list.appendChild(b);
    });
    $('tr-pop-remove').onclick = () => { seg.removed = true; pop.classList.add('hidden'); persistSong(); renderPlayer(); };
    pop.classList.remove('hidden');
  }

  // ---- exportar
  function sheetPlainText() {
    const s = T.song, head = (s.lyrics && !s.lyrics.demo ? s.title + ' — ' + s.artist + '\n\n' : (s.title ? s.title + '\n\n' : ''));
    const rows = currentRows();
    if (rows) return head + CE.sheetText(rows, { notation: T.notation, transpose: T.transpose });
    return head + CE.summarize(s.result.segments, T.notation, T.transpose).map((u) => u.name).join('  ') + (s.lyrics ? '\n\n' + s.lyrics.plain : '');
  }
  async function copyText() {
    const txt = sheetPlainText();
    try { await navigator.clipboard.writeText(txt); toast('Copiado al portapapeles'); }
    catch (e) {
      const ta = document.createElement('textarea'); ta.value = txt; document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); toast('Copiado al portapapeles'); } catch (e2) { toast('No se pudo copiar'); }
      ta.remove();
    }
  }
  async function shareText() {
    if (navigator.share) { try { await navigator.share({ text: sheetPlainText() }); return; } catch (e) { return; } }
    copyText();
  }

  // ================================================================== Arranque
  window.addEventListener('DOMContentLoaded', () => {
    const bars = $('tr-bars');
    for (let i = 0; i < 12; i++) {
      const d = document.createElement('div');
      d.className = 'flex-1 flex flex-col items-center justify-end h-full gap-1';
      d.innerHTML = `<div class="w-full rounded-sm bg-emerald-500/70" style="height:0%"></div><span class="text-[9px] font-mono text-zinc-500">${CE.NAMES.en[i].replace('b', '♭')}</span>`;
      bars.appendChild(d);
    }
    $('tab-tuner').onclick = () => showView('tuner');
    $('tab-transcribe').onclick = () => showView('transcribe');

    // biblioteca / navegación
    $('tr-add').onclick = () => { T.editingLyrics = false; T.lyrics = null; $('tr-results').innerHTML = ''; $('tr-search-msg').textContent = ''; setStatus(''); showSub('new'); };
    $('tr-new-back').onclick = () => { if (T.editingLyrics && T.song) { T.editingLyrics = false; T.lyrics = null; showSub('player'); } else showSub('lib'); };
    $('pl-back').onclick = () => showSub('lib');
    $('pl-dg').onclick = () => { T.diagrams = !T.diagrams; try { localStorage.setItem('studiotune_diagrams', T.diagrams ? '1' : '0'); } catch (e) { /* noop */ } applyDiagramMode(); };
    $('pl-lyrics').onclick = () => { T.editingLyrics = true; T.lyrics = null; $('tr-results').innerHTML = ''; $('tr-search-msg').textContent = ''; showSub('new'); };

    // letra
    $('tr-search').onclick = searchLyrics;
    $('tr-query').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); $('tr-query').blur(); searchLyrics(); } });

    // entradas de audio
    $('tr-import').onclick = () => $('tr-file').click();
    $('tr-file').onchange = (e) => { const f = e.target.files && e.target.files[0]; e.target.value = ''; if (f) importFile(f); };
    $('tr-demo').onclick = runDemo;
    $('src-internal').onclick = () => { if (!T.listening) { T.source = 'internal'; updateSourceUI(); } };
    $('src-mic').onclick = () => { if (!T.listening) { T.source = 'mic'; updateSourceUI(); } };
    $('tr-mic').onclick = () => { if (T.busy) return; if (T.listening) stopListening(false); else if (nativeAC()) startNative(T.source); };
    $('tr-mark').onclick = () => {
      if (!T.listening || !T.lyrics || !T.lyrics.synced || !T.lyrics.lrc.length) return;
      const first = T.lyrics.lrc.find((l) => l.text !== '') || T.lyrics.lrc[0];
      T.pendingOffset = Math.round(((performance.now() - T.t0) / 1000 - 0.4 - first.t) * 2) / 2;
      toast('Inicio de la letra marcado');
    };

    // transporte
    $('pl-play').onclick = () => { if (!PL.audio) return; if (PL.audio.paused) PL.audio.play().catch(() => toast('No se pudo reproducir el audio')); else PL.audio.pause(); };
    $('pl-back10').onclick = () => PL.audio && seekTo(PL.audio.currentTime - 10);
    $('pl-fwd10').onclick = () => PL.audio && seekTo(PL.audio.currentTime + 10);
    $('pl-speed').onclick = () => {
      PL.speedIdx = (PL.speedIdx + 1) % SPEEDS.length;
      if (PL.audio) PL.audio.playbackRate = SPEEDS[PL.speedIdx];
      $('pl-speed').textContent = SPEEDS[PL.speedIdx] + '×';
    };
    $('pl-loop').onclick = () => {
      if (!PL.audio) return;
      const t = PL.audio.currentTime, b = $('pl-loop');
      if (PL.loopA == null) { PL.loopA = t; b.textContent = 'A→'; toast('Punto A marcado: pulsa de nuevo para marcar B'); }
      else if (PL.loopB == null && t > PL.loopA + 0.5) { PL.loopB = t; b.textContent = 'A-B ✓'; toast('Repitiendo de A a B'); }
      else { PL.loopA = PL.loopB = null; b.textContent = 'A-B'; }
    };
    const seek = $('pl-seek');
    seek.addEventListener('input', () => { PL.seeking = true; if (PL.audio) PL.audio.currentTime = parseFloat(seek.value); updatePlayhead(parseFloat(seek.value)); });
    seek.addEventListener('change', () => { PL.seeking = false; });

    // opciones
    $('tr-tr-minus').onclick = () => { T.transpose = Math.max(-11, T.transpose - 1); renderPlayer(); scheduleAudioShift(); };
    $('tr-tr-plus').onclick = () => { T.transpose = Math.min(11, T.transpose + 1); renderPlayer(); scheduleAudioShift(); };
    $('tr-notation').onclick = () => { T.notation = T.notation === 'es' ? 'en' : 'es'; renderPlayer(); };
    $('tr-sevenths').onclick = () => {
      T.sevenths = !T.sevenths;
      if (T.frames && T.framesSongId === T.song.id) {
        T.song.result = CE.decode(T.frames, { sevenths: T.sevenths }); persistSong();
        toast('Recalculado ' + (T.sevenths ? 'con séptimas' : 'solo con acordes simples'));
      } else toast('Se aplicará en la próxima canción que analices');
      renderPlayer();
    };
    $('tr-copy').onclick = copyText;
    $('tr-share').onclick = shareText;
    $('tr-delete').onclick = () => deleteSong(T.song.id);
    $('tr-offset').oninput = (e) => setOffset(parseFloat(e.target.value));
    $('tr-off-minus').onclick = () => setOffset((T.song.offset || 0) - 0.5);
    $('tr-off-plus').onclick = () => setOffset((T.song.offset || 0) + 0.5);
    $('tr-pop').onclick = (e) => { if (e.target.id === 'tr-pop') $('tr-pop').classList.add('hidden'); };

    $('tr-link').onclick = captureFromLink;
    document.addEventListener('visibilitychange', () => {
      const AC = nativeAC();
      if (document.visibilityState === 'visible' && T.listening && AC) {
        AC.status().then((st) => { if (st && !st.running && T.listening) stopNative(false); }).catch(() => { /* noop */ });
      }
    });

    renderLibrary();
  });

  window.StudioTranscribe = { T, PL, showView, showSub };
})();
