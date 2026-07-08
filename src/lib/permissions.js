// permissions — helpers PUROS de autorización, sin dependencia de
// Supabase. Extraídos de auth.js (07/07/2026) para poder testearlos en
// Node en el contexto del blindaje de aislamiento por member.
//
// auth.js sigue exportando estas mismas funciones (re-export) para no
// romper los ~30 imports existentes. Este archivo es la fuente de
// verdad; auth.js las envuelve junto a los flujos que sí dependen de
// Supabase (signIn, signUp, session, etc.).

// Permisos por módulo (features). Jerárquicos: admin ⊃ edit ⊃ view.
export function hasPermission(member, feature, level = "view", permissions = null) {
  if (!member) return false;
  if (member.accountRole === "admin") return true;
  if (!permissions || !feature) return false;
  const memberPerms = permissions[member.id]?.[feature];
  if (!memberPerms) return false;
  if (level === "view")  return !!(memberPerms.view || memberPerms.edit || memberPerms.admin);
  if (level === "edit")  return !!(memberPerms.edit || memberPerms.admin);
  if (level === "admin") return !!memberPerms.admin;
  return false;
}

export function canEditProject(member, project){
  if (!member || !project) return false;
  if (member.accountRole === "admin") return true;
  if (project.ownerId === member.id) return true;
  if (Array.isArray(project.members) && project.members.includes(member.id)) return true;
  return false;
}

export function canViewProject(member, project){
  if (canEditProject(member, project)) return true;
  if (!project) return false;
  // Blindaje El Umbral (07/07/2026): members no-admin NUNCA obtienen
  // acceso via visibility "team"/"public". Solo por ownership.
  if (!member || member.accountRole !== "admin") return false;
  if (project.visibility === "team")   return true;
  if (project.visibility === "public") return true;
  return false;
}

export function canEditDeal(member, deal){
  if (!member || !deal) return false;
  if (member.accountRole === "admin") return true;
  if (deal.ownerId === member.id) return true;
  if (Array.isArray(deal.members) && deal.members.includes(member.id)) return true;
  return false;
}

export function canViewDeal(member, deal){
  if (canEditDeal(member, deal)) return true;
  if (!deal) return false;
  if (!member || member.accountRole !== "admin") return false;
  if (deal.visibility === "team")   return true;
  if (deal.visibility === "public") return true;
  return false;
}

// Set de claves del Consejo (especialistas exclusivos del dueño hoy).
export const COUNCIL_AGENT_KEYS = new Set(["mario","jorge","alvaro","gonzalo","diego"]);

export function canUseAgent(member, agentKey, permissions = null){
  if (!member) return false;
  if (member.accountRole === "admin") return true;
  if (COUNCIL_AGENT_KEYS.has(agentKey)) return false;
  if (!permissions || !agentKey) return false;
  const agentPerms = permissions[member.id]?.agents;
  if (!agentPerms) return false;
  return agentPerms[agentKey] === true;
}

export function isAccountOwner(member, opts = {}) {
  if (opts?.legacyMode) return false;
  if (!member) return false;
  return member.accountRole === "admin";
}

export function getAvailableAgents(member, allAgents, permissions = null){
  if (!member || !Array.isArray(allAgents)) return [];
  return allAgents.filter(a => canUseAgent(member, a.key, permissions));
}
