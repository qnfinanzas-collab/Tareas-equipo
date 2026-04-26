import { createClient } from "@supabase/supabase-js";

const URL = import.meta.env.VITE_SUPABASE_URL;
const KEY = import.meta.env.VITE_SUPABASE_KEY;

export const supa = (URL && KEY) ? createClient(URL, KEY) : null;
export const syncEnabled = !!supa;

export async function fetchState(){
  if(!supa) return null;
  const { data, error } = await supa.from("taskflow_state").select("data").eq("id",1).single();
  if(error){ console.warn("[sync] fetch", error.message); return null; }
  return data?.data || null;
}

let pushTimer = null;
let lastPushAt = 0;
let onPushResultCb = null;

// Permite a la UI suscribirse al resultado del push: cb(error|null).
// Se llama tras cada flush del debounce — null si OK, Error si fallo.
export function setOnPushResult(cb){ onPushResultCb = cb; }

export function pushState(state){
  if(!supa){ console.warn("[sync] pushState llamado sin Supabase configurado"); return; }
  clearTimeout(pushTimer);
  pushTimer = setTimeout(async ()=>{
    lastPushAt = Date.now();
    try {
      const { error } = await supa.from("taskflow_state")
        .update({ data: state, updated_at: new Date().toISOString() })
        .eq("id",1);
      if(error){
        // ANTES: console.warn silencioso. AHORA: console.error visible
        // en DevTools rojo + callback a la UI para toast persistente.
        // Causa típica: RLS bloqueando UPDATE para usuarios authenticated
        // (faltan policies). Sin esto, cambios locales nunca subían y al
        // recargar la app fetchState devolvía estado viejo → datos perdidos.
        console.error("[sync] push falló:", error.message, error);
        onPushResultCb?.(error);
      } else {
        onPushResultCb?.(null);
      }
    } catch(e){
      console.error("[sync] push lanzó excepción:", e);
      onPushResultCb?.(e instanceof Error ? e : new Error(String(e)));
    }
  }, 400);
}

export function getLastPushAt(){ return lastPushAt; }

export function subscribeState(onChange){
  if(!supa) return ()=>{};
  const ch = supa.channel("taskflow_state_ch")
    .on("postgres_changes",
      { event: "UPDATE", schema: "public", table: "taskflow_state" },
      payload => { onChange(payload.new?.data); })
    .subscribe();
  return ()=>{ supa.removeChannel(ch); };
}
