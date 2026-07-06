// smoke_day_plan — protege helpers puros de persistencia de rutas por
// fecha (src/lib/dayPlans.js), Fase 1 del Organizador del Día.
//
// Regla crítica: si extractPlanDate falla, upsert es no-op silencioso
// (mejor no persistir que persistir en fecha errónea). Y la dedup por
// signature previene acumulación de duplicados cuando el CEO regenera
// la ruta del mismo día desde el chat.

import { extractPlanDate, rutaSignature, upsertDayPlan, deleteDayPlan, getTasksForDate, countActiveNegotiations } from "../../src/lib/dayPlans.js";

const NOW = "2026-07-05T18:00:00.000Z";

try {
  // ── Caso 1 — extractPlanDate ──
  if (extractPlanDate({ salida: "2026-07-06T08:00" }) !== "2026-07-06") throw new Error("Caso1a: salida ISO con hora");
  if (extractPlanDate({ salida: "2026-07-06" }) !== "2026-07-06") throw new Error("Caso1b: salida solo fecha");
  if (extractPlanDate({ salida: "2026-07-06 08:00" }) !== "2026-07-06") throw new Error("Caso1c: salida con espacio en vez de T");
  if (extractPlanDate({ salida: "" }) !== null) throw new Error("Caso1d: salida vacía debería null");
  if (extractPlanDate({ salida: "mañana" }) !== null) throw new Error("Caso1e: salida no parseable debería null");
  if (extractPlanDate({}) !== null) throw new Error("Caso1f: sin salida debería null");
  if (extractPlanDate(null) !== null) throw new Error("Caso1g: ruta null debería null");

  // ── Caso 2 — rutaSignature ──
  const rA = { origen: "Estepona", destino: "Málaga", salida: "2026-07-06T08:00" };
  const rB = { origen: "estepona", destino: " MÁLAGA ", salida: "2026-07-06T08:00" };
  if (rutaSignature(rA) !== rutaSignature(rB)) throw new Error("Caso2a: signature debería ser insensible a mayúsculas/espacios");
  const rC = { origen: "Estepona", destino: "Málaga", salida: "2026-07-06T09:00" };  // hora distinta
  if (rutaSignature(rA) === rutaSignature(rC)) throw new Error("Caso2b: signature distinta si cambia la hora");

  // ── Caso 3 — upsertDayPlan primera vez ──
  const r1 = { origen: "Estepona", destino: "Soulbaric", salida: "2026-07-06T08:00", paradas: [{tipo:"inicio",lugar:"Estepona"},{tipo:"destino",lugar:"Soulbaric"}] };
  const map3 = upsertDayPlan({}, r1, { sourceUserId: 6, now: NOW });
  if (!map3["2026-07-06"]) throw new Error("Caso3a: debería crear la clave fecha");
  if (map3["2026-07-06"].length !== 1) throw new Error("Caso3b: debería haber 1 entrada");
  const e3 = map3["2026-07-06"][0];
  if (!e3.id || !e3.id.startsWith("dp_")) throw new Error("Caso3c: id debe empezar por dp_");
  if (e3.createdAt !== NOW) throw new Error("Caso3d: createdAt = now");
  if (e3.sourceUserId !== 6) throw new Error("Caso3e: sourceUserId debe respetarse");
  if (e3.ruta !== r1) throw new Error("Caso3f: ruta debe guardarse por referencia");

  // ── Caso 4 — upsert dedup: misma signature reemplaza ──
  const r1b = { ...r1, paradas: [...r1.paradas, {tipo:"cafe",lugar:"Café X",direccion:"C. Nueva 1"}] };  // añade parada
  const NOW2 = "2026-07-05T18:30:00.000Z";
  const map4 = upsertDayPlan(map3, r1b, { sourceUserId: 6, now: NOW2 });
  if (map4["2026-07-06"].length !== 1) throw new Error("Caso4a: dedup, sigue habiendo 1 entrada");
  const e4 = map4["2026-07-06"][0];
  if (e4.id !== e3.id) throw new Error("Caso4b: id se preserva al hacer reemplazo");
  if (e4.createdAt !== NOW) throw new Error("Caso4c: createdAt del original se preserva");
  if (e4.updatedAt !== NOW2) throw new Error("Caso4d: updatedAt refleja el nuevo now");
  if (e4.ruta !== r1b) throw new Error("Caso4e: la ruta interna es la nueva versión");

  // ── Caso 5 — upsert dos rutas distintas mismo día no colisionan ──
  const r2 = { origen: "Málaga", destino: "Granada", salida: "2026-07-06T14:00", paradas: [{tipo:"inicio",lugar:"Málaga"},{tipo:"destino",lugar:"Granada"}] };
  const map5 = upsertDayPlan(map4, r2, { sourceUserId: 6, now: NOW });
  if (map5["2026-07-06"].length !== 2) throw new Error("Caso5: dos signatures distintas deben coexistir");

  // ── Caso 6 — sin salida → no-op silencioso ──
  const rSinSalida = { origen: "A", destino: "B", paradas: [{tipo:"inicio",lugar:"A"},{tipo:"destino",lugar:"B"}] };
  const map6 = upsertDayPlan(map5, rSinSalida, { sourceUserId: 6, now: NOW });
  if (map6 !== map5) throw new Error("Caso6: sin salida debe devolver el mapa intacto (mismo objeto)");

  // ── Caso 7 — deleteDayPlan ──
  const targetId = map5["2026-07-06"][0].id;
  const map7 = deleteDayPlan(map5, "2026-07-06", targetId);
  if (map7["2026-07-06"].length !== 1) throw new Error("Caso7a: debe haber 1 entrada tras borrar");
  if (map7["2026-07-06"][0].id === targetId) throw new Error("Caso7b: el borrado no debe seguir presente");

  // Idempotente: borrar id que no existe → mapa intacto
  const map7b = deleteDayPlan(map7, "2026-07-06", "dp_noexiste");
  if (map7b !== map7) throw new Error("Caso7c: delete idempotente debe devolver el mismo mapa");

  // Borrar única entrada de una fecha → clave fecha desaparece
  const map7c = deleteDayPlan(map7, "2026-07-06", map7["2026-07-06"][0].id);
  if ("2026-07-06" in map7c) throw new Error("Caso7d: fecha con array vacío se elimina del mapa");

  // ── Caso 8 — dayPlans null / undefined tolerados ──
  const map8 = upsertDayPlan(null, r1, { sourceUserId: 6, now: NOW });
  if (!map8["2026-07-06"]) throw new Error("Caso8a: upsertDayPlan tolera null como estado inicial");
  const map8b = deleteDayPlan(null, "2026-07-06", "cualquier");
  if (typeof map8b !== "object") throw new Error("Caso8b: deleteDayPlan tolera null");

  // ── Caso 9 — getTasksForDate (Fase 2) ──
  const projects9 = [
    { id: 10, name: "Soulbaric", emoji: "🎯" },
    { id: 20, name: "ALMA DIMO", emoji: "🏛" },
  ];
  const boards9 = {
    10: [
      { id: "c1", name: "Por hacer", tasks: [
        { id: "t1", ref: "SB-1", title: "Preparar propuesta", dueDate: "2026-07-06", dueTime: "09:30", priority: "alta", assignees: [6] },
        { id: "t2", ref: "SB-2", title: "Revisar borrador",   dueDate: "2026-07-07", dueTime: "10:00", priority: "media", assignees: [6] },
        { id: "t3", ref: "SB-3", title: "Sesión Luis Granda", dueDate: "2026-07-06", dueTime: "18:00", priority: "alta", assignees: [7] },  // otro miembro
        { id: "t4", ref: "SB-4", title: "Archivada del día",  dueDate: "2026-07-06", dueTime: "12:00", priority: "baja", assignees: [6], archived: true },
      ]},
      { id: "c2", name: "Hecho", tasks: [
        { id: "t5", ref: "SB-5", title: "Ya completada",      dueDate: "2026-07-06", dueTime: "08:00", priority: "media", assignees: [6] },
      ]},
    ],
    20: [
      { id: "c3", name: "Backlog", tasks: [
        { id: "t6", ref: "AD-1", title: "Sin hora del día",  dueDate: "2026-07-06", dueTime: "",      priority: "media", assignees: [6] },
        { id: "t7", ref: "AD-2", title: "Con hora temprano",  dueDate: "2026-07-06", dueTime: "07:00", priority: "media", assignees: [6] },
      ]},
    ],
  };
  // Filtro por memberId=6 → excluye t3 (asignada a 7), t4 (archivada), t5 (Hecho), t2 (otro día).
  const tasks9 = getTasksForDate(boards9, projects9, "2026-07-06", { memberId: 6 });
  if (tasks9.length !== 3) throw new Error("Caso9a: esperaba 3 tareas para memberId=6, recibí " + tasks9.length);
  // Orden: 07:00 (t7), 09:30 (t1), sin hora (t6).
  if (tasks9[0].ref !== "AD-2") throw new Error("Caso9b: primera debería ser AD-2 (07:00), recibí " + tasks9[0].ref);
  if (tasks9[1].ref !== "SB-1") throw new Error("Caso9c: segunda debería ser SB-1 (09:30), recibí " + tasks9[1].ref);
  if (tasks9[2].ref !== "AD-1") throw new Error("Caso9d: tercera (sin hora) debería ser AD-1, recibí " + tasks9[2].ref);
  // Enriquecimiento correcto: projName y projEmoji.
  if (tasks9[0].projName !== "ALMA DIMO" || tasks9[0].projEmoji !== "🏛") throw new Error("Caso9e: enriquecimiento project mal · " + JSON.stringify({name:tasks9[0].projName, emoji:tasks9[0].projEmoji}));

  // Sin filtro por memberId → incluye t3 (asignada a 7). Sigue excluyendo archivadas y Hecho.
  const tasks9b = getTasksForDate(boards9, projects9, "2026-07-06");
  if (tasks9b.length !== 4) throw new Error("Caso9f: sin memberId esperaba 4 (incluir t3), recibí " + tasks9b.length);
  if (!tasks9b.some(t => t.ref === "SB-3")) throw new Error("Caso9g: SB-3 debería estar sin filtro de memberId");
  if (tasks9b.some(t => t.ref === "SB-4")) throw new Error("Caso9h: SB-4 archivada NUNCA debe salir");
  if (tasks9b.some(t => t.ref === "SB-5")) throw new Error("Caso9i: SB-5 en 'Hecho' NUNCA debe salir");

  // Fecha sin tareas → array vacío.
  const tasks9c = getTasksForDate(boards9, projects9, "2026-08-01");
  if (tasks9c.length !== 0) throw new Error("Caso9j: fecha sin tareas → []");

  // boards vacío/inválido → array vacío defensivo.
  if (getTasksForDate(null, projects9, "2026-07-06").length !== 0) throw new Error("Caso9k: boards null → []");
  if (getTasksForDate({}, projects9, "").length !== 0) throw new Error("Caso9l: date vacía → []");

  // ── Caso 10 — countActiveNegotiations ──
  const negs = [
    { id: "n1", status: "en_curso", archived: false },
    { id: "n2", status: "pausado",  archived: false },
    { id: "n3", status: "en_curso", archived: true  },   // archivada → no cuenta
    { id: "n4", status: "cerrado_ganado", archived: false },  // cerrada → no cuenta
    { id: "n5", status: "cerrado_perdido", archived: false },
    { id: "n6", status: "acuerdo_parcial", archived: false },
    null,
  ];
  if (countActiveNegotiations(negs) !== 2) throw new Error("Caso10a: solo n1 (en_curso) + n2 (pausado) deben contar = 2");
  if (countActiveNegotiations([]) !== 0) throw new Error("Caso10b: array vacío → 0");
  if (countActiveNegotiations(null) !== 0) throw new Error("Caso10c: null → 0");

  console.log("=== DAY PLAN OK ===");
  console.log("Caso 1: extractPlanDate — variantes ISO, solo fecha, con espacio, vacío, no-parseable, null ✓");
  console.log("Caso 2: rutaSignature — insensible a caps/espacios; distinta hora → distinta signature ✓");
  console.log("Caso 3: upsertDayPlan primera vez → crea fecha, id dp_, createdAt/sourceUserId respetados ✓");
  console.log("Caso 4: dedup por signature → reemplaza in-place, preserva id + createdAt, actualiza updatedAt ✓");
  console.log("Caso 5: dos signatures distintas mismo día coexisten ✓");
  console.log("Caso 6: ruta sin salida → no-op silencioso (mapa intacto, mismo objeto) ✓");
  console.log("Caso 7: deleteDayPlan borra, idempotente si no existe, elimina fecha vacía ✓");
  console.log("Caso 8: null tolerado como estado inicial ✓");
  console.log("Caso 9: getTasksForDate — filtro dueDate + memberId, excluye archived/Hecho, orden por dueTime ✓");
  console.log("Caso 10: countActiveNegotiations — solo en_curso|pausado, no archivadas ni cerradas ✓");
} catch (e) {
  console.log("FAIL:", e.message);
  process.exit(1);
}
