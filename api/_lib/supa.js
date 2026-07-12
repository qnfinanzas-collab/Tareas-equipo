// Cliente Supabase con service_role para endpoints backend de F1.
//
// SERVICE_ROLE_KEY salta RLS: la usamos SOLO desde estos endpoints,
// jamás desde el cliente. Cada endpoint valida el JWT del caller
// primero (verifyBearer) y luego decide qué operaciones permitir.

import { createClient } from "@supabase/supabase-js";

const SUPA_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANON_KEY = process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_KEY;

if (!SUPA_URL) throw new Error("SUPABASE_URL no configurada");
if (!SERVICE_KEY) throw new Error("SUPABASE_SERVICE_ROLE_KEY no configurada");

// Cliente con service_role: bypasses RLS. Solo backend.
export const supaAdmin = createClient(SUPA_URL, SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

// Cliente con anon, usado solo para verificar tokens JWT del caller.
// createClient con anon key permite auth.getUser({jwt}) para validar.
export const supaAnon = ANON_KEY ? createClient(SUPA_URL, ANON_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
}) : null;

// Extrae y valida el Bearer JWT del header Authorization. Devuelve
// { user, error }. Si no hay JWT, error="no bearer". Si JWT inválido,
// error del mensaje de Supabase.
export async function verifyBearer(req) {
  const auth = req.headers?.authorization || req.headers?.Authorization || "";
  const m = auth.match(/^Bearer\s+(.+)$/i);
  if (!m) return { user: null, error: "no bearer token" };
  const jwt = m[1];
  const { data, error } = await supaAdmin.auth.getUser(jwt);
  if (error) return { user: null, error: error.message };
  return { user: data.user, error: null };
}

// JSON response helper con status.
export function json(res, status, body) {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(body));
}

// Lee el body JSON del request (Vercel Node functions no auto-parsean
// en todos los runtimes).
export async function readJsonBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      try { resolve(raw ? JSON.parse(raw) : {}); }
      catch (e) { reject(e); }
    });
    req.on("error", reject);
  });
}
