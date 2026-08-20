// preview-antesala.mjs — captura los estados clave de la Antesala:
// - Pantalla 0 (Welcome) escribiendo — parcial.
// - Pantalla 0 (Welcome) completada — Consejo + botón.
// - Paso 1 escribiendo — sin input/botón visibles todavía.
// - Paso 1 completado — input y botón visibles.
// - Pasos 2, 3, 4a (input), 4b (confirm), 5, 6 — completos.
//
// Replica los estilos exactos de src/components/Antesala/*. Si divergen,
// la captura deja de ser fiel. SIN SOMBRA en las tarjetas (contraste
// de fondo #FAFAF7 vs #FFFFFF).
//
// El typewriter en el preview se simula mostrando texto parcial. En la
// app real es carácter a carácter (ver src/components/Antesala/useTypewriter.js).
//
// Uso: node scripts/smoke/preview-antesala.mjs
// Output: /tmp/kluxor-antesala.png

import puppeteer from "puppeteer";

const BG      = "#FAFAF7";
const CARD    = "#FFFFFF";
const INK     = "#1A1A1A";
const GRAY    = "#6B6B6B";
const GOLD    = "#C9A84C";
const BLACK   = "#0A0A0A";
const PEARL   = "#F5F0E8";
const HAIR    = "#E5E0D5";
const SERIF   = '"Cormorant Garamond","Instrument Serif",Georgia,serif';
const SANS    = '"Inter",system-ui,-apple-system,sans-serif';

// Monograma inline replicando src/components/Shared/AgentAvatar.jsx.
const mono = (letter, size = 44) => `
<div style="width:${size}px;height:${size}px;background:${BLACK};border:1px solid ${GOLD};display:flex;align-items:center;justify-content:center;font-family:${SERIF};font-weight:500;font-size:${Math.max(10, Math.round(size*0.55))}px;line-height:1;color:${GOLD};letter-spacing:0.01em;padding-top:1px;flex-shrink:0">${letter}</div>`;

const inputStyle = `width:100%;height:56px;padding:0 16px;font-family:${SANS};font-size:16px;line-height:1.3;color:${INK};background:${CARD};border:1px solid ${HAIR};outline:none;box-sizing:border-box;border-radius:0;-webkit-appearance:none`;
const textareaStyle = `width:100%;min-height:120px;padding:14px 16px;font-family:${SANS};font-size:16px;line-height:1.5;color:${INK};background:${CARD};border:1px solid ${HAIR};outline:none;box-sizing:border-box;border-radius:0;resize:vertical`;

const stepShell = ({ n, header = true, cardPadding = "40px 32px", inner }) => `
<div style="background:${BG};padding:min(6vh,48px) 24px 40px;font-family:${SANS};color:${INK};display:flex;flex-direction:column;align-items:center">
  ${header ? `<div style="width:100%;max-width:560px;display:flex;align-items:center;justify-content:space-between;margin-bottom:28px">
    <div style="font-family:${SERIF};font-size:14px;font-weight:500;color:${GOLD};letter-spacing:0.24em">KLUXOR</div>
    <div style="font-size:12px;color:${GRAY};letter-spacing:0.02em">${n} de 7</div>
  </div>` : ""}
  <div style="width:100%;max-width:560px;background:${CARD};padding:${cardPadding}">${inner}</div>
</div>`;

const welcomeShell = ({ inner }) => `
<div style="background:${BG};padding:min(6vh,48px) 24px 40px;font-family:${SANS};color:${INK};display:flex;flex-direction:column;align-items:center">
  <div style="width:100%;max-width:620px;margin-bottom:40px">
    <div style="font-family:${SERIF};font-size:14px;font-weight:500;color:${GOLD};letter-spacing:0.24em">KLUXOR</div>
  </div>
  <div style="width:100%;max-width:620px;background:${CARD};padding:48px 40px;display:flex;flex-direction:column;align-items:center">${inner}</div>
</div>`;

const question = (text) =>
  `<h1 style="font-family:${SERIF};font-size:32px;font-weight:500;line-height:1.25;color:${INK};margin:0;letter-spacing:-0.005em;min-height:1.25em">${text}</h1>`;

const help = (text) =>
  `<p style="margin-top:12px;margin-bottom:0;font-size:14px;line-height:1.55;color:${GRAY}">${text}</p>`;

const cta = (label = "Continuar") =>
  `<button style="margin-top:28px;width:100%;height:48px;background:${BLACK};color:${PEARL};border:none;font-family:inherit;font-size:14px;font-weight:600;letter-spacing:0.04em;cursor:pointer">${label}</button>`;

const skip = () =>
  `<div style="margin-top:20px;width:100%;max-width:560px;display:flex;justify-content:center">
    <button style="background:transparent;border:none;padding:8px 12px;font-family:inherit;font-size:12px;color:${GRAY};cursor:pointer;letter-spacing:0.01em">Prefiero hacerlo después</button>
  </div>`;

const inputText = (placeholder, value = "") =>
  `<input type="text" placeholder="${placeholder}" value="${value}" style="${inputStyle}"/>`;
const textarea = (placeholder, value = "", rows = 3) =>
  `<textarea rows="${rows}" placeholder="${placeholder}" style="${textareaStyle}">${value}</textarea>`;
const chip = (label, hint, selected = false) =>
  `<button style="display:flex;justify-content:space-between;align-items:center;padding:14px 16px;background:${selected ? BLACK : "transparent"};color:${selected ? PEARL : INK};border:1px solid ${selected ? BLACK : HAIR};font-family:inherit;font-size:14px;font-weight:500;cursor:pointer;border-radius:0;text-align:left;letter-spacing:0.01em"><span>${label}</span><span style="font-size:12px;color:${selected ? PEARL : GRAY};opacity:${selected ? 0.75 : 1}">${hint}</span></button>`;
const smallChip = (label, selected = false) =>
  `<button style="padding:10px 16px;background:${selected ? BLACK : "transparent"};color:${selected ? PEARL : INK};border:1px solid ${selected ? BLACK : HAIR};font-family:inherit;font-size:13px;font-weight:500;cursor:pointer;border-radius:0;letter-spacing:0.01em">${label}</button>`;

const councilMono = (key, letter, name, role) => `
<div style="display:flex;flex-direction:column;align-items:center;gap:8px;min-width:72px">
  ${mono(letter, 44)}
  <div style="font-family:${SERIF};font-size:14px;font-weight:500;color:${INK};line-height:1.1">${name}</div>
  <div style="font-size:11px;color:${GRAY};letter-spacing:0.02em;line-height:1.1">${role}</div>
</div>`;

const TXT_HEADLINE = "Soy Héctor, su Jefe de Gabinete.";
const TXT_LINE_A   = "Mi trabajo es proteger su tiempo.";
const TXT_LINE_B   = "Cada mañana sabrá qué decide hoy, qué puede esperar y qué se le está enfriando.";
const TXT_LINE_C   = "Tiene a su disposición un Consejo: legal, financiero, inmobiliario, societario y contable.";
const TXT_LINE_D   = "Yo lo convoco cuando la decisión lo pide.";
const TXT_ASK_A    = "Empecemos por conocer su empresa.";
const TXT_ASK_B    = "Siete preguntas. Al terminar, su gabinete queda configurado.";
const TXT_FOOT     = "KLUXOR — NO SE CONTRATA. SE RECIBE.";

const q1Partial = "¿Cómo quiere que le l";
const q1Full = "¿Cómo quiere que le llame?";

// Filete oro sutil — separador.
const goldRule = `<div style="width:100%;max-width:220px;height:1px;background:${GOLD};opacity:0.45;margin:48px auto"></div>`;

// PANTALLA 0a: welcome — headline typewriter, sin cuerpo aún.
const p0a = welcomeShell({
  inner: `${mono("H", 80)}
    <div style="margin-top:40px;font-family:${SERIF};font-size:32px;font-weight:500;line-height:1.25;color:${INK};letter-spacing:-0.005em;min-height:1.25em;text-align:center">Soy Héctor, su Jefe de Ga</div>
    <div style="margin-top:32px;font-size:17px;line-height:1.55;color:${INK};max-width:420px;text-align:center;min-height:1.55em"></div>
    <div style="margin-top:20px;font-size:17px;line-height:1.55;color:${INK};max-width:420px;text-align:center;min-height:1.55em"></div>`
});

// PANTALLA 0b: welcome — headline + A + B completos, línea C (Consejo) mid-escribe.
const p0b = welcomeShell({
  inner: `${mono("H", 80)}
    <div style="margin-top:40px;font-family:${SERIF};font-size:32px;font-weight:500;line-height:1.25;color:${INK};letter-spacing:-0.005em;text-align:center">${TXT_HEADLINE}</div>
    <div style="margin-top:32px;font-size:17px;line-height:1.55;color:${INK};max-width:420px;text-align:center">${TXT_LINE_A}</div>
    <div style="margin-top:20px;font-size:17px;line-height:1.55;color:${INK};max-width:420px;text-align:center">${TXT_LINE_B}</div>
    <div style="margin-top:28px;font-size:17px;line-height:1.55;color:${INK};max-width:460px;text-align:center">Tiene a su disposición un Consejo: legal, financiero, inmobiliario, socie</div>
    <div style="margin-top:12px;font-size:17px;line-height:1.55;color:${INK};max-width:460px;text-align:center;min-height:1.55em"></div>`
});

// PANTALLA 0c: welcome COMPLETA — filete + Consejo + filete + pregunta + botón + pie.
const p0c = welcomeShell({
  inner: `${mono("H", 80)}
    <div style="margin-top:40px;font-family:${SERIF};font-size:32px;font-weight:500;line-height:1.25;color:${INK};letter-spacing:-0.005em;text-align:center">${TXT_HEADLINE}</div>
    <div style="margin-top:32px;font-size:17px;line-height:1.55;color:${INK};max-width:420px;text-align:center">${TXT_LINE_A}</div>
    <div style="margin-top:20px;font-size:17px;line-height:1.55;color:${INK};max-width:420px;text-align:center">${TXT_LINE_B}</div>
    <div style="margin-top:28px;font-size:17px;line-height:1.55;color:${INK};max-width:460px;text-align:center">${TXT_LINE_C}</div>
    <div style="margin-top:12px;font-size:17px;line-height:1.55;color:${INK};max-width:460px;text-align:center">${TXT_LINE_D}</div>
    <div style="width:100%">
      ${goldRule}
      <div style="font-size:11px;color:${GOLD};letter-spacing:0.24em;font-weight:500;margin-bottom:28px;text-align:center">EL CONSEJO</div>
      <div style="display:flex;justify-content:space-between;flex-wrap:wrap;gap:20px;max-width:480px;margin:0 auto">
        ${councilMono("mario",   "M", "Mario",   "Legal")}
        ${councilMono("jorge",   "J", "Jorge",   "Finanzas")}
        ${councilMono("alvaro",  "Á", "Álvaro",  "Inmobiliario")}
        ${councilMono("gonzalo", "G", "Gonzalo", "Gobernanza")}
        ${councilMono("diego",   "D", "Diego",   "Contabilidad")}
      </div>
      ${goldRule}
      <div style="font-family:${SERIF};font-size:22px;font-weight:500;line-height:1.35;color:${INK};max-width:440px;margin:0 auto;letter-spacing:-0.005em;text-align:center">${TXT_ASK_A}</div>
      <div style="font-family:${SERIF};font-size:19px;font-weight:500;line-height:1.4;color:${INK};max-width:440px;margin:14px auto 0;letter-spacing:-0.005em;text-align:center">${TXT_ASK_B}</div>
      <div style="margin-top:40px;display:flex;justify-content:center">
        <button style="min-width:200px;height:48px;padding:0 32px;background:${BLACK};color:${PEARL};border:none;font-family:inherit;font-size:14px;font-weight:600;letter-spacing:0.04em;cursor:pointer">Empezar</button>
      </div>
      <div style="margin-top:56px;text-align:center;font-size:10px;color:${GOLD};letter-spacing:0.32em;font-weight:500">${TXT_FOOT}</div>
    </div>`
});

// PANTALLA FINAL · Summary — la devolución del diagnóstico.
const eyebrow = (text) =>
  `<div style="font-size:11px;color:${GOLD};letter-spacing:0.24em;font-weight:500;margin-bottom:10px;text-transform:uppercase">${text}</div>`;
const bodyLine = (text) =>
  `<div style="font-family:${SERIF};font-size:19px;font-weight:500;line-height:1.45;color:${INK};letter-spacing:-0.005em">${text}</div>`;
const aside = (text) =>
  `<div style="margin-top:8px;font-size:13px;color:${GRAY};line-height:1.5;font-style:italic">${text}</div>`;
const summaryBlock = (label, body) =>
  `<div style="margin-bottom:28px">${eyebrow(label)}${body}</div>`;
const summaryFrontsList = (fronts) => `<ul style="margin:0;padding-left:20px;font-family:${SERIF};font-size:19px;font-weight:500;line-height:1.6;color:${INK};list-style-type:none">${fronts.map(f => `<li style="position:relative"><span style="position:absolute;left:-18px;color:${GOLD}">·</span>${f}</li>`).join("")}</ul>`;

const summaryShell = ({ inner }) => `
<div style="background:${BG};padding:min(6vh,48px) 24px 40px;font-family:${SANS};color:${INK};display:flex;flex-direction:column;align-items:center">
  <div style="width:100%;max-width:560px;margin-bottom:32px">
    <div style="font-family:${SERIF};font-size:14px;font-weight:500;color:${GOLD};letter-spacing:0.24em">KLUXOR</div>
  </div>
  <div style="width:100%;max-width:560px;background:${CARD};padding:56px 40px;display:flex;flex-direction:column;align-items:center">${inner}</div>
</div>`;

const goldRuleTight = `<div style="width:100%;max-width:220px;height:1px;background:${GOLD};opacity:0.45;margin:40px auto"></div>`;

const summary = summaryShell({
  inner: `${mono("H", 64)}
    <div style="margin-top:32px;font-family:${SERIF};font-size:32px;font-weight:500;line-height:1.25;color:${INK};letter-spacing:-0.005em;text-align:center">Esto es lo que he entendido.</div>
    ${goldRuleTight}
    <div style="width:100%;max-width:440px;margin:0 auto">
      ${summaryBlock("Su empresa", `${bodyLine("ALMA DIMO INVESTMENTS S.L.")}<div style="margin-top:6px;font-size:15px;color:${GRAY};line-height:1.5;font-family:${SANS}">Holding de inversiones, real estate y tecnología en la Costa del Sol.</div>`)}
      ${summaryBlock("Su equipo", bodyLine("10 personas"))}
      ${summaryBlock("Sus tres frentes", `${summaryFrontsList([
        "Cerrar la venta de la nave del Polígono",
        "Reestructurar el equipo comercial de Marbella",
        "Levantar la ronda seed de la vertical de crioterapia",
      ])}${aside("Los he convertido en proyectos.")}`)}
      ${summaryBlock("Lo que le roba tiempo", `${bodyLine("El foro semanal del equipo comercial que se convierte en tres horas de opiniones sin decisión.")}${aside("Lo tendré presente.")}`)}
      ${summaryBlock("Su día", bodyLine("Partido · 09:00 · 14:00 y 16:00 · 19:00 · Marbella"))}
      ${summaryBlock("Quién le asesora hoy", bodyLine("Tengo abogado · Tengo asesor fiscal"))}
    </div>
    ${goldRuleTight}
    <div style="font-family:${SERIF};font-size:22px;font-weight:500;line-height:1.35;color:${INK};max-width:440px;margin:0 auto;letter-spacing:-0.005em;text-align:center">Su gabinete está listo. Empecemos.</div>
    <div style="margin-top:36px;display:flex;justify-content:center">
      <button style="min-width:220px;height:48px;padding:0 32px;background:${BLACK};color:${PEARL};border:none;font-family:inherit;font-size:14px;font-weight:600;letter-spacing:0.04em;cursor:pointer">Entrar en Kluxor</button>
    </div>
    <div style="margin-top:20px;display:flex;justify-content:center">
      <button style="background:transparent;border:none;padding:8px 12px;font-family:inherit;font-size:12px;color:${GRAY};cursor:pointer;letter-spacing:0.01em">Corregir algo</button>
    </div>`
});

// PANTALLA 1a: Paso 1 escribiendo — pregunta parcial, SIN input SIN botón.
const p1a = stepShell({
  n: 1,
  inner: question(q1Partial),
}) + `<div style="margin-top:20px;width:100%;max-width:560px;display:flex;justify-content:center;visibility:hidden"><button style="padding:8px 12px;font-size:12px">.</button></div>`;

// PANTALLA 1b: Paso 1 completado — pregunta + help + input + botón + skip.
const p1b = stepShell({
  n: 1,
  inner: `${question(q1Full)}${help("Su nombre o el trato con el que prefiera trabajar. Héctor lo usará en cada respuesta.")}<div style="margin-top:28px">${inputText("Antonio", "Antonio")}</div>${cta()}`,
}) + skip();

const p2 = stepShell({
  n: 2,
  inner: `${question("¿A qué se dedica su empresa?")}${help("El nombre de la empresa y, en una frase, qué hace o vende. Héctor y el Consejo lo usarán como contexto en cada consulta.")}<div style="margin-top:28px">${inputText("Nombre de la empresa", "ALMA DIMO INVESTMENTS S.L.")}<div style="height:12px"></div>${textarea("Qué hace su empresa", "Holding de inversiones, real estate y tecnología en la Costa del Sol.")}</div>${cta()}`
}) + skip();

const p3 = stepShell({
  n: 3,
  inner: `${question("¿Cuántas personas tiene en su equipo?")}${help("Cuente todas las personas que dependen de usted: propias, freelance recurrentes, socios operativos.")}<div style="margin-top:28px"><div style="display:flex;flex-wrap:wrap;gap:8px;margin-bottom:16px">${smallChip("Yo solo")}${smallChip("2 a 5")}${smallChip("6 a 15", true)}${smallChip("16 a 50")}${smallChip("Más de 50")}</div>${inputText("O escriba el número exacto", "10")}</div>${cta()}`
}) + skip();

const p4 = stepShell({
  n: 4,
  inner: `${question("¿Cuáles son sus tres frentes abiertos ahora mismo?")}${help("Los tres temas que le ocupan la cabeza esta semana. Con ellos armaremos sus tres primeros proyectos en Kluxor.")}<div style="margin-top:28px">${inputText("Frente 1", "Cerrar la venta de la nave del Polígono")}<div style="height:12px"></div>${inputText("Frente 2", "Reestructurar el equipo comercial de Marbella")}<div style="height:12px"></div>${inputText("Frente 3", "Levantar la ronda seed de la vertical de crioterapia")}</div>${cta()}`
}) + skip();

const p5 = stepShell({
  n: 5,
  inner: `${question("¿Qué le roba más tiempo cada semana?")}${help("Reuniones que se alargan, aprobaciones pendientes, tareas repetitivas, temas del equipo. Todo lo que le drena las horas de la semana.")}<div style="margin-top:28px">${textarea("El foro semanal con el equipo comercial, los correos de proveedores…", "El foro semanal del equipo comercial que se convierte en tres horas de opiniones sin decisión.", 4)}</div>${cta()}`
}) + skip();

const p6 = stepShell({
  n: 6,
  inner: `${question("¿Cuál es su horario habitual y su ciudad?")}${help("Su horario ancla la planificación diaria. Su ciudad, las rutas y desplazamientos.")}<div style="margin-top:28px"><div style="display:flex;flex-direction:column;gap:8px;margin-bottom:20px">${chip("Mañana", "09:00 · 14:00")}${chip("Partido", "09:00 · 14:00 y 16:00 · 19:00", true)}${chip("Continuo", "09:00 · 17:00")}</div>${inputText("Su ciudad", "Marbella")}</div>${cta()}`
}) + skip();

// Chip con marca de checkbox interna, para el multi-select del Paso 7.
const checkChip = (label, selected = false) => `
<button style="display:flex;align-items:center;gap:12px;padding:14px 16px;background:${selected ? BLACK : "transparent"};color:${selected ? PEARL : INK};border:1px solid ${selected ? BLACK : HAIR};font-family:inherit;font-size:14px;font-weight:500;cursor:pointer;border-radius:0;text-align:left;letter-spacing:0.01em">
  <span style="width:16px;height:16px;border:1px solid ${selected ? PEARL : HAIR};background:${selected ? PEARL : "transparent"};display:inline-flex;align-items:center;justify-content:center;flex-shrink:0">
    ${selected ? `<span style="width:8px;height:8px;background:${BLACK}"></span>` : ""}
  </span>
  <span>${label}</span>
</button>`;

const p7 = stepShell({
  n: 7,
  inner: `${question("¿Quién le asesora hoy en lo legal, lo fiscal y lo contable?")}${help("Marque todas las que apliquen. Héctor lo tendrá presente al decidir cuándo el Consejo prepara y remite a su profesional, y cuándo actúa como su única cobertura.")}<div style="margin-top:28px"><div style="display:flex;flex-direction:column;gap:8px">
    ${checkChip("Tengo abogado", true)}
    ${checkChip("Tengo asesor fiscal", true)}
    ${checkChip("Tengo gestoría")}
    ${checkChip("Lo llevo internamente")}
    ${checkChip("Ahora mismo, nadie")}
  </div></div>${cta()}`
}) + skip();

// Dividido en 3 capturas para evitar cutoff con canvas Puppeteer y
// para que la devolución (pantalla más crítica según Antonio) se lea
// completa sin apretarse contra otras.
const GROUPS = [
  {
    name: "bienvenida",
    file: "/tmp/kluxor-antesala-bienvenida.png",
    frames: [
      { label: "Pantalla 0 · Bienvenida — escribiendo headline", html: p0a },
      { label: "Pantalla 0 · Bienvenida — línea C (Consejo) mid-escritura", html: p0b },
      { label: "Pantalla 0 · Bienvenida — completa", html: p0c },
    ],
  },
  {
    name: "pasos",
    file: "/tmp/kluxor-antesala-pasos.png",
    frames: [
      { label: "Paso 1 · escribiendo — sin input ni botón todavía", html: p1a },
      { label: "Paso 1 · completo", html: p1b },
      { label: "Paso 2 · Empresa", html: p2 },
      { label: "Paso 3 · Equipo", html: p3 },
      { label: "Paso 4 · Frentes (simplificado)", html: p4 },
      { label: "Paso 5 · Roba-tiempo", html: p5 },
      { label: "Paso 6 · Horario y ciudad", html: p6 },
      { label: "Paso 7 · Quién le asesora hoy", html: p7 },
    ],
  },
  {
    name: "devolucion",
    file: "/tmp/kluxor-antesala-devolucion.png",
    frames: [
      { label: "Pantalla FINAL · Devolución del diagnóstico", html: summary },
    ],
  },
];

const wrap = (framesArr) => `<!doctype html>
<html><head><meta charset="utf-8"/>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@500&family=Inter:wght@400;500;600&display=swap" rel="stylesheet">
<style>
  html, body { margin:0; padding:0; background:#E8E4DA; }
  .frame { padding: 24px 20px 0; }
  .label { text-align:center; font-family:${SANS}; font-size:11px; color:#6B6B6B; letter-spacing:0.16em; text-transform:uppercase; margin: 12px 0 14px; }
</style>
</head>
<body>
${framesArr.map(f => `<div class="frame"><div class="label">${f.label}</div>${f.html}</div>`).join("")}
</body></html>`;

const browser = await puppeteer.launch({ headless: "new" });
for (const g of GROUPS) {
  const page = await browser.newPage();
  // Sin deviceScaleFactor:2 — evita superar el límite de canvas de
  // Puppeteer (~16384px) cuando el fullPage acumula muchos frames y la
  // devolución completa con sus secciones y filetes es muy alta.
  await page.setViewport({ width: 760, height: 1000, deviceScaleFactor: 1.5 });
  await page.setContent(wrap(g.frames), { waitUntil: "networkidle0" });
  await new Promise(r => setTimeout(r, 800));
  await page.screenshot({ path: g.file, fullPage: true });
  await page.close();
  console.log(`captura guardada: ${g.file}`);
}
await browser.close();
