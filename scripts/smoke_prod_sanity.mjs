#!/usr/bin/env node
// smoke_prod_sanity.mjs — comprobación de que producción NO está atascada
// en un deploy viejo. Diseñado tras el incidente del vercel.json inválido
// (junio 2026) que tuvo producción congelada 2 días sin que nadie se
// enterara.
//
// Cómo funciona: cada commit que toca código de UI añade strings
// literales distintivos (labels, placeholders, mensajes). El script lee
// `git log` de los últimos N commits de origin/main, extrae canarios de
// sus diffs, descarga el bundle JS servido por producción y comprueba
// que los canarios estén ahí. Si los últimos commits no tienen
// representación en el bundle → producción atrasada → exit 1.
//
// Uso:
//   npm run smoke:prod
//   # o directo:
//   node scripts/smoke_prod_sanity.mjs
//
// Opciones (variables de entorno):
//   PROD_URL    URL base de producción (default https://tareas-equipo.vercel.app)
//   GIT_REMOTE  rama remota a usar como referencia (default origin/main)
//   BUNDLE_URL  URL completa al bundle servido (para tests negativos:
//               podemos forzar que mire un bundle viejo)
//
// Exit codes:
//   0 — producción al día (al menos un commit reciente está vivo)
//   1 — producción STALE (ningún canario de los últimos commits está en
//       el bundle servido) → alerta, revisar Vercel Deployments
//   2 — indeterminado (no se pudieron extraer canarios de los últimos
//       commits — todos eran cambios sin strings detectables). No grita
//       lobo; el operador debe revisar manualmente.

import { execSync } from "node:child_process";

const PROD_URL   = process.env.PROD_URL   || "https://tareas-equipo.vercel.app";
const GIT_REMOTE = process.env.GIT_REMOTE || "origin/main";
// Si BUNDLE_URL viene seteado, lo usamos tal cual y no extraemos del HTML
// (útil para tests negativos contra bundles conocidos viejos).
const BUNDLE_URL_OVERRIDE = process.env.BUNDLE_URL || null;
const COMMITS_TO_CHECK = 5;

function sh(cmd) {
  return execSync(cmd, { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
}

// Extrae canarios (strings literales distintivos) del diff de un commit.
// Acepta cadenas entre "...", '...' o `...`. Filtra a strings de >=15 y
// <=120 chars, con espacio o tilde/ñ/ü (más probables de ser texto UI
// que sobrevive a la minificación), y SIN ${ (template variables se
// mangean al compilar). Solo mira líneas añadidas en src/.
//
// IMPORTANTE: las líneas de comentario (// ... o * ... dentro de /* */)
// se SALTAN porque Vite las strippea del bundle. Esto evita falsos STALE
// cuando el commit añade docstrings que mencionan strings entre comillas.
function canariesFromCommit(sha) {
  let diff;
  try { diff = sh(`git show --no-color --unified=0 ${sha} -- 'src/**' 'src/*' 2>/dev/null`); }
  catch { return []; }
  const lines = diff.split("\n").filter(l => l.startsWith("+") && !l.startsWith("+++"));
  const out = new Set();
  // Dos fuentes de canarios:
  //   1) Strings entre comillas/backticks: "..." | '...' | `...`
  //   2) Texto JSX entre etiquetas: >Texto contenido<
  //   3) Líneas SUELTAS de prosa multilínea dentro de un elemento JSX.
  // El estado `inJsxComment` rastrea bloques {/* ... */} a través del
  // diff porque sus líneas continuación son prosa pura — fáciles de
  // confundir con contenido JSX, pero Vite las strippea.
  const reQuoted = /(["'`])((?:(?!\1).)*?)\1/g;
  const reJsxText = />\s*([^<>{}][^<>{}]{14,119}?)\s*</g;
  const accept = (s) => {
    if (!s) return false;
    s = s.trim();
    if (s.length < 15 || s.length > 120) return false;
    if (s.includes("${")) return false;
    if (!/[\sáéíóúñÁÉÍÓÚÑüÜ·—]/.test(s)) return false;
    if (/^[a-z0-9_\-./]+$/i.test(s)) return false;
    // CSS / SVG path — el minificador las reformatea.
    if (/\b\d+px\b|rgba?\(|#[0-9a-f]{3,8}\b|\d+%\s|:\s*\d/i.test(s)) return false;
    // Código JS — operadores y sintaxis típica que NO sobrevive a la
    // minificación de Vite (renombra variables, reordena). Si el "string"
    // parece código en vez de texto humano, lo descartamos.
    if (/\|\||&&|=>|==|!=|\?\.|\.\.\.|=>|\bfunction\b|\breturn\b/.test(s)) return false;
    if (/[a-z]\.[a-z]/i.test(s) && /[():;{}=]/.test(s)) return false; // método o acceso a prop dentro de expresión
    return true;
  };
  let inJsxComment = false;
  for (const line of lines) {
    const code = line.slice(1).trimStart();
    // Apertura/cierre de bloque comentario JSX {/* ... */} — rastreamos
    // estado entre líneas. Los contenidos no son canario válido.
    if (code.includes("{/*")) inJsxComment = true;
    const wasInComment = inJsxComment;
    if (code.includes("*/}")) inJsxComment = false;
    if (wasInComment) continue;
    // Salta líneas comentario JS clásico — Vite las strippea.
    if (code.startsWith("//") || code.startsWith("/*") || code.startsWith("*")) continue;
    let m;
    while ((m = reQuoted.exec(line)) !== null) {
      const s = m[2];
      if (accept(s)) out.add(s);
    }
    reJsxText.lastIndex = 0;
    while ((m = reJsxText.exec(line)) !== null) {
      const s = m[1].trim();
      if (accept(s)) out.add(s);
    }
    // Línea SUELTA de prosa dentro de un elemento JSX. Sin syntax JS.
    const bare = line.slice(1).trim();
    if (bare && !bare.match(/[<>{}=()]/) && accept(bare)) out.add(bare);
  }
  // Ranking de canarios: priorizamos texto UI real frente a SVG paths,
  // CSS residual o tokens semi-estructurados. Un canario gana cuanto más
  // "palabras-letra" tiene (chunks de ≥3 letras seguidas sin números),
  // que es exactamente la pinta de un label, placeholder o mensaje.
  // Strings tipo "M14 32 q8 -6 16 0" (SVG path) puntúan 0 y se descartan.
  const score = (s) => (s.match(/\b[A-Za-zÁÉÍÓÚáéíóúñÑüÜ]{3,}\b/g) || []).length;
  return [...out]
    .map(s => ({ s, sc: score(s) }))
    .filter(x => x.sc >= 2)              // al menos 2 palabras-letra
    .sort((a, b) => b.sc - a.sc || b.s.length - a.s.length)
    .map(x => x.s)
    .slice(0, 4);
}

async function fetchText(url, { noCache = true } = {}) {
  const headers = { "User-Agent": "kluxor-smoke-prod-sanity" };
  if (noCache) headers["Cache-Control"] = "no-cache";
  const u = noCache && !url.includes("?") ? `${url}?_t=${Date.now()}` : url;
  const r = await fetch(u, { headers });
  if (!r.ok) throw new Error(`HTTP ${r.status} ${url}`);
  return { text: await r.text(), headers: r.headers };
}

function extractBundleUrl(html) {
  const m = html.match(/\/assets\/index-[A-Za-z0-9_-]+\.js/);
  return m ? m[0] : null;
}

// MAIN ───────────────────────────────────────────────────────────────────
try {
  // Asegura tener origin/main actualizado para no comparar contra un
  // estado obsoleto local. fetch silencioso; si falla (sin red, sin
  // git remote), seguimos con lo local.
  try { sh("git fetch --quiet origin main"); } catch {}

  const head = sh(`git rev-parse ${GIT_REMOTE}`);
  const recentShas = sh(`git log ${GIT_REMOTE} --format=%h -n ${COMMITS_TO_CHECK}`)
    .split("\n").filter(Boolean);
  console.log(`[prod-sanity] HEAD ${GIT_REMOTE}: ${head.slice(0,7)}`);

  // Resolve bundle URL.
  let bundlePath, bundleAge, bundleUrl;
  if (BUNDLE_URL_OVERRIDE) {
    bundleUrl = BUNDLE_URL_OVERRIDE;
    bundlePath = "(override)";
    console.log(`[prod-sanity] BUNDLE_URL override: ${bundleUrl}`);
  } else {
    const htmlRes = await fetchText(PROD_URL);
    const path = extractBundleUrl(htmlRes.text);
    if (!path) {
      console.log("[prod-sanity] FAIL: no se encontró /assets/index-*.js en el HTML de producción");
      process.exit(1);
    }
    bundlePath = path;
    bundleUrl = PROD_URL.replace(/\/$/, "") + path;
    bundleAge = htmlRes.headers.get("age") || "0";
    console.log(`[prod-sanity] bundle prod: ${path.split("/").pop()} (age=${bundleAge}s)`);
  }

  // Descarga del bundle.
  let bundleRes;
  try { bundleRes = await fetchText(bundleUrl, { noCache: false }); }
  catch (e) {
    console.log(`[prod-sanity] FAIL: no se pudo descargar el bundle (${e.message})`);
    process.exit(1);
  }
  const bundle = bundleRes.text;

  // Por commit, extraemos canarios y comprobamos.
  const results = [];
  for (const sha of recentShas) {
    const canaries = canariesFromCommit(sha);
    const subject = sh(`git log -1 --format=%s ${sha}`);
    if (canaries.length === 0) {
      results.push({ sha, status: "no-canary", subject, canary: null });
      continue;
    }
    const hit = canaries.find(c => bundle.includes(c));
    if (hit) results.push({ sha, status: "LIVE", subject, canary: hit });
    else     results.push({ sha, status: "STALE", subject, canary: canaries[0] });
  }

  // Reporte.
  for (const r of results) {
    const tag = r.status === "LIVE" ? "LIVE " : r.status === "STALE" ? "STALE" : "  -  ";
    const canaryStr = r.canary ? `· canary: ${JSON.stringify(r.canary).slice(0,70)}` : "· (sin canarios extraíbles — commit backend/config)";
    console.log(`[prod-sanity] ${r.sha} ${tag} ${r.subject.slice(0,60)}  ${canaryStr}`);
  }

  const liveCount = results.filter(r => r.status === "LIVE").length;
  const staleCount = results.filter(r => r.status === "STALE").length;
  const noCanaryCount = results.filter(r => r.status === "no-canary").length;

  // Decisión: si AL MENOS UNO de los últimos commits con canario está
  // LIVE y NINGUNO con canario está STALE → producción al día.
  // Si CUALQUIERA está STALE → alerta.
  if (staleCount > 0) {
    console.log(`\n=== PROD SANITY FAIL · ${staleCount}/${results.length} commits recientes STALE ===`);
    if (bundleAge && Number(bundleAge) > 3600) {
      const h = (Number(bundleAge)/3600).toFixed(1);
      console.log(`=== Bundle servido tiene ${h}h · revisar Vercel Dashboard > Deployments ===`);
    }
    process.exit(1);
  }
  if (liveCount === 0) {
    console.log(`\n=== PROD SANITY INDETERMINADO · ${noCanaryCount} commits sin canarios verificables ===`);
    console.log("=== Probable: cambios solo en backend/config/docs. Revisar manualmente Vercel Deployments. ===");
    process.exit(2);
  }
  console.log(`\n=== PROD SANITY OK · ${liveCount}/${results.length} commits recientes servidos ===`);
  process.exit(0);
} catch (e) {
  console.log(`[prod-sanity] EXCEPTION: ${e.message}`);
  process.exit(1);
}
