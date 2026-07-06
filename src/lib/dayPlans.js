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

// ── Fase 2: Organizador del Día — cruce por fecha ────────────────────
// Ancla usado en este frente: dueDate (cuándo vence la tarea), NO
// startDate. Coherente con la visión "las tareas que se despachan ese
// día" — se cruzan con la ruta cuya salida coincide.
// (MiDiaView usa startDate como ancla de su agenda por horas — decisión
// producto distinta y compatible; ambas coexisten sin fricción.)

// Extrae tareas cuyo dueDate === date, planas y enriquecidas con datos
// del proyecto y columna. Excluye archivadas y las que estén en columna
// "Hecho" (regla del proyecto — coherente con MiDiaView y otras vistas).
// Filtro opcional por memberId (si se pasa, solo tareas asignadas a él).
// Ordenación: por dueTime ascendente ("" al final del grupo).
//
// Inputs:
//   boards: { [projId]: [{id, name, tasks: [{id, ref, title, dueDate, dueTime, priority, duration_minutes, assignees, archived}]}] }
//   projects: array de proyectos { id, name, emoji }
//   date: "YYYY-MM-DD"
//   opts: { memberId? }
export function getTasksForDate(boards, projects, date, opts = {}) {
  if (!boards || typeof boards !== "object") return [];
  if (!date) return [];
  const memberId = opts.memberId;
  const projMap = new Map();
  if (Array.isArray(projects)) {
    for (const p of projects) {
      if (p && p.id != null) projMap.set(p.id, p);
    }
  }
  const out = [];
  for (const [pidRaw, cols] of Object.entries(boards)) {
    if (!Array.isArray(cols)) continue;
    const pid = Number(pidRaw);
    const proj = projMap.get(pid) || null;
    for (const col of cols) {
      if (!col || !Array.isArray(col.tasks)) continue;
      if (col.name === "Hecho") continue;
      for (const t of col.tasks) {
        if (!t || t.archived === true) continue;
        if (t.dueDate !== date) continue;
        if (memberId != null && Array.isArray(t.assignees) && !t.assignees.includes(memberId)) continue;
        out.push({
          ...t,
          projId: pid,
          projName: proj?.name || "",
          projEmoji: proj?.emoji || "📋",
          colName: col.name || "",
          colId: col.id,
        });
      }
    }
  }
  // Ordenación: dueTime asc; las sin dueTime al final.
  out.sort((a, b) => {
    const ta = /^\d{2}:\d{2}$/.test(a.dueTime || "") ? a.dueTime : "99:99";
    const tb = /^\d{2}:\d{2}$/.test(b.dueTime || "") ? b.dueTime : "99:99";
    if (ta !== tb) return ta.localeCompare(tb);
    return String(a.title || "").localeCompare(String(b.title || ""));
  });
  return out;
}

// Cuenta negociaciones activas (no archivadas + status en_curso|pausado).
// Fase 2 la usa para un banner discreto informativo: "N negociaciones
// activas — próximas acciones pendientes de Fase 2b". Cuando Fase 2b
// introduzca el schema n.nextAction, se sustituirá por el conteo real
// de próximas acciones del día.
export function countActiveNegotiations(negotiations) {
  if (!Array.isArray(negotiations)) return 0;
  return negotiations.filter(n => n && !n.archived && (n.status === "en_curso" || n.status === "pausado")).length;
}
