// Configuración pública de la nube. La clave "anon" de Supabase es pública por diseño:
// la seguridad la dan las reglas por usuario (RLS) de sql/supabase.sql.
import { json, supabaseEnv } from './_auth.js';

export function GET() {
  const { url, anon } = supabaseEnv();
  return json(url && anon ? { supabaseUrl: url, supabaseAnonKey: anon } : {});
}
