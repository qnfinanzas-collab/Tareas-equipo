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
