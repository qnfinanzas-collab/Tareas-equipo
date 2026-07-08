// smoke_visibility_isolation — blindaje del aislamiento intra-tenant
// por member (07/07/2026, incidente Elena veía proyectos/rutas de
// Antonio). Cubre helpers puros de src/lib/visibility.js.

import { filterVisibleProjects, filterVisibleNegotiations, filterMyDayPlans, visibleProjectIdSet } from "../../src/lib/visibility.js";
import { canViewProject } from "../../src/lib/permissions.js";

const admin  = { id: 6, name: "Antonio", accountRole: "admin" };
const elena  = { id: 8, name: "Elena",   accountRole: "member" };
const marc   = { id: 5, name: "Marc",    accountRole: "member" };

const proyAntonio     = { id: 100, name: "Marbella Club",       ownerId: 6, members: [6],       visibility: "private" };
const proyIceflow     = { id: 101, name: "Iceflow",             ownerId: 6, members: [6],       visibility: "private" };
const proyElena       = { id: 200, name: "Proyecto de Elena",   ownerId: 8, members: [8],       visibility: "private" };
const proyMixto       = { id: 300, name: "Proyecto compartido", ownerId: 6, members: [6, 8],    visibility: "private" };
const proyLegacyTeam  = { id: 400, name: "Legacy team",         ownerId: 6, members: [6],       visibility: "team" };
const proyLegacyPub   = { id: 401, name: "Legacy public",       ownerId: 6, members: [6],       visibility: "public" };

try {
  // ── Caso 1 — filterVisibleProjects: admin ve todo ──
  const projects = [proyAntonio, proyIceflow, proyElena, proyMixto, proyLegacyTeam, proyLegacyPub];
  const forAdmin = filterVisibleProjects(projects, admin);
  if (forAdmin.length !== 6) throw new Error("Caso1a: admin debería ver todos, recibí " + forAdmin.length);

  // ── Caso 2 — Elena solo ve lo suyo ──
  const forElena = filterVisibleProjects(projects, elena);
  const idsE = forElena.map(p => p.id).sort();
  if (idsE.join(",") !== "200,300") throw new Error("Caso2a: Elena debería ver [proyElena, proyMixto] = [200,300], recibí " + idsE.join(","));
  // ¡Blindaje El Umbral! Legacy visibility "team"/"public" NO le dan acceso.
  if (forElena.some(p => p.visibility === "team")) throw new Error("Caso2b: FUGA — Elena NO debe ver 'team'");
  if (forElena.some(p => p.visibility === "public")) throw new Error("Caso2c: FUGA — Elena NO debe ver 'public'");

  // ── Caso 3 — Marc similar (no owner, no en ningún members) ──
  const forMarc = filterVisibleProjects(projects, marc);
  if (forMarc.length !== 0) throw new Error("Caso3: Marc no debería ver nada, recibí " + forMarc.length);

  // ── Caso 4 — canViewProject directo (regresión blindaje) ──
  if (canViewProject(elena, proyAntonio) !== false) throw new Error("Caso4a: Elena NUNCA debe ver Marbella Club de Antonio");
  if (canViewProject(elena, proyLegacyTeam) !== false) throw new Error("Caso4b: Elena NUNCA debe ver un proyecto legacy 'team' (blindaje)");
  if (canViewProject(elena, proyLegacyPub) !== false) throw new Error("Caso4c: Elena NUNCA debe ver un proyecto legacy 'public' (blindaje)");
  if (canViewProject(admin, proyLegacyTeam) !== true) throw new Error("Caso4d: admin SÍ ve 'team' (paso libre)");
  if (canViewProject(elena, proyElena) !== true) throw new Error("Caso4e: Elena SÍ ve su propio proyecto");
  if (canViewProject(elena, proyMixto) !== true) throw new Error("Caso4f: Elena SÍ ve proyecto donde está en members");

  // ── Caso 5 — filterVisibleNegotiations (misma semántica) ──
  const negs = [
    { id: "n1", ownerId: 6, members: [6],    visibility: "private" },  // solo Antonio
    { id: "n2", ownerId: 6, members: [6, 8], visibility: "private" },  // compartido
    { id: "n3", ownerId: 8, members: [8],    visibility: "private" },  // solo Elena
    { id: "n4", ownerId: 6, members: [6],    visibility: "team" },     // legacy team
  ];
  const negsAdmin = filterVisibleNegotiations(negs, admin);
  if (negsAdmin.length !== 4) throw new Error("Caso5a: admin ve las 4");
  const negsElena = filterVisibleNegotiations(negs, elena);
  const negIdsE = negsElena.map(n => n.id).sort();
  if (negIdsE.join(",") !== "n2,n3") throw new Error("Caso5b: Elena solo n2 y n3, recibí " + negIdsE.join(","));
  if (negsElena.some(n => n.id === "n4")) throw new Error("Caso5c: FUGA — Elena NO debe ver neg legacy 'team'");

  // ── Caso 6 — filterMyDayPlans separa por sourceUserId ──
  const dayPlans = {
    "2026-07-06": [
      { id: "dp1", sourceUserId: 6, ruta: {} },  // Antonio
      { id: "dp2", sourceUserId: 8, ruta: {} },  // Elena
    ],
    "2026-07-07": [
      { id: "dp3", sourceUserId: 8, ruta: {} },  // Elena
    ],
    "2026-07-08": [
      { id: "dp4", sourceUserId: 6, ruta: {} },  // Antonio
    ],
  };
  const dpAdmin = filterMyDayPlans(dayPlans, 6, true);
  if (dpAdmin !== dayPlans) throw new Error("Caso6a: admin recibe el mismo mapa (misma referencia = paso libre)");

  const dpElena = filterMyDayPlans(dayPlans, 8, false);
  if (!dpElena["2026-07-06"]) throw new Error("Caso6b: Elena tiene su ruta del 6");
  if (dpElena["2026-07-06"].length !== 1 || dpElena["2026-07-06"][0].id !== "dp2") throw new Error("Caso6c: Elena solo su ruta dp2 del 6");
  if (!dpElena["2026-07-07"]) throw new Error("Caso6d: Elena tiene su ruta dp3 del 7");
  if ("2026-07-08" in dpElena) throw new Error("Caso6e: fecha con solo rutas de Antonio NO debe aparecer para Elena");

  const dpAntonio = filterMyDayPlans(dayPlans, 6, false);  // no admin mode
  if (dpAntonio["2026-07-06"]?.length !== 1 || dpAntonio["2026-07-06"][0].id !== "dp1") throw new Error("Caso6f: Antonio ve solo dp1 del 6 (modo member)");
  if ("2026-07-07" in dpAntonio) throw new Error("Caso6g: fecha con solo rutas de Elena NO debe aparecer para Antonio en modo member");

  // memberId null → mapa vacío defensivo.
  if (Object.keys(filterMyDayPlans(dayPlans, null, false)).length !== 0) throw new Error("Caso6h: memberId null → {}");

  // ── Caso 7 — visibleProjectIdSet ──
  const setE = visibleProjectIdSet(projects, elena);
  if (setE.size !== 2 || !setE.has(200) || !setE.has(300)) throw new Error("Caso7: Elena's set = {200,300}, recibí " + [...setE].join(","));

  // ── Caso 8 — tolerancia inputs degenerados ──
  if (filterVisibleProjects(null, elena).length !== 0) throw new Error("Caso8a: null projects → []");
  if (filterVisibleProjects(projects, null).length !== 0) throw new Error("Caso8b: null member → []");
  if (Object.keys(filterMyDayPlans(null, 8, false)).length !== 0) throw new Error("Caso8c: null dayPlans → {}");
  if (Object.keys(filterMyDayPlans({}, 8, false)).length !== 0) throw new Error("Caso8d: {} → {}");

  console.log("=== VISIBILITY ISOLATION OK ===");
  console.log("Caso 1: admin (Antonio) ve TODOS los proyectos del tenant ✓");
  console.log("Caso 2: member (Elena) solo ve owner/members; blindaje 'team'/'public' rechaza legacy ✓");
  console.log("Caso 3: member sin ownership NO ve nada ✓");
  console.log("Caso 4: canViewProject blindado — 'team'/'public' NUNCA da acceso a member ✓");
  console.log("Caso 5: filterVisibleNegotiations misma semántica (owner ve todo, member solo owner/members) ✓");
  console.log("Caso 6: filterMyDayPlans — admin paso libre; member solo sourceUserId === memberId ✓");
  console.log("Caso 7: visibleProjectIdSet devuelve set correcto ✓");
  console.log("Caso 8: inputs null/undefined tolerados ✓");
} catch (e) {
  console.log("FAIL:", e.message);
  process.exit(1);
}
