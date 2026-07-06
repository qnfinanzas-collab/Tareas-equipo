// smoke_day_plan — protege helpers puros de persistencia de rutas por
// fecha (src/lib/dayPlans.js), Fase 1 del Organizador del Día.
//
// Regla crítica: si extractPlanDate falla, upsert es no-op silencioso
// (mejor no persistir que persistir en fecha errónea). Y la dedup por
// signature previene acumulación de duplicados cuando el CEO regenera
// la ruta del mismo día desde el chat.

import { extractPlanDate, rutaSignature, upsertDayPlan, deleteDayPlan } from "../../src/lib/dayPlans.js";

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

  console.log("=== DAY PLAN OK ===");
  console.log("Caso 1: extractPlanDate — variantes ISO, solo fecha, con espacio, vacío, no-parseable, null ✓");
  console.log("Caso 2: rutaSignature — insensible a caps/espacios; distinta hora → distinta signature ✓");
  console.log("Caso 3: upsertDayPlan primera vez → crea fecha, id dp_, createdAt/sourceUserId respetados ✓");
  console.log("Caso 4: dedup por signature → reemplaza in-place, preserva id + createdAt, actualiza updatedAt ✓");
  console.log("Caso 5: dos signatures distintas mismo día coexisten ✓");
  console.log("Caso 6: ruta sin salida → no-op silencioso (mapa intacto, mismo objeto) ✓");
  console.log("Caso 7: deleteDayPlan borra, idempotente si no existe, elimina fecha vacía ✓");
  console.log("Caso 8: null tolerado como estado inicial ✓");
} catch (e) {
  console.log("FAIL:", e.message);
  process.exit(1);
}
