// POST /api/revoke-invite
//
// Body: { token: string }
// Header: Authorization: Bearer <supabase_access_token>
//
// Invalida una invitación pendiente marcando revoked_at = now(). Guard
// crítico: el caller solo puede revocar invitaciones que él mismo
// creó (invited_by = auth.uid()). Un owner NUNCA puede tocar
// invitaciones de otro owner.
//
// Idempotente y seguro:
//   - Si la invitación ya fue usada  → 200 { alreadyUsed: true }.
//   - Si la invitación ya fue revocada → 200 { alreadyRevoked: true }.
//   - Si el token no existe            → 404.
//   - Si el token no pertenece al caller → 404 (no revelamos que existe).
//
// Response OK: { ok, revoked_at }
//
// Diseño paralelo a create-invite.js (F1.2 Antesala): mismo patrón de
// auth (verifyBearer), misma tabla, semántica opuesta.

import { supaAdmin, verifyBearer, json, readJsonBody } from "./_lib/supa.js";

export default async function handler(req, res) {
  if (req.method !== "POST") return json(res, 405, { error: "method not allowed" });

  // 1) Auth del caller.
  const { user, error: authErr } = await verifyBearer(req);
  if (!user) return json(res, 401, { error: `auth: ${authErr}` });

  // 2) Body.
  let body;
  try { body = await readJsonBody(req); }
  catch { return json(res, 400, { error: "body inválido (no es JSON)" }); }
  const token = (body?.token || "").trim();
  if (!token || token.length < 8) return json(res, 400, { error: "token requerido" });

  // 3) Localizar la invitación restringida a las del caller.
  //    Si no existe O no es del caller → 404 (no discriminamos entre los dos
  //    casos: revelar "existe pero no es tuya" filtraría información).
  const { data: inv, error: findErr } = await supaAdmin
    .from("invitations")
    .select("id, invited_by, used_at, revoked_at")
    .eq("token", token)
    .eq("invited_by", user.id)     // guard duro: solo tuyas
    .maybeSingle();
  if (findErr) return json(res, 500, { error: `db: ${findErr.message}` });
  if (!inv) return json(res, 404, { error: "invitación no encontrada" });

  // 4) Idempotencia: ya usada o ya revocada → no-op con marca en respuesta.
  if (inv.used_at) {
    return json(res, 200, { ok: true, alreadyUsed: true, used_at: inv.used_at });
  }
  if (inv.revoked_at) {
    return json(res, 200, { ok: true, alreadyRevoked: true, revoked_at: inv.revoked_at });
  }

  // 5) Revocar. Guard extra en el UPDATE contra race con signup:
  //    .is("used_at", null) evita revocar una invitación que se acaba
  //    de usar justo entre nuestro SELECT y este UPDATE.
  const nowIso = new Date().toISOString();
  const { data: updated, error: updErr } = await supaAdmin
    .from("invitations")
    .update({ revoked_at: nowIso })
    .eq("id", inv.id)
    .is("used_at", null)
    .is("revoked_at", null)
    .select("revoked_at")
    .single();

  if (updErr) {
    // Si el error es "no rows" (PGRST116), significa que la race la
    // ganó signup/otro revoke — releemos y devolvemos el estado real.
    const { data: fresh } = await supaAdmin
      .from("invitations")
      .select("used_at, revoked_at")
      .eq("id", inv.id)
      .single();
    if (fresh?.used_at) return json(res, 200, { ok: true, alreadyUsed: true, used_at: fresh.used_at });
    if (fresh?.revoked_at) return json(res, 200, { ok: true, alreadyRevoked: true, revoked_at: fresh.revoked_at });
    return json(res, 500, { error: `update: ${updErr.message}` });
  }

  return json(res, 200, { ok: true, revoked_at: updated.revoked_at });
}
