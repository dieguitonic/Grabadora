// Función serverless de Vercel: recibe un bloque de audio y lo transcribe con Whisper.
// La clave del proveedor vive solo en el servidor (variables de entorno).
//   APP_TOKEN     clave compartida con la app (obligatoria)
//   STT_API_KEY   clave de Groq (o de OpenAI)           — también acepta GROQ_API_KEY
//   STT_BASE_URL  por defecto https://api.groq.com/openai/v1
//   STT_MODEL     por defecto whisper-large-v3
import { timingSafeEqual } from 'node:crypto';

const MAX_BYTES = 4_400_000; // límite de cuerpo de Vercel: 4,5 MB
const json = (body, status = 200, extra = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...extra },
  });

function authorized(request) {
  const expected = process.env.APP_TOKEN || '';
  const got = request.headers.get('x-app-token') || '';
  if (!expected) return { ok: false, res: json({ error: 'Falta APP_TOKEN en el servidor' }, 500) };
  const a = Buffer.from(got), b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, res: json({ error: 'Clave inválida' }, 401) };
  return { ok: true };
}

const provider = () => ({
  key: process.env.STT_API_KEY || process.env.GROQ_API_KEY || '',
  base: (process.env.STT_BASE_URL || 'https://api.groq.com/openai/v1').replace(/\/$/, ''),
  model: process.env.STT_MODEL || 'whisper-large-v3',
});

export async function GET(request) {
  const auth = authorized(request);
  if (!auth.ok) return auth.res;
  const p = provider();
  if (!p.key) return json({ error: 'Falta STT_API_KEY en el servidor' }, 500);
  return json({ ok: true, model: p.model });
}

export async function POST(request) {
  const auth = authorized(request);
  if (!auth.ok) return auth.res;
  const p = provider();
  if (!p.key) return json({ error: 'Falta STT_API_KEY en el servidor' }, 500);

  const len = Number(request.headers.get('content-length') || 0);
  if (len > MAX_BYTES) return json({ error: 'Bloque demasiado grande' }, 413);

  let form;
  try { form = await request.formData(); } catch { return json({ error: 'Formato inválido' }, 400); }
  const file = form.get('file');
  if (!file || typeof file === 'string' || !file.size) return json({ error: 'Falta el audio' }, 400);
  if (file.size > MAX_BYTES) return json({ error: 'Bloque demasiado grande' }, 413);
  if (file.type && !/^audio\/|^video\/webm/.test(file.type)) return json({ error: 'Tipo de archivo no permitido' }, 415);

  const name = String(form.get('name') || 'audio.webm').replace(/[^\w.-]/g, '').slice(0, 60) || 'audio.webm';
  const language = String(form.get('language') || 'es').toLowerCase().slice(0, 2);
  const prompt = String(form.get('prompt') || '').slice(0, 800);

  const out = new FormData();
  out.append('file', file, name);
  out.append('model', p.model);
  out.append('response_format', 'verbose_json');
  out.append('temperature', '0');
  if (/^[a-z]{2}$/.test(language)) out.append('language', language);
  if (prompt) out.append('prompt', prompt);

  let r;
  try {
    r = await fetch(`${p.base}/audio/transcriptions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${p.key}` },
      body: out,
      signal: AbortSignal.timeout(55_000),
    });
  } catch {
    return json({ error: 'El proveedor de transcripción no respondió' }, 504);
  }

  const raw = await r.text();
  if (!r.ok) {
    let msg = `Proveedor: error ${r.status}`;
    try { msg = JSON.parse(raw)?.error?.message || msg; } catch { /* texto plano */ }
    const extra = {};
    const ra = r.headers.get('retry-after');
    if (ra) extra['retry-after'] = ra;
    const status = r.status === 429 ? 429 : r.status >= 500 ? 502 : 400;
    return json({ error: msg.slice(0, 300) }, status, extra);
  }

  let data;
  try { data = JSON.parse(raw); } catch { return json({ error: 'Respuesta inválida del proveedor' }, 502); }
  return json({
    text: data.text || '',
    duration: data.duration ?? null,
    segments: (data.segments || []).map((s) => ({
      start: s.start, end: s.end, text: s.text,
      no_speech_prob: s.no_speech_prob, avg_logprob: s.avg_logprob, compression_ratio: s.compression_ratio,
    })),
  });
}
