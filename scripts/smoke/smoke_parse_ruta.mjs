// smoke_parse_ruta — parser unitario del bloque [RUTA] que Héctor emite
// cuando el CEO pide una ruta de viaje por carretera.
//
// CRÍTICO: protege parseRuta + sanitización defensiva. Si esto se rompe,
// las cards de ruta de Héctor se renderizan rotas o desaparecen.
//
// 3 casos:
//   1) Válido — bloque [RUTA]{...}[/RUTA] bien formado, devuelve objeto
//      con paradas sanitizadas. Verifica también cleanRutaBlock.
//   2) Malformado — JSON roto dentro del bloque, devuelve null. La prosa
//      queda intacta para que el CEO vea contexto. Fallo silencioso.
//   3) Vacío / sin bloque — input sin [RUTA], devuelve null. Sin ruido.

import { parseRuta, cleanRutaBlock } from "../../src/lib/agentActions.js";

try {
  // ── Caso 1 — válido ──
  const validReply = `Aquí tienes la ruta optimizada con paradas reales.

[RUTA]
{
  "origen": "Marbella",
  "destino": "Madrid",
  "salida": "2026-06-27T08:00",
  "etaTotal": "5h 45min",
  "distanciaTotal": "590 km",
  "peajesEstimados": "32€",
  "paradas": [
    {"tipo":"inicio","lugar":"Marbella","hora":"08:00","km":0,"nota":""},
    {"tipo":"cafe","lugar":"Área Antequera","hora":"09:15","km":120,"nota":"15 min · gasolina"},
    {"tipo":"comida","lugar":"Venta El Romeral","hora":"11:30","km":280,"nota":"Salida 320"},
    {"tipo":"destino","lugar":"Madrid","hora":"13:45","km":590,"nota":""},
    {"tipo":"basurilla","lugar":"","hora":"99:99","km":"NaN"},
    "no es objeto",
    null
  ]
}
[/RUTA]

¿Quieres que cuadre con alguna otra parada?`;

  const r1 = parseRuta(validReply);
  if (!r1) throw new Error("Caso1: parseRuta devolvió null para un bloque válido");
  if (r1.origen !== "Marbella")  throw new Error("Caso1: origen incorrecto · " + r1.origen);
  if (r1.destino !== "Madrid")   throw new Error("Caso1: destino incorrecto · " + r1.destino);
  if (r1.etaTotal !== "5h 45min") throw new Error("Caso1: etaTotal incorrecto · " + r1.etaTotal);
  if (r1.distanciaTotal !== "590 km") throw new Error("Caso1: distanciaTotal incorrecto · " + r1.distanciaTotal);
  if (r1.peajesEstimados !== "32€") throw new Error("Caso1: peajesEstimados incorrecto · " + r1.peajesEstimados);
  // Sanitización: items degenerados (lugar vacío, "no es objeto", null) deben caer
  if (r1.paradas.length !== 4) throw new Error("Caso1: esperaba 4 paradas tras sanitizar, recibí " + r1.paradas.length);
  const tipos = r1.paradas.map(p => p.tipo);
  if (tipos.join(",") !== "inicio,cafe,comida,destino") throw new Error("Caso1: tipos incorrectos · " + tipos.join(","));
  if (r1.paradas[0].hora !== "08:00") throw new Error("Caso1: hora inicio incorrecta");
  if (r1.paradas[1].km !== 120) throw new Error("Caso1: km parada1 incorrecto");

  // cleanRutaBlock debe quitar el bloque pero conservar la prosa antes/después
  const cleaned = cleanRutaBlock(validReply);
  if (cleaned.includes("[RUTA]") || cleaned.includes("[/RUTA]")) throw new Error("Caso1: cleanRutaBlock NO quitó el bloque");
  if (!cleaned.includes("Aquí tienes la ruta")) throw new Error("Caso1: cleanRutaBlock comió la prosa de antes");
  if (!cleaned.includes("¿Quieres que cuadre")) throw new Error("Caso1: cleanRutaBlock comió la prosa de después");

  // ── Caso 2 — malformado (JSON roto dentro del bloque) ──
  const broken = `Te paso la ruta.

[RUTA]
{ "origen": "Sevilla", "destino": "Lisboa" oops esto no es JSON válido
[/RUTA]

Avísame si quieres alternativa.`;
  const r2 = parseRuta(broken);
  if (r2 !== null) throw new Error("Caso2: parseRuta debería devolver null para JSON malformado, recibí: " + JSON.stringify(r2));

  // cleanRutaBlock SÍ debe quitar el bloque aunque el JSON sea malo
  // (regex match independiente del contenido). La prosa queda visible.
  const cleaned2 = cleanRutaBlock(broken);
  if (cleaned2.includes("[RUTA]")) throw new Error("Caso2: cleanRutaBlock NO quitó el bloque malformado");
  if (!cleaned2.includes("Te paso la ruta")) throw new Error("Caso2: cleanRutaBlock comió la prosa");

  // ── Caso 2b — válido sintácticamente pero sin paradas mínimas ──
  const tooFew = `[RUTA]{"origen":"A","destino":"B","paradas":[{"tipo":"inicio","lugar":"A"}]}[/RUTA]`;
  const r2b = parseRuta(tooFew);
  if (r2b !== null) throw new Error("Caso2b: parseRuta debería devolver null con menos de 2 paradas válidas, recibí: " + JSON.stringify(r2b));

  // ── Caso 3 — vacío / sin bloque ──
  if (parseRuta(null) !== null)        throw new Error("Caso3: parseRuta(null) debería ser null");
  if (parseRuta("") !== null)          throw new Error("Caso3: parseRuta('') debería ser null");
  if (parseRuta(undefined) !== null)   throw new Error("Caso3: parseRuta(undefined) debería ser null");
  const sinBloque = "Esta respuesta no tiene bloque de ruta, solo prosa normal sobre la negociación.";
  if (parseRuta(sinBloque) !== null)   throw new Error("Caso3: parseRuta sin bloque debería ser null");

  // cleanRutaBlock sobre input sin bloque devuelve el input intacto (trim)
  const cleaned3 = cleanRutaBlock(sinBloque);
  if (cleaned3 !== sinBloque) throw new Error("Caso3: cleanRutaBlock sin bloque debería devolver el texto intacto");

  console.log("=== PARSE RUTA OK ===");
  console.log("Caso 1: bloque válido → ruta con 4 paradas sanitizadas (3 degenerados descartados) · cleanRutaBlock quita el bloque y conserva prosa ✓");
  console.log("Caso 2: JSON malformado → parseRuta=null (fallo silencioso) · cleanRutaBlock SÍ quita el bloque por regex ✓");
  console.log("Caso 2b: bloque válido con < 2 paradas → parseRuta=null (regla mínima de utilidad) ✓");
  console.log("Caso 3: input vacío / sin bloque → parseRuta=null · cleanRutaBlock devuelve texto intacto ✓");
} catch (e) {
  console.log("FAIL:", e.message);
  process.exit(1);
}
