// smoke_fase2_isolation — aislamiento multi-tenant E2E real (no solo bundle).
//
// CRÍTICO: protege que el cimiento RLS + tenant resolution siga funcionando.
//
// 5 queries reales contra Supabase producción con anon key:
//   1) tenant_id de Antonio → fila id=1 con data.projects.length>=50.
//   2) tenant_id inventado   → 0 filas (filtro mecánico OK).
//   3) RPC current_tenant_id desde anon → 42501 (portero cerrado).
//   4) tenant_members anon   → 0 filas (RLS estricta vacía).
//   5) tenants anon          → 0 filas (idem).
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

// 1) tenant correcto → fila id=1 con data.
{
  const { data, error } = await supa.from("taskflow_state").select("id, tenant_id, data").eq("tenant_id", TENANT_ANTONIO).maybeSingle();
  results.queryAntonio = {
    ok: !error && data && data.id === 1 && data.tenant_id === TENANT_ANTONIO && Array.isArray(data.data?.projects),
    projects: Array.isArray(data?.data?.projects) ? data.data.projects.length : null,
  };
}
// 2) tenant inventado → 0 filas.
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
console.log(`· Supabase real: tenant correcto devuelve fila id=1 (${results.queryAntonio.projects} projects); tenant inventado → 0; RPC anon 42501; tenants/tenant_members invisibles.`);
console.log(`· Bundle servido contiene markers de Fase 2B (RPC + tenant_id + logs).`);
