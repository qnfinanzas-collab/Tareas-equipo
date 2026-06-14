// Resolución user → tenant_id contra Supabase BD.
//
// El portero único es el RPC `current_tenant_id()` definido en producción
// (Fase 2A, 2026-06-14) con SECURITY DEFINER + STABLE. Devuelve el UUID
// del tenant del usuario logueado leyendo `tenants` por owner_uid y
// `tenant_members` por user_uid — las dos tablas viven con RLS estricta
// e invisibles al cliente. El RPC está GRANT a authenticated y REVOKE
// a anon: un cliente sin sesión no puede ni intentar llamarlo (42501).
//
// Cache en memoria por uid: la resolución es estable durante la sesión,
// así que evitamos un round-trip por cada montaje de useEffect. Se limpia
// en logout (clearTenantCache) o cuando cambia el uid.

import { supa } from "./sync.js";

let _cache = { uid: null, tenantId: null };

export async function fetchCurrentTenantId(authUid) {
  if (!authUid || !supa) return null;
  if (_cache.uid === authUid) return _cache.tenantId;
  const { data, error } = await supa.rpc("current_tenant_id");
  if (error) {
    console.warn("[tenants] rpc error:", error.message);
    return null;
  }
  _cache = { uid: authUid, tenantId: data || null };
  return _cache.tenantId;
}

export function clearTenantCache() {
  _cache = { uid: null, tenantId: null };
}
