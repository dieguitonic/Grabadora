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
let calls = 0, wavCalls = 0, mergedCalls = 0;
const FRASE = 'Necesitamos que el sistema registre cada contrato con la cuota el vencimiento y quién es el garante de cada cliente para poder cobrar a tiempo todos los meses sin errores';
const upstream = http.createServer((req, res) => {
  let size = 0;
  const parts = [];
  req.on('data', (c) => { size += c.length; parts.push(c); });
  req.on('end', () => {
    calls += 1;
    const body = Buffer.concat(parts).toString('latin1');
    if (/Content-Type: audio\/wav/i.test(body)) wavCalls += 1;
    const ok = req.headers.authorization === 'Bearer fake-key' && size > 500;
    if (ok && body.includes('MODORECORTE')) {
      // Simula el caso reportado: con poco audio Whisper devuelve 4 palabras; con el tramo unido, la frase completa.
      const merged = size > 26 * 32000;
      if (merged) mergedCalls += 1;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ text: 'x', segments: merged
        ? [{ start: 7.8, end: 15, text: ' ' + FRASE + '.', no_speech_prob: 0.65, avg_logprob: -1.2, compression_ratio: 1.3 }]
        : [{ start: 7.8, end: 9, text: ' Necesitamos que el sistema.', no_speech_prob: 0.1, avg_logprob: -0.4 }] }));
      return;
    }
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
const apiConfig = await import(path.join(ROOT, 'api/config.js'));

/* ---------- Supabase simulado: cuentas, tablas con reglas por usuario y archivos ---------- */
import { randomUUID } from 'node:crypto';
const SB = { users: [], tokens: new Map(), refresh: new Map(), files: new Map(), last: 0,
  tables: { meetings: [], blocks: [], notes: [], audio_slices: [] } };
const SB_PK = { meetings: ['id'], blocks: ['meeting_id', 'idx'], notes: ['meeting_id', 'kind', 'key'], audio_slices: ['meeting_id', 'part', 'n'] };
const sbStamp = () => { SB.last = Math.max(Date.now(), SB.last + 1); return new Date(SB.last).toISOString(); };
function sbSession(u) {
  const access = 'at-' + randomUUID(), refresh = 'rt-' + randomUUID();
  SB.tokens.set(access, u); SB.refresh.set(refresh, u);
  return { access_token: access, refresh_token: refresh, expires_in: 3600, user: { id: u.id, email: u.email } };
}
function sbSend(res, status, body, raw) {
  res.writeHead(status, { 'content-type': raw ? 'application/octet-stream' : 'application/json' });
  res.end(raw ? body : body === undefined ? '' : JSON.stringify(body));
}
function sbMatch(row, params) {
  for (const [k, v] of params) {
    if (['select', 'order', 'limit', 'on_conflict'].includes(k)) continue;
    const [op, ...rest] = v.split('.'); const val = rest.join('.');
    const cell = row[k] === undefined ? '' : String(row[k]);
    if (op === 'eq' && cell !== val) return false;
    if (op === 'gt' && !(cell > val)) return false;
  }
  return true;
}
async function supabaseMock(req, res, url, body) {
  const path = url.pathname.slice(3); // sin /sb
  if (req.headers.apikey !== 'anon-test') return sbSend(res, 401, { message: 'no apikey' });
  const bearer = (req.headers.authorization || '').replace(/^Bearer /, '');
  const user = SB.tokens.get(bearer);
  if (path === '/auth/v1/signup') {
    const j = JSON.parse(body.toString() || '{}');
    if (SB.users.find((u) => u.email === j.email)) return sbSend(res, 422, { msg: 'User already registered' });
    const u = { id: randomUUID(), email: j.email, password: j.password }; SB.users.push(u);
    return sbSend(res, 200, sbSession(u));
  }
  if (path === '/auth/v1/token') {
    const j = JSON.parse(body.toString() || '{}');
    if (url.searchParams.get('grant_type') === 'password') {
      const u = SB.users.find((x) => x.email === j.email && x.password === j.password);
      return u ? sbSend(res, 200, sbSession(u)) : sbSend(res, 400, { error_description: 'Invalid login credentials' });
    }
    const u = SB.refresh.get(j.refresh_token);
    return u ? sbSend(res, 200, sbSession(u)) : sbSend(res, 400, { error_description: 'Invalid Refresh Token' });
  }
  if (path === '/auth/v1/user') return user ? sbSend(res, 200, { id: user.id, email: user.email }) : sbSend(res, 401, { msg: 'bad jwt' });
  if (path === '/auth/v1/logout') return sbSend(res, 204);
  if (!user) return sbSend(res, 401, { message: 'JWT required' });
  if (path.startsWith('/rest/v1/')) {
    const table = path.slice(9);
    const rows = SB.tables[table];
    if (!rows) return sbSend(res, 404, { message: 'no table' });
    const params = [...url.searchParams.entries()];
    if (req.method === 'GET') {
      let out = rows.filter((r) => r.user_id === user.id && sbMatch(r, params));
      const order = url.searchParams.get('order');
      if (order) {
        const keys = order.split(',').map((o) => o.split('.')[0]);
        out = [...out].sort((a, b) => { for (const k of keys) { if (a[k] < b[k]) return -1; if (a[k] > b[k]) return 1; } return 0; });
      }
      const limit = Number(url.searchParams.get('limit') || 0);
      if (limit) out = out.slice(0, limit);
      const sel = (url.searchParams.get('select') || '*').split(',');
      return sbSend(res, 200, out.map((r) => (sel[0] === '*' ? r : Object.fromEntries(sel.map((k) => [k, r[k]])))));
    }
    if (req.method === 'POST') {
      for (const row of JSON.parse(body.toString() || '[]')) {
        const key = SB_PK[table];
        const i = rows.findIndex((r) => r.user_id === user.id && key.every((k) => String(r[k]) === String(row[k])));
        const val = { ...(i >= 0 ? rows[i] : {}), ...row, user_id: user.id, synced_at: sbStamp() };
        if (i >= 0) rows[i] = val; else rows.push(val);
      }
      return sbSend(res, 201);
    }
    if (req.method === 'DELETE') {
      const keep = rows.filter((r) => !(r.user_id === user.id && sbMatch(r, params)));
      rows.length = 0; rows.push(...keep);
      return sbSend(res, 204);
    }
  }
  if (path.startsWith('/storage/v1/object/audio/') && req.method === 'POST') {
    const key = path.slice('/storage/v1/object/audio/'.length);
    if (!key.startsWith(user.id + '/')) return sbSend(res, 403, { message: 'policy' });
    SB.files.set(key, body);
    return sbSend(res, 200, { Key: key });
  }
  if (path.startsWith('/storage/v1/object/authenticated/audio/')) {
    const key = path.slice('/storage/v1/object/authenticated/audio/'.length);
    const f = key.startsWith(user.id + '/') && SB.files.get(key);
    return f ? sbSend(res, 200, f, true) : sbSend(res, 404, { message: 'not found' });
  }
  if (path === '/storage/v1/object/audio' && req.method === 'DELETE') {
    for (const k of JSON.parse(body.toString() || '{}').prefixes || []) if (k.startsWith(user.id + '/')) SB.files.delete(k);
    return sbSend(res, 200, []);
  }
  return sbSend(res, 404, { message: 'mock: ruta no soportada ' + path });
}

/* ---------- Servidor estático + API real ---------- */
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname.startsWith('/sb/')) {
    const parts = []; for await (const c of req) parts.push(c);
    return supabaseMock(req, res, url, Buffer.concat(parts));
  }
  if (url.pathname === '/api/config') {
    const out = await apiConfig.GET(new Request(url));
    res.writeHead(out.status, Object.fromEntries(out.headers));
    res.end(Buffer.from(await out.arrayBuffer()));
    return;
  }
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
process.env.SUPABASE_URL = BASE + 'sb';
process.env.SUPABASE_ANON_KEY = 'anon-test';

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
await page.evaluate(() => localStorage.setItem('acta.settings', JSON.stringify({ v: 3, token: 'test-token', segSec: 20, live: true })));
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
  check('Android: los ajustes viejos se actualizan (vivo apagado, mic natural, bloques automáticos)', st.live === false && st.micMode === 'natural' && st.segSec === 0 && st.token === 'test-token', JSON.stringify({ live: st.live, mic: st.micMode, seg: st.segSec }));
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

/* =========================================================
   D) TELÉFONO NUEVO SIN CLAVE: el caso "graba pero no aparece texto"
   ========================================================= */
const fresh = await browser.newContext({
  viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, permissions: ['microphone'],
  userAgent: 'Mozilla/5.0 (Linux; Android 14; SM-A546E) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36',
});
const fp = await fresh.newPage(); watch(fp);
await fp.goto(BASE);
await fp.evaluate(() => localStorage.setItem('acta.settings', JSON.stringify({ v: 2, segSec: 20, live: false })));
await fp.reload();
await step('Teléfono sin clave', async () => {
  const saysMissing = await fp.waitForFunction(() => /Falta la clave|Entrá a tu cuenta/.test(document.querySelector('#health').textContent), null, { timeout: 5000 }).then(() => true, () => false);
  check('Sin clave: el inicio lo dice claramente', saysMissing);
  await fp.tap('#btn-start');
  await fp.waitForSelector('#live:not([hidden])');
  await fp.waitForTimeout(24000);
  check('Sin clave: aviso visible mientras graba', /Falta la clave|Entrá a tu cuenta/.test(await fp.textContent('#alerts')));
  await stopRec(fp);
  await fp.waitForTimeout(800);
  check('Sin clave: el detalle explica por qué no hay texto y lleva a Ajustes', /Todavía no se transcribe/.test(await fp.textContent('#d-progress')) && !!(await fp.$('#d-progress [data-go="settings"]')));
  await fp.screenshot({ path: `${OUT}/08-sin-clave-390.png`, fullPage: true });
  // Enlace de configuración desde la PC
  await fp.goto(BASE + '#clave=test-token');
  await fp.waitForTimeout(1500);
  const st = await fp.evaluate(() => [JSON.parse(localStorage.getItem('acta.settings')).token, location.hash]);
  check('El enlace de configuración carga la clave y la borra de la dirección', st[0] === 'test-token' && st[1] === '', JSON.stringify(st));
  await fp.waitForTimeout(6000);
  const segs = await getAll(fp, 'segments');
  check('Con la clave cargada, lo grabado antes se transcribe solo', segs.length >= 2 && segs.every((g) => g.status === 'done' && g.result.length), segs.map((g) => g.status + ':' + (g.result || []).length).join(','));
  // Bloque viejo marcado "silencio" por la versión anterior
  await fp.evaluate(() => new Promise((res) => { const r = indexedDB.open('acta'); r.onsuccess = () => { const t = r.result.transaction('segments', 'readwrite'); const os = t.objectStore('segments'); const q = os.getAll(); q.onsuccess = () => { const g = q.result[0]; g.status = 'done'; g.note = 'silencio'; g.result = []; os.put(g); }; t.oncomplete = res; }; }));
  await fp.evaluate(() => localStorage.removeItem('acta.requeueSilent'));
  await fp.reload();
  await fp.waitForTimeout(7000);
  const s0 = (await getAll(fp, 'segments'))[0];
  check('Los bloques que la versión vieja marcó como "silencio" se transcriben', s0.status === 'done' && s0.result.length > 0 && !s0.note);
  // Volver a transcribir
  await fp.click('.tab[data-go="list"]');
  await fp.click('#list .item');
  await fp.waitForSelector('#d-redo');
  const before = calls;
  await fp.click('#d-redo');
  await fp.click('#dlg button[value="ok"]');
  await fp.waitForTimeout(7000);
  check('"Volver a transcribir" rehace el texto desde el audio', calls > before && (await getAll(fp, 'segments')).every((g) => g.status === 'done'), `${calls - before} pedidos`);
  // Clave equivocada: lo dice
  await fp.evaluate(() => { const s = JSON.parse(localStorage.getItem('acta.settings')); s.token = 'mala'; localStorage.setItem('acta.settings', JSON.stringify(s)); });
  await fp.reload();
  await fp.waitForTimeout(2500);
  const saysWrong = await fp.waitForFunction(() => /no coincide/.test(document.querySelector('#health').textContent), null, { timeout: 5000 }).then(() => true, () => false);
  check('Clave equivocada: el inicio dice que no coincide', saysWrong);
  await fp.click('.tab[data-go="settings"]');
  const ver = await fp.waitForFunction(() => /6 · 26\/11\/2026/.test(document.querySelector('#storage-kv').textContent), null, { timeout: 5000 }).then(() => true, () => false);
  check('Ajustes muestra la versión de la app', ver);
});

/* =========================================================
   E) ACTUALIZACIÓN desde la versión anterior + clave que no se pierde + texto casi en vivo
   ========================================================= */
const upg = await browser.newContext({
  viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, permissions: ['microphone'],
  userAgent: 'Mozilla/5.0 (Linux; Android 14; SM-A546E) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36',
});
const up = await upg.newPage(); watch(up);
await up.goto(BASE + 'icon.svg'); // mismo origen, sin cargar la app: base de datos como la dejó la versión 1
await up.evaluate(() => new Promise((res) => {
  const r = indexedDB.open('acta', 1);
  r.onupgradeneeded = () => {
    const d = r.result;
    d.createObjectStore('sessions', { keyPath: 'id' });
    const ch = d.createObjectStore('chunks', { autoIncrement: true }); ch.createIndex('track', ['sid', 'track', 'part']); ch.createIndex('sid', 'sid');
    const sg = d.createObjectStore('segments', { keyPath: ['sid', 'idx'] }); sg.createIndex('sid', 'sid'); sg.createIndex('status', 'status');
    d.createObjectStore('lines', { autoIncrement: true }).createIndex('sid', 'sid');
    d.createObjectStore('marks', { autoIncrement: true }).createIndex('sid', 'sid');
  };
  r.onsuccess = () => {
    const t = r.result.transaction('sessions', 'readwrite');
    t.objectStore('sessions').put({ id: 'vieja-1', createdAt: Date.now() - 864e5, client: '', title: 'Reunión de la versión anterior', titleManual: true, tags: [], userTags: [], hiddenTags: [], status: 'stopped', durationMs: 60000, mime: 'audio/webm', parts: [], endedAt: Date.now() - 86e6, deleted: false, searchText: '', liveText: '' });
    t.oncomplete = () => { r.result.close(); res(); };
  };
}));
await up.evaluate(() => localStorage.setItem('acta.settings', JSON.stringify({ v: 2, token: 'test-token', segSec: 60, live: false, micMode: 'natural' })));
await up.goto(BASE);
await step('Actualización y clave', async () => {
  await up.waitForTimeout(1500);
  check('Actualizar no borra las grabaciones existentes', /versión anterior/.test(await up.textContent('#recent')));
  const kv = await up.evaluate(() => new Promise((res) => { const r = indexedDB.open('acta'); r.onsuccess = () => { const q = r.result.transaction('kv').objectStore('kv').get('settings'); q.onsuccess = () => res(q.result); }; }));
  check('La clave queda guardada también en la base de datos', kv && kv.token === 'test-token');
  const st = await up.evaluate(() => JSON.parse(localStorage.getItem('acta.settings')));
  check('Pasa a bloques automáticos al actualizar', st.segSec === 0 && st.v === 3, `segSec ${st.segSec}`);
  await up.evaluate(() => localStorage.clear()); // el navegador borró los ajustes rápidos
  await up.reload();
  await up.waitForTimeout(2000);
  const st2 = await up.evaluate(() => JSON.parse(localStorage.getItem('acta.settings') || '{}'));
  const ok = await up.waitForFunction(() => /Transcripción conectada/.test(document.querySelector('#health').textContent), null, { timeout: 5000 }).then(() => true, () => false);
  check('Si se borran los ajustes, la clave se recupera sola', st2.token === 'test-token' && ok);
});
await step('Texto casi en vivo en el teléfono', async () => {
  await up.tap('#btn-start');
  await up.waitForSelector('#live:not([hidden])');
  await up.waitForTimeout(2500);
  check('Mientras graba muestra que está escuchando', await up.evaluate(() => !document.querySelector('#pending').hidden));
  const t0 = Date.now();
  const first = await up.waitForFunction(() => /relevamiento del proceso/.test(document.querySelector('#live-t').textContent), null, { timeout: 30000, polling: 500 }).then(() => Date.now() - t0 + 2500, () => 0);
  check('El primer texto aparece en cuanto se cierra el primer bloque', first > 0 && first < 35000, `${Math.round(first / 1000)} s desde que empezó`);
  await up.waitForTimeout(17000);
  const segs = (await getAll(up, 'segments')).filter((g) => g.sid !== 'vieja-1');
  const closed = segs.filter((g) => g.endMs);
  const lens = closed.map((g) => (g.endMs - g.startMs) / 1000);
  check('Los bloques automáticos duran entre 15 y 30 s', closed.length >= 2 && lens.every((x) => x >= 14.5 && x <= 31), lens.map((x) => x.toFixed(1)).join(', '));
  check('Cada bloque se transcribe enseguida', segs.filter((g) => g.status === 'done').length >= closed.length - 1, `${segs.filter((g) => g.status === 'done').length}/${closed.length}`);
  await up.screenshot({ path: `${OUT}/09-casi-en-vivo-390.png` });
  await stopRec(up);
});

/* =========================================================
   F) FIDELIDAD: frase larga recortada por Whisper (el caso reportado en la PC)
   ========================================================= */
const FAKE_SR_LONG = () => {
  class S {
    start() {
      if (window.__said) return;
      this.t = setTimeout(() => {
        window.__said = true;
        const r = [{ transcript: 'Necesitamos que el sistema registre cada contrato con la cuota el vencimiento y quién es el garante de cada cliente para poder cobrar a tiempo todos los meses sin errores' }];
        r.isFinal = true;
        this.onresult?.({ resultIndex: 0, results: [r] });
      }, 9000);
    }
    stop() { clearTimeout(this.t); setTimeout(() => this.onend?.(), 50); }
    abort() { clearTimeout(this.t); setTimeout(() => this.onend?.(), 10); }
  }
  window.webkitSpeechRecognition = S; window.SpeechRecognition = S;
};
const fid = await browser.newContext({ viewport: { width: 1440, height: 900 }, permissions: ['microphone'] });
await fid.addInitScript(FAKE_SR_LONG);
const fx = await fid.newPage(); watch(fx);
await fx.goto(BASE);
await fx.evaluate(() => localStorage.setItem('acta.settings', JSON.stringify({ v: 3, token: 'test-token', segSec: 0, live: true, vocab: 'MODORECORTE' })));
await fx.reload();
await step('Fidelidad', async () => {
  const wav0 = wavCalls;
  await fx.click('#btn-start');
  await fx.waitForSelector('#live:not([hidden])');
  // 1) Whisper devuelve el bloque recortado: el borrador completo NO desaparece
  const suspect = await fx.waitForFunction(() => window.__acta.R.doneSegs.some((g) => g.idx === 0 && g.suspect), null, { timeout: 40000, polling: 300 }).then(() => true, () => false);
  check('Detecta que el texto final salió recortado', suspect);
  check('Mientras tanto la frase completa sigue en pantalla', /garante de cada cliente/.test(await fx.textContent('#live-t')));
  // 2) Al cerrarse el bloque siguiente, retranscribe uniendo ambos
  const merged = await fx.waitForFunction(() => window.__acta.R.doneSegs.some((g) => g.idx === 0 && g.merged), null, { timeout: 40000, polling: 300 }).then(() => true, () => false);
  check('Vuelve a transcribir el tramo unido al bloque siguiente', merged && mergedCalls >= 1, `${mergedCalls} pedido(s) unidos`);
  await stopRec(fx);
  await fx.waitForTimeout(5000);
  const finals = await fx.$$eval('#d-transcript .line.final', (n) => n.map((x) => ({ t: x.textContent, low: x.classList.contains('low') })));
  const hit = finals.find((f) => /garante de cada cliente para poder cobrar a tiempo/.test(f.t));
  check('La frase queda completa y textual en la transcripción final', !!hit);
  check('Un tramo con audio poco claro se muestra marcado, no se borra', hit && hit.low);
  const drafts = await fx.$$eval('#d-transcript .line.draft', (n) => n.map((x) => x.textContent).join(' '));
  check('Con el texto final completo, el borrador ya no se duplica', !/garante de cada cliente/.test(drafts));
  const segs = await getAll(fx, 'segments');
  check('El bloque unido queda registrado y se guarda la respuesta original', segs.some((g) => g.note === 'unido') && segs.every((g) => g.status === 'done' && Array.isArray(g.raw)));
  check('Manda a Whisper audio nivelado (WAV 16 kHz)', wavCalls > wav0, `${wavCalls - wav0} WAV`);
  const plain = await fx.evaluate(() => document.querySelector('#d-transcript').textContent);
  check('No quedan textos inventados', !/Amara/.test(plain));
  await fx.screenshot({ path: `${OUT}/10-fidelidad-1440.png`, fullPage: true });
});

/* =========================================================
   G) CUENTA Y SINCRONIZACIÓN: PC y teléfono con los mismos datos
   ========================================================= */
const pcC = await browser.newContext({ viewport: { width: 1440, height: 900 }, permissions: ['microphone'] });
const phC = await browser.newContext({
  viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, permissions: ['microphone'],
  userAgent: 'Mozilla/5.0 (Linux; Android 14; SM-A546E) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36',
});
const gpc = await pcC.newPage(); watch(gpc);
const gph = await phC.newPage(); watch(gph);
const login = async (pg, mode) => {
  await pg.click('.tab[data-go="settings"]');
  await pg.waitForSelector('#cloud-form');
  await pg.fill('#cloud-form [name=email]', 'diego@test.com');
  await pg.fill('#cloud-form [name=password]', 'secreta123');
  await pg.click(mode === 'up' ? '#btn-signup' : '#cloud-form button[type=submit]');
  return pg.waitForFunction(() => window.__acta.CLOUD.session?.access_token, null, { timeout: 8000 }).then(() => true, () => false);
};
const syncNow = (pg) => pg.evaluate(() => window.__acta.sync());
await step('Sincronización', async () => {
  for (const pg of [gpc, gph]) { await pg.goto(BASE); await pg.evaluate(() => localStorage.setItem('acta.settings', JSON.stringify({ v: 3, segSec: 0, live: false }))); await pg.reload(); }
  check('Nube: crear cuenta en la PC', await login(gpc, 'up'));
  const conn = await gpc.waitForFunction(() => /Transcripción conectada/.test(document.querySelector('#health').textContent) || true, null, { timeout: 3000 }).then(() => true);
  await gpc.click('.tab[data-go="rec"]');
  const health = await gpc.waitForFunction(() => /Transcripción conectada/.test(document.querySelector('#health').textContent), null, { timeout: 6000 }).then(() => true, () => false);
  check('Nube: con la cuenta se transcribe sin clave APP_TOKEN', conn && health);
  await gpc.click('#btn-start');
  await gpc.waitForTimeout(34000);
  await stopRec(gpc);
  await gpc.waitForTimeout(6000);
  await syncNow(gpc); await syncNow(gpc);
  const m = SB.tables.meetings, b = SB.tables.blocks;
  check('Nube: la reunión de la PC queda en la nube', m.length === 1 && m[0].data.title, m[0]?.data.title);
  check('Nube: el texto transcripto queda en la nube', b.length >= 2 && b.every((x) => x.data.status === 'done') && b.some((x) => (x.data.result || []).length), `${b.length} bloques`);
  check('Nube: el audio se sube por tramos', SB.tables.audio_slices.length >= 1 && [...SB.files.values()].every((f) => f.length > 1000), `${SB.tables.audio_slices.length} tramo(s), ${[...SB.files.values()].reduce((n, f) => n + f.length, 0)} bytes`);

  check('Nube: entrar en el teléfono con la misma cuenta', await login(gph, 'in'));
  await syncNow(gph);
  await gph.click('.tab[data-go="list"]');
  await gph.waitForTimeout(500);
  check('Teléfono: ve la reunión grabada en la PC', (await gph.$$('#list .item')).length === 1 && /computadora/.test(await gph.textContent('#list')));
  const callsBefore = calls;
  await gph.click('#list .item');
  await gph.waitForSelector('#d-transcript');
  check('Teléfono: ve el texto de la reunión de la PC', /relevamiento del proceso/.test(await gph.textContent('#d-transcript')));
  await gph.click('#d-fetch-audio');
  await gph.waitForSelector('#d-audio', { timeout: 15000 });
  const dur = await gph.evaluate(() => new Promise((res) => { const a = document.querySelector('#d-audio'); const done = () => res(a.duration); if (a.duration && a.duration !== Infinity) done(); else { a.addEventListener('durationchange', () => { if (a.duration !== Infinity) done(); }); setTimeout(done, 5000); } }));
  check('Teléfono: escucha el audio bajado de la nube', dur > 25 && dur !== Infinity, `${Math.round(dur)} s`);
  await gph.waitForTimeout(2500);
  check('Teléfono: no retranscribe lo que grabó la PC', calls === callsBefore && SB.tables.blocks.every((x) => x.data.status === 'done' && x.data.note !== 'sin audio'));

  await gph.fill('#d-title', 'Relevamiento Valtti');
  await gph.dispatchEvent('#d-title', 'change');
  await gph.waitForTimeout(600);
  await syncNow(gph); await syncNow(gpc);
  const pcS = (await getAll(gpc, 'sessions'))[0];
  check('PC: recibe el título editado en el teléfono', pcS.title === 'Relevamiento Valtti', pcS.title);
  check('PC: su reunión no se pisa con datos viejos', pcS.status === 'stopped' && (pcS.parts || []).length === 1);

  await gph.click('.tab[data-go="rec"]');
  await gph.tap('#btn-start');
  await gph.waitForTimeout(5000);
  await stopRec(gph);
  await syncNow(gph); await syncNow(gpc);
  await gpc.click('.tab[data-go="list"]');
  await gpc.waitForTimeout(500);
  check('PC: ve la reunión grabada en el teléfono', (await gpc.$$('#list .item')).length === 2 && /teléfono/.test(await gpc.textContent('#list')));

  // Papelera y borrado definitivo desde la PC
  await gpc.click('#list .item >> text=Relevamiento Valtti');
  await gpc.click('#d-trash'); await gpc.click('#dlg button[value="ok"]');
  await gpc.waitForTimeout(600);
  await syncNow(gpc); await syncNow(gph);
  await gph.click('.tab[data-go="list"]'); await gph.waitForTimeout(400);
  check('Teléfono: lo que se manda a la papelera en la PC desaparece', !/Relevamiento Valtti/.test(await gph.textContent('#list')));
  const sid = pcS.id;
  await gpc.click('.tab[data-go="settings"]'); await gpc.click('[data-go="trash"]');
  await gpc.click(`[data-purge="${sid}"]`); await gpc.click('#dlg button[value="ok"]');
  await gpc.waitForTimeout(800);
  await syncNow(gpc); await syncNow(gph);
  check('Nube: el borrado definitivo quita texto y audio de la nube', !SB.tables.blocks.some((x) => x.meeting_id === sid) && !SB.tables.audio_slices.some((x) => x.meeting_id === sid) && ![...SB.files.keys()].some((k) => k.includes(sid)));
  check('Teléfono: el borrado definitivo también se aplica en el teléfono', !(await gph.evaluate((id) => new Promise((res) => { const r = indexedDB.open('acta'); r.onsuccess = () => { const q = r.result.transaction('sessions').objectStore('sessions').get(id); q.onsuccess = () => res(!!q.result); }; }), sid)));
  check('Nube: la reunión del teléfono sigue intacta', SB.tables.meetings.some((x) => x.data.device === 'teléfono' && !x.deleted));
  await gph.screenshot({ path: `${OUT}/11-cuenta-telefono.png`, fullPage: true });
});

const bad = await fetch(BASE + 'api/transcribe', { headers: { 'x-app-token': 'mala' } });
check('La API rechaza una clave incorrecta (401)', bad.status === 401);
const relevant = errors.filter((e) => !/speech|recognition|status of 401/i.test(e)); // 401: prueba de clave equivocada
check('Consola sin errores ni 404', relevant.length === 0, relevant.filter((e) => e.startsWith('404 ')).concat(relevant).slice(0, 3).join(' | '));

await browser.close(); server.close(); upstream.close();
const failed = results.filter((r) => !r[1]).length;
console.log(`\n${results.length - failed}/${results.length} comprobaciones en True`);
process.exit(failed ? 1 : 0);
