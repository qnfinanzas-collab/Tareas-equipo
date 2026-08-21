// smoke_antesala_persist — verifica el helper applyAntesalaAnswers.
//
// Función pura sin React. Casos cubiertos:
//   Caso 1: skip parcial (progress 2, status "progress") — persiste
//           lo respondido + antesalaSkippedAt, no toca completedAt.
//   Caso 2: respuesta completa sin pulsar Entrar (progress 7,
//           "full-answered") — persiste TODO + antesalaProgress=7,
//           sin marcar completedAt (Summary sigue reabrible).
//   Caso 3: completed (progress 7, "completed") — marca completedAt,
//           limpia skippedAt y antesalaPendingFronts.
//   Caso 4: idempotencia — aplicar dos veces con las mismas
//           respuestas no duplica keyFacts ni places[home].
//   Caso 5: helper degrada si falta ownerMemberId — no toca
//           members[i].avail ni places[home].
//   Caso 6: filtrado de advisors — keys inválidas se descartan.

import { applyAntesalaAnswers, extractAntesalaAnswers, backfillAntesalaSeenAt } from "../../src/components/Antesala/applyAntesalaAnswers.js";

function assert(cond, label) {
  if (!cond) { console.error(`✗ ${label}`); process.exitCode = 1; return false; }
  console.log(`  ✓ ${label}`);
  return true;
}

const BASE_DATA = () => ({
  ceoProfile: { name: "", company: "", role: "", sector: "", description: "", teamSize: 0, city: "", antesalaProgress: 0, antesalaCompletedAt: null, antesalaSkippedAt: null },
  ceoMemory:  { preferences: [], keyFacts: [], decisions: [], lessons: [], updatedAt: null },
  members:    [{ id: 6, name: "Antonio Díaz", avail: { workDays:[1,2,3,4,5], morningStart:"09:00", morningEnd:"14:00", afternoonStart:"16:00", afternoonEnd:"19:00", hoursPerDay:8 } }],
  places:     [],
});

// ─── Caso 1: skip parcial ──────────────────────────────────────────
{
  const prev = BASE_DATA();
  const now = new Date("2026-08-20T10:00:00Z");
  const next = applyAntesalaAnswers(prev, {
    name: "Antonio",
    company: "ALMA DIMO INVESTMENTS S.L.",
  }, { progress: 2, status: "skipped", ownerMemberId: 6, now });

  console.log("Caso 1: skip parcial (status='skipped', progress 2)");
  assert(next.ceoProfile.name === "Antonio", "name persiste");
  assert(next.ceoProfile.company === "ALMA DIMO INVESTMENTS S.L.", "company persiste");
  assert(next.ceoProfile.antesalaProgress === 2, "progress = 2");
  assert(next.ceoProfile.antesalaSkippedAt === "2026-08-20T10:00:00.000Z", "skippedAt marcado");
  assert(next.ceoProfile.antesalaCompletedAt === null, "completedAt sigue null");
  assert(prev.ceoProfile.name === "", "prev no mutado");
}

// ─── Caso 1b: avance normal (progressing) ─────────────────────────
{
  const prev = BASE_DATA();
  prev.ceoProfile.antesalaSkippedAt = "2026-08-19T20:00:00.000Z"; // había skipeado antes
  const now = new Date("2026-08-20T10:02:00Z");
  const next = applyAntesalaAnswers(prev, {
    name: "Antonio",
    company: "ALMA DIMO",
  }, { progress: 2, status: "progressing", ownerMemberId: 6, now });

  console.log("Caso 1b: avance normal (status='progressing')");
  assert(next.ceoProfile.antesalaProgress === 2, "progress = 2");
  assert(next.ceoProfile.antesalaSkippedAt === null, "skippedAt LIMPIO (retomó desde skip previo)");
  assert(next.ceoProfile.antesalaCompletedAt === null, "completedAt sigue null");
}

// ─── Caso 2: full-answered (7/7 sin pulsar Entrar) ────────────────
{
  const prev = BASE_DATA();
  const now = new Date("2026-08-20T10:05:00Z");
  const answers = {
    name: "Antonio",
    company: "ALMA DIMO",
    description: "Holding de inversiones",
    teamSize: 10,
    fronts: ["Frente A", "Frente B", "Frente C"],
    timeSink: "Foro semanal comercial que se alarga",
    scheduleKey: "split",
    city: "Marbella",
    advisors: ["legal", "fiscal"],
  };
  const next = applyAntesalaAnswers(prev, answers, { progress: 7, status: "full-answered", ownerMemberId: 6, now });

  console.log("Caso 2: full-answered (7/7, aún en Summary)");
  assert(next.ceoProfile.antesalaProgress === 7, "progress = 7");
  assert(next.ceoProfile.antesalaCompletedAt === null, "completedAt sigue null (aún en Summary)");
  assert(next.ceoProfile.antesalaSkippedAt === null, "skippedAt limpio (ya no está en skip)");
  assert(Array.isArray(next.ceoProfile.antesalaPendingFronts) && next.ceoProfile.antesalaPendingFronts.length === 3, "3 frentes en buffer temporal");
  assert(next.ceoProfile.teamSize === 10, "teamSize");
  assert(next.ceoProfile.city === "Marbella", "city");
  assert(Array.isArray(next.ceoProfile.advisors) && next.ceoProfile.advisors.length === 2, "advisors 2 keys");
  assert(next.ceoMemory.keyFacts.length === 1 && next.ceoMemory.keyFacts[0].content.startsWith("Le roba tiempo:"), "keyFact timeSink añadido");
  assert(next.members[0].avail.morningStart === "09:00" && next.members[0].avail.afternoonStart === "16:00" && next.members[0].avail.hoursPerDay === 8, "avail actualizado del schedule 'split'");
  assert(next.places.length === 1 && next.places[0].placeType === "home" && next.places[0].name === "Marbella" && String(next.places[0].memberId) === "6", "place[home] añadido con la ciudad");
}

// ─── Caso 3: completed (pulsó Entrar en Kluxor) ───────────────────
{
  const prev = BASE_DATA();
  prev.ceoProfile.antesalaPendingFronts = ["A", "B", "C"];
  prev.ceoProfile.antesalaSkippedAt = "2026-08-19T20:00:00.000Z";
  const now = new Date("2026-08-20T10:10:00Z");
  const next = applyAntesalaAnswers(prev, {}, { progress: 7, status: "completed", ownerMemberId: 6, now });

  console.log("Caso 3: completed (pulsó Entrar en Kluxor)");
  assert(next.ceoProfile.antesalaCompletedAt === "2026-08-20T10:10:00.000Z", "completedAt marcado");
  assert(next.ceoProfile.antesalaSkippedAt === null, "skippedAt limpio");
  assert(next.ceoProfile.antesalaPendingFronts === null, "pendingFronts limpio (proyectos ya creados)");
}

// ─── Caso 4: idempotencia — sin duplicar keyFacts ni places ────────
{
  let d = BASE_DATA();
  const now1 = new Date("2026-08-20T10:00:00Z");
  const now2 = new Date("2026-08-20T10:15:00Z");
  const answers = {
    timeSink: "Reuniones sin decisión",
    city: "Marbella",
  };
  d = applyAntesalaAnswers(d, answers, { progress: 5, status: "skipped", ownerMemberId: 6, now: now1 });
  d = applyAntesalaAnswers(d, answers, { progress: 6, status: "skipped", ownerMemberId: 6, now: now2 });

  console.log("Caso 4: idempotencia");
  assert(d.ceoMemory.keyFacts.length === 1, "keyFacts NO duplicado tras aplicar dos veces");
  assert(d.ceoMemory.keyFacts[0].updatedAt === "2026-08-20T10:15:00.000Z", "updatedAt refresca");
  assert(d.ceoMemory.keyFacts[0].createdAt === "2026-08-20T10:00:00.000Z", "createdAt se preserva del primer insert");
  assert(d.places.length === 1 && d.places[0].placeType === "home", "place[home] NO duplicado");
  assert(d.places[0].createdAt === "2026-08-20T10:00:00.000Z", "createdAt del place se preserva");
}

// ─── Caso 5: sin ownerMemberId — degrada silencioso ────────────────
{
  const prev = BASE_DATA();
  const originalAvail = { ...prev.members[0].avail };
  const now = new Date("2026-08-20T10:00:00Z");
  const next = applyAntesalaAnswers(prev, {
    scheduleKey: "morning",
    city: "Sevilla",
  }, { progress: 6, status: "skipped", now /* sin ownerMemberId */ });

  console.log("Caso 5: sin ownerMemberId");
  assert(next.ceoProfile.city === "Sevilla", "ceoProfile.city sí se actualiza (no depende de member)");
  assert(next.members[0].avail.morningStart === originalAvail.morningStart, "avail NO tocado sin ownerMemberId");
  assert(!Array.isArray(next.places) || next.places.length === 0, "places NO tocado sin ownerMemberId");
}

// ─── Caso 6: advisors — solo keys válidas ──────────────────────────
{
  const prev = BASE_DATA();
  const next = applyAntesalaAnswers(prev, {
    advisors: ["legal", "totallyInvented", "fiscal", ""],
  }, { progress: 7, status: "full-answered", now: new Date() });

  console.log("Caso 6: advisors filtrados");
  assert(Array.isArray(next.ceoProfile.advisors), "advisors es array");
  assert(next.ceoProfile.advisors.length === 2, "solo 2 keys válidas (legal, fiscal)");
  assert(next.ceoProfile.advisors.includes("legal") && next.ceoProfile.advisors.includes("fiscal"), "las 2 correctas se preservan");
  assert(!next.ceoProfile.advisors.includes("totallyInvented"), "clave inventada descartada");
}

// ─── Caso 7: 'none' exclusivo se preserva ───────────────────────────
{
  const prev = BASE_DATA();
  const next = applyAntesalaAnswers(prev, {
    advisors: ["none"],
  }, { progress: 7, status: "full-answered", now: new Date() });

  console.log("Caso 7: advisors ['none']");
  assert(next.ceoProfile.advisors.length === 1 && next.ceoProfile.advisors[0] === "none", "'none' se preserva como key válida");
}

// ─── Caso 8: extractAntesalaAnswers — round-trip ──────────────────
{
  let d = BASE_DATA();
  const now = new Date("2026-08-20T10:00:00Z");
  const answers = {
    name: "Antonio",
    company: "ALMA DIMO",
    description: "Holding",
    teamSize: 10,
    fronts: ["A", "B", "C"],
    timeSink: "Reuniones sin decisión",
    scheduleKey: "split",
    city: "Marbella",
    advisors: ["legal", "fiscal"],
  };
  d = applyAntesalaAnswers(d, answers, { progress: 7, status: "full-answered", ownerMemberId: 6, now });
  const restored = extractAntesalaAnswers(d, 6);

  console.log("Caso 8: extractAntesalaAnswers — round-trip");
  assert(restored.name === "Antonio", "name restored");
  assert(restored.company === "ALMA DIMO", "company restored");
  assert(restored.description === "Holding", "description restored");
  assert(restored.teamSize === 10, "teamSize restored");
  assert(Array.isArray(restored.fronts) && restored.fronts.length === 3 && restored.fronts[0] === "A", "fronts restored");
  assert(restored.timeSink === "Reuniones sin decisión", "timeSink extraído del keyFact (sin prefijo)");
  assert(restored.scheduleKey === "split", "scheduleKey reconstruido desde member.avail");
  assert(restored.city === "Marbella", "city restored");
  assert(Array.isArray(restored.advisors) && restored.advisors.length === 2, "advisors restored");
}

// ─── Caso 9: backfill — tenant pre-deploy con proyectos ───────────
{
  const prev = {
    ceoProfile: { name: "", antesalaCompletedAt: null, antesalaSkippedAt: null, antesalaSeenAt: null },
    projects: [{ id: 1, name: "Proyecto existente" }, { id: 2, name: "Otro" }],
    boards: {},
  };
  const now = new Date("2026-08-21T09:00:00Z");
  const next = backfillAntesalaSeenAt(prev, { now });

  console.log("Caso 9: backfill tenant pre-deploy con proyectos");
  assert(next.ceoProfile.antesalaSeenAt === "2026-08-21T09:00:00.000Z", "seenAt marcado con timestamp");
  assert(prev.ceoProfile.antesalaSeenAt === null, "prev NO mutado");
  assert(next.projects === prev.projects, "projects referencia intacta (solo mutamos ceoProfile)");
}

// ─── Caso 10: backfill idempotente si seenAt ya está ──────────────
{
  const prev = {
    ceoProfile: { antesalaSeenAt: "2020-01-01T00:00:00.000Z", antesalaCompletedAt: null },
    projects: [{ id: 1 }],
  };
  const next = backfillAntesalaSeenAt(prev, { now: new Date("2026-08-21T09:00:00Z") });

  console.log("Caso 10: backfill idempotente si seenAt ya está");
  assert(next === prev, "devuelve el mismo prev sin tocar");
  assert(next.ceoProfile.antesalaSeenAt === "2020-01-01T00:00:00.000Z", "seenAt previo preservado");
}

// ─── Caso 11: backfill no marca si projects=0 (tenant nuevo) ──────
{
  const prev = {
    ceoProfile: { antesalaSeenAt: null, antesalaCompletedAt: null },
    projects: [],
  };
  const next = backfillAntesalaSeenAt(prev, { now: new Date("2026-08-21T09:00:00Z") });

  console.log("Caso 11: tenant nuevo (projects=0) — no backfill");
  assert(next === prev, "devuelve el mismo prev");
  assert(next.ceoProfile.antesalaSeenAt === null, "seenAt sigue null (deja que la Antesala se dispare)");
}

// ─── Caso 12: backfill no marca si completedAt ya está ────────────
{
  const prev = {
    ceoProfile: { antesalaSeenAt: null, antesalaCompletedAt: "2025-12-01T00:00:00.000Z" },
    projects: [{ id: 1 }],
  };
  const next = backfillAntesalaSeenAt(prev, { now: new Date("2026-08-21T09:00:00Z") });

  console.log("Caso 12: completedAt ya seteado — no backfill (guardia ya bloquea)");
  assert(next === prev, "devuelve el mismo prev");
  assert(next.ceoProfile.antesalaSeenAt === null, "seenAt sigue null (completedAt ya bloquea)");
}

// ─── Caso 13: escenario welcome+cierra sin responder ──────────────
{
  // Simula: CEO nuevo abre la app, ve welcome, cierra sin responder.
  // NUNCA se llama a applyAntesalaAnswers (no hubo onProgress).
  // El backfill tampoco toca (projects=0).
  // El seenAt sigue null → la guardia mostrará la Antesala al reload.
  const prev = {
    ceoProfile: { antesalaSeenAt: null, antesalaCompletedAt: null, antesalaSkippedAt: null, antesalaProgress: 0 },
    projects: [],
    members: [{ id: 0, name: "CEO", accountRole: "admin" }],
  };
  const next = backfillAntesalaSeenAt(prev, { now: new Date("2026-08-21T09:00:00Z") });

  console.log("Caso 13: welcome + cierra sin responder → sigue viendo Antesala al reload");
  assert(next.ceoProfile.antesalaSeenAt === null, "seenAt sigue null (no hay projects)");
  assert(next.ceoProfile.antesalaProgress === 0, "progress sigue 0");
  // La guardia (fuera de este helper) evaluaría:
  // syncReady && isOwner && projects.length===0 && !completedAt && !skippedAt && !seenAt
  // → TRUE (todos los negados son true, todos los positivos también).
  // Reproducimos:
  const guardShown = true && true && (next.projects.length === 0) && !next.ceoProfile.antesalaCompletedAt && !next.ceoProfile.antesalaSkippedAt && !next.ceoProfile.antesalaSeenAt;
  assert(guardShown === true, "guardia evalúa true → Antesala se mostraría al reload");
}

// ─── Caso 14: escenario Antonio borra sus proyectos ───────────────
{
  // Antonio tras backfill: seenAt marcado. Guardia con !seenAt bloquea
  // aunque borre todos los proyectos. Este es el bug de la guardia
  // que Antonio detectó en la verificación previa al push (21/08).
  const prev = {
    ceoProfile: { antesalaSeenAt: null, antesalaCompletedAt: null, antesalaSkippedAt: null, antesalaProgress: 0 },
    projects: [{ id: 1, name: "P1" }, { id: 2, name: "P2" }],
  };
  // Backfill al primer load post-deploy.
  let d = backfillAntesalaSeenAt(prev, { now: new Date("2026-08-21T09:00:00Z") });
  // Antonio borra todos sus proyectos.
  d = { ...d, projects: [] };
  // Reload → backfill vuelve a correr, pero ahora seenAt ya está.
  d = backfillAntesalaSeenAt(d, { now: new Date("2026-08-22T10:00:00Z") });

  console.log("Caso 14: Antonio borra proyectos tras backfill → NO ve Antesala");
  assert(d.ceoProfile.antesalaSeenAt === "2026-08-21T09:00:00.000Z", "seenAt preservado (idempotente)");
  const guardShown = true && true && (d.projects.length === 0) && !d.ceoProfile.antesalaCompletedAt && !d.ceoProfile.antesalaSkippedAt && !d.ceoProfile.antesalaSeenAt;
  assert(guardShown === false, "guardia evalúa false → Antesala NO se muestra (fix del bug)");
}

if (process.exitCode === 1) {
  console.log("\n=== ANTESALA PERSIST FAIL ===");
  process.exit(1);
}
console.log("\n=== ANTESALA PERSIST OK ===");
console.log("Caso 1:  skipped persiste + marca skippedAt ✓");
console.log("Caso 1b: progressing limpia skippedAt previo ✓");
console.log("Caso 2:  full-answered persiste todo + pendingFronts ✓");
console.log("Caso 3:  completed marca completedAt + limpia buffers ✓");
console.log("Caso 4:  idempotencia — keyFacts y places sin duplicar ✓");
console.log("Caso 5:  sin ownerMemberId degrada silencioso ✓");
console.log("Caso 6:  advisors — solo keys válidas ✓");
console.log("Caso 7:  'none' exclusivo se preserva ✓");
console.log("Caso 8:  extractAntesalaAnswers round-trip ✓");
console.log("Caso 9:  backfill marca seenAt en tenant pre-deploy con proyectos ✓");
console.log("Caso 10: backfill idempotente si seenAt ya está ✓");
console.log("Caso 11: backfill no marca si projects=0 (tenant nuevo) ✓");
console.log("Caso 12: backfill no marca si completedAt ya está ✓");
console.log("Caso 13: welcome+cierra sin responder → Antesala vuelve al reload ✓");
console.log("Caso 14: Antonio borra proyectos post-backfill → guardia bloquea ✓");
