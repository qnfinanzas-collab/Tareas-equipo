// URL routing — Fase 1 (commit MNT-009).
//
// Mapping bidireccional tab id ↔ slug en español. Tabs no listados aquí
// (board/eisenhower/reports/team — sub-vistas internas del proyecto activo)
// NO actualizan URL: cuando el usuario entra a una sub-vista la URL queda
// en /projects, y un F5 lo devuelve a la lista de Proyectos. Phase 2
// añadiría deep linking de project.code y sub-tab.
//
// Excepciones fuera del scope de este módulo:
//   - /vault/<token>     → guest view, captura previa con parseVaultGuestPath
//   - /landing.html      → estático servido por Vercel
//   - #type=recovery&... → flow de recovery de Supabase Auth (lee hash)

export const TAB_TO_SLUG = {
  "hector-direct": "hector",
  "command":       "sala-de-mando",
  "home":          "home",
  "dealroom":      "dealroom",
  "mytasks":       "mytasks",
  "projects":      "projects",
  "finance":       "finance",
  "workspaces":    "workspaces",
  "places":        "places",
  "dashboard":     "dashboard",
  "briefings":     "briefings",
  "memory":        "memory",
  "gobernanza":    "gobernanza",
  "vault":         "vault",
  "users":         "users",
  "mantenimiento": "mantenimiento",
};

export const SLUG_TO_TAB = Object.fromEntries(
  Object.entries(TAB_TO_SLUG).map(([tab, slug]) => [slug, tab])
);

// Resuelve un tab a partir de un pathname. Devuelve null si no matchea
// ningún slug conocido. Solo considera el primer segmento; el resto
// (deep linking) se ignora en Fase 1.
export function tabFromPath(pathname) {
  if (!pathname || typeof pathname !== "string") return null;
  const cleaned = pathname.replace(/^\/+|\/+$/g, "");
  if (!cleaned) return null;
  const first = cleaned.split("/")[0].toLowerCase();
  return SLUG_TO_TAB[first] || null;
}

// Resuelve el slug canónico de un tab. Devuelve null si no tiene
// (caso board/eisenhower/reports/team — sub-vistas del proyecto activo).
export function slugFromTab(tabId) {
  return TAB_TO_SLUG[tabId] || null;
}

// Path canónico de un tab. "/" para tabs sin slug propio.
export function pathFromTab(tabId) {
  const slug = slugFromTab(tabId);
  return slug ? `/${slug}` : "/";
}
