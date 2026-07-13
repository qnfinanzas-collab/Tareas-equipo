// smoke_landing_redirect — verifica el redirect anon a las landings.
//
// Contra preview local (http://localhost:4173). Puppeteer headless sin
// cookies previas. Simula la visita del CEO externo llegando a kluxor.com.
//
// Origen del bug (2026-07-13): el redirect vivía como side effect en
// fase de render de React. En iOS Safari incógnito, window.location.replace
// durante render puede lanzar SecurityError que un try/catch tragaba →
// caía al LoginScreen. Fix: mover a useEffect post-render.
//
// Este smoke lo protege para el futuro.

import puppeteer from "puppeteer";

const BASE = process.env.BASE_URL || "http://localhost:4173";

async function testRedirect(path, expectedTarget) {
  const browser = await puppeteer.launch({ headless: "new" });
  const context = browser.defaultBrowserContext();
  const page = await context.newPage();
  try {
    // Vamos a la ruta y esperamos a que la navegación cambie a la landing.
    await page.goto(`${BASE}${path}`, { waitUntil: "domcontentloaded", timeout: 20000 });
    // Espera activa: la redirect vía useEffect ocurre tras el primer render.
    // Damos hasta 3s para que window.location.replace se complete.
    const deadline = Date.now() + 3000;
    let url = page.url();
    while (Date.now() < deadline && !url.includes(expectedTarget)) {
      await new Promise(r => setTimeout(r, 100));
      url = page.url();
    }
    const finalPath = new URL(url).pathname;
    return { ok: finalPath === expectedTarget, path, expectedTarget, finalPath };
  } finally {
    await browser.close();
  }
}

const results = [];

// 1) "/" → landing ES.
results.push(await testRedirect("/", "/kluxor-landing-es.html"));
// 2) "/en" → landing EN.
results.push(await testRedirect("/en", "/kluxor-landing-en.html"));
// 3) "/login" → NO redirect (queda en /login, muestra LoginScreen).
results.push(await testRedirect("/login", "/login"));

console.log(`[landing-redirect · base=${BASE}]\n`);
let allOk = true;
for (const r of results) {
  if (!r.ok) allOk = false;
  console.log(`  ${r.ok ? "✓" : "✗"} ${r.path} → esperado ${r.expectedTarget} · final ${r.finalPath}`);
}
console.log("");
if (!allOk) {
  console.log("=== LANDING REDIRECT SMOKE FAIL ===");
  process.exit(1);
}
console.log("=== LANDING REDIRECT SMOKE OK ===");
