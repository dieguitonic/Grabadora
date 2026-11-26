// core.js — Lógica pura de Acta (sin DOM, sin red). Testeada con node --test.

/* ---------- Configuración ---------- */
export const SETTINGS_VERSION = 4;
export const DEFAULT_SETTINGS = Object.freeze({
  v: SETTINGS_VERSION,
  endpoint: '/api/transcribe',
  token: '',
  lang: 'es-AR',
  live: true,
  segSec: 120, // 2 min cortados en una pausa: máxima precisión. 0 = automático (más rápido, menos contexto)
  bitrate: 32000,
  micMode: 'natural',
  customTags: '',
  vocab: '',
});

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

export function normalizeSettings(raw) {
  const s = { ...DEFAULT_SETTINGS, ...(raw && typeof raw === 'object' ? raw : {}) };
  s.endpoint = String(s.endpoint || DEFAULT_SETTINGS.endpoint).trim();
  s.token = String(s.token || '').trim();
  s.lang = /^[a-z]{2}(-[A-Z]{2})?$/.test(s.lang) ? s.lang : DEFAULT_SETTINGS.lang;
  s.live = s.live !== false;
  const seg = Math.round(Number(s.segSec) || 0);
  s.segSec = seg <= 0 ? 0 : clamp(seg, 20, 480);
  s.bitrate = [24000, 32000, 48000, 64000].includes(Number(s.bitrate)) ? Number(s.bitrate) : 32000;
  s.customTags = String(s.customTags || '');
  s.micMode = s.micMode === 'filtro' ? 'filtro' : 'natural';
  s.vocab = String(s.vocab || '').slice(0, 800);
  s.v = SETTINGS_VERSION;
  return s;
}

/**
 * Ajustes guardados por versiones anteriores -> versión actual.
 * v2: micrófono natural (sin modo llamada), bloques de 1 min y, en Android,
 * borrador en vivo apagado (le quita el micrófono a la grabación).
 */
export function migrateSettings(raw, isAndroid) {
  const r = raw && typeof raw === 'object' ? { ...raw } : {};
  const fresh = !raw || typeof raw !== 'object' || !Object.keys(raw).length;
  if (fresh) return normalizeSettings({ live: !isAndroid });
  const v = Number(r.v) || 1;
  if (v < 2) {
    r.micMode = 'natural';
    if (isAndroid) r.live = false;
  }
  if (v < 3 && (!r.segSec || Number(r.segSec) <= 120)) r.segSec = 0; // v3: bloques automáticos
  if (v < 4 && Number(r.segSec || 0) === 0) r.segSec = 120; // v4: 2 min cortados en pausa (más preciso)
  return normalizeSettings(r);
}

/* ---------- Bloques automáticos (texto casi en vivo) ---------- */
export const AUTO_BLOCK = Object.freeze({ minMs: 15000, maxMs: 30000, quietMs: 600 });

/** Piso de ruido: baja rápido, sube muy despacio (se adapta a la sala). */
export function updateNoiseFloor(floor, rms) {
  if (!(floor > 0)) return Math.max(rms, 1e-5);
  return rms < floor ? rms : floor + (rms - floor) * 0.02;
}

/** ¿El nivel actual es una pausa entre frases? */
export const isQuiet = (rms, floor) => rms < Math.max(floor * 2.5, 0.004);

/**
 * ¿Cortar el bloque ahora? Fijo: al cumplir segSec. Automático: en la primera pausa real
 * después de minMs (15 s), o sí o sí al llegar a maxMs (30 s).
 */
export function shouldRotate({ lenMs, quietMs, segSec }) {
  if (segSec > 0) {
    // Fijo: al cumplir el tiempo se espera la primera pausa real (nunca se corta una palabra); tope +20 s.
    const t = segSec * 1000;
    return lenMs >= t + 20000 || (lenMs >= t && quietMs >= AUTO_BLOCK.quietMs);
  }
  return lenMs >= AUTO_BLOCK.maxMs || (lenMs >= AUTO_BLOCK.minMs && quietMs >= AUTO_BLOCK.quietMs);
}

/** Restricciones del micrófono. "natural" = como una grabadora; "filtro" = modo llamada. */
export function micConstraints(mode) {
  const on = mode === 'filtro';
  return { echoCancellation: on, noiseSuppression: on, autoGainControl: on, channelCount: 1 };
}

/** Idioma ISO-639-1 para Whisper ("es-AR" -> "es"). */
export const whisperLang = (lang) => String(lang || 'es').slice(0, 2).toLowerCase();

/* ---------- Formato ---------- */
export function formatDuration(ms) {
  const t = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
  const p = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${p(m)}:${p(s)}` : `${p(m)}:${p(s)}`;
}

export function formatBytes(b) {
  const n = Number(b) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

export function fileStamp(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

/* ---------- Grabación ---------- */
export const MIME_CANDIDATES = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/mp4;codecs=mp4a.40.2',
  'audio/mp4',
  'audio/ogg;codecs=opus',
];

export function pickMimeType(isSupported) {
  for (const m of MIME_CANDIDATES) {
    try { if (isSupported(m)) return m; } catch { /* sigue */ }
  }
  return '';
}

export const extForMime = (mime) =>
  /mp4/.test(mime) ? 'm4a' : /ogg/.test(mime) ? 'ogg' : 'webm';

/** Espera antes de reintentar (ms). attempts empieza en 1. */
export function backoffMs(attempts, rand = 0.5) {
  const base = 15000 * 2 ** Math.max(0, attempts - 1);
  return Math.round(Math.min(base, 10 * 60000) * (0.8 + 0.4 * rand));
}

/** ¿El grabador dejó de entregar datos? */
export function isStalled(lastChunkAt, now, timesliceMs) {
  return now - lastChunkAt > timesliceMs * 3 + 2000;
}

/**
 * Nivel de la señal con precisión completa (Float32).
 * rms: de las últimas `tail` muestras (para el medidor); peak: máximo de toda la ventana;
 * flat: ceros absolutos en toda la ventana (sin datos del micrófono).
 */
export function analyzeFloat(buf, tail = 2048) {
  let peak = 0, sum = 0;
  const from = Math.max(0, buf.length - tail);
  for (let i = 0; i < buf.length; i++) {
    const a = Math.abs(buf[i]);
    if (a > peak) peak = a;
    if (i >= from) sum += buf[i] * buf[i];
  }
  const n = buf.length - from;
  return { rms: n ? Math.sqrt(sum / n) : 0, peak, flat: peak === 0 };
}

/**
 * Tras volver de segundo plano: ¿cuánto audio falta? (ms). Compara el tiempo real que pasó
 * con los trozos que el grabador entregó. 0 si no hubo corte.
 */
export function backgroundGapMs(hiddenMs, chunksGot, timesliceMs) {
  const expected = Math.floor(hiddenMs / timesliceMs);
  const missing = expected - chunksGot;
  return missing > 2 && missing > expected * 0.15 ? missing * timesliceMs : 0;
}

/* ---------- Transcripción en vivo (Web Speech) ---------- */
/** Texto comparable: sin acentos, mayúsculas, signos ni espacios repetidos. */
export const compactText = (s) => normalizeText(s).replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();

/**
 * Agrega un resultado final en vivo. Corrige el bug de Android que repite
 * el texto acumulado de la misma sesión de reconocimiento.
 * Devuelve { op: 'add'|'replace'|'skip', line, index }.
 */
export function mergeLiveFinal(lines, text, ms, run) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (!t) return { op: 'skip' };
  const lastIdx = lines.length - 1;
  const last = lines[lastIdx];
  if (last && last.run === run) {
    const a = compactText(last.text), b = compactText(t);
    if (a === b || a.endsWith(b)) return { op: 'skip' };
    if (b.startsWith(a)) return { op: 'replace', index: lastIdx, line: { ...last, text: t } };
  }
  return { op: 'add', line: { ms, text: t, run } };
}

/* ---------- Transcripción final (Whisper) ---------- */
const HALLUCINATIONS = [
  'subtitulos realizados por la comunidad de amara.org',
  'subtitulado por la comunidad de amara.org',
  'gracias por ver el video',
  'gracias por ver',
  'suscribete',
  'no olvides suscribirte',
  'musica',
  'www.mooji.org',
];

/** Frase inventada conocida: solo si es TODO el tramo (nunca se corta texto real que la contenga). */
export function isHallucination(text) {
  const n = normalizeText(text).replace(/[^a-z0-9. ]/g, '').replace(/\s+/g, ' ').replace(/^[. ]+|[. ]+$/g, '').trim();
  if (!n) return true;
  return HALLUCINATIONS.includes(n);
}

export const wordCount = (s) => compactText(s).split(' ').filter(Boolean).length;

/** Repeticiones en bucle ("sí sí sí sí sí", frases repetidas 5 veces): deja 2, no borra el resto. */
export function collapseLoops(text) {
  let words = String(text || '').split(/\s+/).filter(Boolean);
  const same = (a, b, n) => { for (let k = 0; k < n; k++) if (compactText(words[a + k]) !== compactText(words[b + k])) return false; return true; };
  for (let n = 1; n <= 6; n++) {
    const out = [];
    let i = 0;
    while (i < words.length) {
      let reps = 1;
      while (i + (reps + 1) * n <= words.length && same(i, i + reps * n, n)) reps++;
      if (reps > 2) { for (let k = 0; k < 2 * n; k++) out.push(words[i + k]); i += reps * n; }
      else { out.push(words[i]); i += 1; }
    }
    words = out;
  }
  return words.join(' ');
}

/**
 * Limpia la respuesta de Whisper SIN borrar texto real:
 * - quita solo frases inventadas conocidas que ocupan todo el tramo;
 * - reduce bucles de repetición;
 * - marca (no borra) los tramos de baja confianza.
 */
export function cleanWhisperSegments(segments) {
  const out = [];
  for (const s of Array.isArray(segments) ? segments : []) {
    const raw = String(s.text || '').replace(/\s+/g, ' ').trim();
    if (!raw || isHallucination(raw)) continue;
    const text = collapseLoops(raw);
    const prev = out[out.length - 1];
    if (prev && text.length >= 20 && compactText(prev.text) === compactText(text)) continue; // misma oración larga duplicada = bucle
    const seg = { start: Number(s.start) || 0, end: Number(s.end) || 0, text };
    if ((s.no_speech_prob ?? 0) > 0.6 || (s.avg_logprob ?? 0) < -1) seg.low = true;
    out.push(seg);
  }
  return out;
}

/**
 * Los bloques se solapan ~1 s para no perder palabras en el corte. Quita del comienzo del
 * bloque nuevo las palabras que repiten el final del anterior (al menos 2 palabras seguidas).
 */
export function dedupeBoundary(prevResult, nextResult, maxWords = 10) {
  const prevWords = (prevResult || []).map((s) => s.text).join(' ').split(/\s+/).filter(Boolean);
  const next = (nextResult || []).map((s) => ({ ...s, words: s.text.split(/\s+/).filter(Boolean) }));
  const head = next.flatMap((s) => s.words).slice(0, maxWords);
  let k = 0;
  for (let n = Math.min(maxWords, prevWords.length, head.length); n >= 2; n--) {
    const a = prevWords.slice(-n).map(compactText).join(' ');
    const b = head.slice(0, n).map(compactText).join(' ');
    if (a && a === b) { k = n; break; }
  }
  if (!k) return nextResult || [];
  const out = [];
  for (const s of next) {
    const drop = Math.min(k, s.words.length);
    k -= drop;
    const words = s.words.slice(drop);
    if (!words.length) continue;
    const { words: _w, ...rest } = s;
    out.push({ ...rest, text: words.join(' ') });
  }
  return out;
}

/** El texto final de un tramo salió sospechosamente más corto que lo que se dijo (según el borrador). */
export function isSuspectTruncation(finalWords, draftWords) {
  return draftWords >= 8 && finalWords < draftWords * 0.5;
}

/** Vocabulario para Whisper: solo palabras del usuario (nunca texto anterior, que lo hace saltear partes). */
export function vocabPrompt(vocab) {
  const words = String(vocab || '').split(/[,;\n]/).map((w) => w.trim()).filter(Boolean);
  if (!words.length) return '';
  let p = '';
  for (const w of words) { const next = p ? `${p}, ${w}` : w; if (next.length > 600) break; p = next; }
  return p ? `Reunión de trabajo en español rioplatense. Vocabulario: ${p}.` : '';
}

/**
 * Arma la transcripción ordenada por tiempo.
 * - Un borrador en vivo se reemplaza solo cuando TODO su tramo (inicio a fin) tiene texto final.
 * - Los bloques marcados keepDraft (posible recorte) dejan ver también el borrador.
 * - Los tramos de baja confianza se muestran marcados, nunca se borran.
 */
export function buildTranscript({ segments = [], live = [], marks = [] }) {
  const items = [];
  const ranges = [];
  for (const seg of segments) {
    if (seg.status !== 'done') continue;
    if (!seg.keepDraft) ranges.push([seg.startMs, seg.endMs ?? Infinity]);
    for (const s of seg.result || []) {
      const it = { kind: 'final', ms: Math.round(seg.startMs + s.start * 1000), text: s.text };
      if (s.low) it.low = true;
      items.push(it);
    }
  }
  ranges.sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const r of ranges) {
    const last = merged[merged.length - 1];
    if (last && r[0] <= last[1] + 1500) last[1] = Math.max(last[1], r[1]); // bloques contiguos (con solapamiento)
    else merged.push([...r]);
  }
  const covered = (a, b) => merged.some(([s, e]) => a >= s && b <= e);
  for (const l of live) {
    if (!covered(l.ms, Math.max(l.ms, l.end ?? l.ms))) items.push({ kind: 'draft', ms: l.ms, text: l.text });
  }
  for (const m of marks) items.push({ kind: 'mark', ms: m.ms, text: m.text || 'Marca', type: m.type || 'user' });
  const order = { mark: 0, final: 1, draft: 2 };
  items.sort((a, b) => a.ms - b.ms || order[a.kind] - order[b.kind]);
  return items;
}

/* ---------- Audio para transcribir: 16 kHz mono, nivelado ---------- */
/** Sube voces lejanas: normaliza el pico a `target` sin pasar de `maxGain`. */
export function normalizePeak(data, target = 0.9, maxGain = 20) {
  let peak = 0;
  for (let i = 0; i < data.length; i++) { const a = Math.abs(data[i]); if (a > peak) peak = a; }
  const gain = peak > 0 ? Math.min(maxGain, target / peak) : 1;
  const out = new Float32Array(data.length);
  for (let i = 0; i < data.length; i++) out[i] = data[i] * gain;
  return { data: out, gain };
}

/** WAV PCM 16 bits mono. */
export function encodeWav(data, rate) {
  const buf = new ArrayBuffer(44 + data.length * 2);
  const v = new DataView(buf);
  const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); v.setUint32(4, 36 + data.length * 2, true); w(8, 'WAVE'); w(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  w(36, 'data'); v.setUint32(40, data.length * 2, true);
  for (let i = 0; i < data.length; i++) {
    const x = Math.max(-1, Math.min(1, data[i]));
    v.setInt16(44 + i * 2, x < 0 ? x * 0x8000 : x * 0x7fff, true);
  }
  return buf;
}

export function transcriptPlain(items) {
  return items
    .filter((i) => i.kind !== 'draft' || i.text)
    .map((i) => i.kind === 'mark'
      ? `[${formatDuration(i.ms)}] ★ ${i.text}`
      : `[${formatDuration(i.ms)}] ${i.text}${i.low ? ' [audio poco claro]' : ''}`)
    .join('\n');
}

/* ---------- Búsqueda y etiquetas ---------- */
export function normalizeText(s) {
  return String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

export function matchesQuery(query, ...fields) {
  const words = normalizeText(query).split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const hay = normalizeText(fields.join(' '));
  return words.every((w) => hay.includes(w));
}

/** Diccionario de temas. Editable: agregar/quitar filas no toca la lógica. */
export const TAG_RULES = [
  { tag: 'Relevamiento', words: ['relevamiento', 'proceso', 'como trabajan', 'hoy usan', 'actualmente', 'planilla', 'excel', 'paso a paso', 'flujo', 'circuito', 'quien se encarga'] },
  { tag: 'Demo', words: ['demo', 'te muestro', 'te comparto pantalla', 'fijate aca', 'mira aca', 'prueba', 'probalo'] },
  { tag: 'CRM', words: ['crm', 'seguimiento', 'leads', 'lead', 'embudo', 'pipeline', 'base de datos', 'contactos', 'clientes potenciales'] },
  { tag: 'Sitio web', words: ['pagina web', 'sitio', 'la web', 'dominio', 'hosting', 'landing', 'catalogo', 'google', 'seo'] },
  { tag: 'WhatsApp e IA', words: ['whatsapp', 'chatbot', 'bot', 'automatizacion', 'automatizar', 'inteligencia artificial', 'respuesta automatica', 'mensajes'] },
  { tag: 'Precios', words: ['precio', 'presupuesto', 'cuanto sale', 'cuanto cuesta', 'costo', 'abono', 'mensual', 'dolares', 'pesos', 'pago', 'cuotas', 'descuento'] },
  { tag: 'Motos', words: ['moto', 'motos', 'concesionaria', 'cilindrada', 'patentamiento', 'anticipo', 'financiacion', 'test ride', 'service'] },
  { tag: 'Inmobiliaria', words: ['propiedad', 'propiedades', 'inmobiliaria', 'departamento', 'alquiler', 'tasacion', 'lote', 'escritura'] },
  { tag: 'Energía solar', words: ['panel', 'paneles', 'solar', 'fotovoltaica', 'inversor', 'kw', 'kwp', 'bateria', 'medidor', 'epec'] },
  { tag: 'Contratos y cobranza', words: ['contrato', 'cobranza', 'deuda', 'vencimiento', 'mora', 'factura', 'facturacion', 'recibo'] },
  { tag: 'Marketing', words: ['instagram', 'facebook', 'publicidad', 'anuncios', 'campana', 'redes', 'meta ads', 'contenido'] },
  { tag: 'Próximos pasos', words: ['proxima reunion', 'te paso', 'te envio', 'te mando', 'quedamos', 'para el lunes', 'la semana que viene', 'plazo', 'entrega', 'fecha'] },
];

/** "Cliente X: palabra1, palabra2; Otro: a, b" -> reglas. */
export function parseCustomTags(str) {
  return String(str || '')
    .split(/[;\n]/)
    .map((row) => row.split(':'))
    .filter((p) => p.length === 2 && p[0].trim() && p[1].trim())
    .map(([tag, words]) => ({
      tag: tag.trim().slice(0, 30),
      words: words.split(',').map((w) => normalizeText(w).trim()).filter(Boolean),
    }));
}

function countOccurrences(hay, word) {
  const esc = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = hay.match(new RegExp(`(^|[^a-z0-9])${esc}(?=$|[^a-z0-9])`, 'g'));
  return m ? m.length : 0;
}

/** Etiquetas automáticas por tema: devuelve hasta `max` etiquetas ordenadas por peso. */
export function autoTag(text, rules = TAG_RULES, max = 4) {
  const hay = normalizeText(text);
  const words = hay.split(/\s+/).filter(Boolean).length;
  if (words < 15) return [];
  const threshold = Math.max(2, Math.round(words / 2500));
  return rules
    .map((r) => ({ tag: r.tag, score: r.words.reduce((n, w) => n + countOccurrences(hay, normalizeText(w)), 0) }))
    .filter((r) => r.score >= threshold)
    .sort((a, b) => b.score - a.score)
    .slice(0, max)
    .map((r) => r.tag);
}

export function defaultTitle(ts, client) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  const when = `${p(d.getDate())}/${p(d.getMonth() + 1)} ${p(d.getHours())}:${p(d.getMinutes())}`;
  return client ? `${client} · ${when}` : `Reunión ${when}`;
}

export function autoTitle(ts, client, tags) {
  const base = defaultTitle(ts, client);
  return tags && tags.length ? `${base} · ${tags.slice(0, 2).join(' + ')}` : base;
}

/* ---------- Exportación ---------- */
export function exportHeader(session) {
  const d = new Date(session.createdAt);
  const fecha = d.toLocaleDateString('es-AR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  const hora = d.toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit', hour12: false });
  return [
    `Título: ${session.title}`,
    `Fecha: ${fecha}, ${hora} h`,
    `Duración: ${formatDuration(session.durationMs)}`,
    session.tags?.length ? `Temas: ${session.tags.join(', ')}` : '',
  ].filter(Boolean).join('\n');
}

export const CLAUDE_PROMPT =
  'Te paso la transcripción de una reunión con un cliente (relevamiento o demo). ' +
  'Armame: 1) resumen en 5 líneas, 2) necesidades y dolores del cliente, 3) requisitos concretos del sistema o la web, ' +
  '4) precios, plazos y condiciones que se mencionaron, 5) objeciones, 6) próximos pasos con responsable, 7) preguntas que quedaron abiertas. ' +
  'Las partes marcadas con ★ son momentos que marqué como importantes.';

export function claudeExport(session, items) {
  return `${CLAUDE_PROMPT}\n\n${exportHeader(session)}\n\nTranscripción:\n${transcriptPlain(items)}`;
}
