#!/usr/bin/env node
// build_tenant_insert.mjs — genera las 3 sentencias SQL del alta manual
// de un CEO nuevo (Fase 2C). NO ejecuta nada contra Supabase. Solo emite
// SQL listo para pegar en el SQL Editor del panel.
//
// USO:
//   node scripts/build_tenant_insert.mjs \
//     --owner-uid <auth.users.id del CEO nuevo>           \
//     --tenant-name "CEO Test · Empresa Demo"             \
//     --ceo-name   "Antonio Test"                         \
//     --email      "qn.finanzas+test@gmail.com"           \
//     --company    "Empresa Demo S.L."                    \
//     --sector     "Inversión inmobiliaria"               \
//     --description "Probando el sistema de aislamiento."
//
// Salida: las 3 sentencias SQL (INSERT tenants → RETURNING id ; INSERT
// tenant_members ; INSERT taskflow_state) por stdout. Pegas en SQL
// Editor en orden. Sustituyes el <TENANT_ID> en las dos últimas con
// el UUID que devolvió la primera.
//
// El template `initialState/blank.json` se rellena con los campos del
// CLI y se inyecta el CEO como único miembro (id=1, accountRole=admin)
// para que `resolveSessionMember` lo encuentre tras login.
//
// NO toca runtime ni Supabase. Solo lee blank.json y compone SQL como
// strings.

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BLANK_PATH = resolve(__dirname, "..", "initialState", "blank.json");

// CLI args muy simples (sin librería). --key value o --key=value.
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const eq = a.indexOf("=");
    if (eq >= 0) { out[a.slice(2, eq)] = a.slice(eq + 1); continue; }
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) { out[a.slice(2)] = true; continue; }
    out[a.slice(2)] = next;
    i++;
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));

const REQUIRED = ["owner-uid", "tenant-name", "ceo-name", "email", "company", "sector", "description"];
const missing = REQUIRED.filter(k => !args[k] || typeof args[k] !== "string");
if (missing.length) {
  console.error("[build_insert] faltan args obligatorios:", missing.join(", "));
  console.error("\nUso:");
  console.error("  node scripts/build_tenant_insert.mjs \\");
  console.error("    --owner-uid <UUID> --tenant-name '...' --ceo-name '...' --email '...' \\");
  console.error("    --company '...' --sector '...' --description '...'");
  process.exit(2);
}

// Validación mínima: el owner-uid debe parecer un UUID.
const UID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
if (!UID_RE.test(args["owner-uid"])) {
  console.error(`[build_insert] --owner-uid no parece un UUID válido: ${args["owner-uid"]}`);
  process.exit(2);
}

// Carga blank.json y compone el estado del nuevo tenant.
const blank = JSON.parse(readFileSync(BLANK_PATH, "utf8"));

// (1) ceoProfile relleno con los 4 campos del CLI.
blank.ceoProfile = {
  name:        args["ceo-name"],
  company:     args["company"],
  sector:      args["sector"],
  description: args["description"],
};

// (2) Inyectamos el CEO como único miembro inicial. Iniciales = 2
// primeras letras del nombre en mayúsculas; rol display "Manager"
// (decisión cosmética). accountRole=admin (el CEO es el admin de su
// propio tenant). avail mínimo — _migrate puede rellenar defaults.
const initials = (args["ceo-name"] || "").trim().split(/\s+/).map(s => s[0] || "").join("").slice(0, 2).toUpperCase() || "CE";
blank.members = [{
  id: 1,
  name: args["ceo-name"],
  initials,
  role: "Manager",
  email: args["email"],
  supabaseUid: args["owner-uid"],
  accountRole: "admin",
  avail: { workDays: [1,2,3,4,5], morningStart: "08:00", morningEnd: "13:00", afternoonStart: "14:30", afternoonEnd: "18:00", hoursPerDay: 8, exceptions: [], blockedSlots: [], whatsapp: "", transportMarginMins: 30 },
}];

// Escape SQL para strings ('') — los campos de texto pueden tener
// apóstrofos en el sector o description.
function sqlString(s) {
  if (s === null || s === undefined) return "NULL";
  return "'" + String(s).replace(/'/g, "''") + "'";
}

// JSONB literal: stringify a JSON estándar y reusa sqlString.
const blankJson = JSON.stringify(blank);

const sql = `-- Alta manual de tenant (CEO nuevo) generada por build_tenant_insert.mjs
-- Argumentos:
--   owner-uid    = ${args["owner-uid"]}
--   tenant-name  = ${args["tenant-name"]}
--   ceo-name     = ${args["ceo-name"]}
--   email        = ${args["email"]}
--   company      = ${args["company"]}
--   sector       = ${args["sector"]}
-- Pega las 3 sentencias en SQL Editor EN ORDEN. La sentencia 1 te devuelve
-- un <TENANT_ID> que tienes que copiar en las sentencias 2 y 3 antes de
-- ejecutarlas.

-- 1) Registrar el tenant. Apunta el id devuelto:
INSERT INTO public.tenants (name, owner_uid)
VALUES (${sqlString(args["tenant-name"])}, ${sqlString(args["owner-uid"])})
RETURNING id;

-- 2) Registrar al CEO como admin de su tenant. Sustituye <TENANT_ID>.
INSERT INTO public.tenant_members (tenant_id, user_uid, role)
VALUES ('<TENANT_ID>', ${sqlString(args["owner-uid"])}, 'admin');

-- 3) Crear la fila taskflow_state con el blank state + ceoProfile relleno.
--    Sustituye <TENANT_ID>.
INSERT INTO public.taskflow_state (data, tenant_id)
VALUES (${sqlString(blankJson)}::jsonb, '<TENANT_ID>');

-- Verificación post-ejecución (opcional):
-- SELECT data->'ceoProfile' AS profile,
--        jsonb_array_length(data->'members') AS n_members,
--        jsonb_array_length(data->'agents')  AS n_agents
--   FROM public.taskflow_state WHERE tenant_id = '<TENANT_ID>';
-- Esperado: profile con los 4 campos, n_members=1 (el propio CEO), n_agents=0
-- (los 6 especialistas se hidratan en el primer load vía _migrate).
`;

process.stdout.write(sql);
