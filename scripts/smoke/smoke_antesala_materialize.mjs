// smoke_antesala_materialize — verifica materializeAntesalaFronts.
//
// Casos:
//   1: happy path — 3 frentes crean 3 proyectos con codes únicos.
//   2: colisión de codes entre frentes (prefijos iguales) — segundo
//      y tercero reciben codes distintos con reglas de autoProjectCode.
//   3: colisión con codes ya existentes en prev.
//   4: fronts inválidos (menos de 3, con vacíos) → no-op.
//   5: sin ownerMemberId → no-op.
//   6: prev vacío (proyecto id inicial correcto).
//   7: idempotencia relativa — invocar con codes ya usados NO revienta
//      (autoProjectCode agota alternativas hasta encontrar uno libre).

import { materializeAntesalaFronts } from "../../src/components/Antesala/materializeAntesalaFronts.js";

function assert(cond, label) {
  if (!cond) { console.error(`✗ ${label}`); process.exitCode = 1; return false; }
  console.log(`  ✓ ${label}`);
  return true;
}

const NOW = new Date("2026-08-20T10:00:00Z");

// ─── Caso 1: happy path ────────────────────────────────────────────
{
  const prev = { projects: [], boards: {} };
  const { nextData, created } = materializeAntesalaFronts(prev, {
    fronts: [
      "Cerrar la venta de la nave",
      "Reestructurar el equipo comercial",
      "Levantar la ronda seed",
    ],
    ownerMemberId: 6,
    now: NOW,
  });

  console.log("Caso 1: happy path (3 frentes distintos)");
  assert(created.length === 3, "3 proyectos creados");
  assert(nextData.projects.length === 3, "nextData.projects.length = 3");
  assert(Object.keys(nextData.boards).length === 3, "nextData.boards con 3 entries");

  const codes = created.map(c => c.code);
  assert(new Set(codes).size === 3, "codes únicos entre sí");

  const p0 = nextData.projects[0];
  assert(p0.name === "Cerrar la venta de la nave", "name del primero");
  assert(p0.code === "CER", "code CER");
  assert(p0.ownerId === 6, "ownerId");
  assert(p0.visibility === "private", "visibility private");
  assert(p0.category === "antesala", "category antesala");
  assert(p0.members.length === 1 && p0.members[0] === 6, "members = [ownerId]");
  assert(p0.createdAt === "2026-08-20T10:00:00.000Z", "createdAt inyectado");

  const boardsP0 = nextData.boards[p0.id];
  assert(boardsP0.length === 4, "4 columnas por defecto");
  assert(boardsP0[0].name === "Por hacer" && boardsP0[3].name === "Hecho", "columnas orden correcto");
  assert(boardsP0.every(c => c.tasks.length === 0), "columnas vacías");

  assert(prev.projects.length === 0, "prev no mutado");
}

// ─── Caso 2: colisión de codes entre frentes (misma raíz) ─────────
{
  const prev = { projects: [], boards: {} };
  const { created } = materializeAntesalaFronts(prev, {
    fronts: [
      "Reestructurar equipo comercial",
      "Reestructurar procesos internos",
      "Reformar oficinas",
    ],
    ownerMemberId: 6,
    now: NOW,
  });

  console.log("Caso 2: colisión de codes entre frentes");
  assert(created[0].code === "REE", "primero: REE");
  assert(created[1].code !== "REE" && created[1].code.startsWith("RE"), "segundo: distinto pero relacionado (RE2/RE3/...)");
  assert(new Set(created.map(c => c.code)).size === 3, "los 3 códigos únicos");
}

// ─── Caso 3: colisión con codes ya existentes en prev ─────────────
{
  const prev = {
    projects: [
      { id: 5, code: "CER", name: "Existente 1" },
      { id: 6, code: "REE", name: "Existente 2" },
    ],
    boards: { 5: [], 6: [] },
  };
  const { created, nextData } = materializeAntesalaFronts(prev, {
    fronts: ["Cerrar deal", "Reestructurar", "Ronda seed"],
    ownerMemberId: 6,
    now: NOW,
  });

  console.log("Caso 3: colisión con codes existentes");
  assert(!created.some(c => c.code === "CER" || c.code === "REE"), "codes nuevos NO chocan con los existentes");
  assert(nextData.projects.length === 5, "prev preservado + 3 nuevos = 5 total");
  assert(nextData.projects[0].code === "CER", "existentes preservados en orden");
}

// ─── Caso 4: fronts inválidos → no-op ─────────────────────────────
{
  const prev = { projects: [{ id: 1 }], boards: {} };
  const r1 = materializeAntesalaFronts(prev, { fronts: ["Solo uno"], ownerMemberId: 6, now: NOW });
  const r2 = materializeAntesalaFronts(prev, { fronts: ["Uno", "", "Tres"], ownerMemberId: 6, now: NOW });
  const r3 = materializeAntesalaFronts(prev, { fronts: null, ownerMemberId: 6, now: NOW });
  const r4 = materializeAntesalaFronts(prev, { ownerMemberId: 6, now: NOW });

  console.log("Caso 4: fronts inválidos → no-op");
  assert(r1.created.length === 0 && r1.nextData === prev, "1 solo frente → no-op");
  assert(r2.created.length === 0 && r2.nextData === prev, "vacío en medio → no-op (< 3 no vacíos)");
  assert(r3.created.length === 0 && r3.nextData === prev, "fronts null → no-op");
  assert(r4.created.length === 0 && r4.nextData === prev, "sin fronts → no-op");
}

// ─── Caso 5: sin ownerMemberId → no-op ────────────────────────────
{
  const prev = { projects: [], boards: {} };
  const r = materializeAntesalaFronts(prev, {
    fronts: ["A", "B", "C"],
    now: NOW,
  });
  console.log("Caso 5: sin ownerMemberId → no-op");
  assert(r.created.length === 0 && r.nextData === prev, "sin owner → no-op");
}

// ─── Caso 6: prev vacío arranca en id 5 ───────────────────────────
{
  const prev = { projects: [], boards: {} };
  const { created } = materializeAntesalaFronts(prev, {
    fronts: ["Uno", "Dos", "Tres"],
    ownerMemberId: 6,
    now: NOW,
  });
  console.log("Caso 6: prev vacío arranca ids en 5");
  assert(created[0].id === 5, "primer id = 5 (default arranque)");
  assert(created[1].id === 6, "id secuencial +1");
  assert(created[2].id === 7, "id secuencial +2");
}

// ─── Caso 7: idempotencia relativa — invocar con codes ya usados ──
{
  // Simulamos que ya se materializó una vez y volvemos a invocar. Sin
  // el buffer pendingFronts limpio (que es lo que hace applyAntesalaAnswers
  // status="completed"), el helper simplemente crea otros 3 sin
  // colisión de codes.
  let d = { projects: [], boards: {} };
  const r1 = materializeAntesalaFronts(d, { fronts: ["A", "B", "C"], ownerMemberId: 6, now: NOW });
  d = r1.nextData;
  const r2 = materializeAntesalaFronts(d, { fronts: ["A", "B", "C"], ownerMemberId: 6, now: NOW });

  console.log("Caso 7: doble invocación no revienta");
  assert(r2.created.length === 3, "segunda invocación también crea 3");
  assert(r2.nextData.projects.length === 6, "total 6 proyectos");
  const allCodes = r2.nextData.projects.map(p => p.code);
  assert(new Set(allCodes).size === 6, "codes únicos incluso entre lotes");
}

if (process.exitCode === 1) {
  console.log("\n=== ANTESALA MATERIALIZE FAIL ===");
  process.exit(1);
}
console.log("\n=== ANTESALA MATERIALIZE OK ===");
console.log("Caso 1: happy path 3 frentes ✓");
console.log("Caso 2: colisión entre frentes resuelta ✓");
console.log("Caso 3: colisión con codes existentes resuelta ✓");
console.log("Caso 4: fronts inválidos → no-op ✓");
console.log("Caso 5: sin ownerMemberId → no-op ✓");
console.log("Caso 6: prev vacío arranca ids correctamente ✓");
console.log("Caso 7: doble invocación no revienta ni duplica codes ✓");
