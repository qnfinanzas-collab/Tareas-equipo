// smoke_c1 — gating del bloque CEO en el system prompt enviado a /api/agent.
//
// CRÍTICO: protege la contención C1 (no fuga de identidad/contexto privado
// del CEO al prompt de Héctor cuando un member usa la app).
//
// MODO DUAL (Fase 2C Pieza 1):
// · LEGACY: data.ceoProfile vacío → fallback al literal de Antonio
//   (ALMA DIMO, CIF B19929256, PERFIL PROFESIONAL).
// · DINÁMICO: data.ceoProfile relleno → bloque dinámico (Sector:, LO QUE
//   LE OCUPA:). NO aparece B19929256 ni PERFIL PROFESIONAL.
//
// Autodetect del path activo. Pre-Fase 2C es legacy; tras Fase 2C es
// dinámico. Markers estables válidos en ambos paths.

import puppeteer from "puppeteer";

const SUPABASE_REF = "iqilkicirtmmpvykogot";
const OWNER  = { uid: "2d958a69-9484-4306-b015-6b0a6356fbd1", email: "qn.finanzas@gmail.com" };
const MEMBER = { uid: "089678db-5f31-4ef3-b185-cd8ad3afab78", email: "mdiaz.holding@gmail.com" };

async function runScenario(profile, role) {
  const browser = await puppeteer.launch({ headless: true });
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });

  await page.evaluateOnNewDocument((p, ref) => {
    const session = {
      access_token: "fake", token_type: "bearer", expires_in: 86400,
      expires_at: Math.floor(Date.now()/1000) + 86400, refresh_token: "fake-refresh",
      user: { id: p.uid, aud: "authenticated", role: "authenticated", email: p.email,
              email_confirmed_at: new Date().toISOString(), phone: "",
              created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
              app_metadata: { provider: "email" }, user_metadata: {} },
    };
    try {
      localStorage.setItem(`sb-${ref}-auth-token`, JSON.stringify(session));
      localStorage.setItem("kluxor.briefingMatinal.lastDate", new Date().toISOString().slice(0,10));
      // Previene CierreDia automático (se dispara post-18:00 hora local
      // y hace POST a /api/agent ANTES de que el smoke envíe el chat
      // de Héctor — el smoke capturaría ese system prompt en lugar del
      // de Héctor, rompiendo todos los markers de ceoBlock).
      localStorage.setItem("kluxor.cierreDia.lastDate", new Date().toISOString().slice(0,10));
    } catch {}
    // Strip Authorization en GETs a taskflow_state — el JWT fake da 401;
    // sin auth header pasa como anon vía allow_read permisiva.
    const origFetch = window.fetch;
    window.fetch = async function(input, init) {
      const url = typeof input === "string" ? input : (input?.url || "");
      const method = (init?.method || (typeof input !== "string" && input?.method) || "GET").toUpperCase();
      if (!url.includes("/rest/v1/taskflow_state")) return origFetch.apply(this, arguments);
      if (method !== "GET") return new Response("null", { status: 204, headers: { "Content-Type": "application/json" } });
      const stripped = { ...(init || {}) };
      const inputHeaders = (typeof input !== "string" && input?.headers) ? input.headers : null;
      const merged = new Headers(inputHeaders || stripped.headers || {});
      merged.delete("Authorization"); merged.delete("authorization");
      stripped.headers = merged;
      return origFetch.call(this, url, stripped);
    };
  }, profile, SUPABASE_REF);

  let capturedSystem = null;
  await page.setRequestInterception(true);
  page.on("request", req => {
    if (req.url().includes("/api/agent") && req.method() === "POST") {
      try {
        const body = JSON.parse(req.postData() || "{}");
        if (capturedSystem === null) capturedSystem = body.system || "";
      } catch {}
      req.respond({ status: 200, contentType: "application/json", body: JSON.stringify({ text: "ok", citations: [], stop_reason: "end_turn" }) });
      return;
    }
    req.continue();
  });

  await page.goto("http://localhost:4173/home", { waitUntil: "networkidle0", timeout: 25000 });
  await new Promise(r => setTimeout(r, 1500));
  for (let i = 0; i < 4; i++) {
    const closed = await page.evaluate(() => {
      const x = [...document.querySelectorAll("button")].find(b => /^[×x]$/i.test((b.innerText||"").trim()));
      if (x) { x.click(); return true; } return false;
    });
    if (!closed) break;
    await new Promise(r => setTimeout(r, 400));
  }

  // Navega a Héctor.
  await page.evaluate(() => {
    const el = [...document.querySelectorAll("a, button, div, span")].find(e => (e.innerText||"").trim() === "Héctor");
    if (!el) return false;
    let t = el; for (let i = 0; i < 6 && t.parentElement; i++) { if (t.tagName==="A"||t.tagName==="BUTTON"||t.onclick) break; t = t.parentElement; }
    t.click();
  });
  await new Promise(r => setTimeout(r, 1500));

  // Escribe + envía.
  await page.evaluate(() => {
    const ta = document.querySelector('textarea[placeholder*="Héctor"]') || document.querySelector('textarea');
    if (!ta) return;
    Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set.call(ta, "Hola Héctor, prueba C1.");
    ta.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await new Promise(r => setTimeout(r, 300));
  await page.evaluate(() => {
    const btn = [...document.querySelectorAll("button")].find(b => /enviar/i.test(b.getAttribute("title")||""));
    if (btn) btn.click();
  });
  for (let i = 0; i < 30 && capturedSystem === null; i++) await new Promise(r => setTimeout(r, 200));
  await browser.close();
  if (capturedSystem === null) { console.log(`[${role}] FAIL: /api/agent no se invocó`); process.exit(1); }
  return capturedSystem;
}

// ── Owner ──
const sysOwner = await runScenario(OWNER, "owner");
const stable = {
  hasOwnerBlock:    /USUARIO ACTIVO — CEO Y PROPIETARIO/.test(sysOwner),
  hasAlmaDimo:      /ALMA DIMO INVESTMENTS/.test(sysOwner),
  hasNameAntonio:   /Antonio Díaz/.test(sysOwner),
  hasComm:          /CÓMO COMUNICARTE/.test(sysOwner),
  NO_memberBlock:  !/miembro del equipo \(no es el CEO/.test(sysOwner),
  NO_instrPriv:    !/INSTRUCCIONES DE PRIVACIDAD/.test(sysOwner),
};
const dynamic = {
  hasSector:  /Sector:\s+/.test(sysOwner),
  hasOcupa:   /LO QUE LE OCUPA:/.test(sysOwner),
};
const legacy = {
  hasCIF:        /B19929256/.test(sysOwner),
  hasPerfilProf: /PERFIL PROFESIONAL/.test(sysOwner),
};
const detectedPath = (dynamic.hasSector && dynamic.hasOcupa) ? "dinámico"
                   : (legacy.hasCIF && legacy.hasPerfilProf) ? "legacy"
                   : "indeterminado";
console.log("[owner] stable:",  JSON.stringify(stable));
console.log("[owner] dynamic:", JSON.stringify(dynamic));
console.log("[owner] legacy:",  JSON.stringify(legacy));
console.log("[owner] path detectado:", detectedPath);

const stableOk = stable.hasOwnerBlock && stable.hasAlmaDimo && stable.hasNameAntonio
              && stable.hasComm && stable.NO_memberBlock && stable.NO_instrPriv;
if (!stableOk) { console.log("[owner] FAIL: markers estables incompletos"); process.exit(1); }
if (detectedPath === "indeterminado") { console.log("[owner] FAIL: path indeterminado"); process.exit(1); }

// ── Member ──
const sysMember = await runScenario(MEMBER, "member");
const member = {
  NO_ownerBlock:  !/USUARIO ACTIVO — CEO Y PROPIETARIO/.test(sysMember),
  NO_cif:         !/B19929256/.test(sysMember),
  NO_perfilProf:  !/PERFIL PROFESIONAL/.test(sysMember),
  NO_perfilCeo:   !/PERFIL CEO/.test(sysMember),
  NO_sector:      !/Sector:\s+/.test(sysMember),
  NO_ocupa:       !/LO QUE LE OCUPA:/.test(sysMember),
  has_memberBlock: /miembro del equipo \(no es el CEO/.test(sysMember),
  has_instrPriv:   /INSTRUCCIONES DE PRIVACIDAD/.test(sysMember),
};
console.log("[member]", JSON.stringify(member));
const memberOk = member.NO_ownerBlock && member.NO_cif && member.NO_perfilProf && member.NO_perfilCeo
              && member.NO_sector && member.NO_ocupa && member.has_memberBlock && member.has_instrPriv;
if (!memberOk) { console.log("[member] FAIL: filtración o privacy markers ausentes"); process.exit(1); }

console.log("\n=== ALL CHECKS OK ===");
console.log(`Owner: path ${detectedPath} · markers estables OK.`);
console.log("Member: sin filtración de identidad CEO; memberBlock + INSTRUCCIONES DE PRIVACIDAD presentes.");
