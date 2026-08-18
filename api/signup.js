// POST /api/signup
//
// Body: { email, password, token }
//
// Crea un nuevo CEO en Kluxor a partir de una invitación válida:
//   1) Valida el token (existe, no usado, no revocado, no expirado, email match).
//   2) Crea auth.user con service_role.
//   3) Crea nueva fila en tenants (id UUID auto, owner_uid = user, plan='trial',
//      status='active', trial_start=NULL — se marca en el primer login efectivo).
//   4) Crea nueva fila en taskflow_state con BLANK_STATE + memberSeed del
//      invitado (accountRole='admin') — sin ese seed, el auth gate del
//      cliente lo rechazaría por "email no autorizado".
//      CRÍTICO: nunca id=1. Postgres asigna vía IDENTITY (migración 18/08).
//   5) Registra al invitado en tenant_members con role='admin' (CHECK
//      solo admite admin|member — nunca 'owner', que es concepto de tenants).
//   6) Marca invitations.used_at.
//
// Si CUALQUIER paso falla después de crear el auth.user, hace rollback.
//
// Response: { ok, tenant_id } · error responses con status claros.

import { supaAdmin, json, readJsonBody } from "./_lib/supa.js";
import { BLANK_STATE } from "./_lib/blank-state.js";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_PASSWORD = 8;

export default async function handler(req, res) {
  if (req.method !== "POST") return json(res, 405, { error: "method not allowed" });

  // 1) Body.
  let body;
  try { body = await readJsonBody(req); }
  catch { return json(res, 400, { error: "body inválido" }); }
  const email    = (body?.email || "").trim().toLowerCase();
  const password = body?.password || "";
  const token    = body?.token || "";

  if (!EMAIL_RE.test(email)) return json(res, 400, { error: "email inválido" });
  if (password.length < MIN_PASSWORD) return json(res, 400, { error: `contraseña mínimo ${MIN_PASSWORD} caracteres` });
  if (!token) return json(res, 400, { error: "token requerido" });

  // 2) Validar invitación.
  const { data: invite, error: invErr } = await supaAdmin
    .from("invitations")
    .select("id, email, token, used_at, revoked_at, expires_at")
    .eq("token", token)
    .maybeSingle();
  if (invErr)  return json(res, 500, { error: `db: ${invErr.message}` });
  if (!invite) return json(res, 400, { error: "invitación no encontrada" });

  if (invite.used_at)   return json(res, 400, { error: "invitación ya usada" });
  if (invite.revoked_at) return json(res, 400, { error: "invitación revocada" });
  if (new Date(invite.expires_at).getTime() < Date.now()) {
    return json(res, 400, { error: "invitación expirada" });
  }
  if ((invite.email || "").toLowerCase() !== email) {
    return json(res, 400, { error: "email no coincide con la invitación" });
  }

  // 3) Crear auth.user. email_confirm:true → sin necesidad de verificación
  //    por email en MVP (F1). Cuando F2 monte SMTP, cambiar a false.
  const { data: created, error: createErr } = await supaAdmin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (createErr) return json(res, 400, { error: `crear usuario: ${createErr.message}` });
  const userId = created.user?.id;
  if (!userId) return json(res, 500, { error: "usuario creado pero sin id" });

  // Rollback helper — se llama en cualquier fallo posterior.
  async function rollback(stage, err) {
    try { await supaAdmin.auth.admin.deleteUser(userId); } catch {}
    // Los INSERTs incompletos ya se limpian en su propio paso si falla
    // antes; aquí solo hace falta el auth user.
    return json(res, 500, { error: `signup fallo en ${stage}: ${err?.message || err}` });
  }

  // 4) Crear tenant. Guard: nunca escribir sobre un tenant existente.
  //    tenants.id es UUID con DEFAULT gen_random_uuid — no colisiona.
  const tenantName = email.split("@")[0].slice(0, 60);
  const { data: newTenant, error: tErr } = await supaAdmin
    .from("tenants")
    .insert({
      name: tenantName,
      owner_uid: userId,
      plan: "trial",
      status: "active",
      trial_start: null,    // se marca en el primer login efectivo
      trial_ends_at: null,
    })
    .select("id")
    .single();
  if (tErr || !newTenant?.id) return rollback("tenants.insert", tErr);
  const newTenantId = newTenant.id;

  // 5) Crear fila taskflow_state con el estado inicial + member seed del
  //    invitado. IDENTITY sobre `id` desde la migración
  //    2026-08-18-taskflow-state-identity.sql — Postgres asigna el
  //    siguiente id automáticamente.
  //
  //    CRÍTICO (18/08/2026): NO insertar BLANK_STATE tal cual. Ese blank
  //    tiene `members: []` vacío, y el auth gate del cliente
  //    (App.jsx:15651 con resolveSessionMember) falla si no encuentra al
  //    user auth en data.members[]. El invitado se autenticaría bien pero
  //    vería pantalla "Acceso no autorizado". Precedente: el mismo bug
  //    lo resolvió a mano scripts/onboard-robert.mjs:126-138 al onboarding
  //    manual de Robert — replicamos el patrón aquí para signups vía
  //    /api/signup normales.
  //
  //    Guard extra defensivo: si por bug se reasignara id=1 (fila
  //    crown-jewel del tenant fundacional), abortar.
  const memberSeed = {
    id: 0,
    name: tenantName,
    initials: ((tenantName[0] || "?") + (tenantName[1] || "")).toUpperCase(),
    role: "Editor",             // rol interno UI (Editor/Viewer/Manager) — legacy
    email,
    supabaseUid: userId,
    accountRole: "admin",       // rol funcional: owner del tenant nuevo
    avail: { hoursPerDay: 8, whatsapp: "" },
  };
  const seededData = {
    ...BLANK_STATE,
    members: [memberSeed],
    ceoProfile: { ...BLANK_STATE.ceoProfile, name: tenantName },
  };

  const { data: newRow, error: rowErr } = await supaAdmin
    .from("taskflow_state")
    .insert({
      tenant_id: newTenantId,
      data: seededData,
    })
    .select("id")
    .single();
  if (rowErr || !newRow?.id) {
    await supaAdmin.from("tenants").delete().eq("id", newTenantId);
    return rollback("taskflow_state.insert", rowErr);
  }
  if (newRow.id === 1) {
    // Debería ser imposible con IDENTITY (secuencia empezó en MAX+1),
    // pero defensivo por si algún día se restaurara la tabla con
    // DEFAULT 1: borrar todo y no seguir.
    await supaAdmin.from("taskflow_state").delete().eq("id", newRow.id).eq("tenant_id", newTenantId);
    await supaAdmin.from("tenants").delete().eq("id", newTenantId);
    return rollback("taskflow_state.insert (id=1 rechazado)", "invariante violada");
  }

  // 6) Registrar como admin en tenant_members.
  //    Nota (18/08/2026): NO escribimos `email` aquí (columna no existe).
  //    Nota (18/08/2026 tarde): role='admin' NO 'owner'. La CHECK
  //    tenant_members_role_check solo admite ('admin','member'). Y la
  //    app en toda su capa de permisos (auth.js, permissions.js, App.jsx)
  //    compara accountRole contra 'admin'/'member' — nunca 'owner'.
  //    El owner del tenant es un concepto de la tabla tenants (owner_uid),
  //    no un rol en tenant_members.
  const { error: memErr } = await supaAdmin
    .from("tenant_members")
    .insert({
      tenant_id: newTenantId,
      user_uid: userId,
      role: "admin",
    });
  if (memErr) {
    await supaAdmin.from("taskflow_state").delete().eq("id", newRow.id);
    await supaAdmin.from("tenants").delete().eq("id", newTenantId);
    return rollback("tenant_members.insert", memErr);
  }

  // 7) Marcar invitación como usada.
  const { error: markErr } = await supaAdmin
    .from("invitations")
    .update({ used_at: new Date().toISOString() })
    .eq("id", invite.id)
    .is("used_at", null);   // guard contra doble uso simultáneo
  if (markErr) {
    // No hacemos rollback: el usuario ya está creado y consistente.
    // Solo logueamos — la próxima ejecución del endpoint verá used_at=null
    // pero fallará porque el email ya existe en auth.
    console.warn(`[signup] no pude marcar invitations.used_at para invite ${invite.id}: ${markErr.message}`);
  }

  return json(res, 200, { ok: true, tenant_id: newTenantId });
}
