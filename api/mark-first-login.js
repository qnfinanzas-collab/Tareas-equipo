// POST /api/mark-first-login
//
// Header: Authorization: Bearer <supabase_access_token>
// Body: {} (vacío — el user viene del JWT)
//
// Marca el trial_start del tenant del caller la PRIMERA vez que hace
// login efectivo. Idempotente por diseño: si trial_start ya está
// fijado, no-op.
//
// Motivación (Antonio, 2026-07-11): el trial de 7 días NO debe arrancar
// al crear el tenant (podría "quemar" días si el invitado tarda). Arranca
// cuando el CEO invitado hace su primer login real.
//
// Response: { trial_start, trial_ends_at, wasAlreadySet }

import { supaAdmin, verifyBearer, json } from "./_lib/supa.js";

const TRIAL_DAYS = 7;

export default async function handler(req, res) {
  if (req.method !== "POST") return json(res, 405, { error: "method not allowed" });

  const { user, error: authErr } = await verifyBearer(req);
  if (!user) return json(res, 401, { error: `auth: ${authErr}` });

  // Resolver el tenant del caller. Aceptamos dos caminos:
  //   (a) owner_uid = user.id  → dueño del tenant.
  //   (b) tenant_member.user_uid = user.id → invitado a un tenant.
  // Priorizamos (a): si eres owner, trial_start es tuyo.
  const { data: ownedRows } = await supaAdmin
    .from("tenants")
    .select("id, trial_start, trial_ends_at")
    .eq("owner_uid", user.id)
    .limit(1);

  let tenant = ownedRows?.[0] || null;

  if (!tenant) {
    // Buscar via tenant_members.
    const { data: memRow } = await supaAdmin
      .from("tenant_members")
      .select("tenant_id")
      .eq("user_uid", user.id)
      .maybeSingle();
    if (memRow?.tenant_id) {
      const { data: t2 } = await supaAdmin
        .from("tenants")
        .select("id, trial_start, trial_ends_at")
        .eq("id", memRow.tenant_id)
        .maybeSingle();
      tenant = t2 || null;
    }
  }

  if (!tenant) return json(res, 404, { error: "sin tenant asociado" });

  // Ya está fijado → no-op idempotente.
  if (tenant.trial_start) {
    return json(res, 200, {
      trial_start: tenant.trial_start,
      trial_ends_at: tenant.trial_ends_at,
      wasAlreadySet: true,
    });
  }

  // Fijar trial_start y trial_ends_at. Guard `.is("trial_start", null)`
  // evita race entre dos logins simultáneos.
  const now = new Date();
  const ends = new Date(now.getTime() + TRIAL_DAYS * 24 * 3600 * 1000);
  const { data: updated, error: updErr } = await supaAdmin
    .from("tenants")
    .update({
      trial_start: now.toISOString(),
      trial_ends_at: ends.toISOString(),
    })
    .eq("id", tenant.id)
    .is("trial_start", null)
    .select("trial_start, trial_ends_at")
    .single();

  if (updErr) return json(res, 500, { error: `update: ${updErr.message}` });

  // updated puede ser null si otra request ganó la carrera y ya lo fijó.
  // En ese caso releemos.
  if (!updated) {
    const { data: fresh } = await supaAdmin
      .from("tenants")
      .select("trial_start, trial_ends_at")
      .eq("id", tenant.id)
      .single();
    return json(res, 200, {
      trial_start: fresh?.trial_start,
      trial_ends_at: fresh?.trial_ends_at,
      wasAlreadySet: true,
    });
  }

  return json(res, 200, {
    trial_start: updated.trial_start,
    trial_ends_at: updated.trial_ends_at,
    wasAlreadySet: false,
  });
}
