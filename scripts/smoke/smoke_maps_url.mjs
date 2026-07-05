// smoke_maps_url — protege buildGoogleMapsUrl (src/lib/mapsUrl.js).
//
// CRÍTICO: cierra el bug "Torre Eiffel" del 05/07/2026 donde rutas con
// paradas no-geocodificables generaban path que iOS Maps interpretaba
// mal (fuzzy global al POI más famoso). Regla del builder:
//   - p.direccion > p.lugar cuando la parada la trae (Fase B v2 / C /
//     Fase D1 con coord).
//   - Descarta "Tu ubicación" sin coord (Fase D1 label sin GPS resuelto).
//   - Descarta activity markers puros ("descanso", "parada rápida", "20 min").
//   - Prefiere ruta.origen / ruta.destino global cuando sean resolubles.
//   - Truncado a 8 puntos (más estricto que los 10 previos — iOS Maps
//     es más frágil con path largo).
//
// Además protege el formato path validado en f344176 (fix Maps iOS).

import { buildGoogleMapsUrl, resolveMapsPoint } from "../../src/lib/mapsUrl.js";

const decode = (url) => decodeURIComponent(url.replace("https://www.google.com/maps/dir/", "")).split("/").filter(Boolean);

try {
  // ── Caso 1 — feliz: paradas con direccion postal usan la dirección ──
  const r1 = {
    origen: "Marbella",
    destino: "Madrid",
    paradas: [
      { tipo: "inicio",   lugar: "Marbella",                direccion: "" },
      { tipo: "cafe",     lugar: "Área Servicio Antequera", direccion: "A-92 km 145, 29200 Antequera" },
      { tipo: "comida",   lugar: "Venta El Romeral",        direccion: "N-IV km 320, 14710 Córdoba" },
      { tipo: "gasolina", lugar: "Cepsa Manzanares",        direccion: "A-4 km 154, 13200 Manzanares" },
      { tipo: "destino",  lugar: "Madrid",                  direccion: "" },
    ],
  };
  const u1 = buildGoogleMapsUrl(r1);
  const s1 = decode(u1);
  if (!u1.startsWith("https://www.google.com/maps/dir/")) throw new Error("Caso1: URL no arranca con el path base · " + u1);
  if (s1[0] !== "Marbella") throw new Error("Caso1: origen debería ser 'Marbella', recibí: " + s1[0]);
  if (s1[s1.length - 1] !== "Madrid") throw new Error("Caso1: destino debería ser 'Madrid', recibí: " + s1[s1.length - 1]);
  // Las 3 intermedias deben ser las DIRECCIONES, no los lugares coloquiales.
  if (!s1.includes("A-92 km 145, 29200 Antequera")) throw new Error("Caso1: falta dirección Antequera en path · " + s1.join(" | "));
  if (!s1.includes("N-IV km 320, 14710 Córdoba"))  throw new Error("Caso1: falta dirección Córdoba en path · " + s1.join(" | "));
  if (!s1.includes("A-4 km 154, 13200 Manzanares")) throw new Error("Caso1: falta dirección Manzanares en path · " + s1.join(" | "));
  if (s1.includes("Área Servicio Antequera")) throw new Error("Caso1: NO debería usar el lugar coloquial cuando hay dirección · " + s1.join(" | "));

  // ── Caso 2 — Fase D1 GPS: inicio con lugar "Tu ubicación" y coord ──
  // La coord de direccion debe ganar. "Tu ubicación" sin coord se
  // descartaría; con coord en direccion se usa la coord.
  const r2 = {
    origen: "Tu ubicación",   // label del Fase D1 — descartable como global
    destino: "Granada",
    paradas: [
      { tipo: "inicio",  lugar: "Tu ubicación",        direccion: "36.5099, -4.8863" },
      { tipo: "cafe",    lugar: "Bar Los Álamos",      direccion: "" },
      { tipo: "destino", lugar: "Granada",             direccion: "" },
    ],
  };
  const u2 = buildGoogleMapsUrl(r2);
  const s2 = decode(u2);
  if (s2[0] !== "36.5099, -4.8863") throw new Error("Caso2: origen debería ser la coord GPS, recibí: " + s2[0]);
  if (s2[s2.length - 1] !== "Granada") throw new Error("Caso2: destino debería ser 'Granada' (global), recibí: " + s2[s2.length - 1]);
  if (s2.some(p => /tu\s+ubicaci/i.test(p))) throw new Error("Caso2: 'Tu ubicación' NO debe aparecer en path — solo la coord · " + s2.join(" | "));

  // ── Caso 3 — "Tu ubicación" sin coord: descarte total ──
  const r3 = {
    origen: "Tu ubicación",
    destino: "Málaga",
    paradas: [
      { tipo: "inicio",  lugar: "Tu ubicación",   direccion: "" },   // sin coord — descartable
      { tipo: "cafe",    lugar: "Bar Los Álamos", direccion: "" },
      { tipo: "destino", lugar: "Málaga",         direccion: "" },
    ],
  };
  const u3 = buildGoogleMapsUrl(r3);
  const s3 = decode(u3);
  if (s3.some(p => /tu\s+ubicaci/i.test(p))) throw new Error("Caso3: 'Tu ubicación' sin coord debería descartarse · " + s3.join(" | "));
  // El path arranca directamente con la parada café válida (o Málaga si
  // Málaga es global no descartable). Verificamos que arranca por algo
  // geocodificable.
  if (s3[0] === "Tu ubicación") throw new Error("Caso3: path arranca con 'Tu ubicación' — mal · " + s3.join(" | "));

  // ── Caso 4 — activity markers como lugar sin direccion: descartados ──
  const r4 = {
    origen: "Marbella",
    destino: "Madrid",
    paradas: [
      { tipo: "inicio",   lugar: "Marbella",           direccion: "" },
      { tipo: "descanso", lugar: "descanso 20 min",    direccion: "" },  // activity marker, sin dir → descartable
      { tipo: "cafe",     lugar: "parada rápida",      direccion: "" },  // idem
      { tipo: "cafe",     lugar: "Área Antequera",     direccion: "" },  // válido, mantener
      { tipo: "destino",  lugar: "Madrid",             direccion: "" },
    ],
  };
  const u4 = buildGoogleMapsUrl(r4);
  const s4 = decode(u4);
  if (s4.includes("descanso 20 min")) throw new Error("Caso4: 'descanso 20 min' no debería llegar al path · " + s4.join(" | "));
  if (s4.includes("parada rápida"))   throw new Error("Caso4: 'parada rápida' no debería llegar al path · " + s4.join(" | "));
  if (!s4.includes("Área Antequera")) throw new Error("Caso4: 'Área Antequera' válido debería estar en el path · " + s4.join(" | "));

  // ── Caso 5 — activity marker CON direccion: se mantiene por dirección ──
  const r5 = {
    origen: "Marbella",
    destino: "Madrid",
    paradas: [
      { tipo: "inicio",   lugar: "Marbella",        direccion: "" },
      { tipo: "descanso", lugar: "descanso 20 min", direccion: "A-4 km 200, Andújar" },  // tiene dir, mantener
      { tipo: "destino",  lugar: "Madrid",          direccion: "" },
    ],
  };
  const u5 = buildGoogleMapsUrl(r5);
  const s5 = decode(u5);
  if (!s5.includes("A-4 km 200, Andújar")) throw new Error("Caso5: dirección debería estar en path · " + s5.join(" | "));
  if (s5.includes("descanso 20 min")) throw new Error("Caso5: el lugar activity marker NO debe usarse cuando hay dirección · " + s5.join(" | "));

  // ── Caso 6 — truncado a 8 puntos (más estricto que los 10 previos) ──
  const r6 = {
    origen: "Origen",
    destino: "Destino",
    paradas: [
      { tipo: "inicio",   lugar: "Origen",    direccion: "" },
      ...Array.from({ length: 15 }, (_, i) => ({ tipo: "punto", lugar: `Punto${i + 1}`, direccion: "" })),
      { tipo: "destino",  lugar: "Destino",   direccion: "" },
    ],
  };
  const u6 = buildGoogleMapsUrl(r6);
  const s6 = decode(u6);
  if (s6.length > 8) throw new Error("Caso6: truncado debería ser <=8, recibí " + s6.length + " · " + s6.join(" | "));
  if (s6[0] !== "Origen") throw new Error("Caso6: primer punto debería ser 'Origen'");
  // Con 8 puntos: origen + 7 más. El último es Destino? No — con slice(0,8),
  // el destino se corta si los intermedios lo empujan fuera. Documentamos.
  if (s6[s6.length - 1] !== "Punto7" && s6[s6.length - 1] !== "Destino") throw new Error("Caso6: último punto inesperado · " + s6[s6.length - 1]);

  // ── Caso 7 — encoding correcto: espacios, slashes, tildes ──
  const r7 = {
    origen: "Costa Brava",
    destino: "El Puerto de Sta. María",
    paradas: [
      { tipo: "inicio",  lugar: "Costa Brava",   direccion: "" },
      { tipo: "cafe",    lugar: "Café A/B Test", direccion: "" },   // "/" debe encodearse
      { tipo: "destino", lugar: "El Puerto",     direccion: "" },
    ],
  };
  const u7 = buildGoogleMapsUrl(r7);
  if (!u7.includes("Costa%20Brava")) throw new Error("Caso7: espacios deberían encodearse · " + u7);
  if (u7.includes("Café A/B Test")) throw new Error("Caso7: '/' sin encodear rompe el path · " + u7);
  if (!u7.includes("Caf%C3%A9%20A%2FB%20Test")) throw new Error("Caso7: encoding UTF-8 + %2F esperado · " + u7);

  // ── Caso 8 — sin paradas (edge): devuelve endpoint vacío ──
  const u8 = buildGoogleMapsUrl(null);
  if (u8 !== "https://www.google.com/maps/dir/") throw new Error("Caso8: sin ruta debe devolver endpoint base");
  const u8b = buildGoogleMapsUrl({ paradas: [{ lugar: "A" }] });
  if (u8b !== "https://www.google.com/maps/dir/") throw new Error("Caso8b: menos de 2 paradas debe devolver endpoint base");

  // ── Caso 9 — resolveMapsPoint helper: cubre coord en lugar ──
  if (resolveMapsPoint({ direccion: "", lugar: "36.5, -4.8" }) !== "36.5, -4.8") throw new Error("Caso9: coord en lugar debería devolverse tal cual");
  if (resolveMapsPoint({ direccion: "", lugar: "Tu ubicación" }) !== null) throw new Error("Caso9: 'Tu ubicación' sin coord debería null");
  if (resolveMapsPoint({ direccion: "  A-92 km 145  ", lugar: "X" }) !== "A-92 km 145") throw new Error("Caso9: direccion debe ganar y trimearse");
  if (resolveMapsPoint({ direccion: "", lugar: "descanso" }) !== null) throw new Error("Caso9: 'descanso' solo debería descartarse");
  if (resolveMapsPoint({ direccion: "", lugar: "Restaurante El Cid" }) !== "Restaurante El Cid") throw new Error("Caso9: nombre plausible debe mantenerse");

  console.log("=== MAPS URL OK ===");
  console.log("Caso 1: paradas con dirección postal → dirección gana sobre lugar coloquial ✓");
  console.log("Caso 2: Fase D1 'Tu ubicación' + coord en direccion → path usa la coord GPS ✓");
  console.log("Caso 3: 'Tu ubicación' sin coord → descartada del path ✓");
  console.log("Caso 4: activity markers ('descanso 20 min', 'parada rápida') sin dir → descartados ✓");
  console.log("Caso 5: activity marker CON dirección → se mantiene por su dirección ✓");
  console.log("Caso 6: truncado a 8 puntos (más estricto que 10 previos, mejor iOS Maps) ✓");
  console.log("Caso 7: encoding UTF-8 correcto (tildes, espacios) + '/' encodeado como %2F ✓");
  console.log("Caso 8: ruta null / <2 paradas → endpoint base seguro ✓");
  console.log("Caso 9: resolveMapsPoint helper — coord, label, dirección, activity, nombre plausible ✓");
} catch (e) {
  console.log("FAIL:", e.message);
  process.exit(1);
}
