// Genera las capturas de la app (datos de ejemplo) con Edge sin interfaz y emulación de móvil.
// Uso: node promo/capturar.mjs   (requiere `node scripts/serve.js` en marcha en el puerto 8123)
import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const out = join(dirname(fileURLToPath(import.meta.url)), 'capturas');
mkdirSync(out, { recursive: true });
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9333;
const edge = spawn(EDGE, ['--headless=new', '--disable-gpu', `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${process.env.TEMP}\\studiotune-promo-edge`, '--autoplay-policy=no-user-gesture-required', 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let page;
for (let i = 0; i < 40 && !page; i++) {
  try { page = (await (await fetch(`http://localhost:${PORT}/json`)).json()).find((p) => p.type === 'page'); } catch (e) { /* aún no */ }
  if (!page) await sleep(250);
}
if (!page) { edge.kill(); throw new Error('Edge no arrancó'); }
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let nextId = 1; const pending = new Map();
ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); } };
const send = (method, params = {}) => new Promise((res) => { const id = nextId++; pending.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
const ev = async (expr) => { const r = await send('Runtime.evaluate', { expression: `(async()=>{${expr}})()`, awaitPromise: true, returnByValue: true }); if (r.result.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 400)); return r.result.result.value; };
const shot = async (name) => { const r = await send('Page.captureScreenshot', { format: 'png' }); writeFileSync(join(out, name + '.png'), Buffer.from(r.result.data, 'base64')); console.log('captura', name); };

await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
await send('Emulation.setTouchEmulationEnabled', { enabled: true });
await send('Page.navigate', { url: 'http://localhost:8123/' });
await sleep(2500);
await ev('localStorage.clear(); indexedDB.deleteDatabase("studiotune");');
await send('Page.navigate', { url: 'http://localhost:8123/' });
await sleep(2500);

// 1) Afinador en modo demo, afinado
await ev(`
  document.getElementById('btn-sim').click(); await new Promise(r=>setTimeout(r,300));
  state.simStringIndex = 2; updateSimCents(0);
  [0,1].forEach(i=>state.tunedStrings.add(i)); renderStringButtons();
  document.getElementById('sim-cents-slider').value = 0;
  await new Promise(r=>setTimeout(r,2600));`);
await shot('afinador');
await ev(`window.scrollTo(0, 600); await new Promise(r=>setTimeout(r,300));`);
await shot('afinador-cuerdas');
await ev(`toggleSimulationMode(false); window.scrollTo(0,0);`);

// 2) Transcribir: añadir canción
await ev(`document.getElementById('tab-transcribe').click(); await new Promise(r=>setTimeout(r,400)); document.getElementById('tr-add').click(); await new Promise(r=>setTimeout(r,400)); window.scrollTo(0,0);`);
await shot('anadir');

// 3) Canción de ejemplo → reproductor
await ev(`document.getElementById('tr-demo').click(); await new Promise(r=>setTimeout(r,5000));`);
await ev(`document.getElementById('pl-strip').children[2].click(); await new Promise(r=>setTimeout(r,700)); window.scrollTo(0,0);`);
await shot('reproductor');
await ev(`document.getElementById('pl-strip').children[5].click(); await new Promise(r=>setTimeout(r,700));`);
await shot('reproductor-2');

// 4) Hoja de diagramas y opciones
await ev(`document.getElementById('tr-used').scrollIntoView({block:'start'}); window.scrollBy(0,-90); await new Promise(r=>setTimeout(r,500));`);
await shot('diagramas');

// 5) Tono transpuesto +2 (audio y diagramas)
await ev(`window.scrollTo(0,0); document.getElementById('tr-tr-plus').click(); document.getElementById('tr-tr-plus').click(); await new Promise(r=>setTimeout(r,2500)); document.getElementById('pl-strip').children[2].click(); await new Promise(r=>setTimeout(r,500));`);
await ev(`document.getElementById('tr-used').scrollIntoView({block:'start'}); window.scrollBy(0,-90); await new Promise(r=>setTimeout(r,400));`);
await shot('diagramas-transpuesto');

ws.close(); edge.kill();
process.exit(0);
