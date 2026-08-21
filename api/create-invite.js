// POST /api/create-invite
//
// Body: { email: string }
// Header: Authorization: Bearer <supabase_access_token>
//
// Genera un token de invitación de un solo uso, atado al email, con
// caducidad de 7 días. Solo el OWNER de un tenant existente puede
// crear invitaciones. El invited_by queda registrado para trazabilidad.
//
// Response: { url, token, expires_at }

import { supaAdmin, verifyBearer, json, readJsonBody } from "./_lib/supa.js";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const INVITE_TTL_MS = 7 * 24 * 3600 * 1000;

export default async function handler(req, res) {
  if (req.method !== "POST") return json(res, 405, { error: "method not allowed" });

  // 1) Auth del caller.
  const { user, error: authErr } = await verifyBearer(req);
  if (!user) return json(res, 401, { error: `auth: ${authErr}` });

  // 2) Body.
  let body;
  try { body = await readJsonBody(req); }
  catch { return json(res, 400, { error: "body inválido (no es JSON)" }); }
  const email = (body?.email || "").trim().toLowerCase();
  if (!EMAIL_RE.test(email)) return json(res, 400, { error: "email inválido" });
  // F1.2 El Umbral (18/08/2026): aceptamos nombre del invitado para
  // personalizar tarjeta y mensaje. Nullable en BD, guardamos tal cual
  // (sin validación de formato — nombres tienen todas las formas del
  // mundo). Tope defensivo para evitar payloads absurdos.
  const name = (body?.name || "").trim();
  if (name.length > 120) return json(res, 400, { error: "nombre demasiado largo (máx 120)" });

  // 3) Verificar que el caller es OWNER de algún tenant.
  //    Se puede invitar a alguien nuevo solo si tú ya tienes un tenant.
  const { data: tenantRows, error: tErr } = await supaAdmin
    .from("tenants")
    .select("id, name")
    .eq("owner_uid", user.id)
    .limit(1);
  if (tErr) return json(res, 500, { error: `supabase: ${tErr.message}` });
  if (!tenantRows || tenantRows.length === 0) {
    return json(res, 403, { error: "solo owners de un tenant pueden invitar" });
  }

  // 4) INSERT invitations. token generado por Postgres (default gen_random_uuid())
  //    o explícito aquí. Usamos crypto.randomUUID() para claridad.
  const token = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + INVITE_TTL_MS).toISOString();

  const { data: inv, error: insErr } = await supaAdmin
    .from("invitations")
    .insert({
      token,
      email,
      name: name || null,        // opcional, se rellena si el owner lo dio
      invited_by: user.id,
      tenant_id: null,           // el tenant se crea al aceptar el signup
      expires_at: expiresAt,
    })
    .select("id, token, name, expires_at")
    .single();

  if (insErr) {
    return json(res, 500, { error: `insert: ${insErr.message}` });
  }

  // 5) URL de invitación. Canonicalizamos a kluxor.com salvo que la
  //    request venga de una preview de Vercel (dominios con "-git-" o
  //    "-<sha>-"). Fix (21/08/2026): antes usábamos req.headers.host
  //    directo, lo que emitía URLs "tareas-equipo.vercel.app" cuando el
  //    CEO invitador entraba por el dominio Vercel por defecto.
  const rawHost = req.headers?.host || "";
  const isPreview = /-git-|-[a-f0-9]{9}-/i.test(rawHost);
  const host = isPreview ? rawHost : "kluxor.com";
  const proto = req.headers?.["x-forwarded-proto"] || "https";
  const url = `${proto}://${host}/signup?token=${encodeURIComponent(token)}`;

  return json(res, 200, {
    url,
    token: inv.token,
    name: inv.name,
    expires_at: inv.expires_at,
  });
}
