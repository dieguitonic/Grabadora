// Prueba de punta a punta: Chrome headless con micrófono simulado, reconocimiento de voz simulado
// y la función real /api/transcribe apuntando a un Whisper simulado.
// Uso: node tests/e2e.mjs   (requiere playwright y Chrome; ajustar CHROME si está en otra ruta)
import http from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { Readable } from 'node:stream';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const CHROME = process.env.CHROME || '/usr/bin/google-chrome';
const require = createRequire(import.meta.url);
const { chromium } = require(require.resolve('playwright', { paths: [process.cwd(), '/opt/npm-tools/node_modules'] }));
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'test-results');
await mkdir(OUT, { recursive: true });

const results = [];
const check = (name, ok, extra = '') => { results.push([name, !!ok]); console.log(`${ok ? 'True ' : 'False'}  ${name}${extra ? ' — ' + extra : ''}`); };
const step = async (name, fn) => { try { await fn(); } catch (e) { check(name, false, String(e.message).split('\n')[0]); } };

/* ---------- Whisper simulado ---------- */
let calls = 0;
const upstream = http.createServer((req, res) => {
  let size = 0;
  req.on('data', (c) => { size += c.length; });
  req.on('end', () => {
    calls += 1;
    const ok = req.headers.authorization === 'Bearer fake-key' && size > 500;
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

/* ---------- Servidor estático + API real ---------- */
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

/* ---------- Reconocimiento de voz simulado: deja una frase a medias hasta que lo frenan ---------- */
const FAKE_SR = () => {
  class FakeSR {
    start() {
      this.t = setTimeout(() => this.emit('esto es lo último que dije antes de pausar', false), 600);
    }
    emit(text, isFinal) {
      const r = [{ transcript: text }]; r.isFinal = isFinal;
      this.onresult?.({ resultIndex: 0, results: [r] });
    }
    stop() { clearTimeout(this.t); setTimeout(() => { this.emit('Esto es lo último que dije antes de pausar.', true); this.onend?.(); }, 150); }
    abort() { clearTimeout(this.t); setTimeout(() => this.onend?.(), 10); }
  }
  window.webkitSpeechRecognition = FakeSR;
  window.SpeechRecognition = FakeSR;
};

const browser = await chromium.launch({
  executablePath: CHROME, headless: true,
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
});
const errors = [];
const watch = (p) => {
  p.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  p.on('pageerror', (e) => errors.push(e.message));
  p.on('response', (r) => { if (r.status() === 404) errors.push('404 ' + r.url()); });
};
const countChunks = (p) => p.evaluate(() => new Promise((res) => { const r = indexedDB.open('acta'); r.onsuccess = () => { const q = r.result.transaction('chunks').objectStore('chunks').count(); q.onsuccess = () => res(q.result); }; }));
const getAll = (p, store) => p.evaluate((s) => new Promise((res) => { const r = indexedDB.open('acta'); r.onsuccess = () => { const q = r.result.transaction(s).objectStore(s).getAll(); q.onsuccess = () => res(q.result.map((x) => { const o = { ...x }; delete o.buf; return o; })); }; }), store);
const state = (p) => p.evaluate(() => window.__acta.R.state);
const stopRec = async (p) => { await p.click('#btn-stop'); await p.click('#dlg button[value="ok"]'); await p.waitForSelector('#v-detail:not([hidden]) #d-continue', { timeout: 20000 }); };
const setHidden = (p, hidden) => p.evaluate((h) => {
  Object.defineProperty(document, 'visibilityState', { value: h ? 'hidden' : 'visible', configurable: true });
  Object.defineProperty(document, 'hidden', { value: h, configurable: true });
  document.dispatchEvent(new Event('visibilitychange'));
}, hidden);

/* =========================================================
   A) TELÉFONO (390 × 844, táctil)
   ========================================================= */
const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, permissions: ['microphone'] });
await phone.addInitScript(FAKE_SR);
let page = await phone.newPage(); watch(page);
await page.goto(BASE);
await page.evaluate(() => localStorage.setItem('acta.settings', JSON.stringify({ token: 'test-token', segSec: 20, live: true })));
await page.reload();
await page.waitForSelector('#btn-start');
await page.screenshot({ path: `${OUT}/01-inicio-390.png`, fullPage: true });

await step('Grabación básica', async () => {
  await page.tap('#btn-start');
  await page.waitForSelector('#live:not([hidden])');
  await page.waitForTimeout(5000);
  check('Graba y guarda trozos cada 2 s', (await countChunks(page)) >= 4, `${await countChunks(page)} trozos`);
  const ms = await page.evaluate(() => [navigator.mediaSession.playbackState, navigator.mediaSession.metadata?.title]);
  check('Notificación del sistema con controles (grabando)', ms[0] === 'playing' && /Grabando/.test(ms[1]), ms.join(' / '));
});

await step('Pausa sin perder la frase en curso', async () => {
  await page.waitForFunction(() => !document.querySelector('#interim').hidden, null, { timeout: 5000 });
  await page.tap('#btn-pause');
  await page.waitForTimeout(800);
  const lines = await getAll(page, 'lines');
  const kept = lines.some((l) => /ultimo que dije|último que dije/i.test(l.text));
  check('Al pausar se guarda lo último que se estaba diciendo', kept, `${lines.length} línea(s)`);
  check('No se duplica la frase cuando llega el resultado final', lines.filter((l) => /que dije/i.test(l.text)).length === 1);
  check('La frase queda visible en pantalla', /que dije antes de pausar/.test(await page.textContent('#live-t')));
  const segs = await getAll(page, 'segments');
  check('Al pausar, el bloque se cierra para transcribirse ya', segs.length === 1 && segs[0].status !== 'recording', segs.map((s) => s.status).join(','));
  const ms = await page.evaluate(() => navigator.mediaSession.playbackState);
  check('Notificación pasa a "en pausa"', ms === 'paused');
  const t1 = await page.textContent('#timer'); await page.waitForTimeout(2200); const t2 = await page.textContent('#timer');
  check('El contador no avanza en pausa', t1 === t2, `${t1} = ${t2}`);
  await page.tap('#btn-pause');
  await page.waitForTimeout(500);
  check('Continuar retoma la grabación y abre un bloque nuevo', (await state(page)) === 'recording' && (await getAll(page, 'segments')).some((s) => s.status === 'recording'));
});

await step('Transcripción por bloques', async () => {
  await page.tap('#btn-mark');
  await page.waitForTimeout(26000);
  const segs = await getAll(page, 'segments');
  const done = segs.filter((s) => s.status === 'done').length;
  check('Rota bloques y los transcribe con la API real', done >= 2, `${segs.length} bloques, ${done} transcriptos`);
  const panel = await page.textContent('#live-t');
  check('El texto final aparece en pantalla', /relevamiento del proceso/.test(panel));
  check('Filtra frases inventadas por Whisper', !/Amara/.test(panel));
  check('La marca se ve en la transcripción', /Marca/.test(panel));
  await page.screenshot({ path: `${OUT}/02-grabando-390.png` });
});

await step('Segundo plano', async () => {
  const before = await countChunks(page);
  await setHidden(page, true);
  await page.waitForTimeout(23000);
  const during = await countChunks(page);
  check('Sigue guardando audio con la app en segundo plano', during - before >= 18, `${during - before} trozos nuevos en 23 s`);
  await setHidden(page, false);
  await page.waitForTimeout(3200);
  const toast = await page.textContent('#toast');
  check('Al volver avisa que siguió grabando (sin falsos cortes)', /Siguió grabando/.test(toast), toast);
  const marks = await getAll(page, 'marks');
  check('No marca cortes inexistentes', !marks.some((m) => /segundo plano/.test(m.text)));
});

await step('App congelada por el sistema', async () => {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Page.setWebLifecycleState', { state: 'frozen' });
  await new Promise((r) => setTimeout(r, 8000));
  await cdp.send('Page.setWebLifecycleState', { state: 'active' });
  await page.waitForTimeout(5000);
  const a = await countChunks(page); await page.waitForTimeout(4500); const b = await countChunks(page);
  check('Tras un congelamiento sigue grabando sola', (await state(page)) === 'recording' && b > a, `${a} → ${b} trozos`);
});

await step('Cierre abrupto y recuperación', async () => {
  const beforeChunks = await countChunks(page);
  await page.close({ runBeforeUnload: false });
  page = await phone.newPage(); watch(page);
  await page.goto(BASE);
  await page.waitForSelector('#recovery .banner', { timeout: 8000 });
  const s = (await getAll(page, 'sessions'))[0];
  check('Recupera la grabación tras el cierre', s.status === 'interrupted' && s.durationMs > 50000, `${s.status}, ${Math.round(s.durationMs / 1000)} s`);
  check('No se perdió ningún trozo guardado', (await countChunks(page)) >= beforeChunks, `${beforeChunks} → ${await countChunks(page)}`);
  await page.screenshot({ path: `${OUT}/03-recuperada-390.png`, fullPage: true });
  await page.tap('[data-resume]');
  await page.waitForSelector('#live:not([hidden])');
  await page.waitForTimeout(3000);
  check('"Seguir grabando" desde el aviso', (await state(page)) === 'recording');
  await stopRec(page);
});

await step('Continuar muchas veces', async () => {
  for (let i = 1; i <= 4; i++) {
    await page.tap('#d-continue');
    await page.waitForSelector('#live:not([hidden])');
    await page.waitForTimeout(3000);
    if ((await state(page)) !== 'recording') { check(`Continuar vez ${i}`, false); return; }
    await stopRec(page);
  }
  const s = (await getAll(page, 'sessions'))[0];
  check('Se puede continuar la misma reunión todas las veces que haga falta', s.parts.length >= 6, `${s.parts.length} partes`);
});

await step('Detalle', async () => {
  await page.waitForTimeout(6000);
  const s = (await getAll(page, 'sessions'))[0];
  const segs = await getAll(page, 'segments');
  check('Todos los bloques quedan transcriptos', segs.every((g) => g.status === 'done'), `${segs.length} bloques`);
  check('Etiquetado automático por tema', (s.tags || []).includes('CRM') && (s.tags || []).includes('Precios'), (s.tags || []).join(', '));
  const dur = await page.evaluate(() => new Promise((res) => {
    const a = document.querySelector('#d-audio');
    const done = () => res(a.duration);
    if (a.duration && a.duration !== Infinity) done(); else { a.addEventListener('durationchange', () => { if (a.duration !== Infinity) done(); }); setTimeout(done, 5000); }
  }));
  check('El audio se reproduce y tiene duración', dur > 20 && dur !== Infinity, `${Math.round(dur)} s`);
  await page.tap('[data-part="2"]');
  await page.waitForTimeout(800);
  check('Cambiar de parte carga otro audio', await page.evaluate(() => document.querySelector('[data-part="2"]').getAttribute('aria-pressed') === 'true'));
  const line = await page.$('#d-transcript button.line');
  await line.tap();
  await page.waitForTimeout(800);
  check('Tocar una línea lleva al audio de ese momento', await page.evaluate(() => !document.querySelector('#d-audio').paused || document.querySelector('#d-audio').currentTime >= 0));
  check('La transcripción muestra lo dicho antes de pausar', /que dije antes de pausar/.test(await page.textContent('#d-transcript')));
  await page.screenshot({ path: `${OUT}/04-detalle-390.png`, fullPage: true });
});

await step('Historial', async () => {
  await page.tap('.tab[data-go="list"]');
  await page.fill('#search', 'abono');
  await page.waitForTimeout(400);
  check('Búsqueda dentro de la transcripción', (await page.$$('#list .item')).length === 1);
  await page.fill('#search', 'zzz');
  await page.waitForTimeout(400);
  check('Búsqueda sin resultados', (await page.$$('#list .item')).length === 0);
  await page.fill('#search', '');
  check('Sin scroll horizontal a 390 px', !(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)));
});

/* =========================================================
   B) PC con ventana baja (1408 × 400): el error del scroll
   ========================================================= */
const pc = await browser.newContext({ viewport: { width: 1408, height: 400 }, permissions: ['microphone'] });
await pc.addInitScript(FAKE_SR);
const pp = await pc.newPage(); watch(pp);
await pp.goto(BASE);
await pp.evaluate(() => localStorage.setItem('acta.settings', JSON.stringify({ token: 'test-token', segSec: 20, live: true })));
await pp.reload();
await step('PC', async () => {
  for (let i = 0; i < 3; i++) {
    await pp.click('.tab[data-go="rec"]');
    await pp.click('#btn-start');
    await pp.waitForTimeout(2500);
    await stopRec(pp);
  }
  await pp.click('#d-continue'); // en ventana baja el botón no debe quedar tapado
  await pp.waitForTimeout(2000);
  check('PC: "Seguir grabando" accesible con ventana baja', (await state(pp)) === 'recording');
  await stopRec(pp);
  await pp.click('.tab[data-go="rec"]');
  await pp.waitForTimeout(400);
  await pp.mouse.wheel(0, 6000);
  await pp.waitForTimeout(400);
  const m = await pp.evaluate(() => ({ last: [...document.querySelectorAll('#recent li')].pop().getBoundingClientRect().bottom, nav: document.querySelector('.tabs').getBoundingClientRect().top }));
  check('PC: se puede bajar hasta la última grabación', m.last <= m.nav, `fin ${Math.round(m.last)} px, barra ${Math.round(m.nav)} px`);
  await pp.screenshot({ path: `${OUT}/05-inicio-pc-ventana-baja.png` });
  await pp.setViewportSize({ width: 1440, height: 900 });
  await pp.click('.tab[data-go="settings"]');
  await pp.click('#btn-test');
  await pp.waitForTimeout(800);
  check('PC: probar conexión con la API', /Conectado/.test(await pp.textContent('#test-out')));
  await pp.click('.tab[data-go="list"]');
  await pp.screenshot({ path: `${OUT}/06-historial-1440.png`, fullPage: true });
});

/* =========================================================
   C) ANDROID con ajustes de la versión anterior: micrófono natural y sin vivo
   ========================================================= */
const droid = await browser.newContext({
  viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, permissions: ['microphone'],
  userAgent: 'Mozilla/5.0 (Linux; Android 14; SM-A546E) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36',
});
await droid.addInitScript(FAKE_SR);
await droid.addInitScript(() => {
  window.__gum = [];
  const orig = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  navigator.mediaDevices.getUserMedia = (c) => { window.__gum.push(c); return orig(c); };
});
const dp = await droid.newPage(); watch(dp);
await dp.goto(BASE);
await dp.evaluate(() => localStorage.setItem('acta.settings', JSON.stringify({ token: 'test-token', live: true, segSec: 120 })));
await dp.reload();
await step('Android', async () => {
  const st = await dp.evaluate(() => JSON.parse(localStorage.getItem('acta.settings')));
  check('Android: los ajustes viejos se actualizan (vivo apagado, mic natural, bloques 1 min)', st.live === false && st.micMode === 'natural' && st.segSec === 60 && st.token === 'test-token', JSON.stringify({ live: st.live, mic: st.micMode, seg: st.segSec }));
  await dp.tap('#btn-start');
  await dp.waitForSelector('#live:not([hidden])');
  await dp.waitForTimeout(3000);
  const c = await dp.evaluate(() => window.__gum.at(-1).audio);
  check('Android: el micrófono se abre sin modo llamada', c.echoCancellation === false && c.noiseSuppression === false && c.autoGainControl === false, JSON.stringify(c));
  check('Android: el medidor de nivel recibe la señal del micrófono natural', await dp.evaluate(() => window.__acta.R.analyserOk === true));
  check('Android: no usa el reconocimiento en vivo durante la grabación', await dp.evaluate(() => !window.__acta.R.state || !document.querySelector('#interim') || document.querySelector('#interim').hidden));
  await stopRec(dp);
  await dp.tap('.tab[data-go="settings"]');
  await dp.tap('#btn-mictest');
  await dp.waitForSelector('#mictest-audio:not([hidden])', { timeout: 12000 });
  const d = await dp.evaluate(() => new Promise((res) => { const a = document.querySelector('#mictest-audio'); if (a.duration > 0 && a.duration !== Infinity) res(a.duration); else { a.currentTime = 1e9; a.addEventListener('durationchange', () => res(a.duration), { once: true }); setTimeout(() => res(a.duration), 3000); } }));
  check('Prueba de micrófono: graba y se puede escuchar', d > 4, `${Math.round(d)} s`);
  await dp.screenshot({ path: `${OUT}/07-ajustes-android.png`, fullPage: true });
});

const bad = await fetch(BASE + 'api/transcribe', { headers: { 'x-app-token': 'mala' } });
check('La API rechaza una clave incorrecta (401)', bad.status === 401);
const relevant = errors.filter((e) => !/speech|recognition/i.test(e));
check('Consola sin errores ni 404', relevant.length === 0, relevant.slice(0, 3).join(' | '));

await browser.close(); server.close(); upstream.close();
const failed = results.filter((r) => !r[1]).length;
console.log(`\n${results.length - failed}/${results.length} comprobaciones en True`);
process.exit(failed ? 1 : 0);
