// smoke_b1_agent_auth — cierre B1 (19/08/2026).
//
// Verifica que /api/agent RECHAZA peticiones no autenticadas. Antes de este
// cierre cualquiera podía consumir el saldo Anthropic. Este smoke es la
// prueba de que el vector está cerrado.
//
// Tests:
//   1) POST sin ningún auth              → 401
//   2) POST con Authorization: Bearer <garbage>  → 401
//   3) POST con Bearer válido-formato pero JWT falso → 401
//   4) POST con vault_token+pin inexistentes     → 401
//   5) POST solo con vault_token (sin PIN)       → 401
//   6) POST solo con vault_pin (sin token)       → 401
//   7) GET /api/agent                            → 405
//
// No prueba el camino positivo (Bearer válido → 200) porque:
//   (a) requiere una sesión real de Supabase (con costes Anthropic reales),
//   (b) el positivo se valida manualmente en el navegador tras el deploy.
//
// URL base por defecto: producción. Se puede sobreescribir con PROD_URL.

const BASE = process.env.PROD_URL || "https://kluxor.com";

async function postAgent(body, headers = {}) {
  const r = await fetch(`${BASE}/api/agent`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body || {}),
  });
  let json = null;
  try { json = await r.json(); } catch {}
  return { status: r.status, body: json };
}

// Payload mínimo válido en shape (para no fallar en validación de body
// antes de llegar al gate de auth). Si el auth pasa, este payload
// dispararía una llamada real a Anthropic — por eso todos los tests son
// negativos: nunca llegamos al proxy real.
const VALID_SHAPE = {
  system: "test",
  messages: [{ role: "user", content: "ping" }],
  max_tokens: 10,
};

const results = {};

// 1) Sin auth alguna → 401.
{
  const r = await postAgent(VALID_SHAPE);
  results.noAuth = { ok: r.status === 401, status: r.status, err: r.body?.error };
}

// 2) Garbage en Authorization (no matchea "Bearer <token>") → 401.
{
  const r = await postAgent(VALID_SHAPE, { authorization: "garbage-token" });
  results.garbageHeader = { ok: r.status === 401, status: r.status, err: r.body?.error };
}

// 3) Bearer con formato pero JWT falso → 401 (Supabase rechaza).
{
  const r = await postAgent(VALID_SHAPE, { authorization: "Bearer eyJhbGciOiJIUzI1NiJ9.fake.jwt" });
  results.fakeBearer = { ok: r.status === 401, status: r.status, err: r.body?.error };
}

// 4) vault_token+pin inexistentes → 401 (no revela si existe o no).
{
  const r = await postAgent({
    ...VALID_SHAPE,
    vault_token: "nonexistent-token-12345678",
    vault_pin: "9999",
  });
  results.invalidVault = { ok: r.status === 401, status: r.status, err: r.body?.error };
}

// 5) Solo token, sin PIN → 401 (ambos requeridos).
{
  const r = await postAgent({ ...VALID_SHAPE, vault_token: "nonexistent-token-12345678" });
  results.vaultTokenNoPin = { ok: r.status === 401, status: r.status, err: r.body?.error };
}

// 6) Solo PIN, sin token → 401.
{
  const r = await postAgent({ ...VALID_SHAPE, vault_pin: "1234" });
  results.vaultPinNoToken = { ok: r.status === 401, status: r.status, err: r.body?.error };
}

// 7) GET → 405 (method not allowed).
{
  const r = await fetch(`${BASE}/api/agent`);
  results.getMethod = { ok: r.status === 405, status: r.status };
}

console.log(`[b1-agent-auth · base=${BASE}]\n`);
let allOk = true;
for (const [k, v] of Object.entries(results)) {
  if (!v.ok) allOk = false;
  console.log(`  ${v.ok ? "✓" : "✗"} ${k}: ${JSON.stringify(v)}`);
}
console.log();

if (allOk) {
  console.log("=== B1 AGENT AUTH SMOKE OK ===");
  console.log("· /api/agent rechaza correctamente peticiones sin auth (401).");
  console.log("· vault_token requiere PIN válido; garbage/fake JWT rechazados.");
  console.log("· El vector que agotó el saldo Anthropic está cerrado.");
  process.exit(0);
} else {
  console.log("=== B1 AGENT AUTH SMOKE FAIL ===");
  console.log("· Al menos una petición sin auth NO devolvió 401.");
  console.log("· REVISAR api/agent.js: el gate de auth puede estar roto o deployado a medias.");
  process.exit(1);
}
