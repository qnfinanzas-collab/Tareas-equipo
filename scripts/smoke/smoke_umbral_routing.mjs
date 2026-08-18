// smoke_umbral_routing — protege el aislamiento del nuevo tab /umbral
// (F1.2 El Umbral) frente a los tabs preexistentes.
//
// La ruta /umbral se resuelve al tab "umbral" y no debe colisionar con
// ningún otro slug. El componente UmbralView es owner-only pero el
// routing es simétrico — se verifica que:
//   1. tabFromPath("/umbral") = "umbral".
//   2. slugFromTab("umbral")  = "umbral".
//   3. Ninguna otra ruta activa el tab "umbral" por accidente.
//   4. Ninguna ruta legacy pierde su mapeo tras la adición.

import { TAB_TO_SLUG, SLUG_TO_TAB, tabFromPath, slugFromTab, pathFromTab } from "../../src/lib/routing.js";

let failures = [];
function assert(cond, name) { if (!cond) failures.push(name); }

// ── Nuevo tab /umbral ───────────────────────────────────────────
assert(TAB_TO_SLUG.umbral === "umbral",          "TAB_TO_SLUG.umbral === 'umbral'");
assert(SLUG_TO_TAB.umbral === "umbral",          "SLUG_TO_TAB.umbral === 'umbral'");
assert(tabFromPath("/umbral") === "umbral",      "tabFromPath('/umbral') === 'umbral'");
assert(slugFromTab("umbral")  === "umbral",      "slugFromTab('umbral') === 'umbral'");
assert(pathFromTab("umbral")  === "/umbral",     "pathFromTab('umbral') === '/umbral'");

// ── Los 16 tabs preexistentes preservan su mapeo ────────────────
const EXPECTED_LEGACY = {
  "hector-direct": "hector",
  "command":       "sala-de-mando",
  "home":          "home",
  "dealroom":      "dealroom",
  "mytasks":       "mytasks",
  "projects":      "projects",
  "finance":       "finance",
  "workspaces":    "workspaces",
  "places":        "places",
  "dashboard":     "dashboard",
  "briefings":     "briefings",
  "memory":        "memory",
  "gobernanza":    "gobernanza",
  "vault":         "vault",
  "users":         "users",
  "mantenimiento": "mantenimiento",
};
for (const [tab, slug] of Object.entries(EXPECTED_LEGACY)) {
  assert(TAB_TO_SLUG[tab] === slug, `TAB_TO_SLUG.${tab} === '${slug}'`);
  assert(SLUG_TO_TAB[slug] === tab, `SLUG_TO_TAB.${slug} === '${tab}'`);
  assert(tabFromPath(`/${slug}`) === tab, `tabFromPath('/${slug}') === '${tab}'`);
}

// ── /umbral no colisiona con ningún path preexistente ───────────
// Ningún slug legacy debe ser prefijo de "umbral" ni empezar con "umbra".
for (const slug of Object.keys(SLUG_TO_TAB)) {
  if (slug === "umbral") continue;
  assert(slug !== "umbral" && !slug.startsWith("umbra"), `slug '${slug}' NO colisiona con umbral`);
}

// ── Rutas especiales quedan libres ─────────────────────────────
assert(tabFromPath("/") === null,               "root no resuelve a ningún tab");
assert(tabFromPath("/vault/token123") === "vault", "/vault/<token> resuelve a tab vault (primer segmento)");
assert(tabFromPath("/signup") === null,          "/signup no resuelve tab (es ruta pública pre-auth)");
assert(tabFromPath("/landing.html") === null,    "landing.html no resuelve tab");
assert(tabFromPath("/vitrina") === null,         "/vitrina no resuelve tab (rewrite al HTML estático)");

// ── Total ───────────────────────────────────────────────────────
const totalTabs = Object.keys(TAB_TO_SLUG).length;
assert(totalTabs === 17, `TAB_TO_SLUG tiene 17 entradas (16 legacy + umbral): recibí ${totalTabs}`);

// ── Report ──────────────────────────────────────────────────────
if (failures.length > 0) {
  console.error("=== UMBRAL ROUTING SMOKE FAIL ===");
  for (const f of failures) console.error("  ✗ " + f);
  process.exit(1);
}
console.log("=== UMBRAL ROUTING SMOKE OK ===");
console.log(`  Nuevo tab /umbral: 5/5 asertos ✓`);
console.log(`  Legacy 16 tabs preservados: ✓`);
console.log(`  Sin colisiones con slugs previos: ✓`);
console.log(`  Rutas especiales (/, /vault/<t>, /signup, /vitrina, landing): ✓`);
console.log(`  Total tabs: ${totalTabs} (16 + umbral) ✓`);
