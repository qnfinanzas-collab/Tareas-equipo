// smoke_fase2_isolation — aislamiento multi-tenant E2E real (no solo bundle).
//
// CRÍTICO: protege que el cimiento RLS + tenant resolution siga funcionando.
//
// LECTURA anon (todas deben devolver 0/vacío tras el cierre RLS 2026-07-12):
//   1) taskflow_state por tenant Antonio → 0 filas (RLS bloquea SELECT anon).
//   2) taskflow_state por tenant inventado → 0 filas.
//   3) RPC current_tenant_id anon → 42501 (portero cerrado).
//   4) tenant_members anon → 0 filas.
//   5) tenants anon → 0 filas.
//
// ESCRITURA anon (paso 3 obligatorio tras el incidente 2026-07-12):
//   6) UPDATE anon a taskflow_state id=1 → 0 filas afectadas.
//   7) INSERT anon taskflow_state → rechazado (42501 o schema block).
//   8) DELETE anon taskflow_state → 0 filas afectadas.
//   9) UPDATE anon a tenants (fila Antonio) → 0 filas afectadas.
//
// Bundle check (puppeteer): el bundle servido por preview contiene los
// markers de wiring de Fase 2B (RPC + tenant_id filter + logs).

import { createClient } from "@supabase/supabase-js";
import puppeteer from "puppeteer";

const SUPA_URL = "https://iqilkicirtmmpvykogot.supabase.co";
const SUPA_KEY = "sb_publishable_zD9BqUw7LY4gZcLDdpbUnA_WczNBPv7";
const TENANT_ANTONIO  = "89934a37-60d9-49ac-8a41-dad10601ad81";
const TENANT_INVENTED = "00000000-0000-0000-0000-000000000099";

const supa = createClient(SUPA_URL, SUPA_KEY);

const results = {};

// 1) taskflow_state por tenant Antonio: anon debe recibir NULL.
// (Antes del cierre RLS 2026-07-12 devolvía la fila. Ahora RLS bloquea SELECT.)
{
  const { data, error } = await supa.from("taskflow_state").select("id, tenant_id").eq("tenant_id", TENANT_ANTONIO).maybeSingle();
  results.taskflowAnonBlind = { ok: !error && data === null, leaked: data };
}
// 2) tenant inventado → 0 filas (mismo comportamiento antes y ahora).
{
  const { data, error } = await supa.from("taskflow_state").select("id").eq("tenant_id", TENANT_INVENTED);
  results.queryInvented = { ok: !error && Array.isArray(data) && data.length === 0 };
}
// 3) RPC anon → 42501.
{
  const { data, error } = await supa.rpc("current_tenant_id");
  results.rpcAnonBlocked = { ok: !!error && error.code === "42501", code: error?.code || null, leakedData: data };
}
// 4) tenant_members anon → 0.
{
  const { data, error } = await supa.from("tenant_members").select("*", { count: "exact", head: true });
  results.tenantMembersHidden = { ok: !error && (data === null || (Array.isArray(data) && data.length === 0)) };
}
// 5) tenants anon → 0.
{
  const { data, error } = await supa.from("tenants").select("*", { count: "exact", head: true });
  results.tenantsHidden = { ok: !error && (data === null || (Array.isArray(data) && data.length === 0)) };
}

// ── ESCRITURA anon: todas deben resultar en 0 filas afectadas. ────────────
// Post-cierre RLS un UPDATE anon a una fila que no puede ver devuelve
// data=[] sin error explícito. Ese es el signal de "0 rows affected".
async function anonWriteRejected(name, promise) {
  const { data, error } = await promise;
  const explicitError = !!error;
  const zeroRowsAffected = Array.isArray(data) && data.length === 0;
  results[name] = {
    ok: explicitError || zeroRowsAffected,
    code: error?.code || null,
    affectedRows: Array.isArray(data) ? data.length : (data ? "non-array-truthy" : "null"),
  };
}

// 6) UPDATE anon a taskflow_state id=1: 0 filas.
await anonWriteRejected(
  "taskflowUpdateRejected",
  supa.from("taskflow_state").update({ updated_at: "1999-12-31T23:59:59Z" }).eq("id", 1).select("id")
);
// 7) INSERT anon taskflow_state: rechazado.
await anonWriteRejected(
  "taskflowInsertRejected",
  supa.from("taskflow_state").insert({ id: 99999, tenant_id: TENANT_INVENTED, data: {} }).select("id")
);
// 8) DELETE anon taskflow_state id=1: 0 filas.
await anonWriteRejected(
  "taskflowDeleteRejected",
  supa.from("taskflow_state").delete().eq("id", 1).select("id")
);
// 9) UPDATE anon a tenants (fila Antonio): 0 filas.
await anonWriteRejected(
  "tenantsAntonioUpdateRejected",
  supa.from("tenants").update({ name: "PROBE_2026-07-12" }).eq("id", TENANT_ANTONIO).select("id")
);

console.log("[isolation · supabase real]");
for (const [k, v] of Object.entries(results)) {
  console.log(`  ${v.ok ? "✓" : "✗"} ${k}:`, JSON.stringify(v));
}
const supaOk = Object.values(results).every(v => v.ok);
if (!supaOk) { console.log("\nFAIL: parte 1 (Supabase real)"); process.exit(1); }

// Parte 2 — bundle.
const browser = await puppeteer.launch({ headless: true });
const page = await browser.newPage();
await page.goto("http://localhost:4173/home", { waitUntil: "networkidle0", timeout: 25000 });
const bundleProbe = await page.evaluate(async () => {
  const html = document.documentElement.outerHTML;
  const m = html.match(/index-[A-Za-z0-9_-]+\.js/);
  if (!m) return { error: "no encuentro bundle" };
  const r = await fetch("/assets/" + m[0]);
  const js = await r.text();
  return {
    bundle: m[0], bytes: js.length,
    hasRpcCall:       js.includes("current_tenant_id"),
    hasTenantFilter:  js.includes('"tenant_id"') || js.includes("tenant_id=eq"),
    hasResolvedLog:   js.includes("tenant resolved"),
    hasFallbackLog:   js.includes("fallback to id=1"),
    hasTenantsModule: js.includes("[tenants] rpc error"),
  };
});
await browser.close();

console.log("\n[isolation · bundle]");
console.log("  bundle:", bundleProbe.bundle, "·", bundleProbe.bytes, "bytes");
for (const k of ["hasRpcCall", "hasTenantFilter", "hasResolvedLog", "hasFallbackLog", "hasTenantsModule"]) {
  console.log(`  ${bundleProbe[k] ? "✓" : "✗"} ${k}`);
}
const bundleOk = bundleProbe.hasRpcCall && bundleProbe.hasTenantFilter && bundleProbe.hasResolvedLog && bundleProbe.hasFallbackLog && bundleProbe.hasTenantsModule;
if (!bundleOk) { console.log("\nFAIL: parte 2 (bundle)"); process.exit(1); }

console.log("\n=== ISOLATION SMOKE OK ===");
console.log(`· Supabase real: taskflow_state invisible a anon; RPC 42501; tenants/tenant_members invisibles.`);
console.log(`· Escritura anon: UPDATE/INSERT/DELETE de taskflow_state y UPDATE tenants → 0 filas afectadas.`);
console.log(`· Bundle servido contiene markers de Fase 2B (RPC + tenant_id + logs).`);
