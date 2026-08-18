// smoke_signup_routing — protege que el parser de /signup:
//   1) reconoce solo /signup con token válido (≥8 chars).
//   2) NO devuelve nada para las 15 rutas existentes (routing.js).
//   3) devuelve email en lowercase si viene en query.
//   4) tolera token+email en cualquier orden y con URL encoding.

import { parseSignupPath } from "../../src/lib/signupPath.js";
import { TAB_TO_SLUG, tabFromPath } from "../../src/lib/routing.js";

let failures = [];
function assert(cond, name) { if (!cond) failures.push(name); }

// ── Parser positivo ──────────────────────────────────────────────
const s1 = parseSignupPath("/signup", "?token=abc12345");
assert(s1?.token === "abc12345" && s1?.email === "", "token válido, sin email");

const s2 = parseSignupPath("/signup", "?token=abc12345&email=USER%40Ejemplo.COM");
assert(s2?.token === "abc12345" && s2?.email === "user@ejemplo.com", "email URL-encoded + lowercase");

const s3 = parseSignupPath("/signup", "?email=x%40y.com&token=zzzz9999");
assert(s3?.token === "zzzz9999" && s3?.email === "x@y.com", "orden inverso de params");

// ── Parser negativo ──────────────────────────────────────────────
assert(parseSignupPath("/signup", "") === null,                    "sin query → null");
assert(parseSignupPath("/signup", "?email=x@y.com") === null,       "email pero sin token → null");
assert(parseSignupPath("/signup", "?token=abc") === null,           "token corto (<8) → null");
assert(parseSignupPath("/signup/", "?token=abc12345") === null,     "path con slash final → null (strict)");
assert(parseSignupPath("/signup/extra", "?token=abc12345") === null,"path extra → null");

// ── No colisión con las 15 rutas de routing.js ─────────────────
// Cada slug conocido debe: (a) resolver tab por tabFromPath, (b) NO
// activar parseSignupPath aunque incluya query string parecida.
for (const [tabId, slug] of Object.entries(TAB_TO_SLUG)) {
  const path = `/${slug}`;
  const t = tabFromPath(path);
  assert(t === tabId, `tabFromPath('${path}') → tabId '${tabId}'`);
  assert(parseSignupPath(path, "?token=abc12345") === null,
    `parseSignupPath('${path}') NO debe activar aunque tenga ?token`);
}

// Rutas especiales del proyecto que también deben quedar libres.
assert(parseSignupPath("/", "?token=abc12345") === null,           "root no debe matchear");
assert(parseSignupPath("/vault/token123", "") === null,             "vault guest no debe matchear");
assert(parseSignupPath("/landing.html", "") === null,               "landing estática no debe matchear");
assert(parseSignupPath("/vitrina", "") === null,                    "vitrina no debe matchear");

// ── Report ──────────────────────────────────────────────────────
if (failures.length > 0) {
  console.error("=== SIGNUP ROUTING SMOKE FAIL ===");
  for (const f of failures) console.error("  ✗ " + f);
  process.exit(1);
}
console.log("=== SIGNUP ROUTING SMOKE OK ===");
console.log(`  Parser positivo: 3/3 casos ✓`);
console.log(`  Parser negativo: 5/5 casos ✓`);
console.log(`  Aislamiento vs ${Object.keys(TAB_TO_SLUG).length} rutas existentes: ✓`);
console.log(`  Aislamiento vs rutas especiales (root, vault, landing, vitrina): ✓`);
