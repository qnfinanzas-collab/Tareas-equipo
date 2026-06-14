import { createClient } from "@supabase/supabase-js";

const URL = import.meta.env.VITE_SUPABASE_URL;
const KEY = import.meta.env.VITE_SUPABASE_KEY;

export const supa = (URL && KEY) ? createClient(URL, KEY) : null;
export const syncEnabled = !!supa;

// Las 3 helpers aceptan tenantId opcional. XOR estricto:
//   tenantId truthy  → camino nuevo por tenant_id (Fase 2 multi-tenant).
//   tenantId null    → camino histórico por id=1 (compat con bundles viejos
//                      y con la fila única pre-multi-tenant).
// Mientras las policies permisivas de taskflow_state estén vivas (modo
// shadow de Fase 2A), ambos caminos devuelven la misma fila para Antonio.
// Tras el flip de Fase 2E (DROP de las permisivas), solo el camino nuevo
// con tenantId resuelto seguirá viendo datos.

let _loggedThisMount = false;

export async function fetchState(tenantId = null){
  if(!supa) return null;
  if (!_loggedThisMount) {
    if (tenantId) console.log(`[sync] tenant resolved: ${tenantId}`);
    else          console.log(`[sync] fallback to id=1 (no tenant resolved)`);
    _loggedThisMount = true;
  }
  const q = supa.from("taskflow_state").select("data");
  const { data, error } = tenantId
    ? await q.eq("tenant_id", tenantId).maybeSingle()
    : await q.eq("id", 1).single();
  if(error){ console.warn("[sync] fetch", error.message); return null; }
  return data?.data || null;
}

let pushTimer = null;
let lastPushAt = 0;
export function pushState(state, tenantId = null){
  if(!supa) return;
  clearTimeout(pushTimer);
  pushTimer = setTimeout(async ()=>{
    lastPushAt = Date.now();
    const base = supa.from("taskflow_state")
      .update({ data: state, updated_at: new Date().toISOString() });
    const { error } = tenantId
      ? await base.eq("tenant_id", tenantId)
      : await base.eq("id", 1);
    if(error) console.warn("[sync] push", error.message);
  }, 400);
}

export function getLastPushAt(){ return lastPushAt; }

export function subscribeState(onChange, tenantId = null){
  if(!supa) return ()=>{};
  const cfg = tenantId
    ? { event: "UPDATE", schema: "public", table: "taskflow_state", filter: `tenant_id=eq.${tenantId}` }
    : { event: "UPDATE", schema: "public", table: "taskflow_state" };
  const ch = supa.channel("taskflow_state_ch")
    .on("postgres_changes", cfg, payload => { onChange(payload.new?.data); })
    .subscribe();
  return ()=>{ supa.removeChannel(ch); };
}
