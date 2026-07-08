// visibility — filtros centralizados de aislamiento intra-tenant por
// member (07/07/2026, incidente Elena veía proyectos/rutas de Antonio).
//
// Contexto:
//   Los datos viven a nivel tenant (data.projects, data.negotiations,
//   data.dayPlans compartidos por todo el equipo). El aislamiento entre
//   users del mismo tenant es aplicativo (frontend). El owner
//   (accountRole:"admin") ve TODO; los members solo ven lo que les han
//   asignado explícitamente (ownership/membership) o lo que crearon
//   ellos mismos.
//
// Estos helpers son puros — testeables en Node sin JSX/React.

import { canViewProject, canViewDeal } from "./permissions.js";

// Devuelve solo los proyectos visibles al member. admin ve todos.
export function filterVisibleProjects(projects, member) {
  if (!Array.isArray(projects)) return [];
  if (!member) return [];
  if (member.accountRole === "admin") return projects.slice();
  return projects.filter(p => canViewProject(member, p));
}

// Devuelve solo las negociaciones visibles al member. admin ve todas.
export function filterVisibleNegotiations(negotiations, member) {
  if (!Array.isArray(negotiations)) return [];
  if (!member) return [];
  if (member.accountRole === "admin") return negotiations.slice();
  return negotiations.filter(n => canViewDeal(member, n));
}

// Rutas persistidas por fecha. El schema es
// { "YYYY-MM-DD": [{id, ruta, sourceUserId, ...}] }.
// Owner ve TODO el mapa; member solo las rutas donde
// sourceUserId === memberId. Devuelve un mapa nuevo (fecha se omite si
// tras filtrar queda vacía, para no ensuciar UI).
export function filterMyDayPlans(dayPlans, memberId, isAdmin = false) {
  if (!dayPlans || typeof dayPlans !== "object") return {};
  if (isAdmin) return dayPlans;
  if (memberId == null) return {};
  const out = {};
  for (const [date, list] of Object.entries(dayPlans)) {
    if (!Array.isArray(list)) continue;
    const mine = list.filter(e => e && e.sourceUserId === memberId);
    if (mine.length > 0) out[date] = mine;
  }
  return out;
}

// Set de ids de proyectos visibles — útil como filtro auxiliar cuando
// una vista necesita tomar decisiones item-a-item (ej. seleccionar
// tareas del prompt del LLM cuya projectId esté en visible).
export function visibleProjectIdSet(projects, member) {
  const visible = filterVisibleProjects(projects, member);
  return new Set(visible.map(p => p && p.id).filter(id => id != null));
}
