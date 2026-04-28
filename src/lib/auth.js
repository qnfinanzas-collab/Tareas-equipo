// Supabase Auth wrapper. Mantiene a la sesión separada del JSONB
// de la app (taskflow_state) — un usuario logueado se resuelve a un
// miembro existente por email. Si Supabase no está configurado,
// authEnabled() devuelve false y el caller cae al user picker legacy.

import { supa } from "./sync.js";

export const authEnabled = () => !!supa;

export async function signIn(email, password){
  if(!supa) throw new Error("Auth no disponible (Supabase no configurado)");
  const { data, error } = await supa.auth.signInWithPassword({ email, password });
  if(error) throw new Error(error.message);
  return data.session;
}

export async function signUp(email, password){
  if(!supa) throw new Error("Auth no disponible (Supabase no configurado)");
  const { data, error } = await supa.auth.signUp({ email, password });
  if(error) throw new Error(error.message);
  return data.session;
}

export async function signOut(){
  if(!supa) return;
  await supa.auth.signOut();
}

export async function getSession(){
  if(!supa) return null;
  const { data } = await supa.auth.getSession();
  return data?.session || null;
}

// Subscribe al cambio de sesión. Devuelve función para desuscribirse.
export function onAuthStateChange(handler){
  if(!supa) return ()=>{};
  const { data } = supa.auth.onAuthStateChange((event, session)=>{
    handler({ event, session });
  });
  return ()=>{ try { data?.subscription?.unsubscribe?.(); } catch {} };
}

// Resuelve la sesión a un miembro del equipo. Match prioritario por
// supabaseUid (el id estable de auth.users — sobrevive a renames de
// email); fallback por email lowercased. Devuelve {member, role} con
// role = "admin" | "member" | null si no está autorizado.
export function resolveSessionMember(session, members){
  const user = session?.user;
  if(!user) return { member: null, role: null };
  const list = members||[];
  // 1) Match por supabaseUid — fuente estable de identidad.
  const byUid = user.id ? list.find(m => m.supabaseUid && m.supabaseUid === user.id) : null;
  if(byUid) return { member: byUid, role: byUid.accountRole || "member" };
  // 2) Fallback por email — útil mientras se hace el binding inicial.
  const email = (user.email||"").toLowerCase().trim();
  if(!email) return { member: null, role: null };
  const byEmail = list.find(m => typeof m.email === "string" && m.email.toLowerCase().trim() === email);
  if(!byEmail) return { member: null, role: null };
  return { member: byEmail, role: byEmail.accountRole || "member" };
}

// Sistema de permisos granulares por feature reutilizable. data.permissions
// es {[memberId]: {[feature]: {view, edit, admin}}}. Admin global de la
// cuenta (accountRole==="admin") tiene acceso total a todos los features
// automáticamente; el resto necesita el flag específico. Niveles
// jerárquicos: admin ⊃ edit ⊃ view (un admin del módulo también puede
// editar y ver). Pasamos `permissions` como argumento para no depender
// de globals — el caller suele tener data.permissions a mano.
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

// Permisos de proyecto. Edit ⊃ View. La edición exige pertenencia explícita
// (owner o miembro). La visibilidad relaja según `project.visibility`:
//   - "private" : solo owner + miembros (lo mismo que canEditProject).
//   - "team"    : visible a cualquier autenticado de la organización.
//   - "public"  : igual que team (placeholder por si en el futuro hay acceso
//                 externo no autenticado — hoy son equivalentes en lectura).
// Admin global (accountRole==="admin") tiene paso libre en ambas.
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
  if (project.visibility === "team")   return true;
  if (project.visibility === "public") return true;
  return false;
}

// Permisos de negociación. Misma semántica que canEditProject/canViewProject:
// edit ⊃ view, "private" exige pertenencia explícita (owner o miembro de la
// negociación), "team"/"public" relajan la visibilidad pero NO la edición.
// Admin global tiene paso libre.
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
  if (deal.visibility === "team")   return true;
  if (deal.visibility === "public") return true;
  return false;
}

// Permisos por agente IA. data.permissions[memberId].agents = {mario:bool,
// jorge:bool, alvaro:bool}. Admin global tiene paso libre. Si no hay entrada,
// el agente no está disponible (falla cerrado).
export function canUseAgent(member, agentKey, permissions = null){
  if (!member) return false;
  if (member.accountRole === "admin") return true;
  if (!permissions || !agentKey) return false;
  const agentPerms = permissions[member.id]?.agents;
  if (!agentPerms) return false;
  return agentPerms[agentKey] === true;
}

// Filtra una lista de agentes a los que el miembro tiene permiso. Cada
// agente debe traer un campo `key` (mario | jorge | alvaro) que mapea con
// data.permissions[member.id].agents[key].
export function getAvailableAgents(member, allAgents, permissions = null){
  if (!member || !Array.isArray(allAgents)) return [];
  return allAgents.filter(a => canUseAgent(member, a.key, permissions));
}
