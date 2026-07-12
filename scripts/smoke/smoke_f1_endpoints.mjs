// smoke_f1_endpoints — verifica que /api/create-invite, /api/signup y
// /api/mark-first-login están wireados y responden con errores esperados
// cuando se llaman sin auth o con datos inválidos.
//
// Corre contra un servidor local (Vercel dev en http://localhost:3000)
// o contra el URL de preview (var PROD_URL=…).
//
// No hace signup real — eso es E2E manual con una invitación creada por
// Antonio, para no ensuciar prod con tenants basura.

const BASE = process.env.PROD_URL || "http://localhost:3000";

async function post(path, body, headers = {}) {
  const r = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await r.json(); } catch {}
  return { status: r.status, body: json };
}

const results = {};

// 1) create-invite sin auth → 401.
{
  const r = await post("/api/create-invite", { email: "test@example.com" });
  results.createInviteNoAuth = { ok: r.status === 401, status: r.status, err: r.body?.error };
}

// 2) create-invite sin body → 400.
{
  const r = await post("/api/create-invite", null, { authorization: "Bearer fake.jwt" });
  results.createInviteBadAuth = { ok: r.status === 401, status: r.status, err: r.body?.error };
}

// 3) signup con token inexistente → 400.
{
  const r = await post("/api/signup", {
    email: "test@example.com",
    password: "hunter2xyz",
    token: "00000000-0000-0000-0000-000000000000",
  });
  results.signupInvalidToken = { ok: r.status === 400, status: r.status, err: r.body?.error };
}

// 4) signup sin body → 400.
{
  const r = await post("/api/signup", {});
  results.signupNoBody = { ok: r.status === 400, status: r.status, err: r.body?.error };
}

// 5) signup con password muy corto → 400.
{
  const r = await post("/api/signup", {
    email: "test@example.com",
    password: "abc",
    token: "any",
  });
  results.signupShortPassword = { ok: r.status === 400, status: r.status, err: r.body?.error };
}

// 6) mark-first-login sin auth → 401.
{
  const r = await post("/api/mark-first-login", {});
  results.markFirstLoginNoAuth = { ok: r.status === 401, status: r.status, err: r.body?.error };
}

// 7) GET a un POST endpoint → 405.
{
  const r = await fetch(`${BASE}/api/create-invite`);
  results.createInviteGet = { ok: r.status === 405, status: r.status };
}

console.log(`[f1-endpoints · base=${BASE}]\n`);
let allOk = true;
for (const [k, v] of Object.entries(results)) {
  if (!v.ok) allOk = false;
  console.log(`  ${v.ok ? "✓" : "✗"} ${k}: ${JSON.stringify(v)}`);
}
console.log("");
if (!allOk) {
  console.log("=== ENDPOINTS SMOKE FAIL ===");
  process.exit(1);
}
console.log("=== ENDPOINTS SMOKE OK — 3 endpoints wireados y validando ===");
