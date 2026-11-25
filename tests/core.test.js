import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as C from '../core.js';

test('formatDuration', () => {
  assert.equal(C.formatDuration(0), '00:00');
  assert.equal(C.formatDuration(65000), '01:05');
  assert.equal(C.formatDuration(4 * 3600000 + 61000), '4:01:01');
  assert.equal(C.formatDuration(-5), '00:00');
});

test('normalizeSettings acota valores', () => {
  const s = C.normalizeSettings({ segSec: 5, bitrate: 999, lang: 'xx_bad', live: false });
  assert.equal(s.segSec, 20);
  assert.equal(s.bitrate, 32000);
  assert.equal(s.lang, 'es-AR');
  assert.equal(s.live, false);
  assert.equal(C.normalizeSettings(null).endpoint, '/api/transcribe');
  assert.equal(C.normalizeSettings({ micMode: 'raro' }).micMode, 'natural');
  assert.equal(C.whisperLang('es-AR'), 'es');
});

test('pickMimeType elige el primero soportado', () => {
  assert.equal(C.pickMimeType((m) => m === 'audio/mp4'), 'audio/mp4');
  assert.equal(C.pickMimeType(() => false), '');
  assert.equal(C.extForMime('audio/mp4'), 'm4a');
  assert.equal(C.extForMime('audio/webm;codecs=opus'), 'webm');
});

test('backoff crece y tiene techo', () => {
  assert.equal(C.backoffMs(1, 0.5), 15000);
  assert.equal(C.backoffMs(2, 0.5), 30000);
  assert.equal(C.backoffMs(20, 0.5), 600000);
});

test('isStalled', () => {
  assert.equal(C.isStalled(0, 7000, 2000), false);
  assert.equal(C.isStalled(0, 8001, 2000), true);
});

test('analyzeFloat: detecta voz muy baja que en 8 bits se veía como silencio', () => {
  const quiet = new Float32Array(4096).map((_, i) => 0.002 * Math.sin(i / 7));
  const r = C.analyzeFloat(quiet);
  assert.equal(r.flat, false);
  assert.ok(r.peak > 0.0015 && r.rms > 0.001);
  assert.equal(C.analyzeFloat(new Float32Array(4096)).flat, true);
  const beep = new Float32Array(4096); beep[10] = 0.5;
  const b = C.analyzeFloat(beep, 2048);
  assert.equal(b.peak, 0.5); assert.equal(b.rms, 0); assert.equal(b.flat, false);
});

test('mergeLiveFinal corrige duplicados acumulados de Android', () => {
  let lines = [];
  const apply = (t, run) => {
    const r = C.mergeLiveFinal(lines, t, 1000, run);
    if (r.op === 'add') lines = [...lines, r.line];
    if (r.op === 'replace') lines = lines.map((l, i) => (i === r.index ? r.line : l));
    return r.op;
  };
  assert.equal(apply('hola', 1), 'add');
  assert.equal(apply('hola cómo estás', 1), 'replace');
  assert.equal(apply('Hola como estas', 1), 'skip');
  assert.equal(apply('cómo estás', 1), 'skip');
  assert.equal(apply('otra frase', 2), 'add');
  assert.equal(apply('   ', 2), 'skip');
  assert.deepEqual(lines.map((l) => l.text), ['hola cómo estás', 'otra frase']);
});

test('cleanWhisperSegments filtra alucinaciones, silencio y bucles', () => {
  const out = C.cleanWhisperSegments([
    { start: 0, end: 2, text: ' Buen día, arrancamos. ', no_speech_prob: 0.01, avg_logprob: -0.2 },
    { start: 2, end: 4, text: 'Subtítulos realizados por la comunidad de Amara.org', no_speech_prob: 0.2, avg_logprob: -0.5 },
    { start: 4, end: 6, text: 'ruido', no_speech_prob: 0.9, avg_logprob: -1.2 },
    { start: 6, end: 8, text: 'Gracias por ver el video.' },
    { start: 8, end: 9, text: 'Buen día, arrancamos.' },
    { start: 9, end: 12, text: 'Necesitamos un CRM.', compression_ratio: 1.4 },
    { start: 12, end: 14, text: 'sí sí sí sí sí sí sí sí', compression_ratio: 3.1 },
  ]);
  assert.deepEqual(out.map((s) => s.text), ['Buen día, arrancamos.', 'Necesitamos un CRM.']);
  assert.deepEqual(C.cleanWhisperSegments(undefined), []);
});

test('promptTail corta en palabra', () => {
  assert.equal(C.promptTail('corto'), 'corto');
  const t = C.promptTail('a'.repeat(50) + ' palabra final', 20);
  assert.ok(t.length <= 20 && !t.startsWith('a'));
});

test('buildTranscript: el final reemplaza al borrador de su rango y ordena marcas', () => {
  const items = C.buildTranscript({
    segments: [
      { status: 'done', startMs: 0, endMs: 120000, result: [{ start: 1, text: 'final uno' }, { start: 60, text: 'final dos' }] },
      { status: 'pending', startMs: 120000, endMs: 240000 },
    ],
    live: [{ ms: 2000, text: 'borrador viejo' }, { ms: 130000, text: 'borrador nuevo' }],
    marks: [{ ms: 60000, text: 'Precio' }],
  });
  assert.deepEqual(items.map((i) => `${i.kind}:${i.text}`), [
    'final:final uno', 'mark:Precio', 'final:final dos', 'draft:borrador nuevo',
  ]);
  assert.match(C.transcriptPlain(items), /\[01:00\] ★ Precio/);
});

test('matchesQuery ignora acentos y mayúsculas', () => {
  assert.ok(C.matchesQuery('reunion crm', 'Reunión con el CRM nuevo'));
  assert.ok(!C.matchesQuery('motos', 'Reunión con el CRM nuevo'));
  assert.ok(C.matchesQuery('', 'x'));
});

test('autoTag detecta temas y respeta palabras completas', () => {
  const text = 'Bueno, hoy hacemos el relevamiento del proceso. Actualmente usan una planilla de Excel para el seguimiento de clientes. ' +
    'Queremos un CRM con seguimiento de leads y que se conecte con WhatsApp para responder mensajes con un bot. El precio del abono mensual lo vemos después.';
  const tags = C.autoTag(text);
  assert.ok(tags.includes('Relevamiento'));
  assert.ok(tags.includes('CRM'));
  assert.ok(tags.includes('WhatsApp e IA'));
  assert.ok(!tags.includes('Energía solar'));
  assert.ok(tags.length <= 4);
  assert.deepEqual(C.autoTag('muy corto'), []);
  assert.deepEqual(C.autoTag('desarrollo '.repeat(30)), []);
});

test('parseCustomTags', () => {
  const r = C.parseCustomTags('Valtti: valtti, balti; Ciclos: ciclos, ingeniería\nmal formado');
  assert.equal(r.length, 2);
  assert.deepEqual(r[1].words, ['ciclos', 'ingenieria']);
});

test('títulos y exportación', () => {
  const ts = new Date(2026, 10, 23, 9, 5).getTime();
  assert.equal(C.defaultTitle(ts), 'Reunión 23/11 09:05');
  assert.equal(C.autoTitle(ts, 'Valtti', ['CRM', 'Precios', 'Demo']), 'Valtti · 23/11 09:05 · CRM + Precios');
  const txt = C.claudeExport({ title: 'X', createdAt: ts, durationMs: 3600000, tags: ['CRM'] }, [{ kind: 'final', ms: 0, text: 'hola' }]);
  assert.match(txt, /Duración: 1:00:00/);
  assert.match(txt, /\[00:00\] hola/);
  assert.equal(C.fileStamp(ts), '20261123-0905');
});

test('mergeLiveFinal ignora signos al comparar (final que llega después de pausar)', () => {
  const lines = [{ ms: 0, text: 'hola como estas', run: 3 }];
  assert.equal(C.mergeLiveFinal(lines, 'Hola, ¿cómo estás?', 0, 3).op, 'skip');
  assert.equal(C.mergeLiveFinal(lines, 'Hola, ¿cómo estás? Bien.', 0, 3).op, 'replace');
});

test('backgroundGapMs detecta audio faltante en segundo plano', () => {
  assert.equal(C.backgroundGapMs(60000, 30, 2000), 0);
  assert.equal(C.backgroundGapMs(60000, 29, 2000), 0);
  assert.equal(C.backgroundGapMs(60000, 5, 2000), 50000);
  assert.equal(C.backgroundGapMs(3000, 0, 2000), 0);
});

test('migrateSettings: pasa a micrófono natural y apaga el vivo en Android', () => {
  const old = { token: 'x', live: true, segSec: 120 };
  const a = C.migrateSettings(old, true);
  assert.equal(a.token, 'x'); assert.equal(a.live, false); assert.equal(a.micMode, 'natural'); assert.equal(a.segSec, 60); assert.equal(a.v, 2);
  const pc = C.migrateSettings(old, false);
  assert.equal(pc.live, true);
  assert.equal(C.migrateSettings(null, true).live, false);
  assert.equal(C.migrateSettings({}, false).live, true);
  // Una vez migrado, se respeta lo que elija el usuario
  assert.equal(C.migrateSettings({ ...a, live: true }, true).live, true);
  assert.equal(C.migrateSettings({ ...a, segSec: 180 }, true).segSec, 180);
});

test('micConstraints: natural sin procesamiento de llamada', () => {
  assert.deepEqual(C.micConstraints('natural'), { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 });
  assert.equal(C.micConstraints('filtro').echoCancellation, true);
});
