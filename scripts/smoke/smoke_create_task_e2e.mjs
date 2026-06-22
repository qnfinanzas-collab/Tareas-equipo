// smoke_create_task_e2e — pipeline de creación de tareas vía
// executeAgentActions del bundle de src/lib/agentActions.js.
//
// CRÍTICO: protege la cadena parseAgentActions → executeAgentActions →
// addTaskToProject. Si esto se rompe, "Crear todo" en la app deja de crear.
//
// Importa executeAgentActions directamente desde src/ (no necesita
// puppeteer ni preview). Simula helpers como App.jsx los provee, y
// captura las llamadas a addTaskToProject.
//
// 3 casos:
//   1) projectCode válido GCP + startDate "hoy" + startTime "12:00" →
//      addTaskToProject llamado con (GCP.id, payload con startDate ISO
//      y dueTime="12:00"), results contiene type:"tasks".
//   2) projectCode XYZ_NOEXISTE → addTaskToProject NO llamado, results
//      contiene type:"error", toast warn emitido.
//   3) task.links con mezcla [http válido + http válido + URL malformada
//      + url javascript:] → payload.links contiene SOLO los 2 http
//      válidos, sanitizados con id wl_*, label fallback a url cuando
//      no se da, icon default "🔗". Defensivo contra emisiones
//      degeneradas del LLM.

import { executeAgentActions } from "../../src/lib/agentActions.js";

const TODAY_ISO = new Date().toISOString().slice(0, 10);
let toasts = [];

function buildHelpers({ projects = [], onAddTask }) {
  return {
    data: { projects, members: [] },
    adminMemberId: 6,
    allMembers: [{ id: 6, name: "Antonio Díaz", accountRole: "admin" }],
    createProject: () => ({ id: 99999, code: "NEW" }),
    addTaskToProject: onAddTask,
    createNegotiation: () => {},
    addFinanceMovement: () => {},
    addBankMovement: () => {},
    updateBankMovement: () => {},
    addAccountingEntry: () => {},
    addInvoice: () => {},
    updateInvoice: () => {},
    defaultCompanyId: null,
    addToast: (msg, type) => toasts.push({ type: type || "info", msg }),
    findProjectByCode: (code) => projects.find(p => p.code === code),
  };
}

try {
  // ── Caso 1 ──
  toasts = [];
  const captured1 = [];
  const helpers1 = buildHelpers({
    projects: [{ id: 99999, name: "Gestión clientes proyecto", code: "GCP" }],
    onAddTask: (projId, payload) => captured1.push({ projId, payload }),
  });
  const out1 = executeAgentActions([{
    type: "create_tasks",
    projectCode: "GCP",
    tasks: [{ title: "Gestión visitas", description: "Coordinar", priority: "media", startDate: "hoy", startTime: "12:00" }],
  }], helpers1);
  const results1 = Array.isArray(out1) ? out1 : (out1?.results || []);
  if (captured1.length !== 1) throw new Error("Caso1: esperaba 1 llamada a addTaskToProject, recibí " + captured1.length);
  const p1 = captured1[0];
  if (p1.projId !== 99999) throw new Error("Caso1: projId inesperado " + p1.projId);
  if (p1.payload.title !== "Gestión visitas") throw new Error("Caso1: title incorrecto");
  if (p1.payload.startDate !== TODAY_ISO) throw new Error(`Caso1: startDate esperado ${TODAY_ISO}, recibí ${p1.payload.startDate}`);
  if (p1.payload.dueTime !== "12:00") throw new Error(`Caso1: dueTime esperado "12:00", recibí "${p1.payload.dueTime}"`);
  if (!results1.some(r => r?.type && r.type !== "error")) throw new Error("Caso1: results no contiene éxito");

  // ── Caso 2 ──
  toasts = [];
  const captured2 = [];
  const helpers2 = buildHelpers({
    projects: [{ id: 99999, name: "Gestión clientes proyecto", code: "GCP" }],
    onAddTask: (projId, payload) => captured2.push({ projId, payload }),
  });
  const out2 = executeAgentActions([{
    type: "create_tasks", projectCode: "XYZ_NOEXISTE",
    tasks: [{ title: "Tarea fantasma", priority: "media" }],
  }], helpers2);
  const results2 = Array.isArray(out2) ? out2 : (out2?.results || []);
  if (captured2.length !== 0) throw new Error("Caso2: addTaskToProject se llamó cuando NO debía");
  if (results2.some(r => r?.type && r.type !== "error")) throw new Error("Caso2: results contiene success indebido");

  // ── Caso 3 — task.links sanitizado ──
  toasts = [];
  const captured3 = [];
  const helpers3 = buildHelpers({
    projects: [{ id: 99999, name: "Gestión clientes proyecto", code: "GCP" }],
    onAddTask: (projId, payload) => captured3.push({ projId, payload }),
  });
  const out3 = executeAgentActions([{
    type: "create_tasks",
    projectCode: "GCP",
    tasks: [{
      title: "Reservar vuelo Madrid-Bilbao",
      description: "Vuelo de ida y vuelta",
      priority: "media",
      startDate: "hoy",
      links: [
        { url: "https://www.booking.com/search?city=BIO", label: "Booking Madrid-Bilbao", icon: "✈️" },
        { url: "https://www.renfe.com/" },                  // label vacío → cae a url; icon vacío → "🔗"
        { url: "kayak.com" },                               // sin http(s):// → DESCARTAR
        { url: "javascript:alert(1)" },                     // protocolo malicioso → DESCARTAR
        { label: "Sin url", icon: "🔗" },                   // sin campo url → DESCARTAR
        "stringNoObjeto",                                   // no-objeto → DESCARTAR
      ],
    }],
  }], helpers3);
  const results3 = Array.isArray(out3) ? out3 : (out3?.results || []);
  if (captured3.length !== 1) throw new Error("Caso3: esperaba 1 llamada a addTaskToProject, recibí " + captured3.length);
  const p3 = captured3[0];
  const links3 = p3.payload.links;
  if (!Array.isArray(links3)) throw new Error("Caso3: payload.links no es array (es " + typeof links3 + ")");
  if (links3.length !== 2) throw new Error("Caso3: esperaba 2 links sanitizados, recibí " + links3.length + " · raw: " + JSON.stringify(links3));
  const [L0, L1] = links3;
  if (L0.url !== "https://www.booking.com/search?city=BIO") throw new Error("Caso3: link[0].url incorrecto: " + L0.url);
  if (L0.label !== "Booking Madrid-Bilbao") throw new Error("Caso3: link[0].label incorrecto: " + L0.label);
  if (L0.icon !== "✈️") throw new Error("Caso3: link[0].icon incorrecto: " + L0.icon);
  if (!L0.id || !L0.id.startsWith("wl_")) throw new Error("Caso3: link[0].id sin prefijo wl_: " + L0.id);
  if (L1.url !== "https://www.renfe.com/") throw new Error("Caso3: link[1].url incorrecto: " + L1.url);
  if (L1.label !== "https://www.renfe.com/") throw new Error("Caso3: link[1].label NO cayó a url cuando label estaba vacío: " + L1.label);
  if (L1.icon !== "🔗") throw new Error("Caso3: link[1].icon NO cayó a 🔗 default: " + L1.icon);
  if (!results3.some(r => r?.type && r.type !== "error")) throw new Error("Caso3: results no contiene éxito");

  // ── Caso 3b — links ausente (legacy) → []  ──
  const captured3b = [];
  const helpers3b = buildHelpers({
    projects: [{ id: 99999, name: "GCP", code: "GCP" }],
    onAddTask: (projId, payload) => captured3b.push({ projId, payload }),
  });
  executeAgentActions([{
    type: "create_tasks", projectCode: "GCP",
    tasks: [{ title: "Tarea sin links", priority: "media" }],
  }], helpers3b);
  if (captured3b.length !== 1) throw new Error("Caso3b: esperaba 1 llamada, recibí " + captured3b.length);
  if (!Array.isArray(captured3b[0].payload.links)) throw new Error("Caso3b: payload.links debería ser [] cuando el LLM no emite links");
  if (captured3b[0].payload.links.length !== 0) throw new Error("Caso3b: payload.links debería ser [] cuando el LLM no emite links, len: " + captured3b[0].payload.links.length);

  console.log("=== CREATE TASK E2E OK ===");
  console.log("Caso 1: addTaskToProject llamado con startDate=" + TODAY_ISO + " + dueTime=12:00 · results con success ✓");
  console.log("Caso 2: projectCode inválido → addTaskToProject NO llamado · results solo errors ✓");
  console.log("Caso 3: payload.links sanitizado · 2 válidos (1 con label custom + 1 fallback url) · 4 degenerados descartados ✓");
  console.log("Caso 3b: legacy sin task.links → payload.links = [] ✓");
} catch (e) {
  console.log("FAIL:", e.message);
  process.exit(1);
}
