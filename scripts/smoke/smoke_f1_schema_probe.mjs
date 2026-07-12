// smoke_f1_schema_probe — sondeo del shape de tablas ya existentes en prod.
// 100% LECTURA. Detecta qué columnas existen en invitations y tenant_members
// para saber si el schema encontrado es compatible con F1 o requiere ajuste.

import { createClient } from "@supabase/supabase-js";

const SUPA_URL = "https://iqilkicirtmmpvykogot.supabase.co";
const SUPA_KEY = "sb_publishable_zD9BqUw7LY4gZcLDdpbUnA_WczNBPv7";
const supa = createClient(SUPA_URL, SUPA_KEY);

async function probeColumns(table, columns) {
  const out = {};
  for (const col of columns) {
    const { error } = await supa
      .from(table)
      .select(col, { count: "exact", head: true });
    // 42703 = undefined_column → columna no existe
    // 42501 = RLS block → tabla existe, columna existe, RLS oculta filas
    // null  = tabla accesible (raro con RLS activa)
    out[col] = error?.code === "42703" ? "MISSING" : "present";
  }
  return out;
}

console.log("[f1-schema-probe · sondeo columnas]\n");

const invitationsCols = await probeColumns("invitations", [
  "token", "email", "invited_by", "tenant_id",
  "expires_at", "used_at", "created_at", "id", "status", "revoked_at",
]);
console.log("invitations:");
for (const [k, v] of Object.entries(invitationsCols)) console.log(`  ${v === "present" ? "✓" : "·"} ${k}: ${v}`);

const tenantMembersCols = await probeColumns("tenant_members", [
  "id", "tenant_id", "user_uid", "email", "role", "created_at", "user_id",
]);
console.log("\ntenant_members:");
for (const [k, v] of Object.entries(tenantMembersCols)) console.log(`  ${v === "present" ? "✓" : "·"} ${k}: ${v}`);

const tenantsCols = await probeColumns("tenants", [
  "id", "owner_uid", "name", "created_at",
  "trial_start", "trial_ends_at", "plan", "status", "slug",
]);
console.log("\ntenants:");
for (const [k, v] of Object.entries(tenantsCols)) console.log(`  ${v === "present" ? "✓" : "·"} ${k}: ${v}`);
