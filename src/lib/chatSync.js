// Sincronización cross-device del chat de Héctor a Supabase.
// Usado por HectorDirectView (chat directo) y HectorPanel (Sala de
// Mando). Ambas vistas comparten el mismo localStorage key
// `kluxor.hector.chat.${userId}` y, vía esta capa, la misma tabla
// hector_chat en Supabase (una fila por user_id con messages jsonb).
//
// Mensajes con role "hector_analysis" (Sala de Mando) NO se
// sincronizan: viven en hector_panel_state. Si los flushearamos a
// hector_chat se duplicarían al reabrir y romperían la comparación
// por timestamp del load.

import { supa } from "./sync.js";

export const CHAT_MAX = 50;

// Filtra mensajes no sincronizables. hector_analysis vive en otra
// tabla; el resto (user, hector, assistant, specialist, etc.) sí.
function filterSyncableMessages(messages) {
  if (!Array.isArray(messages)) return [];
  return messages.filter(m => m && m.role !== "hector_analysis");
}

// Upsert del chat completo a Supabase. Silencioso si falla — el
// localStorage local sigue siendo la fuente de verdad inmediata.
// Filtra hector_analysis antes de subir para mantener la tabla
// hector_chat limpia.
export async function flushChatToSupabase(authUid, messages) {
  if (!authUid || !supa) return;
  try {
    const safe = filterSyncableMessages(messages).slice(-CHAT_MAX);
    const { error } = await supa.from("hector_chat").upsert({
      user_id: authUid,
      messages: safe,
      updated_at: new Date().toISOString(),
    }, { onConflict: "user_id" });
    if (error) {
      console.warn(`[Kluxor] Chat flush Supabase error: ${error.message}`);
    } else {
      console.log(`[Kluxor] Chat sincronizado a Supabase: ${safe.length} mensajes`);
    }
  } catch (e) {
    console.warn(`[Kluxor] Chat flush threw: ${e?.message || e}`);
  }
}

// Cuando el load decide que "remote gana", mergea con los mensajes
// hector_analysis locales (que no están en remote por el filtro de
// flush) para no perderlos. Ordena por ts ascendente para mantener
// orden cronológico del chat. Si no hay análisis locales, devuelve
// remote tal cual.
export function mergeRemoteWithLocalAnalyses(remote, local) {
  const baseRemote = Array.isArray(remote) ? remote : [];
  const localAnalyses = (Array.isArray(local) ? local : [])
    .filter(m => m && m.role === "hector_analysis");
  if (localAnalyses.length === 0) return baseRemote.slice(-CHAT_MAX);
  return [...baseRemote, ...localAnalyses]
    .sort((a, b) => (a?.ts || 0) - (b?.ts || 0))
    .slice(-CHAT_MAX);
}

// Last timestamp del chat, ignorando hector_analysis. Usado para
// comparar "remote vs local" en el load — el análisis tiene ts del
// updated_at del panel, no del último mensaje del chat, y falsearía
// la comparación si lo incluyéramos.
export function lastChatTimestamp(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m && m.role !== "hector_analysis" && typeof m.ts === "number") {
      return m.ts;
    }
  }
  return 0;
}
