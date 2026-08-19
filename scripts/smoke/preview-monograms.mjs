// preview-monograms.mjs — screenshot de los monogramas Kluxor en 3 contextos:
// (a) grid de los 6 agentes a 3 tamaños; (b) simulación cabecera chat +
// burbuja; (c) tarjeta del Consejo. Cero dependencia de sesión — el HTML
// es autocontenido con los mismos estilos que AgentAvatar.jsx.
//
// Uso: node scripts/preview-monograms.mjs
// Output: /tmp/kluxor-monograms.png

import puppeteer from "puppeteer";
import { writeFileSync } from "node:fs";

const AGENTS = [
  { key: "hector",  initial: "H", name: "Héctor",  role: "Jefe de Gabinete" },
  { key: "mario",   initial: "M", name: "Mario",   role: "Abogado mercantil" },
  { key: "jorge",   initial: "J", name: "Jorge",   role: "Analista de inversión" },
  { key: "alvaro",  initial: "Á", name: "Álvaro",  role: "Inmobiliario y fiscalidad" },
  { key: "gonzalo", initial: "G", name: "Gonzalo", role: "Holdings y gobernanza" },
  { key: "diego",   initial: "D", name: "Diego",   role: "Analista financiero" },
];

// Monograma inline con la misma spec que AgentAvatar.jsx:
// #0A0A0A bg, #C9A84C border/ink, serif, ~55% font, +1px paddingTop.
const monogram = (initial, size) => `
  <div style="
    width:${size}px;height:${size}px;
    background:#0A0A0A;border:1px solid #C9A84C;
    display:flex;align-items:center;justify-content:center;
    font-family:'Cormorant Garamond','Instrument Serif',Georgia,serif;
    font-weight:500;font-size:${Math.max(10, Math.round(size*0.55))}px;
    line-height:1;color:#C9A84C;letter-spacing:0.01em;padding-top:1px;
    flex-shrink:0;">${initial}</div>`;

const html = `<!doctype html>
<html><head><meta charset="utf-8"/>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@500;600&family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
  body { margin:0; padding:40px; background:#F5F0E8; font-family:'Inter',system-ui,sans-serif; color:#1a1a1a; }
  h1 { font-family:'Cormorant Garamond',serif; font-weight:500; font-size:28px; margin:0 0 6px; color:#0A0A0A; }
  .sub { font-size:12px; color:#6b6b6b; margin:0 0 32px; letter-spacing:0.04em; text-transform:uppercase; }
  h2 { font-family:'Cormorant Garamond',serif; font-weight:500; font-size:18px; margin:36px 0 14px 0; color:#4E4A42; }
  .row { display:flex; gap:22px; align-items:center; margin-bottom:20px; flex-wrap:wrap; }
  .cell { display:flex; flex-direction:column; align-items:center; gap:6px; min-width:80px; }
  .cell .name { font-size:11px; color:#6b6b6b; font-weight:500; }
  .cell .role { font-size:9.5px; color:#9a9a9a; letter-spacing:0.02em; }
  .chatbox { background:#fff; border:0.5px solid #E5E7EB; padding:14px 16px; max-width:520px; }
  .chat-header { display:flex; align-items:center; gap:10px; padding-bottom:10px; border-bottom:0.5px solid #E5E7EB; }
  .chat-header .name { font-size:13px; font-weight:700; color:#111827; }
  .chat-header .role { font-size:11px; color:#6b7280; }
  .bubble { display:flex; gap:10px; margin-top:12px; align-items:flex-start; }
  .bubble .msg { background:#F0EDE5; border:0.5px solid #E5E7EB; padding:10px 14px; font-size:13.5px; line-height:1.5; color:#1F2937; max-width:400px; }
  .card { background:#fff; border:1px solid #E5E7EB; padding:16px; max-width:280px; }
  .card-head { display:flex; align-items:center; gap:10px; margin-bottom:6px; }
  .card-head h3 { font-size:15px; font-weight:600; color:#111827; margin:0; }
  .card p { font-size:13px; color:#6B7280; margin:0; line-height:1.45; }
  .grid-cards { display:grid; grid-template-columns:repeat(3,1fr); gap:14px; max-width:900px; }
  .proposal { background:#C9A84C10; border:2px solid #C9A84C; padding:14px; max-width:420px; display:flex; gap:10px; align-items:center; }
  .proposal .title { font-size:13px; font-weight:700; color:#111827; }
  .proposal .sum { font-size:11.5px; color:#6B7280; margin-top:2px; }
</style></head>
<body>
  <h1>Monogramas Kluxor</h1>
  <p class="sub">Antes: emojis 🧙⚖️📊🏠🏛️💰 · Ahora: monograma H·M·J·Á·G·D</p>

  <h2>1 · Grid a tres tamaños</h2>
  <div class="row">
    ${AGENTS.map(a => `
      <div class="cell">
        ${monogram(a.initial, 48)}
        <div class="name">${a.name}</div>
        <div class="role">${a.role}</div>
      </div>`).join("")}
  </div>
  <div class="row">
    ${AGENTS.map(a => monogram(a.initial, 32)).join("")}
  </div>
  <div class="row">
    ${AGENTS.map(a => monogram(a.initial, 20)).join("")}
  </div>

  <h2>2 · Cabecera del chat de Héctor · burbuja</h2>
  <div class="chatbox">
    <div class="chat-header">
      ${monogram("H", 40)}
      <div>
        <div class="name">Héctor</div>
        <div class="role">Jefe de Gabinete · Kluxor</div>
      </div>
    </div>
    <div class="bubble">
      ${monogram("H", 32)}
      <div class="msg">Tu día empieza con tres tareas críticas. La primera vence a las 12:00, la segunda es una llamada pendiente desde el lunes. Empieza por el email de Emilio — 8 minutos y despejas la vía para el resto.</div>
    </div>
  </div>

  <h2>3 · Tarjetas del Consejo</h2>
  <div class="grid-cards">
    ${AGENTS.slice(1).map(a => `
      <div class="card">
        <div class="card-head">
          ${monogram(a.initial, 32)}
          <h3>${a.name}</h3>
        </div>
        <p>${a.role}</p>
      </div>`).join("")}
  </div>

  <h2>4 · ActionProposal (propuesta ejecutable)</h2>
  <div class="proposal">
    ${monogram("H", 26)}
    <div>
      <div class="title">Héctor propone:</div>
      <div class="sum">Crear proyecto "Q3 Marbella" y 4 tareas iniciales.</div>
    </div>
  </div>

  <h2>5 · Especialista invocado desde Héctor (burbuja)</h2>
  <div class="chatbox">
    <div class="bubble">
      ${monogram("M", 32)}
      <div class="msg"><strong>Mario Legal · Revisión del contrato adjunto.</strong><br/><br/>El clausulado del art. 12 impone un pacto de no competencia de 24 meses. La duración es válida en jurisdicción española pero la ausencia de compensación económica es motivo de nulidad automática. Recomiendo negociar contrapartida o reducir a 12 meses.</div>
    </div>
  </div>

</body></html>`;

const browser = await puppeteer.launch({ headless: "new" });
const page = await browser.newPage();
await page.setViewport({ width: 1000, height: 1400, deviceScaleFactor: 2 });
await page.setContent(html, { waitUntil: "networkidle0" });
// Espera a que la fuente serif cargue.
await new Promise(r => setTimeout(r, 800));
const path = "/tmp/kluxor-monograms.png";
await page.screenshot({ path, fullPage: true });
await browser.close();
console.log(`✓ captura guardada: ${path}`);
