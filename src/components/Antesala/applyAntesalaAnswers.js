// applyAntesalaAnswers — traduce el objeto `answers` del AntesalaFlow
// en mutaciones sobre el JSONB `data` del tenant (taskflow_state.data).
//
// Función PURA, testeable en Node sin React. Devuelve nextData sin
// mutar el original. El commit 5/5 la conectará al ciclo de setData
// en App.jsx (post-signup detección + skip + Entrar en Kluxor).
//
// Mapeo de cada respuesta al campo del que Héctor y el resto de la
// app ya leen (cero campo nuevo salvo los declarados en commit 1/5):
//   answers.name         → ceoProfile.name          (buildCeoBlock)
//   answers.company      → ceoProfile.company       (buildCeoBlock)
//   answers.description  → ceoProfile.description   (buildCeoBlock)
//   answers.teamSize     → ceoProfile.teamSize      (buildCeoBlock)
//   answers.city         → ceoProfile.city          (buildCeoBlock)
//                        + places[home] duplicado   (planificador rutas)
//   answers.advisors     → ceoProfile.advisors      (buildCeoBlock)
//   answers.fronts       → ceoProfile.antesalaPendingFronts (temporal)
//                          — commit 4/5 los convierte en 3 proyectos
//                          reales al pulsar "Entrar en Kluxor".
//   answers.timeSink     → ceoMemory.keyFacts[] con source:"antesala"
//                          (memBlockFormatted lo lee en el system prompt)
//   answers.scheduleKey  → members[owner].avail.{morning,afternoon,hoursPerDay}
//                          (los planners ya leen avail)
//
// Estado de la Antesala en ceoProfile:
//   antesalaProgress:    número 0..7 (pasos respondidos).
//   antesalaSkippedAt:   ISO si el CEO pulsó "Prefiero hacerlo después"
//                        con progress < 7. Se limpia al completar.
//   antesalaCompletedAt: ISO cuando pulsa "Entrar en Kluxor" en el
//                        Summary. A partir de aquí no vuelve a aparecer.
//
// Idempotente ante re-ejecución: si el CEO corrige una respuesta y
// vuelve al Summary, aplicar de nuevo sobre el mismo prev es seguro
// (los campos se sobrescriben, no se acumulan; keyFacts deduplica por
// source:"antesala"; place[home] deduplica por memberId+placeType).

import { SCHEDULES } from "./schedules.js";

/**
 * @param {object} prev       - data actual (no se muta).
 * @param {object} answers    - respuestas parciales/completas del CEO.
 * @param {object} opts
 * @param {number} opts.progress          - pasos respondidos (0..7).
 * @param {"progress"|"full-answered"|"completed"} opts.status
 *   "progress"      → skip parcial (marca antesalaSkippedAt).
 *   "full-answered" → 7/7 respondidas pero aún no pulsó "Entrar en
 *                     Kluxor" (Summary visible, retomable ahí).
 *   "completed"     → pulsó "Entrar en Kluxor" (marca completedAt,
 *                     limpia skipped + antesalaPendingFronts).
 * @param {number|string} [opts.ownerMemberId] - id del member del CEO
 *   propietario. Necesario para tocar members[i].avail y places[home].
 *   Sin él, esos campos NO se tocan (helper degrada silenciosamente).
 * @param {Date}   [opts.now] - inyectable para tests deterministas.
 * @returns {object} nextData
 */
export function applyAntesalaAnswers(prev, answers, opts = {}) {
  const now = opts.now instanceof Date ? opts.now : new Date();
  const nowIso = now.toISOString();
  const progress = typeof opts.progress === "number" ? Math.max(0, Math.min(7, opts.progress)) : 0;
  const status = opts.status || "progress";
  const ownerMemberId = opts.ownerMemberId;
  const a = answers && typeof answers === "object" ? answers : {};

  const next = { ...(prev || {}) };

  // ─── ceoProfile ─────────────────────────────────────────────────
  const cp = { ...(next.ceoProfile || {}) };

  if (typeof a.name === "string" && a.name.trim()) cp.name = a.name.trim();
  if (typeof a.company === "string" && a.company.trim()) cp.company = a.company.trim();
  if (typeof a.description === "string" && a.description.trim()) cp.description = a.description.trim();
  if (typeof a.teamSize === "number" && a.teamSize >= 0) cp.teamSize = a.teamSize;
  if (typeof a.city === "string" && a.city.trim()) cp.city = a.city.trim();
  if (Array.isArray(a.advisors)) {
    // Filtro defensivo — solo keys conocidas.
    const VALID = new Set(["legal","fiscal","gestoria","internal","none"]);
    cp.advisors = a.advisors.filter(k => VALID.has(k));
  }
  if (Array.isArray(a.fronts) && a.fronts.length === 3) {
    const clean = a.fronts.map(f => String(f || "").trim()).filter(Boolean);
    if (clean.length === 3) cp.antesalaPendingFronts = clean;
  }

  cp.antesalaProgress = progress;
  if (status === "progress") {
    cp.antesalaSkippedAt = nowIso;
    // No tocamos completedAt (será null si nunca lo puso; si el CEO
    // completó y luego "corrige" un paso, status pasa por Summary
    // como "full-answered" o "completed", nunca "progress").
  } else if (status === "full-answered") {
    // Respondió 7/7, aún en Summary sin pulsar. Persistimos progreso
    // para poder retomar directo en Summary si cierra el navegador.
    // Limpia skippedAt (ya no está en modo skip).
    cp.antesalaSkippedAt = null;
  } else if (status === "completed") {
    cp.antesalaCompletedAt = nowIso;
    cp.antesalaSkippedAt = null;
    // Los frentes ya materializados como proyectos (lo hace el
    // ejecutor en commit 4/5). Limpiamos el buffer temporal.
    cp.antesalaPendingFronts = null;
  }

  next.ceoProfile = cp;

  // ─── ceoMemory.keyFacts (timeSink) ───────────────────────────────
  if (typeof a.timeSink === "string" && a.timeSink.trim()) {
    const mem = next.ceoMemory
      ? { ...next.ceoMemory }
      : { preferences: [], keyFacts: [], decisions: [], lessons: [], updatedAt: null };
    const keyFacts = Array.isArray(mem.keyFacts) ? [...mem.keyFacts] : [];
    // Dedup: buscar keyFact previo con source:"antesala"+field:"timeSink"
    // para no acumular al re-ejecutar el helper. Si existe, se
    // reemplaza; si no, se añade al final.
    const existingIdx = keyFacts.findIndex(f =>
      f && f.source === "antesala" && f.field === "timeSink"
    );
    const fact = {
      id: existingIdx >= 0 ? keyFacts[existingIdx].id : `kf_ant_ts_${now.getTime()}`,
      type: "keyFact",
      field: "timeSink",
      source: "antesala",
      content: `Le roba tiempo: ${a.timeSink.trim()}`,
      createdAt: existingIdx >= 0 ? keyFacts[existingIdx].createdAt : nowIso,
      updatedAt: nowIso,
    };
    if (existingIdx >= 0) keyFacts[existingIdx] = fact;
    else keyFacts.push(fact);
    mem.keyFacts = keyFacts;
    mem.updatedAt = nowIso;
    next.ceoMemory = mem;
  }

  // ─── members[owner].avail (horario) ─────────────────────────────
  if (a.scheduleKey && ownerMemberId != null) {
    const sched = (SCHEDULES || []).find(s => s.key === a.scheduleKey);
    if (sched) {
      const members = Array.isArray(next.members) ? [...next.members] : [];
      const idx = members.findIndex(m => m && String(m.id) === String(ownerMemberId));
      if (idx >= 0) {
        const m = { ...members[idx] };
        const av = { ...(m.avail || {}) };
        av.morningStart   = sched.morningStart   || "";
        av.morningEnd     = sched.morningEnd     || "";
        av.afternoonStart = sched.afternoonStart || "";
        av.afternoonEnd   = sched.afternoonEnd   || "";
        if (typeof sched.hoursPerDay === "number") av.hoursPerDay = sched.hoursPerDay;
        m.avail = av;
        members[idx] = m;
        next.members = members;
      }
    }
  }

  // ─── places[home] (ciudad) ──────────────────────────────────────
  // Además de ceoProfile.city (para el prompt), añadimos un place
  // tipo "home" en la ciudad del CEO. Cero código nuevo en el
  // planificador: places ya está integrado.
  if (typeof a.city === "string" && a.city.trim() && ownerMemberId != null) {
    const cityStr = a.city.trim();
    const places = Array.isArray(next.places) ? [...next.places] : [];
    const existingIdx = places.findIndex(p =>
      p && p.placeType === "home" && String(p.memberId) === String(ownerMemberId)
    );
    const place = {
      id: existingIdx >= 0 ? places[existingIdx].id : `pl_home_${ownerMemberId}_${now.getTime()}`,
      name: cityStr,
      placeType: "home",
      address: cityStr,
      memberId: ownerMemberId,
      source: "antesala",
      createdAt: existingIdx >= 0 ? places[existingIdx].createdAt : nowIso,
      updatedAt: nowIso,
    };
    if (existingIdx >= 0) places[existingIdx] = place;
    else places.push(place);
    next.places = places;
  }

  return next;
}
