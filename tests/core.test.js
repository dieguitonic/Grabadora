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
  assert.equal(C.normalizeSettings({ segSec: 0 }).segSec, 0);
  assert.equal(C.normalizeSettings({ segSec: 25 }).segSec, 25);
  assert.equal(C.normalizeSettings({ segSec: 600 }).segSec, 480);
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
  assert.equal(a.token, 'x'); assert.equal(a.live, false); assert.equal(a.micMode, 'natural'); assert.equal(a.segSec, 120); assert.equal(a.v, 4);
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

test('migrateSettings: pasa a bloques de 2 min sin tocar la clave ni el vivo elegido', () => {
  const v2 = { v: 2, token: 'k', live: true, segSec: 60, micMode: 'filtro' };
  const r = C.migrateSettings(v2, true);
  assert.equal(r.segSec, 120); assert.equal(r.token, 'k'); assert.equal(r.live, true); assert.equal(r.micMode, 'filtro');
  assert.equal(C.migrateSettings({ v: 3, segSec: 0 }, false).segSec, 120);
  assert.equal(C.migrateSettings({ v: 4, segSec: 0 }, false).segSec, 0, 'si después elige automático, se respeta');
  assert.equal(C.migrateSettings({ v: 2, segSec: 300 }, false).segSec, 300);
});

test('piso de ruido y pausas', () => {
  let f = 0;
  for (const r of [0.05, 0.002, 0.06, 0.07, 0.002]) f = C.updateNoiseFloor(f, r);
  assert.ok(f < 0.003);
  assert.equal(C.isQuiet(0.003, 0.002), true);
  assert.equal(C.isQuiet(0.05, 0.002), false);
  assert.equal(C.isQuiet(0.003, 0), true);
});

test('cleanWhisperSegments NO borra texto real (caso reportado)', () => {
  const frase = 'Necesitamos que el sistema registre cada contrato, con la cuota, el vencimiento y quién es el garante de cada cliente.';
  const out = C.cleanWhisperSegments([
    { start: 0, end: 8, text: ` ${frase} `, no_speech_prob: 0.7, avg_logprob: -1.3, compression_ratio: 1.4 }, // voz lejana: baja confianza
    { start: 8, end: 9, text: 'Subtítulos realizados por la comunidad de Amara.org', no_speech_prob: 0.3 },
    { start: 9, end: 10, text: 'Gracias por ver el video.' },
    { start: 10, end: 12, text: 'Gracias, muchas gracias por ver el video que te mandé del CRM.' }, // real aunque contenga la frase
    { start: 12, end: 16, text: 'sí sí sí sí sí sí sí está bien', compression_ratio: 3.1 },
    { start: 16, end: 17, text: 'Sí.' }, { start: 17, end: 18, text: 'Sí.' }, // repetición corta real
  ]);
  assert.equal(out[0].text, frase);
  assert.equal(out[0].low, true);
  assert.deepEqual(out.slice(1).map((s) => s.text), ['Gracias, muchas gracias por ver el video que te mandé del CRM.', 'sí sí está bien', 'Sí.', 'Sí.']);
  assert.deepEqual(C.cleanWhisperSegments(undefined), []);
});

test('collapseLoops deja 2 repeticiones y no toca texto normal', () => {
  assert.equal(C.collapseLoops('el auto el auto el auto el auto es rojo'), 'el auto el auto es rojo');
  assert.equal(C.collapseLoops('no, no, mirá'), 'no, no, mirá');
});

test('dedupeBoundary quita lo repetido por el solapamiento de bloques', () => {
  const prev = [{ start: 0, text: 'vamos a ver el tema de las cuotas' }];
  assert.deepEqual(C.dedupeBoundary(prev, [{ start: 0, text: 'de las cuotas y los vencimientos' }]).map((s) => s.text), ['y los vencimientos']);
  assert.deepEqual(C.dedupeBoundary(prev, [{ start: 0, text: 'las' }, { start: 0.3, text: 'cuotas, y después' }]).map((s) => s.text), ['y después']);
  assert.deepEqual(C.dedupeBoundary(prev, [{ start: 0, text: 'otra cosa distinta' }]).map((s) => s.text), ['otra cosa distinta']);
  assert.deepEqual(C.dedupeBoundary([], [{ start: 0, text: 'hola' }]).map((s) => s.text), ['hola']);
});

test('buildTranscript: una frase que cruza dos bloques NO se reemplaza hasta tener los dos', () => {
  const draft = { ms: 14000, end: 22000, text: 'una frase larga de más de veinte palabras que empieza en un bloque y termina en el siguiente bloque de audio' };
  const segA = { status: 'done', startMs: 0, endMs: 16000, result: [{ start: 14, text: 'una frase larga' }] };
  const segB = { status: 'pending', startMs: 16000, endMs: 32000 };
  let items = C.buildTranscript({ segments: [segA, segB], live: [draft] });
  assert.ok(items.some((i) => i.kind === 'draft' && i.text === draft.text), 'el borrador completo sigue visible');
  items = C.buildTranscript({ segments: [segA, { ...segB, status: 'done', result: [{ start: 0, text: 'de más de veinte palabras…' }] }], live: [draft] });
  assert.ok(!items.some((i) => i.kind === 'draft'), 'con los dos bloques listos queda el texto final');
  // Bloque marcado como posible recorte: se ve el final Y el borrador
  items = C.buildTranscript({ segments: [{ ...segA, endMs: 30000, keepDraft: true }], live: [draft] });
  assert.ok(items.some((i) => i.kind === 'draft') && items.some((i) => i.kind === 'final'));
  // Marcas y baja confianza
  items = C.buildTranscript({ segments: [{ status: 'done', startMs: 0, endMs: 10000, result: [{ start: 1, text: 'x', low: true }] }], marks: [{ ms: 500, text: 'Precio' }] });
  assert.deepEqual(items.map((i) => i.kind), ['mark', 'final']);
  assert.equal(items[1].low, true);
  assert.match(C.transcriptPlain(items), /\[00:00\] ★ Precio/);
});

test('isSuspectTruncation y vocabPrompt', () => {
  assert.equal(C.isSuspectTruncation(5, 22), true);
  assert.equal(C.isSuspectTruncation(18, 22), false);
  assert.equal(C.isSuspectTruncation(1, 5), false);
  assert.equal(C.vocabPrompt(''), '');
  assert.match(C.vocabPrompt('Valtti, Keller; CRM'), /Vocabulario: Valtti, Keller, CRM\./);
  assert.ok(C.vocabPrompt('x'.repeat(700)) === '');
});

test('shouldRotate: bloques automáticos de 15 a 30 s cortados en pausas', () => {
  assert.equal(C.shouldRotate({ lenMs: 10000, quietMs: 2000, segSec: 0 }), false);
  assert.equal(C.shouldRotate({ lenMs: 16000, quietMs: 300, segSec: 0 }), false);
  assert.equal(C.shouldRotate({ lenMs: 16000, quietMs: 700, segSec: 0 }), true);
  assert.equal(C.shouldRotate({ lenMs: 30000, quietMs: 0, segSec: 0 }), true);
  assert.equal(C.shouldRotate({ lenMs: 60000, quietMs: 0, segSec: 60 }), false, 'fijo: espera una pausa');
  assert.equal(C.shouldRotate({ lenMs: 61000, quietMs: 700, segSec: 60 }), true);
  assert.equal(C.shouldRotate({ lenMs: 80000, quietMs: 0, segSec: 60 }), true, 'tope de 20 s extra');
  assert.equal(C.normalizeSettings({}).segSec, 120);
});

test('audio para Whisper: nivelado y WAV válido', () => {
  const quiet = new Float32Array([0.01, -0.02, 0.015]);
  const n = C.normalizePeak(quiet);
  assert.ok(Math.abs(Math.max(...n.data.map(Math.abs)) - 0.4) < 1e-6, 'tope de ganancia 20x');
  const loud = C.normalizePeak(new Float32Array([0.5, -0.9]));
  assert.ok(Math.abs(loud.gain - 1) < 1e-6);
  const wav = new DataView(C.encodeWav(new Float32Array(16000), 16000));
  assert.equal(wav.byteLength, 44 + 32000);
  assert.equal(String.fromCharCode(wav.getUint8(0), wav.getUint8(1), wav.getUint8(2), wav.getUint8(3)), 'RIFF');
  assert.equal(wav.getUint32(24, true), 16000);
});
