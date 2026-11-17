// Ejecuta JavaScript en la página de la app dentro del teléfono (WebView con depuración remota).
// Uso: node test/cdp.mjs "<expresión async>"   (antes: adb forward tcp:9222 localabstract:webview_devtools_remote_<pid>)
const expr = process.argv[2];
const list = await (await fetch('http://localhost:9222/json')).json();
const page = list.find((p) => p.type === 'page');
if (!page) { console.error('sin página'); process.exit(1); }
const ws = new WebSocket(page.webSocketDebuggerUrl.replace('localhost:9222', 'localhost:9222'));
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
const send = (method, params) => new Promise((res) => {
  const id = Math.floor(Math.random() * 1e9);
  const h = (m) => { const d = JSON.parse(m.data); if (d.id === id) { ws.removeEventListener('message', h); res(d); } };
  ws.addEventListener('message', h); ws.send(JSON.stringify({ id, method, params }));
});
const r = await send('Runtime.evaluate', { expression: `(async()=>{ ${expr} })()`, awaitPromise: true, returnByValue: true, timeout: 120000 });
if (r.result && r.result.exceptionDetails) console.log('ERROR:', JSON.stringify(r.result.exceptionDetails.exception || r.result.exceptionDetails).slice(0, 600));
else console.log(JSON.stringify(r.result.result.value));
ws.close();
