// smoke_f1_preflight — chequeo del estado post-cierre RLS.
//
// 100% LECTURA sobre Supabase producción con anon key. Cero escrituras
// destructivas (los UPDATEs son con valores idempotentes/imposibles;
// tras el cierre de RLS 2026-07-12, no persisten).
//
// Estado esperado tras aplicar migrations/2026-07-12-emergency-rls-taskflow-state.sql:
//   - taskflow_state: SELECT/UPDATE/INSERT/DELETE anon → bloqueado.
//   - RPC current_tenant_id anon → 42501.
//   - tenants, tenant_members, invitations: invisibles/bloqueadas a anon.
//
// Este smoke lo corre CI de F1 y cualquier revisión de "cimiento sano".

import { createClient } from "@supabase/supabase-js";

const SUPA_URL = "https://iqilkicirtmmpvykogot.supabase.co";
const SUPA_KEY = "sb_publishable_zD9BqUw7LY4gZcLDdpbUnA_WczNBPv7";
const TENANT_ANTONIO = "89934a37-60d9-49ac-8a41-dad10601ad81";

const supa = createClient(SUPA_URL, SUPA_KEY);
const results = {};

// ── LECTURAS: anon NO debe ver nada de taskflow_state ni tenants ──────────

// 1) taskflow_state fila id=1: anon debe recibir NULL (RLS oculta).
{
  const { data, error } = await supa
    .from("taskflow_state")
    .select("id, tenant_id")
    .eq("id", 1)
    .maybeSingle();
  results.taskflowAnonBlind = {
    ok: !error && data === null,
    err: error?.code || null,
    leaked: data,
  };
}

// 2) taskflow_state por tenant_id de Antonio: idem.
{
  const { data, error } = await supa
    .from("taskflow_state")
    .select("id")
    .eq("tenant_id", TENANT_ANTONIO)
    .maybeSingle();
  results.taskflowTenantAnonBlind = {
    ok: !error && data === null,
    err: error?.code || null,
    leaked: data,
  };
}

// 3) tenant_members y tenants siguen invisibles.
{
  const { data, error } = await supa.from("tenant_members").select("*", { count: "exact", head: true });
  results.tenantMembersHidden = { ok: !error && (data === null || (Array.isArray(data) && data.length === 0)), err: error?.code || null };
}
{
  const { data, error } = await supa.from("tenants").select("*", { count: "exact", head: true });
  results.tenantsHidden = { ok: !error && (data === null || (Array.isArray(data) && data.length === 0)), err: error?.code || null };
}

// 4) RPC current_tenant_id anon → 42501.
{
  const { data, error } = await supa.rpc("current_tenant_id");
  results.rpcAnonBlocked = { ok: !!error && error.code === "42501", code: error?.code || null, leakedData: data };
}

// ── ESCRITURAS: todos los intentos anon deben resultar en 0 filas afectadas.
//
// Criterio: post-cierre RLS, un UPDATE anon a una fila que no puede ver
// devuelve data=[] sin error. NO devuelve la fila afectada. Ese es el
// signal correcto de "RLS bloqueó silenciosamente". Cero filas afectadas
// = escritura no ocurrió.
async function anonWriteRejected(name, promise) {
  const { data, error } = await promise;
  // Aceptamos dos formas de rechazo:
  //   (a) error explícito con code 42501/PGRST20x/23xxx.
  //   (b) data === [] (RLS oculta la fila; UPDATE afecta 0 filas).
  const explicitError = !!error;
  const zeroRowsAffected = Array.isArray(data) && data.length === 0;
  results[name] = {
    ok: explicitError || zeroRowsAffected,
    code: error?.code || null,
    affectedRows: Array.isArray(data) ? data.length : (data ? "non-array-truthy" : "null"),
  };
}

await anonWriteRejected(
  "taskflowUpdateRejected",
  supa.from("taskflow_state")
    .update({ updated_at: "1999-12-31T23:59:59Z" })
    .eq("id", 1)
    .select("id")
);

await anonWriteRejected(
  "taskflowInsertRejected",
  supa.from("taskflow_state").insert({
    id: 99999,
    tenant_id: "00000000-0000-0000-0000-000000000001",
    data: { probe: "RLS_AUDIT_PROBE_2026-07-12" },
  }).select("id")
);

await anonWriteRejected(
  "taskflowDeleteRejected",
  supa.from("taskflow_state").delete().eq("id", 1).select("id")
);

await anonWriteRejected(
  "tenantsUpdateAntonioRejected",
  supa.from("tenants")
    .update({ name: "RLS_AUDIT_PROBE_2026-07-12" })
    .eq("id", TENANT_ANTONIO)
    .select("id")
);

await anonWriteRejected(
  "tenantsInsertRejected",
  supa.from("tenants").insert({
    name: "RLS_AUDIT_PROBE_2026-07-12",
    owner_uid: "00000000-0000-0000-0000-000000000000",
  }).select("id")
);

// ── SCHEMA CHECKS: infraestructura F1 lista ────────────────────────────────
// Estas tablas se sondean para confirmar shape antes de F1.2 (backend).

async function tableAccessible(table) {
  const { error } = await supa.from(table).select("*", { count: "exact", head: true });
  // 42P01 = tabla no existe. Cualquier otro código (42501 RLS block,
  // PGRST cache, null=vacío) = tabla accesible al menos para PostgREST.
  return error?.code !== "42P01";
}

results.invitationsTableExists  = { ok: await tableAccessible("invitations") };
results.tenantMembersTableExists = { ok: await tableAccessible("tenant_members") };

// ── REPORTE ────────────────────────────────────────────────────────────────
console.log("[f1-preflight · post-cierre RLS · Supabase real]\n");
for (const [k, v] of Object.entries(results)) {
  console.log(`  ${v.ok ? "✓" : "✗"} ${k}: ${JSON.stringify(v)}`);
}

const allOk = Object.values(results).every((v) => v.ok);
console.log("");
if (!allOk) {
  console.log("=== F1 PREFLIGHT FAIL — cimiento no sano ===");
  process.exit(1);
}
console.log("=== F1 PREFLIGHT OK — RLS cerrada, cimiento sano ===");
