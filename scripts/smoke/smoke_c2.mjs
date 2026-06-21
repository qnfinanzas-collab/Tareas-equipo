// smoke_c2 — gating del Consejo (Mario / Jorge / Álvaro / Diego / Gonzalo).
//
// CRÍTICO: protege la contención C2 (members NO acceden al Consejo).
//
//   [owner]  "El Consejo" visible en sidebar/home; al abrirlo se ven
//            Mario/Jorge/Álvaro.
//   [member] "El Consejo" NO aparece en ningún sitio del home; sin
//            specialists del Consejo expuestos.

import puppeteer from "puppeteer";

const SUPABASE_REF = "iqilkicirtmmpvykogot";
const OWNER  = { uid: "2d958a69-9484-4306-b015-6b0a6356fbd1", email: "qn.finanzas@gmail.com" };
const MEMBER = { uid: "089678db-5f31-4ef3-b185-cd8ad3afab78", email: "mdiaz.holding@gmail.com" };

async function bootstrap(profile) {
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
    } catch {}
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

  await page.setRequestInterception(true);
  page.on("request", req => {
    if (req.url().includes("/api/agent") && req.method() === "POST") {
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
  return { browser, page };
}

function hasConsejoText(page) {
  // "El Consejo" aparece en home cards Y en sidebar para owners.
  // Para members, gating filtra ambos planos → no aparece en ningún sitio.
  return page.evaluate(() => /El Consejo/.test(document.body.innerText || ""));
}

async function openConsejoProbe(page) {
  const clicked = await page.evaluate(() => {
    const el = [...document.querySelectorAll("button, a, li, div, span")].find(e => (e.innerText||"").trim() === "El Consejo");
    if (!el) return false;
    let t = el; for (let i = 0; i < 6 && t.parentElement; i++) { if (t.tagName==="A"||t.tagName==="BUTTON"||t.onclick) break; t = t.parentElement; }
    t.click(); return true;
  });
  if (!clicked) return { clicked: false, hasMario: false, hasJorge: false, hasAlvaro: false };
  await new Promise(r => setTimeout(r, 1500));
  const probe = await page.evaluate(() => {
    const text = document.body.innerText || "";
    return { hasMario: text.includes("Mario"), hasJorge: text.includes("Jorge"), hasAlvaro: text.includes("Álvaro") };
  });
  return { clicked: true, ...probe };
}

// ── Owner ──
{
  const { browser, page } = await bootstrap(OWNER);
  const sidebarHas = await hasConsejoText(page);
  const open = await openConsejoProbe(page);
  console.log("[owner] sidebarHasConsejo:", sidebarHas, "clicked:", open.clicked, "consejoState:", JSON.stringify({ hasMario: open.hasMario, hasJorge: open.hasJorge, hasAlvaro: open.hasAlvaro }));
  await browser.close();
  if (!sidebarHas) { console.log("[owner] FAIL: 'El Consejo' debería estar visible"); process.exit(1); }
  if (!open.hasMario || !open.hasJorge || !open.hasAlvaro) { console.log("[owner] FAIL: faltan especialistas tras abrir"); process.exit(1); }
}

// ── Member ──
{
  const { browser, page } = await bootstrap(MEMBER);
  const sidebarHas = await hasConsejoText(page);
  const open = await openConsejoProbe(page);
  console.log("[member] sidebarHasConsejo:", sidebarHas, "consejoState:", JSON.stringify({ hasMario: open.hasMario, hasJorge: open.hasJorge, hasAlvaro: open.hasAlvaro }));
  await browser.close();
  if (sidebarHas) { console.log("[member] FAIL: 'El Consejo' NO debería estar visible"); process.exit(1); }
  if (open.hasMario || open.hasJorge || open.hasAlvaro) { console.log("[member] FAIL: specialists expuestos a member"); process.exit(1); }
}

console.log("\n=== ALL C2 CHECKS OK ===");
console.log("Owner: 'El Consejo' visible + Mario/Jorge/Álvaro accesibles.");
console.log("Member: 'El Consejo' ausente + sin specialists del Consejo expuestos.");
