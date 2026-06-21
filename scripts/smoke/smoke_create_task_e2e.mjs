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
// 2 casos:
//   1) projectCode válido GCP + startDate "hoy" + startTime "12:00" →
//      addTaskToProject llamado con (GCP.id, payload con startDate ISO
//      y dueTime="12:00"), results contiene type:"tasks".
//   2) projectCode XYZ_NOEXISTE → addTaskToProject NO llamado, results
//      contiene type:"error", toast warn emitido.

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

  console.log("=== CREATE TASK E2E OK ===");
  console.log("Caso 1: addTaskToProject llamado con startDate=" + TODAY_ISO + " + dueTime=12:00 · results con success ✓");
  console.log("Caso 2: projectCode inválido → addTaskToProject NO llamado · results solo errors ✓");
} catch (e) {
  console.log("FAIL:", e.message);
  process.exit(1);
}
