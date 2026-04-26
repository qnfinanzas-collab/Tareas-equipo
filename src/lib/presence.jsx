// Presencia en tiempo real entre usuarios sobre tareas concretas. Una única
// suscripción por sesión a un canal global (taskflow:presence). Cada usuario
// publica qué tarea tiene abierta y si la está editando. Los componentes
// consumen el mapa derivado presenceByTask para mostrar banners y avatares
// sin ningún backend extra — Supabase Realtime ya está en el stack.
import { createContext, useContext, useEffect, useRef, useState, useCallback } from "react";
import { supa, syncEnabled } from "./sync.js";

const PresenceContext = createContext({
  presenceByTask: {},
  setOpenTask: () => {},
  currentUserId: null,
  enabled: false,
});

export function PresenceProvider({ currentUser, children }) {
  const [presenceByTask, setPresenceByTask] = useState({});
  const channelRef = useRef(null);
  const stateRef = useRef({ openTaskId: null, isEditing: false });

  useEffect(() => {
    if (!syncEnabled || !supa || !currentUser?.id) return;
    const channel = supa.channel("taskflow:presence", {
      config: { presence: { key: String(currentUser.id) } },
    });
    channelRef.current = channel;
    channel.on("presence", { event: "sync" }, () => {
      const state = channel.presenceState();
      const map = {};
      Object.values(state).flat().forEach((u) => {
        if (!u || !u.openTaskId) return;
        if (!map[u.openTaskId]) map[u.openTaskId] = [];
        map[u.openTaskId].push(u);
      });
      setPresenceByTask(map);
    });
    channel.subscribe(async (status) => {
      if (status === "SUBSCRIBED") {
        try {
          await channel.track({
            userId: currentUser.id,
            userName: currentUser.name,
            userInitials: currentUser.initials || "?",
            openTaskId: stateRef.current.openTaskId,
            isEditing: stateRef.current.isEditing,
            ts: new Date().toISOString(),
          });
        } catch (e) {
          console.warn("[presence] track failed:", e?.message);
        }
      }
    });
    return () => {
      try { supa.removeChannel(channel); } catch {}
      channelRef.current = null;
    };
  }, [currentUser?.id, currentUser?.name, currentUser?.initials]);

  const setOpenTask = useCallback((openTaskId, isEditing = false) => {
    stateRef.current = { openTaskId, isEditing };
    const ch = channelRef.current;
    if (!ch || !currentUser?.id) return;
    ch.track({
      userId: currentUser.id,
      userName: currentUser.name,
      userInitials: currentUser.initials || "?",
      openTaskId,
      isEditing,
      ts: new Date().toISOString(),
    }).catch(() => {});
  }, [currentUser?.id, currentUser?.name, currentUser?.initials]);

  return (
    <PresenceContext.Provider value={{
      presenceByTask,
      setOpenTask,
      currentUserId: currentUser?.id ?? null,
      enabled: !!(syncEnabled && supa && currentUser?.id),
    }}>
      {children}
    </PresenceContext.Provider>
  );
}

export function usePresence() { return useContext(PresenceContext); }
