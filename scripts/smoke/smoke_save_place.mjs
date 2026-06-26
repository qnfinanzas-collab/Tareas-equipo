// smoke_save_place — pipeline de Mis Sitios vía executeAgentActions.
//
// CRÍTICO: protege el flujo "Héctor guarda un sitio del CEO". Si esto
// se rompe, los sitios no llegan a data.places y la integración con
// rutas pierde la prioridad sobre lugares ya validados por experiencia
// personal del CEO.
//
// NOTA DE DISEÑO: el schema del action usa "placeType" (no "type") para
// el tipo del lugar — el campo "type" del objeto action está reservado
// para el routing del executor (save_place vs create_tasks vs ...) y
// si lo reutilizáramos para el tipo del sitio el JSON solo podría llevar
// una sola "type". Por eso schema = placeType, storage interno = type.
//
// 5 casos:
//   1) válido completo (name + placeType + address + rating + notes + tags)
//      → addPlace llamado con payload sanitizado, place.type="comer".
//   2) válido mínimo (solo name) → addPlace con defaults (type=otro,
//      rating=null, address/notes vacíos, tags []).
//   3) sanitización defensiva: placeType inválido + rating fuera de
//      rango + tags con basura → type cae a "otro", rating clamp 0..5,
//      tags filtra solo strings no vacíos.
//   4) name vacío → addPlace NO llamado, results contiene error.
//   5) varios save_place en el mismo bloque [ACTIONS] → addPlace
//      llamado N veces, results con N entradas type:"place".

import { executeAgentActions } from "../../src/lib/agentActions.js";

let calls = [];

function buildHelpers() {
  calls = [];
  return {
    data: { members: [] },
    adminMemberId: 6,
    allMembers: [{ id: 6, name: "Antonio Díaz", accountRole: "admin" }],
    createProject: () => null,
    addTaskToProject: () => null,
    createNegotiation: () => null,
    addFinanceMovement: () => null,
    addBankMovement: () => null,
    updateBankMovement: () => null,
    addAccountingEntry: () => null,
    addInvoice: () => null,
    updateInvoice: () => null,
    addPlace: (payload) => calls.push(payload),
    defaultCompanyId: null,
    addToast: () => null,
    findProjectByCode: () => null,
  };
}

try {
  // ── Caso 1: válido completo ──
  {
    const helpers = buildHelpers();
    const out = executeAgentActions([{
      type: "save_place",
      name: "Venta El Romeral",
      placeType: "comer",
      address: "Salida 320, Córdoba",
      rating: 5,
      notes: "Comimos genial con Marc en mayo.",
      tags: ["coche", "andaluz"],
    }], helpers);
    const results = Array.isArray(out) ? out : (out?.results || []);
    if (calls.length !== 1) throw new Error("Caso1: esperaba 1 llamada a addPlace, recibí " + calls.length);
    const p = calls[0];
    if (p.name !== "Venta El Romeral") throw new Error("Caso1: name incorrecto · " + p.name);
    if (p.type !== "comer") throw new Error("Caso1: type incorrecto · " + p.type);
    if (p.address !== "Salida 320, Córdoba") throw new Error("Caso1: address incorrecto");
    if (p.rating !== 5) throw new Error("Caso1: rating incorrecto · " + p.rating);
    if (p.notes !== "Comimos genial con Marc en mayo.") throw new Error("Caso1: notes incorrecto");
    if (!Array.isArray(p.tags) || p.tags.length !== 2) throw new Error("Caso1: tags incorrecto · " + JSON.stringify(p.tags));
    if (!results.some(r => r?.type === "place" && r.placeType === "comer")) throw new Error("Caso1: results sin type:place placeType:comer");
  }

  // ── Caso 2: mínimo (solo name) ──
  {
    const helpers = buildHelpers();
    executeAgentActions([{ type: "save_place", name: "Bar Pepe" }], helpers);
    if (calls.length !== 1) throw new Error("Caso2: esperaba 1 llamada, recibí " + calls.length);
    const p = calls[0];
    if (p.name !== "Bar Pepe") throw new Error("Caso2: name incorrecto");
    if (p.type !== "otro") throw new Error("Caso2: type debería ser 'otro' por default · recibí " + p.type);
    if (p.rating !== null) throw new Error("Caso2: rating debería ser null · recibí " + p.rating);
    if (p.address !== "") throw new Error("Caso2: address debería ser \"\"");
    if (p.notes !== "") throw new Error("Caso2: notes debería ser \"\"");
    if (!Array.isArray(p.tags) || p.tags.length !== 0) throw new Error("Caso2: tags debería ser []");
  }

  // ── Caso 3: sanitización defensiva ──
  {
    const helpers = buildHelpers();
    executeAgentActions([{
      type: "save_place",
      name: "Hotel basurilla",
      placeType: "EXTRATERRESTRE",   // no válido → otro
      rating: 99,                    // fuera de rango → clamp a 5
      tags: ["valid", 42, "", null, "OK", { x: 1 }],  // filtra solo strings no vacíos tras trim
      notes: "  con espacios alrededor  ",
    }], helpers);
    if (calls.length !== 1) throw new Error("Caso3: esperaba 1 llamada, recibí " + calls.length);
    const p = calls[0];
    if (p.type !== "otro") throw new Error("Caso3: placeType inválido debería caer a 'otro' · " + p.type);
    if (p.rating !== 5) throw new Error("Caso3: rating debería estar clampeado a 5 · " + p.rating);
    if (p.tags.length !== 2 || p.tags[0] !== "valid" || p.tags[1] !== "OK") {
      throw new Error("Caso3: tags filtrado incorrecto · " + JSON.stringify(p.tags));
    }
    if (p.notes !== "con espacios alrededor") throw new Error("Caso3: notes no se trimó · '" + p.notes + "'");
  }

  // ── Caso 3b: rating negativo → clamp a 0 ──
  {
    const helpers = buildHelpers();
    executeAgentActions([{ type: "save_place", name: "Sitio raro", rating: -3 }], helpers);
    if (calls.length !== 1) throw new Error("Caso3b: esperaba 1 llamada");
    if (calls[0].rating !== 0) throw new Error("Caso3b: rating debería estar clampeado a 0 · " + calls[0].rating);
  }

  // ── Caso 4: name vacío → addPlace NO llamado ──
  {
    const helpers = buildHelpers();
    const out = executeAgentActions([{ type: "save_place", name: "   " }], helpers);
    const results = Array.isArray(out) ? out : (out?.results || []);
    if (calls.length !== 0) throw new Error("Caso4: addPlace se llamó cuando name era blanco · " + calls.length);
    if (!results.some(r => r?.type === "error")) throw new Error("Caso4: results debería contener error");
  }

  // ── Caso 4b: name ausente → addPlace NO llamado ──
  {
    const helpers = buildHelpers();
    executeAgentActions([{ type: "save_place" }], helpers);
    if (calls.length !== 0) throw new Error("Caso4b: addPlace se llamó sin name · " + calls.length);
  }

  // ── Caso 5: varios sitios en el mismo bloque ──
  {
    const helpers = buildHelpers();
    executeAgentActions([
      { type: "save_place", name: "Hotel Petit Palace Madrid", placeType: "dormir" },
      { type: "save_place", name: "Cepsa Manzanares",          placeType: "gasolina" },
      { type: "save_place", name: "Venta El Romeral",          placeType: "comer" },
    ], helpers);
    if (calls.length !== 3) throw new Error("Caso5: esperaba 3 llamadas, recibí " + calls.length);
    const types = calls.map(c => c.type).join(",");
    if (types !== "dormir,gasolina,comer") throw new Error("Caso5: tipos en orden incorrecto · " + types);
  }

  console.log("=== SAVE PLACE OK ===");
  console.log("Caso 1:  válido completo → payload sanitizado (placeType=comer, rating 5, tags [coche,andaluz]) ✓");
  console.log("Caso 2:  válido mínimo (solo name) → defaults aplicados (type=otro, rating=null, address/notes=\"\", tags=[]) ✓");
  console.log("Caso 3:  sanitización defensiva → placeType inválido→otro, rating 99→5, tags filtradas ✓");
  console.log("Caso 3b: rating negativo → clamp a 0 ✓");
  console.log("Caso 4:  name blanco → addPlace NO llamado · results contiene error ✓");
  console.log("Caso 4b: name ausente → addPlace NO llamado ✓");
  console.log("Caso 5:  3 save_place en el mismo bloque → 3 llamadas en orden ✓");
} catch (e) {
  console.log("FAIL:", e.message);
  process.exit(1);
}
