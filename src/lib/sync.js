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
export function pushState(state){
  if(!supa) return;
  clearTimeout(pushTimer);
  pushTimer = setTimeout(async ()=>{
    lastPushAt = Date.now();
    const { error } = await supa.from("taskflow_state")
      .update({ data: state, updated_at: new Date().toISOString() })
      .eq("id",1);
    if(error) console.warn("[sync] push", error.message);
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
