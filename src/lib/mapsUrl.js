// buildGoogleMapsUrl — construye el enlace universal a Google Maps para
// una ruta parseada. Extraído de RutaCard.jsx para poder testearlo en
// smoke Node (RutaCard tiene JSX no cargable sin transformador).
//
// Historia:
//   - f344176: fix path format en vez de ?api=1&waypoints= (Maps iOS
//     descartaba waypoints del formato query).
//   - Fix Torre Eiffel (05/07/2026): el path anterior usaba p.lugar sin
//     mirar p.direccion, así rutas con 8+ paradas donde algún lugar
//     no era geocodificable ("Tu ubicación" de Fase D1, o nombres
//     coloquiales tipo "Restaurante en X sin dirección") reventaban
//     la resolución iOS. Maps hacía fuzzy global y podía devolver
//     "Torre Eiffel" u otro POI famoso mundial como destino.
//
// Diseño del fix:
//   - Prioridad de resolución por parada:
//       (1) p.direccion (Fase B v2 / C emite postal o PK+salida; Fase
//           D1 emite "lat,lng" para inicio GPS). Es lo más geocodificable.
//       (2) p.lugar si es un lugar plausible.
//       (3) descartado si el lugar es marker de actividad ("descanso",
//           "parada rápida") o el label GPS "Tu ubicación" sin coord.
//   - Origen / destino global (ruta.origen / ruta.destino) se prefieren
//     sobre la primera/última parada CUANDO son resolubles y no son el
//     label "Tu ubicación" — en cuyo caso caemos a la parada (que sí
//     puede traer coord en direccion).
//   - Truncado 10 → 8 puntos. iOS Maps aguanta peor los path largos
//     que Android/desktop; con 8 seguimos cubriendo casi todas las
//     rutas realistas y ganamos fiabilidad.

// Regex de "no es un lugar geocodificable" — activity markers puros
// (típicos de emisiones descuidadas del modelo cuando no supo confirmar
// un sitio). Solo se aplica cuando la parada NO trae p.direccion; con
// dirección real gana la dirección.
const NON_PLACE_LUGAR_RE = /^(descanso|parada|pausa|para\s+(descansar|comer|caf[eé])|repostar|solo\s+gasolina|caf[eé]\s+r[aá]pido|\d+\s*(min|h|hora)s?\.?)(\s|$)/i;

// El label textual que emite Fase D1 para la parada de inicio cuando el
// CEO usa GPS. Sin dirección con coordenadas, este label no le sirve a
// Maps para nada — descartarlo evita "Tu ubicación" como texto literal
// que iOS Maps interpreta como búsqueda y cae en fuzzy global.
const TU_UBICACION_LABEL_RE = /^tu\s+ubicaci[oó]n$/i;

// Coord format "lat,lng" o "lat, lng" con decimales. Cuando aparece,
// Maps la reconoce nativamente como coordenada y geocoding es 100% fiable.
const COORD_RE = /^-?\d+(\.\d+)?\s*,\s*-?\d+(\.\d+)?$/;

// Resuelve UN string listo para meter como segmento del path. Devuelve
// string trimeado o null si la parada no es geocodificable.
// Regla: dirección > lugar; descarta labels y activity markers puros.
export function resolveMapsPoint(p) {
  if (!p || typeof p !== "object") return null;
  const dir = typeof p.direccion === "string" ? p.direccion.trim() : "";
  const lugar = typeof p.lugar === "string" ? p.lugar.trim() : "";
  // (1) Coord en direccion (Fase D1 GPS) — máxima fiabilidad.
  if (COORD_RE.test(dir)) return dir;
  // (2) Coord por error emitida en lugar — también válida.
  if (COORD_RE.test(lugar)) return lugar;
  // (3) Dirección postal / PK+salida en direccion — priorizada.
  if (dir.length >= 6) return dir;
  // (4) Sin direccion, evaluamos lugar.
  if (!lugar) return null;
  // (5) "Tu ubicación" sin coord es descartable — no le sirve a Maps.
  if (TU_UBICACION_LABEL_RE.test(lugar)) return null;
  // (6) Activity markers puros — descartar.
  if (NON_PLACE_LUGAR_RE.test(lugar)) return null;
  return lugar;
}

// Resuelve un origen/destino global (ruta.origen o ruta.destino).
// Aplica misma sanitización que resolveMapsPoint pero solo con el string
// crudo (no hay direccion asociada). Devuelve null si es descartable.
function resolveMapsGlobal(str) {
  if (!str || typeof str !== "string") return null;
  const s = str.trim();
  if (!s) return null;
  if (TU_UBICACION_LABEL_RE.test(s)) return null;
  if (NON_PLACE_LUGAR_RE.test(s)) return null;
  return s;
}

// Truncado a 8 puntos totales (origen + hasta 6 intermedios + destino).
// Google Maps directions API acepta hasta 10 puntos oficialmente, pero
// iOS Maps en universal-link es más frágil con path largo. Con 8
// cubrimos casi todas las rutas realistas y ganamos fiabilidad de
// resolución.
const MAX_POINTS = 8;

export function buildGoogleMapsUrl(ruta) {
  if (!ruta || !Array.isArray(ruta.paradas) || ruta.paradas.length < 2) {
    return "https://www.google.com/maps/dir/";
  }
  const paradas = ruta.paradas;
  // Origen: preferir ruta.origen global si resoluble; si no, primer
  // parada resuelta. Si tampoco, deja "" (Maps fallback al último).
  const inicio =
    resolveMapsGlobal(ruta.origen) ||
    resolveMapsPoint(paradas[0]) ||
    "";
  // Destino: análogo — preferir ruta.destino global; si no, última parada.
  const fin =
    resolveMapsGlobal(ruta.destino) ||
    resolveMapsPoint(paradas[paradas.length - 1]) ||
    "";
  // Intermedias: paradas 1..n-1 filtradas por resolveMapsPoint. Las
  // descartadas silenciosamente NO van al path — el CEO sigue viéndolas
  // en la RutaCard visual, solo Maps recibe la subsecuencia geocodificable.
  const intermedias = paradas
    .slice(1, -1)
    .map(resolveMapsPoint)
    .filter(Boolean);
  const puntos = [inicio, ...intermedias, fin]
    .filter(Boolean)
    .slice(0, MAX_POINTS);
  // Si tras todo el filtro NO quedan puntos, devolvemos el endpoint
  // vacío de Maps — el CEO al menos ve la app abrirse (mejor que 404).
  if (puntos.length === 0) return "https://www.google.com/maps/dir/";
  return `https://www.google.com/maps/dir/${puntos.map(encodeURIComponent).join("/")}`;
}
