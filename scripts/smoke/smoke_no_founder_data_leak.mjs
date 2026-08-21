// smoke_no_founder_data_leak — verifica que un tenant genérico (no fundador)
// no acaba con datos del founder en su data tras aplicar los seeds.
//
// Vector histórico (21/08/2026): seedQontoAlmaDimo, seedRegistroKluxor y los
// promptBase de INITIAL_DATA.agents (Mario/Jorge) plantaban IBAN 380,76€,
// proyecto REG, "CASO ESPECIAL - KLUXOR", "de Kluxor / Alma Dimo", "Estructura
// financiera Alma Dimo" en el tenant de cualquier CEO que abriera Kluxor en
// su navegador. RLS no lo cazaba porque el frontend escribía en su propia
// fila taskflow_state — con datos ajenos.
//
// Este smoke replica la lógica de los seeds (extractos de src/App.jsx) sobre
// un tenant genérico y comprueba que NO se ejecutan. Complementa con un scan
// de strings sobre el fuente para pillar regresiones futuras.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..", "..");
const APP_JSX = fs.readFileSync(path.join(ROOT, "src", "App.jsx"), "utf8");
const AGENT_ACTIONS = fs.readFileSync(path.join(ROOT, "src", "lib", "agentActions.js"), "utf8");
const HECTOR_DIRECT = fs.readFileSync(path.join(ROOT, "src", "components", "HectorDirectView.jsx"), "utf8");

let allOk = true;
const check = (label, cond, detail = "") => {
  const ok = !!cond;
  if (!ok) allOk = false;
  console.log(`  ${ok ? "✓" : "✗"} ${label}${detail && !ok ? ` — ${detail}` : ""}`);
};

// ── PARTE 1 · Ejecución dinámica de los seeds sobre un tenant genérico ─────
console.log("[no-founder-leak] Parte 1 · seeds ejecutados sobre tenant genérico\n");

// Réplica exacta de la lógica actual de seedQontoAlmaDimo (App.jsx).
function seedQontoAlmaDimo(d) {
  const isFounderTenant = Array.isArray(d.members) && d.members.some(
    m => m && m.email === "qn.finanzas@gmail.com" && m.accountRole === "admin"
  );
  if (!isFounderTenant) return;
  const TARGET_IBAN = "ES6368880001631828815452";
  if (!Array.isArray(d.bankAccounts)) d.bankAccounts = [];
  if (d.bankAccounts.some(a => (a.iban || "").replace(/\s+/g, "").toUpperCase() === TARGET_IBAN)) return;
  d.bankAccounts.push({
    iban: TARGET_IBAN, currentBalance: 380.76, alias: "Cuenta operativa Qonto", bankName: "Qonto",
  });
}

// Réplica exacta de la lógica actual de seedRegistroKluxor (App.jsx).
function seedRegistroKluxor(d) {
  const isFounderTenant = Array.isArray(d.members) && d.members.some(
    m => m && m.email === "qn.finanzas@gmail.com" && m.accountRole === "admin"
  );
  if (!isFounderTenant) return;
  if ((d.projects || []).some(p => p.code === "REG")) return;
  const admin = (d.members || []).find(m => m.accountRole === "admin")
              || (d.members || []).find(m => m.email === "qn.finanzas@gmail.com");
  const marc = (d.members || []).find(m => /^marc/i.test(m.name || "") || /(mdiaz|marc)/i.test(m.email || ""));
  if (!admin || !marc) return;
  d.projects = [...(d.projects || []), { code: "REG", name: "Registro y Protección Kluxor" }];
}

// Caso A · tenant genérico creado vía /api/signup (memberSeed.id=0, email random).
{
  const d = {
    members: [{ id: 0, name: "canary", email: "canary-nuevo@example.com", accountRole: "admin" }],
    bankAccounts: [], projects: [],
  };
  seedQontoAlmaDimo(d);
  seedRegistroKluxor(d);
  check("tenant genérico · bankAccounts queda vacío tras seedQontoAlmaDimo",
    d.bankAccounts.length === 0,
    `bankAccounts=${JSON.stringify(d.bankAccounts)}`);
  check("tenant genérico · no aparece proyecto REG tras seedRegistroKluxor",
    !d.projects.some(p => p.code === "REG"),
    `projects=${JSON.stringify(d.projects)}`);
}

// Caso B · tenant fundador (Antonio) — SÍ debe sembrar.
{
  const d = {
    members: [
      { id: 6, name: "Antonio Díaz", email: "qn.finanzas@gmail.com", accountRole: "admin" },
      { id: 5, name: "Marc Díaz",    email: "mdiaz.holding@gmail.com", accountRole: "member" },
    ],
    bankAccounts: [], projects: [], workspaces: [],
  };
  seedQontoAlmaDimo(d);
  seedRegistroKluxor(d);
  check("tenant fundador · sí siembra la cuenta Qonto (regresión inversa)",
    d.bankAccounts.length === 1 && d.bankAccounts[0].currentBalance === 380.76,
    `bankAccounts=${JSON.stringify(d.bankAccounts)}`);
  check("tenant fundador · sí siembra el proyecto REG (regresión inversa)",
    d.projects.some(p => p.code === "REG"),
    `projects=${JSON.stringify(d.projects.map(p => p.code))}`);
}

// Caso C · tenant que finge ser fundador con email correcto pero rol member
//         (defensa contra bypass por edición manual de data).
{
  const d = {
    members: [{ id: 0, name: "impostor", email: "qn.finanzas@gmail.com", accountRole: "member" }],
    bankAccounts: [], projects: [],
  };
  seedQontoAlmaDimo(d);
  seedRegistroKluxor(d);
  check("impostor con email fundador pero rol=member · bankAccounts vacío",
    d.bankAccounts.length === 0);
  check("impostor con email fundador pero rol=member · sin proyecto REG",
    !d.projects.some(p => p.code === "REG"));
}

// ── PARTE 2 · Scan estático del fuente ─────────────────────────────────────
console.log("\n[no-founder-leak] Parte 2 · scan estático del fuente\n");

// AGENT_ACTIONS_ADDON no debe contener el bloque PERFIL CEO estático.
{
  const addonMatch = AGENT_ACTIONS.match(/export const AGENT_ACTIONS_ADDON\s*=\s*`([\s\S]*?)`;/);
  const addonBody = addonMatch ? addonMatch[1] : "";
  check("AGENT_ACTIONS_ADDON no contiene 'PERFIL CEO:'",
    addonBody && !addonBody.includes("PERFIL CEO:"),
    "PERFIL CEO todavía presente en el addon estático");
  check("AGENT_ACTIONS_ADDON no menciona 'Antonio Díaz'",
    addonBody && !/Antonio\s+D[íi]az/.test(addonBody));
  check("AGENT_ACTIONS_ADDON no menciona 'ALMA DIMO' ni 'Alma Dimo'",
    addonBody && !/Alma Dimo|ALMA DIMO/i.test(addonBody));
  check("AGENT_ACTIONS_ADDON marca de versión actualizada a ACTIONS_v18",
    addonBody && addonBody.includes("ACTIONS_v18"));
}

// INITIAL_DATA (dentro de App.jsx) — extraer el objeto completo y verificar
// strings prohibidos. Todo lo que esté aquí se copia a los tenants nuevos.
// Delimitamos por "const INITIAL_DATA = {" ... primer "\n};\n" posterior.
{
  const idxStart = APP_JSX.indexOf("const INITIAL_DATA = {");
  const idxEnd   = APP_JSX.indexOf("\n};\n", idxStart);
  const initialDataBlock = idxStart > 0 && idxEnd > 0 ? APP_JSX.slice(idxStart, idxEnd + 3) : "";
  check("INITIAL_DATA localizado en App.jsx",
    initialDataBlock.length > 0);
  check("INITIAL_DATA no contiene 'CASO ESPECIAL - KLUXOR'",
    !/CASO ESPECIAL - KLUXOR/.test(initialDataBlock));
  check("INITIAL_DATA no contiene 'Kluxor / Alma Dimo Investments'",
    !/Kluxor \/ Alma Dimo Investments/.test(initialDataBlock));
  check("INITIAL_DATA no contiene 'Antonio Díaz Molina'",
    !/Antonio\s+D[íi]az\s+Molina/.test(initialDataBlock));
  check("INITIAL_DATA no contiene 'Estructura financiera Alma Dimo'",
    !/Estructura financiera Alma Dimo/.test(initialDataBlock));
  check("INITIAL_DATA no contiene 'remanente Alma Dimo'",
    !/remanente Alma Dimo/.test(initialDataBlock));
  check("INITIAL_DATA no contiene 'Estacionalidad Costa del Sol'",
    !/Estacionalidad Costa del Sol/.test(initialDataBlock));
  check("INITIAL_DATA no contiene 'Jurisdicción Marbella' ni 'Juzgados Marbella'",
    !/Jurisdicci[oó]n:? Marbella|Juzgados Marbella/.test(initialDataBlock));
  check("INITIAL_DATA no contiene 'Admore Projects'",
    !/Admore Projects/.test(initialDataBlock));
  check("INITIAL_DATA no contiene CIF B19929256",
    !/B19929256/.test(initialDataBlock));
  check("INITIAL_DATA no contiene el IBAN Qonto fundador",
    !/ES6368880001631828815452/.test(initialDataBlock));
}

// HectorDirectView · buildCeoBlock debe tener guard founder-only para el
// fallback legacy Antonio.
{
  check("HectorDirectView · guard founder-only en fallback buildCeoBlockLegacyAntonio",
    /email === "qn\.finanzas@gmail\.com"\)\s*return buildCeoBlockLegacyAntonio/.test(HECTOR_DIRECT));
  check("HectorDirectView · existe buildCeoBlockNeutro para tenants no-fundador",
    /function buildCeoBlockNeutro\(/.test(HECTOR_DIRECT));
}

// Guards founder-only en seeds de App.jsx.
{
  const seedQontoIdx = APP_JSX.indexOf("function seedQontoAlmaDimo(d)");
  const seedRegIdx = APP_JSX.indexOf("function seedRegistroKluxor(d)");
  const seedQontoBody = APP_JSX.slice(seedQontoIdx, seedQontoIdx + 800);
  const seedRegBody = APP_JSX.slice(seedRegIdx, seedRegIdx + 800);
  check("seedQontoAlmaDimo tiene guard 'isFounderTenant'",
    /isFounderTenant/.test(seedQontoBody));
  check("seedQontoAlmaDimo devuelve temprano si !isFounderTenant",
    /if\s*\(!isFounderTenant\)\s*return/.test(seedQontoBody));
  check("seedRegistroKluxor tiene guard 'isFounderTenant'",
    /isFounderTenant/.test(seedRegBody));
  check("seedRegistroKluxor devuelve temprano si !isFounderTenant",
    /if\s*\(!isFounderTenant\)\s*return/.test(seedRegBody));
}

// ── Resumen ───────────────────────────────────────────────────────────────
console.log("");
if (allOk) {
  console.log("=== NO-FOUNDER-LEAK SMOKE OK ===");
} else {
  console.log("=== NO-FOUNDER-LEAK SMOKE FAIL ===");
  process.exit(1);
}
