// smoke_f1_rls_full_audit — auditoría determinística de RLS de escritura
// en TODAS las tablas conocidas.
//
// Método: INSERTs con marcador "RLS_AUDIT_PROBE_2026-07-12" para poder
// distinguirlos e instruir a Antonio a borrarlos si algún INSERT pasa.
// Cero UPDATEs a datos existentes (aparte del ya conocido en taskflow_state).
//
// Tablas probadas: tenants, tenant_members, invitations, ceo_memory,
// hector_chat, hector_panel_state, hector_tickets.

import { createClient } from "@supabase/supabase-js";

const SUPA_URL = "https://iqilkicirtmmpvykogot.supabase.co";
const SUPA_KEY = "sb_publishable_zD9BqUw7LY4gZcLDdpbUnA_WczNBPv7";
const supa = createClient(SUPA_URL, SUPA_KEY);

const MARKER_EMAIL = "rls-audit-probe-20260712@example.invalid";
const MARKER_UID = "00000000-0000-0000-0000-000000000abc";
const MARKER_TENANT = "00000000-0000-0000-0000-000000000def";

const results = {};

async function probe(name, insertPromise, verifyPromise) {
  const ins = await insertPromise;
  const insertOk = !ins.error;
  const verify = verifyPromise ? await verifyPromise : null;
  const rowPersisted = verify ? (Array.isArray(verify.data) ? verify.data.length > 0 : !!verify.data) : null;
  results[name] = {
    inserted: insertOk,
    persisted: rowPersisted,
    insertCode: ins.error?.code || null,
    insertMsg: ins.error?.message?.slice(0, 100) || null,
  };
}

// ── tenants ────────────────────────────────────────────────────────────────
await probe(
  "tenants",
  supa.from("tenants").insert({
    id: MARKER_TENANT,
    owner_uid: MARKER_UID,
    name: "RLS_AUDIT_PROBE_2026-07-12",
  }).select("id"),
  supa.from("tenants").select("id").eq("id", MARKER_TENANT).maybeSingle()
);

// ── tenant_members ─────────────────────────────────────────────────────────
await probe(
  "tenant_members",
  supa.from("tenant_members").insert({
    tenant_id: MARKER_TENANT,
    user_uid: MARKER_UID,
    email: MARKER_EMAIL,
    role: "member",
  }).select("id"),
  supa.from("tenant_members").select("id").eq("email", MARKER_EMAIL).maybeSingle()
);

// ── invitations ────────────────────────────────────────────────────────────
await probe(
  "invitations",
  supa.from("invitations").insert({
    email: MARKER_EMAIL,
    token: crypto.randomUUID(),
    expires_at: new Date(Date.now() + 86400000).toISOString(),
  }).select("id"),
  supa.from("invitations").select("id").eq("email", MARKER_EMAIL).maybeSingle()
);

// ── ceo_memory ─────────────────────────────────────────────────────────────
await probe(
  "ceo_memory",
  supa.from("ceo_memory").insert({
    user_id: MARKER_UID,
    memory: { probe: "RLS_AUDIT_PROBE_2026-07-12" },
  }).select("*").limit(1),
  supa.from("ceo_memory").select("*").eq("user_id", MARKER_UID).maybeSingle()
);

// ── hector_chat ────────────────────────────────────────────────────────────
await probe(
  "hector_chat",
  supa.from("hector_chat").insert({
    user_id: MARKER_UID,
    messages: [{ probe: "RLS_AUDIT_PROBE_2026-07-12" }],
  }).select("*").limit(1),
  supa.from("hector_chat").select("*").eq("user_id", MARKER_UID).maybeSingle()
);

// ── hector_panel_state ─────────────────────────────────────────────────────
await probe(
  "hector_panel_state",
  supa.from("hector_panel_state").insert({
    user_id: MARKER_UID,
    state: { probe: "RLS_AUDIT_PROBE_2026-07-12" },
  }).select("*").limit(1),
  supa.from("hector_panel_state").select("*").eq("user_id", MARKER_UID).maybeSingle()
);

// ── hector_tickets ─────────────────────────────────────────────────────────
await probe(
  "hector_tickets",
  supa.from("hector_tickets").insert({
    user_id: MARKER_UID,
    title: "RLS_AUDIT_PROBE_2026-07-12",
    body: "audit probe",
  }).select("*").limit(1),
  supa.from("hector_tickets").select("*").eq("title", "RLS_AUDIT_PROBE_2026-07-12").maybeSingle()
);

console.log("[f1-rls-full-audit] — INSERT anon a cada tabla\n");
const failed = [];
for (const [table, r] of Object.entries(results)) {
  const brokenRls = r.persisted === true;
  const symbol = brokenRls ? "🚨" : (r.inserted && r.persisted === null ? "?" : "✓");
  console.log(`  ${symbol} ${table}: inserted=${r.inserted}, persisted=${r.persisted}, code=${r.insertCode || "null"}`);
  if (r.insertMsg && !r.inserted) console.log(`      msg: ${r.insertMsg}`);
  if (brokenRls) failed.push(table);
}

console.log("");
if (failed.length > 0) {
  console.log(`🚨 RLS ROTA EN: ${failed.join(", ")}`);
  console.log(`   Filas insertadas con marcador "${MARKER_EMAIL}" / "RLS_AUDIT_PROBE_2026-07-12".`);
  console.log(`   Deben borrarse manualmente en Supabase Studio tras cerrar RLS.`);
  process.exit(1);
}
console.log("✓ Ninguna tabla adicional muestra RLS rota para INSERT anon.");
console.log("  Solo taskflow_state (comprobado antes) tiene el agujero de UPDATE.");
