// smoke_places_isolation — blindaje del aislamiento de "Mis Lugares"
// por member dentro del mismo tenant (07/07/2026).
//
// CRÍTICO: fuga = un member ve/edita los places de otro. Todos los
// filtros deben respetar memberId. Este smoke cubre los helpers puros;
// los mutators de App.jsx los usan y añaden defensa adicional (los
// integration tests visuales requieren puppeteer contra puertos y
// autenticaciones — fuera de scope de este smoke unit).

import { filterMyPlaces, findMyPlaceIndex, backfillPlaceOwnership } from "../../src/lib/places.js";

try {
  const places = [
    { id: "pl_a", name: "Can Coll",       type: "comer",   memberId: 6 },   // Antonio
    { id: "pl_b", name: "Bar Elena",      type: "cafe",    memberId: 1 },   // Elena
    { id: "pl_c", name: "Diana Bellesa",  type: "dormir",  memberId: 6 },   // Antonio
    { id: "pl_d", name: "Casa Elena",     type: "visitar", memberId: 1 },   // Elena
    { id: "pl_e", name: "Sin dueño",      type: "otro" },                    // sin memberId — no debe salir
    null,                                                                   // basura defensiva
  ];

  // ── Caso 1 — filterMyPlaces devuelve solo los del member ──
  const my6 = filterMyPlaces(places, 6);
  if (my6.length !== 2) throw new Error("Caso1a: memberId=6 debería tener 2 places, recibí " + my6.length);
  if (!my6.every(p => p.memberId === 6)) throw new Error("Caso1b: leak memberId!=6 en el resultado");
  const my1 = filterMyPlaces(places, 1);
  if (my1.length !== 2) throw new Error("Caso1c: memberId=1 debería tener 2 places, recibí " + my1.length);
  if (!my1.every(p => p.memberId === 1)) throw new Error("Caso1d: leak memberId!=1 en el resultado");
  // memberId nulo → array vacío (defensa)
  if (filterMyPlaces(places, null).length !== 0) throw new Error("Caso1e: memberId null debería devolver []");
  if (filterMyPlaces(places, undefined).length !== 0) throw new Error("Caso1f: memberId undefined debería devolver []");
  // Places sin memberId no salen para NADIE (place pl_e).
  if (my6.some(p => p.id === "pl_e") || my1.some(p => p.id === "pl_e")) throw new Error("Caso1g: place sin memberId NO debe aparecer para ningún member");

  // ── Caso 2 — findMyPlaceIndex respeta ownership ──
  // Antonio tiene "Can Coll comer" → índice válido.
  const idxA = findMyPlaceIndex(places, 6, "Can Coll", "comer");
  if (idxA !== 0) throw new Error("Caso2a: Antonio debería encontrar Can Coll en index 0, recibí " + idxA);
  // Elena busca "Can Coll comer" → -1 (no es suyo aunque exista).
  const idxE = findMyPlaceIndex(places, 1, "Can Coll", "comer");
  if (idxE !== -1) throw new Error("Caso2b: Elena NO debería encontrar Can Coll (es de Antonio), recibí " + idxE);
  // Antonio y Elena podrían tener ambos "Bar Elena" con distinto memberId.
  const placesDup = [
    { id: "pl_x", name: "Bar Común", type: "cafe", memberId: 6 },
    { id: "pl_y", name: "Bar Común", type: "cafe", memberId: 1 },
  ];
  if (findMyPlaceIndex(placesDup, 6, "Bar Común", "cafe") !== 0) throw new Error("Caso2c: Antonio matchea su Bar Común");
  if (findMyPlaceIndex(placesDup, 1, "Bar Común", "cafe") !== 1) throw new Error("Caso2d: Elena matchea SU Bar Común (distinto place)");
  // Case-insensitive + trim.
  if (findMyPlaceIndex(places, 6, "  CAN COLL  ", "comer") !== 0) throw new Error("Caso2e: match case-insensitive + trim");
  // name vacío → -1.
  if (findMyPlaceIndex(places, 6, "", "comer") !== -1) throw new Error("Caso2f: name vacío → -1");

  // ── Caso 3 — backfillPlaceOwnership ──
  // Idempotente: places con memberId ya asignado NO se tocan.
  const before3 = [
    { id: "pl_a", name: "Can Coll", type: "comer", memberId: 6 },
    { id: "pl_b", name: "Sin dueño 1", type: "otro" },
    { id: "pl_c", name: "Otro member", type: "cafe", memberId: 1 },
    { id: "pl_d", name: "Sin dueño 2", type: "otro" },
  ];
  const after3 = backfillPlaceOwnership(before3, 6);
  if (after3 === before3) throw new Error("Caso3a: había places sin memberId, debería devolver nuevo array");
  if (after3[0].memberId !== 6) throw new Error("Caso3b: pl_a debería quedar con memberId=6");
  if (after3[1].memberId !== 6) throw new Error("Caso3c: pl_b sin dueño → memberId=6 (backfill)");
  if (after3[2].memberId !== 1) throw new Error("Caso3d: pl_c debe respetarse (memberId=1 preservado)");
  if (after3[3].memberId !== 6) throw new Error("Caso3e: pl_d sin dueño → memberId=6");
  // Cero mutación del input.
  if (before3[1].memberId !== undefined) throw new Error("Caso3f: input original NO debe ser mutado");

  // Idempotencia: llamar dos veces devuelve MISMA referencia (nada que hacer).
  const after3b = backfillPlaceOwnership(after3, 6);
  if (after3b !== after3) throw new Error("Caso3g: segunda pasada debe ser no-op (misma referencia)");

  // ownerMemberId nulo → no toca nada.
  const passthrough = backfillPlaceOwnership(before3, null);
  if (passthrough !== before3) throw new Error("Caso3h: ownerMemberId null → devuelve input intacto");

  // ── Caso 4 — inputs degenerados no rompen ──
  if (filterMyPlaces(null, 6).length !== 0) throw new Error("Caso4a: null places → []");
  if (findMyPlaceIndex(null, 6, "X", "cafe") !== -1) throw new Error("Caso4b: null places → -1");
  if (backfillPlaceOwnership(null, 6) !== null) throw new Error("Caso4c: null places → null");

  console.log("=== PLACES ISOLATION OK ===");
  console.log("Caso 1: filterMyPlaces — solo places del memberId, sin fugas, sin memberId=null tampoco ✓");
  console.log("Caso 2: findMyPlaceIndex — respeta ownership (Antonio y Elena no colisionan), case-insensitive ✓");
  console.log("Caso 3: backfillPlaceOwnership — asigna a places sin dueño, preserva los ya asignados, idempotente ✓");
  console.log("Caso 4: inputs null/undefined tolerados sin ruido ✓");
} catch (e) {
  console.log("FAIL:", e.message);
  process.exit(1);
}
