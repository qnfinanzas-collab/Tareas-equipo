#!/usr/bin/env node
// build_blank_state.mjs — valida que initialState/blank.json puede servir
// como `data` inicial de un CEO nuevo sin que `_migrate` ni la app
// fallen al cargarla.
//
// Cómo se usa:
//   node scripts/build_blank_state.mjs
//
// Qué hace:
//   1. Parsea initialState/blank.json (debe ser JSON válido).
//   2. Comprueba que tiene las claves MÍNIMAS que el código asume:
//        ceoProfile, members, agents, _seededAgents.
//   3. Comprueba que `agents: []` + `_seededAgents: false` están en el
//      estado correcto para que `_migrate` (App.jsx:923-930) hidrate los
//      6 especialistas desde `INITIAL_DATA.agents` en el primer load del
//      CEO nuevo. Eso evita duplicar los promptBase enormes aquí.
//   4. Comprueba que `members: []` (CEO nuevo arranca SIN heredar nadie
//      del equipo de Antonio).
//   5. Comprueba que `ceoProfile` tiene los 4 campos esperados
//      (name, company, sector, description) listos para rellenar a
//      mano en el alta de cada tenant.
//
// Por qué no extraemos INITIAL_DATA del fuente: la mayoría de top-level
// keys del estado vivo (boards, governance, ceoMemory, etc.) NO están
// en `const INITIAL_DATA = {…}` del App.jsx — se materializan vía
// `_migrate` / `_initCounters` al cargar. El blank.json es deliberadamente
// minimalista (solo lo que tiene que existir de antemano) y deja que la
// app rellene defaults. Eso es robusto frente a cambios futuros del
// schema interno.
//
// NO toca runtime: el bundle de la app no importa este script ni el JSON.
// El JSON solo lo consume `scripts/build_tenant_insert.mjs` al onboardar
// un CEO nuevo.

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BLANK_PATH = resolve(__dirname, "..", "initialState", "blank.json");

let blank;
try {
  blank = JSON.parse(readFileSync(BLANK_PATH, "utf8"));
} catch (e) {
  console.error(`[build_blank] blank.json inválido: ${e.message}`);
  process.exit(2);
}

const errors = [];

// (1) Claves mínimas requeridas.
const REQUIRED = ["ceoProfile", "members", "agents", "_seededAgents"];
for (const k of REQUIRED) {
  if (!Object.prototype.hasOwnProperty.call(blank, k)) errors.push(`falta clave requerida: ${k}`);
}

// (2) agents: [] + _seededAgents: false → _migrate hidratará desde INITIAL_DATA.agents.
if (Array.isArray(blank.agents) && blank.agents.length > 0) {
  errors.push("agents debe estar VACÍO ([]) para que _migrate hidrate los 6 especialistas en el primer load");
}
if (blank._seededAgents !== false) {
  errors.push("_seededAgents debe ser false para que _migrate dispare la seed inicial");
}

// (3) members: [] → CEO nuevo arranca SIN heredar a Antonio/Marc/Albert/Elena.
//     El propio CEO se inyecta luego desde build_tenant_insert.mjs.
if (!Array.isArray(blank.members)) {
  errors.push("members debe ser un array");
} else if (blank.members.length > 0) {
  errors.push(`members debe estar VACÍO en el template (recibido ${blank.members.length} miembros) — el CEO se inyecta vía build_tenant_insert.mjs`);
}

// (4) ceoProfile con los 4 campos esperados.
const PROFILE_FIELDS = ["name", "company", "sector", "description"];
if (!blank.ceoProfile || typeof blank.ceoProfile !== "object") {
  errors.push("ceoProfile debe ser un objeto");
} else {
  for (const f of PROFILE_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(blank.ceoProfile, f)) errors.push(`ceoProfile.${f} ausente`);
    else if (typeof blank.ceoProfile[f] !== "string") errors.push(`ceoProfile.${f} debe ser string`);
  }
}

console.log(`[build_blank] ceoProfile fields:    ${blank.ceoProfile ? PROFILE_FIELDS.filter(f => f in blank.ceoProfile).join(", ") : "(falta)"}`);
console.log(`[build_blank] members.length:        ${Array.isArray(blank.members) ? blank.members.length : "(no array)"}`);
console.log(`[build_blank] agents.length:         ${Array.isArray(blank.agents) ? blank.agents.length : "(no array)"}`);
console.log(`[build_blank] _seededAgents:         ${blank._seededAgents}`);
console.log(`[build_blank] top-level keys:        ${Object.keys(blank).length}`);

if (errors.length > 0) {
  console.error("\n[build_blank] ERRORES:");
  for (const e of errors) console.error(`  · ${e}`);
  process.exit(1);
}
console.log("\n[build_blank] OK · blank.json es un template válido para un CEO nuevo.");
