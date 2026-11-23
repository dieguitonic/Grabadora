// core.js — Lógica pura de Acta (sin DOM, sin red). Testeada con node --test.

/* ---------- Configuración ---------- */
export const DEFAULT_SETTINGS = Object.freeze({
  endpoint: '/api/transcribe',
  token: '',
  lang: 'es-AR',
  live: true,
  segSec: 120,
  bitrate: 32000,
  customTags: '',
});

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

export function normalizeSettings(raw) {
  const s = { ...DEFAULT_SETTINGS, ...(raw && typeof raw === 'object' ? raw : {}) };
  s.endpoint = String(s.endpoint || DEFAULT_SETTINGS.endpoint).trim();
  s.token = String(s.token || '').trim();
  s.lang = /^[a-z]{2}(-[A-Z]{2})?$/.test(s.lang) ? s.lang : DEFAULT_SETTINGS.lang;
  s.live = s.live !== false;
  s.segSec = clamp(Math.round(Number(s.segSec) || DEFAULT_SETTINGS.segSec), 20, 480);
  s.bitrate = [24000, 32000, 48000, 64000].includes(Number(s.bitrate)) ? Number(s.bitrate) : 32000;
  s.customTags = String(s.customTags || '');
  return s;
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

/** Nivel RMS (0..1) y si la señal es silencio digital absoluto (micrófono tomado por otro proceso). */
export function analyzeLevel(bytes) {
  let sum = 0, flat = true;
  for (let i = 0; i < bytes.length; i++) {
    const v = (bytes[i] - 128) / 128;
    if (bytes[i] !== 128) flat = false;
    sum += v * v;
  }
  return { rms: bytes.length ? Math.sqrt(sum / bytes.length) : 0, flat };
}

export const SILENCE_RMS = 0.004;

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

export function isHallucination(text) {
  const n = normalizeText(text).replace(/[^a-z0-9. ]/g, '').trim();
  if (!n) return true;
  return HALLUCINATIONS.some((h) => n === h || (n.length < h.length + 12 && n.includes(h)));
}

/** Limpia segmentos de Whisper: descarta silencio, alucinaciones y repeticiones en bucle. */
export function cleanWhisperSegments(segments) {
  const out = [];
  for (const s of Array.isArray(segments) ? segments : []) {
    const text = String(s.text || '').replace(/\s+/g, ' ').trim();
    if (!text) continue;
    if ((s.no_speech_prob ?? 0) > 0.6 && (s.avg_logprob ?? 0) < -0.8) continue;
    if ((s.compression_ratio ?? 0) > 2.6) continue;
    if (isHallucination(text)) continue;
    const prev = out[out.length - 1];
    if (prev && normalizeText(prev.text) === normalizeText(text)) continue;
    out.push({ start: Number(s.start) || 0, end: Number(s.end) || 0, text });
  }
  return out;
}

/** Últimas ~200 letras de texto previo, cortadas en palabra, como contexto para Whisper. */
export function promptTail(text, max = 200) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  const cut = t.slice(-max);
  const sp = cut.indexOf(' ');
  return sp > -1 ? cut.slice(sp + 1) : cut;
}

/**
 * Arma la transcripción ordenada por tiempo.
 * - Segmentos con transcripción final reemplazan al borrador en vivo de su rango.
 * - Las marcas se intercalan.
 */
export function buildTranscript({ segments = [], live = [], marks = [] }) {
  const items = [];
  const doneRanges = [];
  for (const seg of segments) {
    if (seg.status !== 'done') continue;
    const end = seg.endMs ?? Infinity;
    doneRanges.push([seg.startMs, end]);
    for (const s of seg.result || []) {
      items.push({ kind: 'final', ms: Math.round(seg.startMs + s.start * 1000), text: s.text });
    }
  }
  const covered = (ms) => doneRanges.some(([a, b]) => ms >= a && ms < b);
  for (const l of live) if (!covered(l.ms)) items.push({ kind: 'draft', ms: l.ms, text: l.text });
  for (const m of marks) items.push({ kind: 'mark', ms: m.ms, text: m.text || 'Marca', type: m.type || 'user' });
  const order = { mark: 0, final: 1, draft: 2 };
  items.sort((a, b) => a.ms - b.ms || order[a.kind] - order[b.kind]);
  return items;
}

export function transcriptPlain(items) {
  return items
    .filter((i) => i.kind !== 'draft' || i.text)
    .map((i) => i.kind === 'mark'
      ? `[${formatDuration(i.ms)}] ★ ${i.text}`
      : `[${formatDuration(i.ms)}] ${i.text}`)
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
