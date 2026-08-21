// scripts/decontaminate-founder-seeds.mjs — limpieza one-shot de los tenants
// contaminados por seedQontoAlmaDimo, seedRegistroKluxor y los promptBases
// hardcoded de Mario/Jorge (referencias a Antonio/Alma Dimo/Kluxor/Marbella).
//
// Vector histórico (21/08/2026): el frontend _migrate sembraba en cada tenant
// abierto en un navegador la cuenta bancaria Qonto de Alma Dimo (IBAN
// ES6368…5452, saldo 380,76€), el proyecto REG "Registro y Protección
// Kluxor" (latente por guards), y los 6 agents copiados de INITIAL_DATA con
// promptBase contaminado.
//
// Este script:
//   1. Enumera todos los tenants EXCEPTO el fundador (Antonio, tenant
//      89934a37-…).
//   2. Para cada uno, si el bankAccount con IBAN Qonto está en data.bankAccounts,
//      lo elimina.
//   3. Si algún project.code === "REG", lo elimina.
//   4. Resetea data.agents = [] (fuerza al próximo _migrate en el cliente a
//      re-sembrar limpio con los promptBases saneados del commit cec82f7).
//   5. Log detallado de qué se hizo por tenant. Dry-run por defecto — pasa
//      --apply para escribir.
//
// LANZAR:
//   node --env-file=.env.local scripts/decontaminate-founder-seeds.mjs           # dry-run
//   node --env-file=.env.local scripts/decontaminate-founder-seeds.mjs --apply   # ejecutar
//
// NO toca hector_chat (RLS ya aislaba correctamente cada user_id).
// NO toca ninguna otra clave.

import { createClient } from "@supabase/supabase-js";

const SUPA_URL     = "https://iqilkicirtmmpvykogot.supabase.co";
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;
const FOUNDER_TENANT_ID = "89934a37-60d9-49ac-8a41-dad10601ad81";
const TARGET_IBAN  = "ES6368880001631828815452";
const APPLY = process.argv.includes("--apply");

if (!SERVICE_KEY) {
  console.error("ERR: falta SUPABASE_SERVICE_ROLE_KEY en env.");
  process.exit(2);
}

const admin = createClient(SUPA_URL, SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

console.log(`[decontaminate] modo=${APPLY ? "APPLY (escribe)" : "DRY-RUN (solo lee)"}`);
console.log(`[decontaminate] preservando tenant fundador: ${FOUNDER_TENANT_ID}\n`);

const { data: tenants, error: tErr } = await admin.from("tenants").select("id, name").order("created_at");
if (tErr) throw new Error(`tenants: ${tErr.message}`);

let touched = 0;
let clean   = 0;

for (const t of tenants) {
  if (t.id === FOUNDER_TENANT_ID) {
    console.log(`  ⊘ ${t.name.padEnd(45)} · SKIP (fundador)`);
    continue;
  }
  const { data: st, error: sErr } = await admin
    .from("taskflow_state")
    .select("id, data")
    .eq("tenant_id", t.id)
    .maybeSingle();
  if (sErr) { console.warn(`  ⚠ ${t.name}: ${sErr.message}`); continue; }
  if (!st?.data) { console.log(`  · ${t.name.padEnd(45)} · sin taskflow_state`); continue; }

  const d = st.data;
  const changes = [];
  // 1. Bank accounts contaminados (Qonto Alma Dimo).
  const beforeBA = (d.bankAccounts || []).length;
  const filteredBA = (d.bankAccounts || []).filter(
    a => (a.iban || "").replace(/\s+/g, "").toUpperCase() !== TARGET_IBAN
  );
  if (filteredBA.length !== beforeBA) {
    changes.push(`bankAccounts ${beforeBA}→${filteredBA.length} (removed Qonto Alma Dimo)`);
  }
  // 2. Proyecto REG (latente pero por si acaso).
  const beforeProjects = (d.projects || []).length;
  const filteredProjects = (d.projects || []).filter(p => p.code !== "REG");
  if (filteredProjects.length !== beforeProjects) {
    changes.push(`projects ${beforeProjects}→${filteredProjects.length} (removed REG)`);
  }
  // 3. Agents con promptBase contaminado. Reset a [] fuerza re-siembra
  //    limpia en el próximo _migrate del cliente.
  const beforeAgents = (d.agents || []).length;
  const hasContaminated = (d.agents || []).some(a =>
    typeof a?.promptBase === "string" &&
    /Antonio D[íi]az|Alma Dimo|ALMA DIMO|Kluxor \/ |Admore Projects|CASO ESPECIAL - KLUXOR|Juzgados Marbella|Estructura financiera Alma Dimo/.test(a.promptBase)
  ) || (d.agents || []).some(a =>
    Array.isArray(a?.specialtiesExtended) &&
    a.specialtiesExtended.some(s => s?.name === "Estructura financiera Alma Dimo")
  );
  if (hasContaminated) {
    changes.push(`agents ${beforeAgents}→0 (reset para re-siembra limpia)`);
  }

  if (changes.length === 0) {
    console.log(`  ✓ ${t.name.padEnd(45)} · limpio`);
    clean++;
    continue;
  }

  touched++;
  console.log(`  ✗ ${t.name.padEnd(45)} · ${changes.join(", ")}`);

  if (APPLY) {
    const newData = {
      ...d,
      bankAccounts: filteredBA,
      projects: filteredProjects,
      agents: hasContaminated ? [] : d.agents,
      _seededAgents: hasContaminated ? false : d._seededAgents,
    };
    const { error: uErr } = await admin
      .from("taskflow_state")
      .update({ data: newData })
      .eq("id", st.id);
    if (uErr) console.warn(`    ⚠ update fallo: ${uErr.message}`);
    else      console.log(`    → BD actualizada.`);
  }
}

console.log(`\n[decontaminate] resultado: ${touched} tenant(s) contaminados · ${clean} limpios`);
if (touched > 0 && !APPLY) {
  console.log(`[decontaminate] re-ejecuta con --apply para escribir.`);
}
