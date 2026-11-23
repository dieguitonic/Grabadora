// Prueba de punta a punta: Chrome headless con micrófono simulado + la función real /api/transcribe
// apuntando a un Whisper simulado. Uso: node tests/e2e.mjs   (requiere playwright y Chrome)
import http from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { Readable } from 'node:stream';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require(require.resolve('playwright', { paths: [process.cwd(), '/opt/npm-tools/node_modules'] }));
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'test-results');
await mkdir(OUT, { recursive: true });

const results = [];
const check = (name, ok, extra = '') => { results.push([name, !!ok]); console.log(`${ok ? 'True ' : 'False'}  ${name}${extra ? ' — ' + extra : ''}`); };

// 1) Whisper simulado
let calls = 0;
const upstream = http.createServer((req, res) => {
  let size = 0;
  req.on('data', (c) => { size += c.length; });
  req.on('end', () => {
    calls += 1;
    const ok = req.headers.authorization === 'Bearer fake-key' && size > 1000;
    res.writeHead(ok ? 200 : 400, { 'content-type': 'application/json' });
    res.end(JSON.stringify(ok ? {
      text: 'x', duration: 20,
      segments: [
        { start: 0.5, end: 6, text: ` Bloque ${calls}: hacemos el relevamiento del proceso y el seguimiento de clientes en el CRM.`, no_speech_prob: 0.01, avg_logprob: -0.2, compression_ratio: 1.3 },
        { start: 7, end: 9, text: 'Subtítulos realizados por la comunidad de Amara.org', no_speech_prob: 0.3, avg_logprob: -0.6 },
        { start: 10, end: 16, text: ' Hablamos del precio del abono mensual y del presupuesto.', no_speech_prob: 0.02, avg_logprob: -0.25 },
      ],
    } : { error: { message: 'bad' } }));
  });
}).listen(0);
process.env.STT_BASE_URL = `http://127.0.0.1:${upstream.address().port}`;
process.env.STT_API_KEY = 'fake-key';
process.env.APP_TOKEN = 'test-token';
const api = await import(path.join(ROOT, 'api/transcribe.js'));

// 2) Servidor estático + API real
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png' };
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/api/transcribe') {
    const r = new Request(url, { method: req.method, headers: req.headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : Readable.toWeb(req), duplex: 'half' });
    const out = await (api[req.method] ? api[req.method](r) : new Response('', { status: 405 }));
    res.writeHead(out.status, Object.fromEntries(out.headers));
    res.end(Buffer.from(await out.arrayBuffer()));
    return;
  }
  const file = path.join(ROOT, url.pathname === '/' ? 'index.html' : url.pathname);
  try { const b = await readFile(file); res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' }); res.end(b); }
  catch { res.writeHead(404); res.end('404'); }
}).listen(0);
const BASE = `http://localhost:${server.address().port}/`;

// 3) Navegador
const browser = await chromium.launch({
  executablePath: '/usr/bin/google-chrome', headless: true,
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
});
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, permissions: ['microphone'] });
const errors = [];
const watch = (p) => {
  p.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  p.on('pageerror', (e) => errors.push(e.message));
  p.on('response', (r) => { if (r.status() === 404) errors.push('404 ' + r.url()); });
};
let page = await ctx.newPage(); watch(page);
await page.goto(BASE);
await page.evaluate(() => localStorage.setItem('acta.settings', JSON.stringify({ token: 'test-token', segSec: 20, live: true })));
await page.reload();
await page.waitForSelector('#btn-start');
await page.screenshot({ path: `${OUT}/01-inicio-390.png`, fullPage: true });

const dbq = (p, fn) => p.evaluate(fn);
const countChunks = (p) => dbq(p, () => new Promise((res) => { const r = indexedDB.open('acta'); r.onsuccess = () => { const q = r.result.transaction('chunks').objectStore('chunks').count(); q.onsuccess = () => res(q.result); }; }));
const getAll = (p, store) => p.evaluate((s) => new Promise((res) => { const r = indexedDB.open('acta'); r.onsuccess = () => { const q = r.result.transaction(s).objectStore(s).getAll(); q.onsuccess = () => res(q.result.map((x) => { const o = { ...x }; delete o.buf; return o; })); }; }), store);

// Grabar
await page.click('#btn-start');
await page.waitForSelector('#live:not([hidden])');
await page.waitForTimeout(5000);
check('Graba y guarda trozos cada 2 s en IndexedDB', (await countChunks(page)) >= 4, `${await countChunks(page)} trozos`);
await page.click('#btn-mark');
await page.waitForTimeout(41000);
let segs = await getAll(page, 'segments');
const done1 = segs.filter((s) => s.status === 'done').length;
check('Rota bloques y los transcribe con la API real', done1 >= 1, `${segs.length} bloques, ${done1} transcriptos, ${calls} llamadas`);
const panel = await page.textContent('#live-t');
check('El texto final aparece en vivo en pantalla', /relevamiento del proceso/.test(panel));
check('Filtra alucinaciones de Whisper', !/Amara/.test(panel));
check('La marca se ve en la transcripción', /Marca/.test(panel));
await page.screenshot({ path: `${OUT}/02-grabando-390.png` });

// Simular cierre abrupto (pestaña matada)
const beforeChunks = await countChunks(page);
await page.close({ runBeforeUnload: false });
page = await ctx.newPage(); watch(page);
await page.goto(BASE);
await page.waitForSelector('#recovery .banner', { timeout: 8000 });
const sess = (await getAll(page, 'sessions'))[0];
check('Recupera la grabación tras el cierre', sess.status === 'interrupted' && sess.durationMs > 40000, `estado ${sess.status}, ${Math.round(sess.durationMs / 1000)} s`);
check('No se perdió ningún trozo guardado', (await countChunks(page)) >= beforeChunks, `${beforeChunks} → ${await countChunks(page)}`);
await page.screenshot({ path: `${OUT}/03-recuperada-390.png`, fullPage: true });

// Seguir grabando en la misma, pausar, continuar, terminar
await page.click('[data-resume]');
await page.waitForSelector('#live:not([hidden])');
await page.waitForTimeout(4000);
await page.click('#btn-pause');
const paused = await page.evaluate(() => window.__acta.R.state);
const t1 = await page.textContent('#timer');
await page.waitForTimeout(2500);
const t2 = await page.textContent('#timer');
check('Pausa detiene el contador', paused === 'paused' && t1 === t2, `${t1} = ${t2}`);
await page.click('#btn-pause');
await page.waitForTimeout(3000);
check('Continúa grabando', (await page.evaluate(() => window.__acta.R.state)) === 'recording');
await page.click('#btn-stop');
await page.click('#dlg button[value="ok"]');
await page.waitForSelector('#v-detail:not([hidden]) #d-audio', { timeout: 15000 });
await page.waitForTimeout(6000);
const s2 = (await getAll(page, 'sessions'))[0];
check('Sesión terminada con 2 partes de audio', s2.status === 'stopped' && s2.parts.length === 2, `${s2.parts.length} partes`);
segs = await getAll(page, 'segments');
check('Todos los bloques quedan transcriptos', segs.every((s) => s.status === 'done'), segs.map((s) => s.status).join(','));
check('Etiquetado automático por tema', (s2.tags || []).includes('CRM') && (s2.tags || []).includes('Precios'), (s2.tags || []).join(', '));
check('Título automático con temas', /CRM|Relevamiento|Precios/.test(s2.title), s2.title);
const dur = await page.evaluate(() => new Promise((res) => {
  const a = document.querySelector('#d-audio');
  const done = () => res(a.duration);
  if (a.duration && a.duration !== Infinity) done(); else { a.addEventListener('durationchange', () => { if (a.duration !== Infinity) done(); }); setTimeout(done, 5000); }
}));
check('El audio guardado se reproduce y tiene duración', dur > 30 && dur !== Infinity, `${Math.round(dur)} s`);
const lines = await page.$$eval('#d-transcript .line', (n) => n.length);
check('La transcripción del detalle tiene líneas con hora', lines >= 3, `${lines} líneas`);
await page.screenshot({ path: `${OUT}/04-detalle-390.png`, fullPage: true });

// Historial + búsqueda
await page.click('.tab[data-go="list"]');
await page.fill('#search', 'abono');
await page.waitForTimeout(400);
check('Búsqueda dentro de la transcripción', (await page.$$('#list .item')).length === 1);
await page.fill('#search', 'zzz');
await page.waitForTimeout(400);
check('Búsqueda sin resultados', (await page.$$('#list .item')).length === 0);
await page.fill('#search', '');
await page.waitForTimeout(300);
await page.screenshot({ path: `${OUT}/05-historial-390.png`, fullPage: true });

// Desbordes horizontales en 390
const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
check('Sin scroll horizontal a 390 px', !overflow);

// Escritorio
await page.setViewportSize({ width: 1440, height: 900 });
await page.click('.tab[data-go="rec"]');
await page.screenshot({ path: `${OUT}/06-inicio-1440.png`, fullPage: true });
await page.click('.tab[data-go="settings"]');
await page.click('#btn-test');
await page.waitForTimeout(800);
check('Probar conexión con la API', /Conectado/.test(await page.textContent('#test-out')));
await page.screenshot({ path: `${OUT}/07-ajustes-1440.png`, fullPage: true });

// API: rechaza clave incorrecta
const bad = await fetch(BASE + 'api/transcribe', { headers: { 'x-app-token': 'mala' } });
check('La API rechaza una clave incorrecta (401)', bad.status === 401);

const relevant = errors.filter((e) => !/speech|recognition|network/i.test(e));
check('Consola sin errores ni 404', relevant.length === 0, relevant.slice(0, 3).join(' | '));

await browser.close(); server.close(); upstream.close();
const failed = results.filter((r) => !r[1]).length;
console.log(`\n${results.length - failed}/${results.length} comprobaciones en True`);
process.exit(failed ? 1 : 0);
