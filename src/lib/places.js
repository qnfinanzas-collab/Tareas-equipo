// places — aislamiento de "Mis Lugares" por miembro dentro del mismo
// tenant (07/07/2026).
//
// Contexto:
//   Hasta esta fecha, data.places era un array plano tenant-shared y
//   Mis Lugares tenía requiresOwner:true — solo el dueño de la cuenta
//   veía la sección. Al abrirla también a members (Elena, etc.), cada
//   place debe llevar el memberId de su dueño y TODAS las lecturas /
//   escrituras filtran por el memberId activo. El aislamiento es
//   aplicativo (frontend); persistencia sigue siendo tenant-shared.
//
// Diseño mismo patrón que las tareas: `task.assignees:[memberId]` +
// filtro en cada vista. Aquí `place.memberId` + filtro simétrico.

// Devuelve los places que pertenecen al memberId dado. memberId null
// / undefined → array vacío (defensa: nunca devolver places sin
// ownership a nadie).
export function filterMyPlaces(places, memberId) {
  if (!Array.isArray(places)) return [];
  if (memberId == null) return [];
  return places.filter(p => p && p.memberId === memberId);
}

// Busca el índice del place con (name, type, memberId) coincidentes
// dentro de un array crudo (SIN pre-filtrar). Usado por el mutator
// addPlaceToTenant para dedup blando restringido al mismo dueño.
// Comparación: name case-insensitive + trim; type con fallback "otro".
// Devuelve -1 si no hay match.
export function findMyPlaceIndex(places, memberId, name, type) {
  if (!Array.isArray(places)) return -1;
  if (memberId == null) return -1;
  const normName = String(name || "").trim().toLowerCase();
  const normType = String(type || "otro");
  if (!normName) return -1;
  return places.findIndex(p =>
    p && p.memberId === memberId &&
    String(p.name || "").trim().toLowerCase() === normName &&
    (p.type || "otro") === normType
  );
}

// Migración: rellena memberId en places que no lo tengan asignándoles
// el owner del tenant (typically el member con accountRole:"admin").
// Idempotente — places con memberId ya asignado NO se tocan. Devuelve
// un nuevo array (React-friendly) si hubo cambios; si no, el mismo
// array (referencia estable, útil para saltarse setData no-op).
//
// Asunción: hasta el fix del 07/07/2026, solo el owner podía crear
// places (requiresOwner:true en la nav). Por tanto los places sin
// memberId son suyos, no de otros users.
export function backfillPlaceOwnership(places, ownerMemberId) {
  if (!Array.isArray(places)) return places;
  if (ownerMemberId == null) return places;
  let touched = false;
  const out = places.map(p => {
    if (!p || typeof p !== "object") return p;
    if (p.memberId != null) return p;   // ya asignado, respetar
    touched = true;
    return { ...p, memberId: ownerMemberId };
  });
  return touched ? out : places;
}
