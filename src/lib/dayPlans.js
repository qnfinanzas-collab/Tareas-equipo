// dayPlans — persistencia de rutas [RUTA] por fecha.
//
// Contexto:
//   Fase 1 del Organizador del Día. Hoy la ruta emitida por Héctor vive
//   efímera dentro del message.ruta en chatHistory (localStorage). Si el
//   CEO prepara la ruta de mañana desde el chat, se entierra y se pierde.
//
//   La ruta debe convertirse en un objeto persistente con fecha:
//   data.dayPlans = { "YYYY-MM-DD": [{id, ruta, createdAt, sourceUserId, sourceMessageTs}] }
//   y aparecer en Mi Día del día correspondiente al llegar esa fecha.
//
// Diseño:
//   - Helpers puros — testeables en Node sin JSX / React.
//   - Estructura inmutable: cada mutación devuelve un nuevo objeto (React-friendly).
//   - Dedup por signature (origen|destino|salida): si el CEO regenera la
//     ruta del mismo día, se reemplaza en vez de acumular duplicados.
//   - Si ruta.salida no aporta fecha extraíble, upsert es no-op silencioso
//     (mejor no persistir que persistir en fecha errónea).

// Extrae "YYYY-MM-DD" de ruta.salida. Formatos aceptados:
//   - "2026-07-06T08:00" → "2026-07-06"
//   - "2026-07-06" → "2026-07-06"
//   - "2026-07-06 08:00" → "2026-07-06"
// Devuelve null para cualquier otro caso.
export function extractPlanDate(ruta) {
  if (!ruta || typeof ruta !== "object") return null;
  const salida = typeof ruta.salida === "string" ? ruta.salida.trim() : "";
  if (!salida) return null;
  const m = salida.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  return `${m[1]}-${m[2]}-${m[3]}`;
}

// Signature de una ruta para dedup: origen + destino + salida (fecha+hora).
// Normalizada (lowercase + trim) para tolerar micro-variaciones de caps y
// espacios. Si Héctor emite dos veces la misma ruta con leves cambios de
// mayúsculas, sigue considerándose la misma.
export function rutaSignature(ruta) {
  if (!ruta || typeof ruta !== "object") return "";
  const o = typeof ruta.origen === "string" ? ruta.origen.trim().toLowerCase() : "";
  const d = typeof ruta.destino === "string" ? ruta.destino.trim().toLowerCase() : "";
  const s = typeof ruta.salida === "string" ? ruta.salida.trim().toLowerCase() : "";
  return `${o}|${d}|${s}`;
}

// Genera un id nuevo para un day plan.
function _genId() {
  return "dp_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

// Inserta o actualiza una ruta en el mapa dayPlans. Devuelve un nuevo
// objeto (nunca muta el input).
//
// Regla de dedup: si ya existe una entrada con la misma signature en la
// misma fecha, se reemplaza el objeto ruta (createdAt se preserva del
// original; el resto viene de meta). Si signature nueva → se añade al
// array. Sin fecha extraíble → devuelve el mapa intacto.
//
// meta esperado: { sourceUserId?, sourceMessageTs?, now? }
//   now = ISO string; si no se pasa se usa new Date().toISOString().
//   Se acepta como parámetro para testear con fechas fijas.
export function upsertDayPlan(dayPlans, ruta, meta = {}) {
  const date = extractPlanDate(ruta);
  if (!date) return dayPlans || {};
  const map = (dayPlans && typeof dayPlans === "object") ? dayPlans : {};
  const list = Array.isArray(map[date]) ? map[date] : [];
  const sig = rutaSignature(ruta);
  const nowIso = meta.now || new Date().toISOString();
  const existingIdx = list.findIndex(e => e && rutaSignature(e.ruta) === sig);
  if (existingIdx >= 0) {
    const existing = list[existingIdx];
    const updated = {
      ...existing,
      ruta,
      updatedAt: nowIso,
      sourceUserId: meta.sourceUserId ?? existing.sourceUserId ?? null,
      sourceMessageTs: meta.sourceMessageTs ?? existing.sourceMessageTs ?? null,
    };
    const newList = list.map((e, i) => i === existingIdx ? updated : e);
    return { ...map, [date]: newList };
  }
  const fresh = {
    id: _genId(),
    ruta,
    createdAt: nowIso,
    updatedAt: nowIso,
    sourceUserId: meta.sourceUserId ?? null,
    sourceMessageTs: meta.sourceMessageTs ?? null,
  };
  return { ...map, [date]: [...list, fresh] };
}

// Borra una entrada por id de una fecha. Devuelve un nuevo mapa. Si el
// array queda vacío, elimina la clave del mapa para no acumular fechas
// huecas. Idempotente: si id no existe, devuelve el mapa intacto.
export function deleteDayPlan(dayPlans, date, id) {
  if (!dayPlans || typeof dayPlans !== "object") return {};
  if (!date || !id) return dayPlans;
  const list = Array.isArray(dayPlans[date]) ? dayPlans[date] : [];
  const filtered = list.filter(e => e && e.id !== id);
  if (filtered.length === list.length) return dayPlans;
  const { [date]: _removed, ...rest } = dayPlans;
  if (filtered.length === 0) return rest;
  return { ...dayPlans, [date]: filtered };
}
