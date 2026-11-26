// Autorización compartida por las funciones (los archivos que empiezan con _ no son rutas en Vercel).
// Acepta: la sesión de la cuenta (Supabase) o, por compatibilidad, la clave APP_TOKEN.
import { timingSafeEqual } from 'node:crypto';

export const json = (body, status = 200, extra = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...extra },
  });

const safeEq = (a, b) => {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
};

export const supabaseEnv = () => ({
  url: (process.env.SUPABASE_URL || '').replace(/\/$/, ''),
  anon: process.env.SUPABASE_ANON_KEY || '',
});

const cache = new Map(); // token -> { user, exp } (5 min por instancia)
async function verifySession(token) {
  const { url, anon } = supabaseEnv();
  const hit = cache.get(token);
  if (hit && hit.exp > Date.now()) return hit.user;
  try {
    const r = await fetch(`${url}/auth/v1/user`, { headers: { apikey: anon, authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(8000) });
    if (!r.ok) return null;
    const user = await r.json();
    if (cache.size > 200) cache.clear();
    cache.set(token, { user, exp: Date.now() + 5 * 60000 });
    return user;
  } catch { return null; }
}

export async function authorize(request) {
  const appToken = process.env.APP_TOKEN || '';
  const got = request.headers.get('x-app-token') || '';
  if (appToken && got && safeEq(got, appToken)) return { ok: true };

  const { url, anon } = supabaseEnv();
  const bearer = (request.headers.get('authorization') || '').match(/^Bearer\s+(.+)$/i);
  if (bearer && url && anon) {
    const user = await verifySession(bearer[1]);
    if (!user) return { ok: false, res: json({ error: 'Sesión vencida o inválida: volvé a entrar a tu cuenta' }, 401) };
    const allowed = (process.env.ALLOWED_EMAILS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
    if (allowed.length && !allowed.includes(String(user.email || '').toLowerCase())) {
      return { ok: false, res: json({ error: 'Esta cuenta no tiene permiso para transcribir (ALLOWED_EMAILS)' }, 403) };
    }
    return { ok: true, user };
  }
  if (!appToken && !(url && anon)) return { ok: false, res: json({ error: 'Falta APP_TOKEN o SUPABASE_URL en el servidor' }, 500) };
  return { ok: false, res: json({ error: 'Clave inválida' }, 401) };
}
