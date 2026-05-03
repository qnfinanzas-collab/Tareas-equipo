// HectorPanel — análisis proactivo + chat bidireccional. Comparte el MISMO
// stack que el resto de la app:
//   • voz: speak() / listen() de lib/voice.js con la config exacta de
//     Héctor (gender:"male", rate:1.1, pitch:0.9). speak() hace
//     pickVoice("male"), getVoicesReady() y exclusión de voces femeninas;
//     listen() encapsula SpeechRecognition con lang es-ES y permisos.
//   • prompt: agent.promptBase + PLAIN_TEXT_RULE + memoria CEO formateada
//     con formatCeoMemoryForPrompt — Héctor "recuerda" entre sesiones.
//   • energía: getEnergyLevel(hour) compartido en lib/agent.js.
//   • persistencia scoped por userId en localStorage:
//       soulbaric.hector.recs.<id>   → últimas 3 recomendaciones
//       soulbaric.hector.chat.<id>   → últimas 50 entradas de chat
//
// Chat bidireccional:
//   - Input + botón enviar + botón micrófono (SpeechRecognition).
//   - sendOrderToHector(text): manda contexto + orden y parsea JSON con
//     {reply, action, taskId} para ejecutar acciones reales sobre tareas.
//   - El "Implementar" en una recomendación dispara también la orden a
//     Héctor para que verbalice la confirmación y ejecute la acción.
import React, { useEffect, useState, useRef } from "react";
import { speak, stopSpeaking, listen } from "../../lib/voice.js";
import { PLAIN_TEXT_RULE, getEnergyLevel, buildSkillsBlock, detectSkills } from "../../lib/agent.js";
import { parseAgentActions, cleanAgentResponse, detectFalseSuccessClaim, rewriteToPropositive, validateTasksAgainstDatabase, validateAndCorrectDueDate } from "../../lib/agentActions.js";
import { supa } from "../../lib/sync.js";
import ActionProposal from "../Shared/ActionProposal.jsx";
import { formatCeoMemoryForPrompt } from "../../lib/memory.js";

const STATE_LABEL = {
  analyzing:   { label: "Analizando…",  bg: "#FEF3C7", fg: "#92400E", border: "#F59E0B" },
  recommending:{ label: "Recomendando", bg: "#DCFCE7", fg: "#065F46", border: "#10B981" },
  listening:   { label: "Escuchando",   bg: "#DBEAFE", fg: "#1E40AF", border: "#3B82F6" },
  paused:      { label: "⏸ Pausado",   bg: "#F3F4F6", fg: "#6B7280", border: "#9CA3AF" },
};

const FIVE_MIN_MS = 5 * 60 * 1000;
const HECTOR_VOICE = { gender: "male", rate: 1.1, pitch: 0.9 };
const CHAT_MAX = 50;

// Mapas de presentación para los chips de skills detectados. Los keys
// coinciden 1:1 con SKILL_TRIGGERS de lib/agent.js.
const SKILL_LABELS = {
  finanzas:   "💰 Finanzas",
  negociador: "🤝 Negociador",
  comercial:  "📈 Ventas",
  analista:   "📊 Analista",
  estratega:  "🎯 Estratega",
  personas:   "👥 Personas",
  legal:      "⚖️ Legal",
  alquileres: "🏠 Vivienda",
  gobernanza: "🏛️ Gobernanza",
};
const SKILL_COLORS = {
  finanzas:   "#27AE60",
  negociador: "#9B59B6",
  comercial:  "#3498DB",
  analista:   "#16A085",
  estratega:  "#E67E22",
  personas:   "#E91E63",
  legal:      "#34495E",
  alquileres: "#E67E22",
  gobernanza: "#8E44AD",
};

const speakRecommendation = (text) => {
  if (typeof window === "undefined" || !window.speechSynthesis) return;
  try { if (localStorage.getItem("hector_muted") === "1") return; } catch {}
  if (!text) return;
  try { speak(text, HECTOR_VOICE); }
  catch (e) { console.warn("[HectorPanel] speak fallo:", e?.message); }
};

// Convierte "HH:MM" (hora local del día actual) a timestamp ms. Si la
// hora ya pasó devuelve null — no tiene sentido bloquear hacia atrás.
// Acepta también valores "h:mm", "9:5", etc.
const parseBlockUntil = (timeStr) => {
  if (!timeStr || typeof timeStr !== "string") return null;
  const m = timeStr.trim().match(/^(\d{1,2}):(\d{1,2})$/);
  if (!m) return null;
  const hours = Number(m[1]);
  const minutes = Number(m[2]);
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return null;
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null;
  const blockDate = new Date();
  blockDate.setHours(hours, minutes, 0, 0);
  if (blockDate.getTime() < Date.now()) return null;
  return blockDate.getTime();
};

// Calcula urgencia REAL en tiempo real para cada tarea pendiente. Devuelve
// objetos enriquecidos con `urgency` legible (VENCIDA HACE N DÍAS / VENCE
// HOY en Xh / VENCE EN N DÍAS) y `daysOverdue` numérico para ordenar. Se
// pasa al LLM para que use el texto pre-calculado en lugar de razonar
// fechas absolutas — evita errores tipo "vence 2024-12-15" cuando hoy es
// 2026 y debería decir "vencida hace 500 días". Misma serialización en
// generateHectorThought y sendOrderToHector.
const buildTasksWithContext = (tasks, now) => {
  const ref = now instanceof Date ? now : new Date();
  const pending = (tasks || []).filter((t) => t.colName !== "Hecho" && t.colName !== "Cancelada" && !t.completed);
  return pending.map((t) => {
    const rawDeadline = t.dueDate || t.deadline;
    const deadline = rawDeadline ? new Date(rawDeadline) : null;
    let urgency = "SIN FECHA";
    let daysOverdue = -1;
    let diffDays = null;
    if (deadline && !isNaN(deadline.getTime())) {
      const diffMs = deadline.getTime() - ref.getTime();
      diffDays = Math.floor(diffMs / 86400000);
      const diffHours = Math.floor(diffMs / 3600000);
      if (diffDays < -1)       urgency = `VENCIDA HACE ${Math.abs(diffDays)} DÍAS`;
      else if (diffDays === -1) urgency = "VENCIDA AYER";
      else if (diffDays === 0 && diffHours < 0) urgency = "VENCIDA HOY";
      else if (diffDays === 0) urgency = `VENCE HOY en ${Math.max(0, diffHours)}h`;
      else if (diffDays === 1) urgency = "VENCE MAÑANA";
      else                     urgency = `VENCE EN ${diffDays} DÍAS`;
      daysOverdue = diffDays < 0 ? Math.abs(diffDays) : 0;
    }
    // Resolver assignee: el modelo de tareas tiene assignees:[memberId] y
    // members:[{id,name}] — preferir el nombre si tasksRef trae snapshot
    // enriquecido (assigneeName), si no devolver el primer ID o null.
    const assignedTo = t.assigneeName
      || (Array.isArray(t.assigneeNames) && t.assigneeNames[0])
      || (typeof t.assignedTo === "string" ? t.assignedTo : null)
      || (t.assignedTo && t.assignedTo.name)
      || null;
    // Resolver "board" en el orden que el modelo de datos lo expone:
    // - projName (enriquecido en App.jsx para tareas de myTasks/myActive)
    // - project.name si vino como objeto
    // - project como string suelto
    // colName queda como detalle adicional (columna del kanban dentro del
    // board), no se usa como board principal.
    const boardName = t.projName
      || (t.project && (t.project.name || (typeof t.project === "string" ? t.project : "")))
      || "";
    return {
      id: t.id,
      ref: t.ref || null,         // canon SHM-001 — antes se perdía aquí
      title: t.title,
      project: boardName,
      projCode: t.projCode || null,
      priority: t.priority || "media",
      urgency,
      daysOverdue,
      diffDays,
      startDate: t.startDate || null,
      dueDate: t.dueDate || null,
      assignedTo,
      deadlineRaw: deadline && !isNaN(deadline.getTime()) ? deadline.toLocaleDateString("es-ES") : null,
      colName: t.colName || null,
    };
  }).sort((a, b) => {
    // Vencidas primero (mayor retraso arriba), luego por días hasta vencer.
    if (a.daysOverdue !== b.daysOverdue) return b.daysOverdue - a.daysOverdue;
    const da = a.diffDays === null ? 9999 : a.diffDays;
    const db = b.diffDays === null ? 9999 : b.diffDays;
    return da - db;
  });
};

// Pipeline tolerante para el JSON de generateHectorThought. Recibe el
// texto crudo de la respuesta y devuelve el objeto decision o null.
// Maneja: fences markdown, prosa antes del JSON, bloque [ACTIONS] residual
// y truncamiento por max_tokens (intenta cerrar arrays/objetos abiertos).
function parseHectorDecision(text) {
  if (!text || typeof text !== "string") return null;
  // 1. Strip [ACTIONS]
  let t = text.replace(/\[ACTIONS\][\s\S]*?\[\/ACTIONS\]/g, "");
  // 2. Strip fences markdown
  t = t.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  // 3. Recortar desde el primer { (ignora prosa anterior)
  const firstBrace = t.indexOf("{");
  if (firstBrace < 0) return null;
  let candidate = t.slice(firstBrace);
  // 4. Recortar tras el último } completo si hay prosa después
  const lastBrace = candidate.lastIndexOf("}");
  if (lastBrace > 0) candidate = candidate.slice(0, lastBrace + 1);
  // 5. Intento normal
  try { return JSON.parse(candidate); } catch (e1) {
    // 6. Reparación de truncamiento: contar paréntesis abiertos
    //    y cerrarlos. Si la última coma deja un elemento incompleto,
    //    quitamos hasta la última coma o el último elemento parseado.
    try {
      let repaired = candidate;
      // Eliminar elemento incompleto al final: cortar tras la última } o ]
      // que aparezca seguida de coma o nada significativo.
      // Estrategia: ir cerrando hasta que JSON.parse pase.
      // Primero: si termina en coma + texto inacabado, recortar a la última , bien formada.
      // Quitamos cualquier sufijo después de la última } o ] que no sea cierre válido.
      // Intentos sucesivos: cerrar arrays y objetos abiertos.
      for (let attempt = 0; attempt < 8; attempt++) {
        // Quitar coma final que pueda dejar elemento abierto
        repaired = repaired.replace(/,\s*$/, "");
        // Cerrar lo que falte
        const opens = (repaired.match(/[\[{]/g) || []).length;
        const closes = (repaired.match(/[\]}]/g) || []).length;
        const diff = opens - closes;
        if (diff <= 0) break;
        // Heurística: cerrar siempre con } o ] según el último abierto sin cerrar
        let suffix = "";
        const stack = [];
        for (const ch of repaired) {
          if (ch === "{" || ch === "[") stack.push(ch);
          else if (ch === "}") { if (stack[stack.length-1] === "{") stack.pop(); }
          else if (ch === "]") { if (stack[stack.length-1] === "[") stack.pop(); }
        }
        while (stack.length) {
          const c = stack.pop();
          suffix += (c === "{" ? "}" : "]");
        }
        repaired = repaired + suffix;
        try { return JSON.parse(repaired); } catch {}
        // Si sigue fallando, recortar el último valor inacabado y reintentar
        const lastValidComma = repaired.lastIndexOf(",");
        const lastValidBrace = Math.max(repaired.lastIndexOf("}"), repaired.lastIndexOf("]"));
        if (lastValidBrace > lastValidComma) break; // ya no podemos recortar más
        repaired = repaired.slice(0, lastValidComma);
      }
    } catch {}
    return null;
  }
}

export default function HectorPanel({
  tasks = [],
  currentFocus = null,
  riesgos = [],
  agent,
  ceoMemory,
  onRecommendationClick,
  onStateChange,
  onNewRecommendation,
  // Acciones sobre tareas — suben a App.jsx para mutar el board real.
  onCompleteTask,
  onPostponeTask,
  onAssignTask,
  onArchiveTask,
  onOpenTask,
  userId,
  userName,
  // UUID del usuario en Supabase Auth (auth.uid()). Necesario para
  // queries con RLS user_id = auth.uid() en hector_panel_state y
  // ceo_memory. Si null (modo legacy/demo), persistencia BD desactivada.
  authUid = null,
  // Proyectos no archivados, para contar "frentes activos" en SaludoCard.
  projects = [],
  // Callback para navegar a otras vistas desde HectorPanel (ej. CTA
  // "Hablar con Héctor sobre esto" en FocoCard → vista hector-direct).
  // Firma: (tabKey: string) => void. Si no se pasa, el CTA queda
  // inactivo (visualmente igual pero sin onClick efectivo).
  onNavigate,
  // Contexto financiero opcional. Si llega, se inyecta en el prompt para
  // que Héctor pondere recomendaciones según runway y caja disponible.
  financeContext,
  // Alertas de vencimiento del Vault personal (DNI, pasaporte, ITV, seguros).
  // Si llegan, Héctor las cita en su análisis para recordar al CEO que
  // renueve documentos antes de que caduquen.
  vaultAlerts = [],
  // Callback para ejecutar acciones propuestas por Héctor (crear proyecto,
  // tareas, negociación, movimiento). Firma: (selectedActions) => Promise.
  // Si no se pasa, los bloques [ACTIONS] no se mostrarán en el chat.
  onRunAgentActions,
  // Callback para publicar entradas de IA en el timeline de una tarea.
  // Disparado al recomendar tareas críticas y al ejecutar acciones desde
  // las cards (complete/postpone/view). Firma: (taskId, entry).
  onAddTimelineEntry,
}) {
  const STORAGE_KEY = `soulbaric.hector.recs.${userId ?? "anon"}`;
  const CHAT_KEY = `soulbaric.hector.chat.${userId ?? "anon"}`;
  const SESSION_KEY = `soulbaric.hector.session.${userId ?? "anon"}`;

  const [hectorState, setHectorState] = useState("listening");
  const [currentThought, setCurrentThought] = useState("");
  // Timestamp del último análisis guardado en Supabase. Se muestra en el
  // PanelHeader como "Actualizado a las HH:MM". Null si nunca se ha
  // generado/cargado un análisis (estado primera-vez del CEO).
  const [lastUpdatedAt, setLastUpdatedAt] = useState(null);
  // Flag local para el spinner del botón ACTUALIZAR del PanelHeader.
  // Distinto de hectorState (que también puede pasar a "thinking" desde
  // la generación automática inicial); este es solo para feedback UI
  // del click manual del CEO.
  const [refreshLoading, setRefreshLoading] = useState(false);
  // Foco del momento (commit 4 — FocoCard con override CEO).
  // - focoTexto: el texto del foco actualmente mostrado.
  // - focoSource: "hector" cuando lo decide el modelo, "ceo" cuando el
  //   propio Antonio lo fija manualmente vía el icono ✏️.
  // - focoLocked: true bloquea futuras sobrescrituras de generateHector
  //   Thought; el foco solo cambia si el CEO pulsa "Liberar foco".
  // - focoEditing: estado UI para mostrar input editable inline.
  // - focoEditValue: valor temporal del input mientras se edita.
  const [focoTexto, setFocoTexto] = useState("");
  const [focoSource, setFocoSource] = useState("hector");
  const [focoLocked, setFocoLocked] = useState(false);
  const [focoEditing, setFocoEditing] = useState(false);
  const [focoEditValue, setFocoEditValue] = useState("");
  const [recommendations, setRecommendations] = useState(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed?.recommendations) ? parsed.recommendations.slice(0, 3) : [];
    } catch { return []; }
  });
  const [chatHistory, setChatHistory] = useState(() => {
    // Si userId todavía no está hidratado (auth cargando) no leemos
    // localStorage — la clave caería a "soulbaric.hector.chat.anon" y nos
    // quedaríamos pegados a esa clave aunque userId se defina después.
    // El useEffect [userId] de abajo se encarga de re-hidratar cuando ya
    // tenemos un userId real.
    if (!userId) return [];
    try {
      const raw = localStorage.getItem(CHAT_KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.slice(-CHAT_MAX) : [];
    } catch { return []; }
  });
  // sessionMemory: estado runtime que sobrevive reloads. blockedTasks
  // contiene { taskId, blockReason, blockUntil(ts|null), followUpAt(ts|null),
  // followUpDone(bool), ts }.
  const [sessionMemory, setSessionMemory] = useState(() => {
    try {
      const raw = localStorage.getItem(SESSION_KEY);
      if (!raw) return { blockedTasks: [] };
      const parsed = JSON.parse(raw);
      return {
        blockedTasks: Array.isArray(parsed?.blockedTasks) ? parsed.blockedTasks : [],
      };
    } catch { return { blockedTasks: [] }; }
  });
  const [inputMessage, setInputMessage] = useState("");
  const [isListening, setIsListening] = useState(false);
  // Texto interim del dictado (lo que el usuario está diciendo ahora).
  // Se muestra como preview en cursiva debajo del input. NO se acumula
  // hasta que el reconocedor lo marca como final.
  const [interimText, setInterimText] = useState("");
  // Contador de auto-reintentos del reconocedor cuando se corta sin que
  // el usuario haya pulsado stop. Evita loops infinitos si el navegador
  // rechaza la sesión (max 3 intentos por sesión activa).
  const listenRetryRef = useRef(0);
  // Refleja la INTENCIÓN del usuario de seguir dictando. Necesario
  // porque el closure del onEnd no ve el state actualizado de
  // isListening — usamos este ref para decidir si auto-reabrir.
  const wantsListeningRef = useRef(false);
  const [chatLoading, setChatLoading] = useState(false);
  const [isThinking, setIsThinking] = useState(false);
  const [thoughtFlash, setThoughtFlash] = useState(0);
  const [muted, setMuted] = useState(() => {
    try { return localStorage.getItem("hector_muted") === "1"; } catch { return false; }
  });
  // Tab activo + contador de no-leídos para el badge "💬 Chat X".
  // Cuando el usuario entra en el tab Chat, sincronizamos lastSeenChatLength
  // con chatHistory.length → unread vuelve a 0. Se persiste solo en memoria.
  const [activeTab, setActiveTab] = useState("analysis");
  const [activeSkills, setActiveSkills] = useState([]);
  const [lastSeenChatLength, setLastSeenChatLength] = useState(() => {
    try {
      const raw = localStorage.getItem(CHAT_KEY);
      const parsed = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed.length : 0;
    } catch { return 0; }
  });

  // Refs para el contexto siempre fresco sin reinstalar el interval.
  const tasksRef = useRef(tasks);
  const riesgosRef = useRef(riesgos);
  const focusRef = useRef(currentFocus);
  const agentRef = useRef(agent);
  const memoryRef = useRef(ceoMemory);
  const chatHistoryRef = useRef(chatHistory);
  const recommendationsRef = useRef(recommendations);
  const sessionRef = useRef(sessionMemory);
  const vaultAlertsRef = useRef([]);
  const financeRef = useRef(financeContext);
  tasksRef.current = tasks;
  riesgosRef.current = riesgos;
  focusRef.current = currentFocus;
  agentRef.current = agent;
  memoryRef.current = ceoMemory;
  chatHistoryRef.current = chatHistory;
  recommendationsRef.current = recommendations;
  sessionRef.current = sessionMemory;
  financeRef.current = financeContext;
  vaultAlertsRef.current = vaultAlerts;

  // Guards anti-bucle (proactive thought)
  const lastCallTime = useRef(0);
  const isGenerating = useRef(false);
  const lastRecTitleRef = useRef("");
  const cancelledRef = useRef(false);
  const stopListenRef = useRef(null);
  const chatScrollRef = useRef(null);
  // Botón flotante "↓ Ir al final" — aparece cuando el CEO ha hecho scroll
  // arriba en una conversación larga y desaparece cerca del fondo. Sin
  // tocar lógica del chat, solo presentación.
  const [showScrollBtn, setShowScrollBtn] = useState(false);
  // Banner urgente colapsable (móvil ≤768px). Cuenta riesgos críticos del
  // prop existente. Empieza colapsado para no robar espacio del chat.
  const [urgentExpanded, setUrgentExpanded] = useState(false);
  const chatEndRef = useRef(null);

  // Persistencia: recomendaciones
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        recommendations,
        lastRecTitle: lastRecTitleRef.current,
        ts: Date.now(),
      }));
    } catch {}
  }, [recommendations, STORAGE_KEY]);

  // Persistencia: chat (últimos CHAT_MAX). Guard contra userId indefinido
  // — sin él la clave colapsa a "soulbaric.hector.chat.anon" y pisaríamos
  // chats de sesiones futuras o perderíamos el state real al recargar.
  useEffect(() => {
    if (!userId) return;
    try {
      localStorage.setItem(CHAT_KEY, JSON.stringify(chatHistory.slice(-CHAT_MAX)));
    } catch {}
  }, [chatHistory, CHAT_KEY, userId]);

  // Re-hidratación cuando userId pasa de undefined → definido. Esto cubre
  // el caso del primer mount con auth todavía cargando: el useState
  // inicial devolvió [] sin tocar localStorage; cuando ya tenemos userId
  // real, leemos la clave correcta y restauramos la conversación. El
  // efecto solo dispara cuando userId cambia (no en cada render).
  useEffect(() => {
    if (!userId) return;
    try {
      const raw = localStorage.getItem(CHAT_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed) || parsed.length === 0) return;
      // Solo reemplazamos si lo persistido es más rico que el state actual
      // — evita pisar mensajes recién añadidos durante el render previo.
      setChatHistory(prev => prev.length === 0 ? parsed.slice(-CHAT_MAX) : prev);
    } catch {}
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId]);

  // Persistencia: sessionMemory (bloqueos activos del día).
  useEffect(() => {
    try {
      localStorage.setItem(SESSION_KEY, JSON.stringify(sessionMemory));
    } catch {}
  }, [sessionMemory, SESSION_KEY]);

  // Helpers para mutar sessionMemory.blockedTasks
  const addBlockedTask = (entry) => {
    setSessionMemory((prev) => ({
      ...prev,
      blockedTasks: [
        ...prev.blockedTasks.filter((b) => b.taskId !== entry.taskId),
        entry,
      ],
    }));
  };
  const removeBlockedTask = (taskId) => {
    setSessionMemory((prev) => ({
      ...prev,
      blockedTasks: prev.blockedTasks.filter((b) => b.taskId !== taskId),
    }));
  };
  const markFollowUpDone = (taskId) => {
    setSessionMemory((prev) => ({
      ...prev,
      blockedTasks: prev.blockedTasks.map((b) => b.taskId === taskId ? { ...b, followUpDone: true } : b),
    }));
  };

  // Devuelve los taskIds activamente bloqueados (blockUntil null o futuro).
  const computeBlockedTaskIds = () => {
    const now = Date.now();
    return (sessionRef.current?.blockedTasks || [])
      .filter((b) => !b.blockUntil || now < b.blockUntil)
      .map((b) => b.taskId);
  };

  // Follow-up automático: revisa cada minuto si algún bloqueo cumple su
  // followUpAt y si todavía no se notificó. Cuando dispara, inyecta un
  // mensaje de Héctor en el chat con la opción de cerrar/reactivar la
  // tarea, y lee la pregunta en voz alta. Marca followUpDone=true.
  useEffect(() => {
    const checkFollowUps = () => {
      const now = Date.now();
      const sess = sessionRef.current || { blockedTasks: [] };
      sess.blockedTasks.forEach((b) => {
        if (!b.followUpAt || b.followUpDone) return;
        if (now < b.followUpAt) return;
        const tasksList = tasksRef.current || [];
        const task = tasksList.find((t) => String(t.id) === String(b.taskId));
        const taskTitle = task?.title || b.blockReason || "esa gestión";
        setChatHistory((prev) => [...prev, {
          role: "hector",
          isFollowUp: true,
          taskId: b.taskId,
          text: `¿Cómo fue la gestión de "${taskTitle}"? ¿Quedó cerrado o necesita acción?`,
          ts: Date.now(),
        }].slice(-CHAT_MAX));
        speakRecommendation("¿Cómo fue la gestión? ¿Quedó cerrado o necesita acción?");
        markFollowUpDone(b.taskId);
      });
    };
    checkFollowUps();
    const id = setInterval(checkFollowUps, 60 * 1000);
    return () => clearInterval(id);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Auto-scroll al último mensaje cuando hay actividad en el chat. Usa un
  // sentinel al final de la lista — el contenedor con overflow:auto está
  // varios niveles arriba y se remonta al cambiar de tab, así que
  // scrollIntoView en el sentinel es la forma más fiable. behavior:smooth
  // para que el CEO vea la transición y no aparezca de golpe al fondo.
  useEffect(() => {
    if (activeTab !== "chat") return;
    const el = chatEndRef.current;
    if (!el) return;
    requestAnimationFrame(() => {
      try { el.scrollIntoView({ behavior: "smooth", block: "end" }); } catch {}
    });
  }, [activeTab, chatHistory.length, chatLoading]);

  // Handler de scroll del contenedor del chat — controla si mostramos el
  // botón flotante "Ir al final". Solo activo cuando el usuario está a
  // más de 200px del fondo. Sin animar el state para que React no
  // re-renderice en cada pixel del scroll: el threshold actúa de filtro.
  const handleChatScroll = (e) => {
    if (activeTab !== "chat") return;
    const el = e.currentTarget;
    const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    const shouldShow = distFromBottom > 200;
    setShowScrollBtn(prev => prev === shouldShow ? prev : shouldShow);
  };

  const setState = (s) => { setHectorState(s); onStateChange?.(s); };

  // ── Persistencia Supabase (commit 3 — Sala de Mando v2) ──────────
  // Carga el último estado del panel desde la tabla hector_panel_state.
  // Devuelve la fila si existe, null si no. Hidrata chatHistory con el
  // último análisis (rol "hector_analysis") para que el CEO vea su
  // sesión anterior al abrir Sala de Mando.
  const loadPanelState = async () => {
    if (!supa || !authUid) return null;
    try {
      const { data, error } = await supa
        .from("hector_panel_state")
        .select("*")
        .eq("user_id", authUid)
        .maybeSingle();
      if (error) {
        console.warn("[HectorPanel] loadPanelState error:", error.message);
        return null;
      }
      if (!data) return null;
      // Hidratar el chat con el análisis previo si existe.
      let parsedAnalysis = null;
      if (data.hector_analysis) {
        try {
          parsedAnalysis = JSON.parse(data.hector_analysis);
          const analysisMsg = {
            role: "hector_analysis",
            analysis: parsedAnalysis,
            ts: data.updated_at ? Date.parse(data.updated_at) : Date.now(),
          };
          setChatHistory((prev) => [...prev, analysisMsg].slice(-CHAT_MAX));
          if (parsedAnalysis.thought || parsedAnalysis.summary) {
            setCurrentThought(parsedAnalysis.thought || parsedAnalysis.summary || "");
          }
        } catch (e) {
          console.warn("[HectorPanel] análisis JSON corrupto:", e?.message);
        }
      }
      // Foco (commit 4): hidratar los tres campos. Si foco_texto es null
      // pero hay analysis con thought, usamos thought como fallback —
      // el commit 3 no guardaba foco_texto separado (siempre derivaba),
      // así que filas creadas antes de v4 pueden tener foco_texto vacío.
      const fTexto = (data.foco_texto && String(data.foco_texto).trim())
        || (parsedAnalysis?.thought)
        || (parsedAnalysis?.summary)
        || "";
      const fSource = data.foco_source === "ceo" ? "ceo" : "hector";
      const fLocked = !!data.foco_locked;
      setFocoTexto(fTexto);
      setFocoSource(fSource);
      setFocoLocked(fLocked);
      if (data.updated_at) setLastUpdatedAt(data.updated_at);
      return data;
    } catch (e) {
      console.warn("[HectorPanel] loadPanelState exception:", e?.message);
      return null;
    }
  };

  // Persiste estado del panel vía UPSERT con onConflict en user_id
  // (UNIQUE en la tabla — una fila por CEO). Dos firmas:
  //   savePanelState(analysis)               → guarda análisis + foco
  //                                            actuales del state.
  //   savePanelState(analysis, overrides)    → guarda con overrides
  //                                            de focoTexto/Source/Locked
  //                                            (útil cuando setFocoX se
  //                                            acaba de llamar y el
  //                                            state aún no se ha re-
  //                                            renderizado).
  //   savePanelState(null, overrides)        → guarda solo foco, sin
  //                                            tocar hector_analysis
  //                                            (útil al editar/liberar
  //                                            el foco sin nuevo análisis).
  const savePanelState = async (analysis, overrides = null) => {
    if (!supa || !authUid) return;
    try {
      const nowIso = new Date().toISOString();
      const fTexto  = overrides?.focoTexto  ?? focoTexto;
      const fSource = overrides?.focoSource ?? focoSource;
      const fLocked = overrides?.focoLocked ?? focoLocked;
      const payload = {
        user_id: authUid,
        saludo: null,
        foco_texto: (fTexto || "").slice(0, 1000) || null,
        foco_source: fSource,
        foco_locked: fLocked,
        negociaciones_snapshot: null,
        updated_at: nowIso,
      };
      // Solo escribimos hector_analysis si tenemos uno nuevo. Si analysis
      // es null preservamos el campo (no lo enviamos para que el upsert
      // mantenga el valor existente en la fila).
      if (analysis) {
        payload.hector_analysis = JSON.stringify(analysis);
      }
      const { error } = await supa
        .from("hector_panel_state")
        .upsert(payload, { onConflict: "user_id" });
      if (error) {
        console.warn("[HectorPanel] savePanelState error:", error.message);
        return;
      }
      setLastUpdatedAt(nowIso);
    } catch (e) {
      console.warn("[HectorPanel] savePanelState exception:", e?.message);
    }
  };

  // Handlers de FocoCard (commit 4 — override del CEO).
  // ----------------------------------------------------
  // Iniciar edición: copiamos el foco actual al input y entramos en
  // modo editing. El render condicional muestra <input> en lugar del
  // texto + botón ✏️ desaparece hasta confirmar/cancelar.
  const handleStartEditFoco = () => {
    setFocoEditValue(focoTexto || "");
    setFocoEditing(true);
  };
  const handleCancelEditFoco = () => {
    setFocoEditing(false);
    setFocoEditValue("");
  };
  // Confirmar: trim + guard de vacío. Pasa source="ceo" + locked=true
  // para que el siguiente generateHectorThought NO sobreescriba.
  // Persistimos solo el foco (analysis=null) — no regeneramos análisis.
  const handleSaveFoco = () => {
    const trimmed = (focoEditValue || "").trim();
    if (!trimmed) { handleCancelEditFoco(); return; }
    setFocoTexto(trimmed);
    setFocoSource("ceo");
    setFocoLocked(true);
    setFocoEditing(false);
    setFocoEditValue("");
    savePanelState(null, { focoTexto: trimmed, focoSource: "ceo", focoLocked: true });
  };
  // Liberar: vuelve a foco automático del análisis. Buscamos el último
  // mensaje "hector_analysis" en chatHistoryRef para extraer thought/
  // summary; si no hay, vaciamos el foco. source="hector", locked=false.
  // Próximo generateHectorThought lo sobreescribirá libremente.
  const handleReleaseFoco = () => {
    const hist = chatHistoryRef.current || [];
    let lastA = null;
    for (let i = hist.length - 1; i >= 0; i--) {
      const m = hist[i];
      if (m && m.role === "hector_analysis" && m.analysis) { lastA = m.analysis; break; }
    }
    const analysisFoco = (lastA?.thought || lastA?.summary || "").trim();
    setFocoTexto(analysisFoco);
    setFocoSource("hector");
    setFocoLocked(false);
    savePanelState(null, { focoTexto: analysisFoco, focoSource: "hector", focoLocked: false });
  };

  const generateHectorThought = async () => {
    if (typeof document !== "undefined" && document.hidden) return;
    if (isGenerating.current) return;
    if (Date.now() - lastCallTime.current < FIVE_MIN_MS) return;
    isGenerating.current = true;
    lastCallTime.current = Date.now();
    setIsThinking(true);
    setState("analyzing");
    try {
      const tasksNow = tasksRef.current || [];
      const riesgosNow = riesgosRef.current || [];
      const focusNow = focusRef.current;
      const ag = agentRef.current;
      const mem = memoryRef.current;
      const now = new Date();
      const energyLevel = getEnergyLevel(now.getHours());
      // Filtra tareas que el CEO bloqueó hasta una hora futura — Héctor
      // no debe recomendarlas hasta que el bloqueo expire.
      const blockedIds = new Set(computeBlockedTaskIds().map(String));
      const tasksWithContext = buildTasksWithContext(tasksNow, now)
        .filter((t) => !blockedIds.has(String(t.id)));
      const top3 = tasksWithContext.slice(0, 3);
      const criticalRisks = riesgosNow.filter((r) => r.level === "critical");

      // En el análisis automático NO queremos el bloque CAPACIDAD DE
      // EJECUCIÓN (que enseña a Héctor a emitir [ACTIONS]). Esta llamada
      // pide JSON estricto y las acciones no aplican aquí — además
      // pesaba +600 tokens en el prompt sin valor.
      const promptBaseNoActions = (ag?.promptBase || "").split(/\n+CAPACIDAD DE EJECUCIÓN/)[0];
      const baseSystem = promptBaseNoActions
        ? promptBaseNoActions + "\n\n" + PLAIN_TEXT_RULE
        : "Eres Héctor, Chief of Staff estratégico. Conciso, directo, accionable. " + PLAIN_TEXT_RULE;
      const memBlock = formatCeoMemoryForPrompt(mem);
      // Detecta skills relevantes a partir de títulos de tareas activas,
      // foco actual y riesgos — Héctor "carga" el framework adecuado para
      // este análisis (finanzas, comercial, etc.) sin tener que generalizar.
      const skillsSignal = [
        focusNow?.title,
        ...(tasksWithContext.slice(0, 10).map((t) => t.title)),
        ...(riesgosNow.slice(0, 5).map((r) => r.title || r.label || r.msg || "")),
      ].filter(Boolean).join(" | ");
      const skillsBlock = buildSkillsBlock(skillsSignal);
      // Refleja en UI los expertos detectados — chips visibles para el CEO.
      setActiveSkills(detectSkills(skillsSignal));
      const system = baseSystem
        + (memBlock ? ("\n\n---\n" + memBlock) : "")
        + skillsBlock
        + "\n\nIMPORTANTE: en este turno responde ÚNICAMENTE con JSON válido sin markdown ni prosa. USA EL CAMPO \"urgency\" tal cual viene calculado — NO recalcules fechas absolutas y NO menciones la fecha cruda; siempre habla en términos relativos al momento actual.";

      // Lista enriquecida — Héctor recibe id, ref, título, proyecto, fechas
      // ISO, prioridad, asignado y la urgency PRE-CALCULADA. Le pedimos que
      // copie estos campos tal cual al JSON de respuesta.
      const tasksForPrompt = tasksWithContext.slice(0, 20).map((t) => ({
        taskId: t.id,
        ref: t.ref || null,                      // p.ej. "SHM-001"
        title: t.title,
        board: t.project || "(sin proyecto)",     // p.ej. "Inversores"
        projCode: t.projCode || null,             // p.ej. "INV"
        priority: t.priority,
        urgency: t.urgency,
        daysOverdue: t.daysOverdue,
        startDate: t.startDate,
        dueDate: t.dueDate,
        assignedTo: t.assignedTo,
      }));
      // Bloque financiero opcional: solo se incluye si el caller pasa
      // financeContext. Las cifras se formatean en EUR español dentro del
      // prompt para que Héctor las cite literales sin recálculo.
      const fin = financeRef.current;
      const vAlerts = vaultAlertsRef.current || [];
      const vaultBlock = vAlerts.length > 0 ? `\nDOCUMENTOS PERSONALES CON VENCIMIENTO PRÓXIMO:\n${vAlerts.slice(0, 8).map(a => `- ${a.doc} de ${a.spaceName}: ${a.type === "overdue" ? `VENCIDO hace ${a.days} días` : `vence en ${a.days} días`}`).join("\n")}\n\nMenciónalos en el análisis si están a punto de caducar (DNI, pasaporte, ITV, seguros) — el CEO debe renovarlos antes de la fecha.\n` : "";
      const fmtEur = (n)=> typeof n==="number" ? new Intl.NumberFormat("es-ES",{style:"currency",currency:"EUR",maximumFractionDigits:0}).format(n) : "—";
      const finBlock = fin ? `\nCONTEXTO FINANCIERO ACTUAL:
- Saldo: ${fmtEur(fin.currentBalance)}
- Burn rate mensual: ${fmtEur(fin.monthlyBurnRate)}
- Runway estimado: ${fin.runway==null?"sin datos":(typeof fin.runway==="number"?fin.runway.toFixed(1)+" meses":fin.runway)}
- Ingresos pendientes de cobro: ${fmtEur(fin.pendingIncome)}
- Gastos pendientes de pago: ${fmtEur(fin.upcomingExpenses)}

Considera estos datos en tus recomendaciones:
- Si runway < 3 meses → prioriza acciones que generen ingresos.
- Si hay ingresos pendientes significativos → recomienda gestión de cobro.
- Si gastos pendientes > saldo → alerta de tesorería.
` : "";

      const userPrompt = `Hora: ${now.toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit" })}.
Día: ${now.toLocaleDateString("es-ES", { weekday: "long" })} (${now.toLocaleDateString("es-ES")}).
Energía esperada del CEO: ${energyLevel}.
Tarea en foco: ${focusNow?.title || "Ninguna"}.
Tareas pendientes: ${tasksWithContext.length}.
Riesgos críticos: ${criticalRisks.length}.
${finBlock}
${vaultBlock}
TAREAS DISPONIBLES (JSON — copia taskId, ref, title, board y urgency TAL CUAL):
${JSON.stringify(tasksForPrompt)}

Riesgos activos:
${riesgosNow.slice(0, 5).map((r) => `- ${r.title || r.label || r.msg || ""}`).join("\n") || "(ninguno)"}

Devuelve JSON ESTRUCTURADO con esta forma exacta (sin markdown, sin prosa fuera del JSON):
{
  "thought": "resumen en 1 línea de qué estás analizando ahora",
  "tasks": [
    {
      "taskId": "<id real de la tarea de la lista>",
      "ref": "<código tipo SHM-003 si lo da la lista>",
      "title": "<título exacto>",
      "board": "<nombre del proyecto>",
      "urgency": "<copia el campo urgency tal cual>",
      "urgencyLevel": "critical|high|medium",
      "action": "frase imperativa de 1 línea de qué hacer",
      "timeframe": "ahora|hoy|esta semana",
      "startDate": "<copia startDate de la lista>",
      "dueDate": "<copia dueDate de la lista>",
      "priority": "high|medium|low",
      "assignedTo": "<copia assignedTo de la lista o null>"
    }
  ],
  "summary": "frase de cierre estratégica de 1 línea"
}

Reglas:
- Selecciona 1-5 tareas que el CEO debe atender. Vencidas y high-priority primero.
- urgencyLevel: "critical" si está vencida o vence en horas; "high" si vence hoy/mañana o priority alta; "medium" en el resto.
- priority: usa el de la lista. Mapea "alta"→"high", "media"→"medium", "baja"→"low".
- ref: COPIA el campo "ref" de la lista TAL CUAL (es el código tipo "SHM-001"). Si la lista trae null, deja null.
- board: COPIA el campo "board" de la lista TAL CUAL (es el nombre del tablero/proyecto, p.ej. "Inversores"). NO inventes nombres.
- NO inventes taskId — usa solo los de la lista.
- NO recalcules fechas — usa los campos urgency, startDate, dueDate, assignedTo TAL CUAL.`;

      // Timeout 30s: si Sonnet 4.5 no responde a tiempo, abortamos con
      // mensaje claro en lugar de dejar el spinner colgado.
      const ac = new AbortController();
      const timeoutId = setTimeout(() => ac.abort(), 30000);
      let r;
      try {
        r = await fetch("/api/agent", {
          method: "POST",
          headers: { "content-type": "application/json" },
          // max_tokens 4096: el JSON de análisis con 6 tareas + thought +
          // summary puede pasar de 2000 caracteres. Con 800 se truncaba a
          // mitad de array y el parser fallaba en posición ~1996.
          body: JSON.stringify({ system, messages: [{ role: "user", content: userPrompt }], max_tokens: 4096 }),
          signal: ac.signal,
        });
      } catch (e) {
        clearTimeout(timeoutId);
        if (e.name === "AbortError") throw new Error("Tiempo agotado tras 30s — el LLM tardó demasiado en responder");
        throw e;
      }
      clearTimeout(timeoutId);
      const raw = await r.text();
      if (cancelledRef.current) return;
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      let parsed = null; try { parsed = JSON.parse(raw); } catch {}
      const text = parsed?.text || raw;
      // Pipeline de limpieza para robustez del parser:
      //   1. Quitar bloque [ACTIONS]...[/ACTIONS] (no aplica a este flujo).
      //   2. Quitar fences markdown ```json ... ``` o ``` ... ```.
      //   3. Recortar prosa antes del primer { (a veces el LLM antepone texto).
      //   4. Si el JSON está truncado por max_tokens, intentar cerrarlo.
      // El parser real va envuelto en try-catch con log del raw para debug.
      const decision = parseHectorDecision(text);
      if (!decision) {
        console.error("[HectorPanel] respuesta cruda no parseable:", text);
        throw new Error("Héctor no pudo completar el análisis. Inténtalo de nuevo.");
      }
      if (cancelledRef.current) return;
      const analysis = {
        thought: (decision.thought || "").trim(),
        summary: (decision.summary || "").trim(),
        tasks: Array.isArray(decision.tasks) ? decision.tasks.slice(0, 6).map((t) => ({
          taskId: t.taskId || null,
          ref: t.ref || null,
          title: (t.title || "").trim(),
          board: (t.board || "").trim(),
          urgency: (t.urgency || "").trim(),
          urgencyLevel: ["critical","high","medium"].includes(t.urgencyLevel) ? t.urgencyLevel : "medium",
          action: (t.action || "").trim(),
          timeframe: (t.timeframe || "").trim(),
          startDate: t.startDate || null,
          dueDate: t.dueDate || null,
          priority: ["high","medium","low"].includes(t.priority) ? t.priority : null,
          assignedTo: t.assignedTo || null,
        })) : [],
      };
      // Validaciones post-LLM (commit 2a):
      // 1. Reescritura propositiva sobre los textos visibles del análisis.
      //    Si Héctor escribió "Tarea creada en X" en thought/summary, queda
      //    como "a crear" — el campo es texto user-facing.
      if (analysis.thought) {
        const r = rewriteToPropositive(analysis.thought);
        if (r.wasFixed) {
          console.log(`✏️ [HectorPanel.thought] '${r.original}' → '${r.rewritten}'`);
          analysis.thought = r.rewritten;
        }
      }
      if (analysis.summary) {
        const r = rewriteToPropositive(analysis.summary);
        if (r.wasFixed) {
          console.log(`✏️ [HectorPanel.summary] '${r.original}' → '${r.rewritten}'`);
          analysis.summary = r.rewritten;
        }
      }
      // 2. Defensa: corregir dueDate de tareas copiadas si el modelo
      //    reescribió el año (cutoff 2025 de Sonnet 4.5). En este flujo
      //    las tasks vienen del state real, así que normalmente
      //    wasFixed=false y no muta nada — es solo red de seguridad.
      analysis.tasks.forEach((t) => {
        if (!t.dueDate) return;
        const r = validateAndCorrectDueDate(t.dueDate);
        if (r.wasFixed) {
          console.log(`📅 [HectorPanel.task ${t.taskId || "?"}] '${t.dueDate}' → '${r.corrected}'`);
          t.dueDate = r.corrected;
        }
      });
      setCurrentThought(analysis.thought || analysis.summary || "");
      setThoughtFlash((v) => v + 1);
      // Dedup: misma firma de análisis → no añadir, no leer voz, evitar bucle.
      const sig = analysis.tasks.map((t) => `${t.taskId}|${t.urgencyLevel}|${t.action}`).join(";") + "::" + analysis.summary;
      if (sig === lastRecTitleRef.current) {
        setState("listening");
        return;
      }
      lastRecTitleRef.current = sig;
      // Persiste como mensaje rico de chat (kind:"hector_analysis").
      const analysisMsg = {
        role: "hector_analysis",
        analysis,
        ts: Date.now(),
      };
      setChatHistory((prev) => [...prev, analysisMsg].slice(-CHAT_MAX));
      // Mantén la sección "Recomendaciones" sincronizada con la primera
      // tarea por urgencia para no romper consumidores externos
      // (onNewRecommendation, badge en HectorFloat, etc.).
      const top = analysis.tasks[0];
      if (top) {
        const rec = {
          id: `rec_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
          title: top.action || top.title,
          reason: top.urgency || "",
          priority: top.urgencyLevel === "critical" ? "urgent" : top.urgencyLevel === "high" ? "high" : "medium",
          timeframe: top.timeframe || "today",
          ts: Date.now(),
          taskId: top.taskId,
        };
        setRecommendations((prev) => [rec, ...prev].slice(0, 3));
        onNewRecommendation?.(rec);
      }
      setState("recommending");
      // Foco (commit 4): si el CEO no ha bloqueado su propio foco,
      // actualizamos focoTexto con el thought del nuevo análisis y
      // marcamos source = "hector". Si focoLocked === true, NO tocamos
      // foco — el CEO ha fijado su prioridad y se respeta hasta que
      // pulse "Liberar foco". Pasamos overrides al save para evitar el
      // race con setState (que es asíncrono).
      let focoOverrides = null;
      if (!focoLocked) {
        const newFoco = (analysis.thought || analysis.summary || focoTexto || "").trim();
        if (newFoco) {
          setFocoTexto(newFoco);
          setFocoSource("hector");
          focoOverrides = { focoTexto: newFoco, focoSource: "hector", focoLocked: false };
        }
      }
      // Persistencia Supabase (commit 3): guardar el análisis para que
      // al reabrir Sala de Mando aparezca instantáneo sin nueva llamada.
      // No-await intencional — fire and forget; un fallo de red no
      // debería bloquear la UI ni revertir lo que ya pintamos.
      savePanelState(analysis, focoOverrides);
      // Voz: lee el summary (más estratégico que cada acción individual).
      if (analysis.summary) speakRecommendation(analysis.summary);
      // Publica en el timeline de cada tarea CRÍTICA recomendada. Una
      // entrada por tarea, agrupadas con un mismo relatedRecommendationId
      // (firma del análisis) para poder filtrar/dedupar más adelante. Solo
      // nivel critical para no spamear timelines con high/medium.
      if (onAddTimelineEntry) {
        const recId = `rec_${Date.now()}_${Math.random().toString(36).slice(2,6)}`;
        analysis.tasks
          .filter(t => t.urgencyLevel === "critical" && t.taskId)
          .forEach(t => {
            onAddTimelineEntry(t.taskId, {
              type: "ai",
              author: "Héctor",
              authorId: "hector",
              authorAvatar: "🧙",
              text: t.action ? `${t.action}\nMotivo: ${t.urgency || ""}` : (t.urgency || ""),
              relatedRecommendationId: recId,
            });
          });
      }
    } catch (e) {
      if (cancelledRef.current) return;
      // No tocar hectorState a "paused" (suena a "sin créditos API").
      // Mostramos un mensaje claro al CEO y restauramos el estado para
      // que la UI no quede en "analizando…" indefinidamente.
      console.warn("[HectorPanel] generateHectorThought fallo:", e?.message);
      const friendly = (e?.message || "").includes("Tiempo agotado")
        ? "⚠ " + e.message
        : "Héctor no pudo completar el análisis. Inténtalo de nuevo.";
      setCurrentThought(friendly);
      setState("listening"); // sale de analyzing
    } finally {
      isGenerating.current = false;
      if (!cancelledRef.current) setIsThinking(false);
    }
  };

  // Helper: localizar tarea por id o por título normalizado.
  const findTask = (id, title) => {
    const list = tasksRef.current || [];
    if (id) {
      const byId = list.find((t) => String(t.id) === String(id));
      if (byId) return byId;
    }
    if (title) {
      const norm = title.trim().toLowerCase();
      return list.find((t) => (t.title || "").trim().toLowerCase() === norm) || null;
    }
    return null;
  };

  // Ejecuta la acción declarada por Héctor sobre la tarea correspondiente.
  // Las callbacks vienen ya configuradas desde App.jsx con la firma de
  // *Anywhere (mutadores cross-project).
  const executeAction = (parsed) => {
    if (!parsed || !parsed.action || parsed.action === "none") return;
    const task = findTask(parsed.taskId, parsed.taskTitle);
    if (!task) return;
    // Aliases comunes del LLM. archive/archive_task → archive_task real.
    // delete/remove → complete_task (no soportamos delete desde aquí).
    let action = parsed.action;
    if (action === "archive") action = "archive_task";
    if (action === "delete_task" || action === "remove_task") action = "complete_task";
    if (action === "complete_task") {
      onCompleteTask?.(task.id, task.projId, task.colId);
    } else if (action === "postpone_task") {
      onPostponeTask?.(task);
    } else if (action === "archive_task") {
      onArchiveTask?.(task.id);
    } else if (action === "assign_task") {
      onAssignTask?.(task, parsed.assigneeId);
    } else if (action === "block_task") {
      // Bloqueo temporal: blockUntil/followUpAt vienen como "HH:MM" desde
      // Héctor. parseBlockUntil convierte a timestamp (null si la hora ya
      // pasó). Si blockUntil es null y la cadena venía vacía, el bloqueo
      // no tiene fin temporal y dura hasta que el CEO lo libere.
      const blockUntilTs = parseBlockUntil(parsed.blockUntil);
      const followUpAtTs = parseBlockUntil(parsed.followUpAt);
      addBlockedTask({
        taskId: task.id,
        blockReason: (parsed.blockReason || "").trim() || "Bloqueada por el CEO",
        blockUntil: blockUntilTs,
        followUpAt: followUpAtTs,
        followUpDone: false,
        ts: Date.now(),
      });
    }
  };

  // Helpers para acciones desde las task cards del análisis estructurado.
  const goToTask = (taskId, fallbackTitle) => {
    const task = findTask(taskId, fallbackTitle);
    if (!task) return;
    if (onOpenTask) onOpenTask(task.id, task.projId);
    else onRecommendationClick?.({ title: task.title });
  };
  const completeFromCard = (taskId, fallbackTitle) => {
    const task = findTask(taskId, fallbackTitle);
    if (!task) return;
    onCompleteTask?.(task.id, task.projId, task.colId);
  };
  const postponeFromCard = (taskId, fallbackTitle) => {
    const task = findTask(taskId, fallbackTitle);
    if (!task) return;
    onPostponeTask?.(task);
  };

  const sendOrderToHector = async (rawMessage) => {
    const userMessage = (rawMessage || "").trim();
    if (!userMessage) return;
    setChatLoading(true);
    setChatHistory((prev) => [...prev, { role: "user", text: userMessage, ts: Date.now() }].slice(-CHAT_MAX));
    setInputMessage("");
    try {
      const ag = agentRef.current;
      const mem = memoryRef.current;
      const tasksNow = tasksRef.current || [];
      const riesgosNow = riesgosRef.current || [];
      const recsNow = recommendationsRef.current || [];
      const focusNow = focusRef.current;
      const now = new Date();
      const baseSystem = ag?.promptBase
        ? ag.promptBase + "\n\n" + PLAIN_TEXT_RULE
        : "Eres Héctor, Chief of Staff estratégico. " + PLAIN_TEXT_RULE;
      const memBlock = formatCeoMemoryForPrompt(mem);
      // Skills detectados a partir del mensaje del CEO + última recomendación
      // + foco — el chat es donde más útil resulta porque el CEO formula
      // explícitamente el dominio (ej. "prepara la negociación con X").
      const skillsBlock = buildSkillsBlock(
        userMessage,
        recsNow[0]?.title,
        focusNow?.title,
      );
      // En el chat el dominio lo marca sobre todo el mensaje del CEO; lo
      // reflejamos en los chips para que vea qué experto está tirando Héctor.
      setActiveSkills(detectSkills([userMessage, recsNow[0]?.title, focusNow?.title].filter(Boolean).join(" | ")));
      const system = baseSystem
        + (memBlock ? ("\n\n---\n" + memBlock) : "")
        + skillsBlock
        + "\n\nIMPORTANTE: en este turno responde ÚNICAMENTE con JSON válido sin markdown ni prosa. USA EL CAMPO \"urgency\" de cada tarea tal cual viene calculado — NO recalcules fechas absolutas; habla en términos relativos al momento actual.";

      // Tareas con urgencia calculada en tiempo real para que Héctor no
      // razone sobre fechas absolutas y no diga "vence 2024-12-15" cuando
      // hoy ya estamos en 2026.
      const tasksWithContext = buildTasksWithContext(tasksNow, now);
      const tasksList = tasksWithContext.slice(0, 30).map((t) => `- ${t.id} :: ${t.title} · proyecto ${t.project} · prio ${t.priority} · ${t.urgency}`).join("\n") || "(ninguna)";
      const histLines = (chatHistoryRef.current || []).slice(-8).map((m) => `${m.role === "user" ? "CEO" : "Héctor"}: ${m.text}`).join("\n");

      const blockedActive = (sessionRef.current?.blockedTasks || []).filter((b) => !b.blockUntil || Date.now() < b.blockUntil);
      const blockedSummary = blockedActive.length
        ? blockedActive.map((b) => `- ${b.taskId} bloqueada${b.blockUntil ? ` hasta ${new Date(b.blockUntil).toLocaleTimeString("es-ES",{hour:"2-digit",minute:"2-digit"})}` : ""}: ${b.blockReason || "(sin razón)"}`).join("\n")
        : "(ninguna)";
      const userPrompt = `Hora: ${now.toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit" })} (${now.toLocaleDateString("es-ES")}).
Última recomendación tuya: ${recsNow[0]?.title || "(ninguna)"}.
Tarea en foco: ${focusNow?.title || "Ninguna"}.
Riesgos críticos: ${riesgosNow.filter((r) => r.level === "critical").length}.

TAREAS DISPONIBLES (id :: título · proyecto · prio · urgency):
${tasksList}

TAREAS BLOQUEADAS (no las re-sugieras hasta que el bloqueo expire):
${blockedSummary}

CONVERSACIÓN PREVIA (últimos turnos):
${histLines || "(sin turnos previos)"}

EL CEO TE DICE AHORA:
"${userMessage}"

ACCIONES PERMITIDAS (solo estas, NO inventes otras):
- complete_task: marcar tarea como completada (la mueve a "Hecho").
- archive_task: archivar tarea (sale del flujo activo y solo aparece en "Mis tareas ▸ Archivadas"; reversible).
- postpone_task: posponer tarea +1 día.
- block_task: bloquear tarea en esta sesión hasta una hora indicada.
- none: solo responder sin ejecutar acción.

NUNCA uses acciones como "delete", "delete_task", "remove", "assign" o cualquier otra que no esté en la lista anterior. Si el CEO pide "borrar" una tarea, responde con action:"none" y propón archivarla en su lugar. Si pide "asignar", responde con action:"none" y explica que no lo soportas todavía.

Distinción clave entre completar y archivar:
- complete_task = la tarea está terminada y el resultado importa (queda en "Hecho" para reportes).
- archive_task = la tarea ya no aplica/no se va a hacer/quedó obsoleta; sale del flujo y deja de ocupar atención.

Devuelve JSON estricto. Si solo es conversación:
{"reply":"tu respuesta breve","action":"none"}

Si pide marcar hecho, archivar o posponer:
{"reply":"confirmación verbal corta","action":"complete_task|archive_task|postpone_task","taskId":"id real","taskTitle":"título","message":"detalle"}

Si pide BLOQUEAR una tarea (gestionará offline, fuera de la app, en una reunión, etc.) y menciona una hora exacta tipo "11:00" / "a las 9:30" / "esta tarde a las 16":
{"reply":"confirmación verbal corta","action":"block_task","taskId":"id real","blockReason":"resumen de por qué se bloquea","blockUntil":"HH:MM o null si no dijo hora concreta","followUpAt":"HH:MM 5 minutos después de blockUntil para hacer seguimiento, o null"}

Reglas para block_task:
- blockUntil debe ser una hora en formato "HH:MM" (24h) o null. Nunca pongas "end_of_day" ni texto libre.
- followUpAt debe ser ~5 min después de blockUntil para preguntar al CEO cómo fue. Si no hay blockUntil, followUpAt también null.
- Si la hora indicada por el CEO ya ha pasado, NO bloquees: responde con action:"none" y un comentario.`;

      // [DEBUG] Logs temporales para diagnosticar timeouts en órdenes
      // complejas (crear proyecto + tareas + negociación). Permite ver
      // qué pesa el prompt y cuánto se devuelve en respuesta.
      console.log("[Hector] orden enviada, longitud:", userMessage.length);
      console.log("[Hector] system prompt total chars:", system.length);
      // Timeout 60s (subido desde 30s): con AGENT_ACTIONS_ADDON v4 y
      // respuestas que incluyen [ACTIONS] grandes (proyecto + 6 tareas +
      // negociación con stakeholders), Sonnet 4.5 puede tardar 30-50s.
      // Con 30s saltaba abort en mitad del JSON.
      const ac = new AbortController();
      const timeoutId = setTimeout(() => ac.abort(), 60000);
      let r;
      try {
        r = await fetch("/api/agent", {
          method: "POST",
          headers: { "content-type": "application/json" },
          // max_tokens 2048: el JSON de orden + bloque [ACTIONS] con
          // propuestas de plan puede pasar de 400 chars con facilidad.
          // Antes se truncaba en respuestas con plan accionable.
          body: JSON.stringify({ system, messages: [{ role: "user", content: userPrompt }], max_tokens: 2048 }),
          signal: ac.signal,
        });
      } catch (e) {
        clearTimeout(timeoutId);
        if (e.name === "AbortError") throw new Error("Héctor tardó más de 60s. La orden puede ser muy compleja. Prueba a dividirla: primero pídele crear el proyecto, luego las tareas, luego la negociación.");
        throw e;
      }
      clearTimeout(timeoutId);
      const raw = await r.text();
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      let proxied = null; try { proxied = JSON.parse(raw); } catch {}
      const text = proxied?.text || raw;
      console.log("[Hector] respuesta recibida, longitud:", String(text||"").length, "tiene ACTIONS:", String(text||"").includes("[ACTIONS]"));
      // PRIMERO: extraer y separar el bloque [ACTIONS] del texto crudo
      // para que el parser JSON de Héctor no lo capture como parte de su
      // propio JSON de respuesta. proposalFromRaw queda para mostrar
      // ActionProposal al final aunque el JSON de Héctor venga vacío.
      const proposalFromRaw = parseAgentActions(text);
      const textWithoutActions = String(text).replace(/\[ACTIONS\][\s\S]*?\[\/ACTIONS\]/g, "").trim();
      // SEGUNDO: parser tolerante. Reutiliza parseHectorDecision para
      // obtener el mismo manejo de markdown, prosa anterior y reparación
      // de truncamiento por max_tokens. Si falla y tampoco hay propuesta,
      // tiramos error con log del raw para debug.
      let parsedReply = parseHectorDecision(textWithoutActions);
      if (!parsedReply && !proposalFromRaw) {
        console.error("[HectorPanel] sendOrderToHector respuesta cruda no parseable:", text);
        throw new Error("Héctor no pudo procesar la orden");
      }
      if (!parsedReply) parsedReply = { reply: "" };
      const reply = (parsedReply.reply || "").trim();
      // Si Héctor incluyó propuesta dentro del campo reply, también la
      // detectamos (caso poco probable pero defensivo).
      const proposal = proposalFromRaw || parseAgentActions(reply);
      let cleanReply = proposal ? cleanAgentResponse(reply) : reply;
      // Validaciones post-LLM (commit 2a):
      // 1. Reescritura propositiva sobre el reply user-facing. NO toca
      //    parsedReply.action (mecánico) — solo el texto que ve el CEO.
      if (cleanReply) {
        const r = rewriteToPropositive(cleanReply);
        if (r.wasFixed) {
          console.log(`✏️ [HectorPanel.reply] '${r.original}' → '${r.rewritten}'`);
          cleanReply = r.rewritten;
        }
      }
      // 2. Defensa: si el modelo extiende parsedReply con tasks que
      //    incluyan dueDate (no es el shape estándar pero es defensivo
      //    ante futuras evoluciones), corregimos años pasados.
      if (Array.isArray(parsedReply.tasks)) {
        parsedReply.tasks.forEach((t) => {
          if (t && t.dueDate) {
            const r = validateAndCorrectDueDate(t.dueDate);
            if (r.wasFixed) {
              console.log(`📅 [HectorPanel.order.task ${t.taskId || "?"}] '${t.dueDate}' → '${r.corrected}'`);
              t.dueDate = r.corrected;
            }
          }
        });
      }
      // Capa 2 del blindaje anti-fake-success: si Héctor afirma éxito en
      // texto sin bloque [ACTIONS] válido, marcamos el mensaje para que
      // el render del chat muestre el banner amarillo anclado a la
      // burbuja. La detección vive en agentActions (compartida con
      // HectorDirect). Importante: corre SOBRE el cleanReply ya
      // reescrito a propositivo — los participios convertidos a
      // infinitivo no disparan falsos positivos del detector.
      const fakeSuccess = detectFalseSuccessClaim(cleanReply, proposal);
      setChatHistory((prev) => [...prev, { role: "hector", text: cleanReply || "(sin respuesta)", proposal, fakeSuccess, ts: Date.now() }].slice(-CHAT_MAX));
      executeAction(parsedReply);
      if (cleanReply) speakRecommendation(cleanReply);
    } catch (e) {
      console.warn("[HectorPanel] sendOrderToHector fallo:", e?.message);
      // Mensaje claro al usuario en el chat. NO tocamos hectorState
      // (mantenerlo en "listening" o el que tenía) para no dar
      // sensación de "pausado/sin créditos" cuando solo es un parser.
      const isTimeout = (e?.message || "").includes("tardó más de 60s") || (e?.message || "").includes("Tiempo agotado");
      const friendly = isTimeout
        ? `⚠️ ${e.message}`
        : "⚠ Héctor no pudo procesar la orden. Inténtalo de nuevo.";
      setChatHistory((prev) => [...prev, { role: "hector", text: friendly, ts: Date.now() }].slice(-CHAT_MAX));
    } finally {
      setChatLoading(false);
    }
  };

  // SpeechRecognition para dictado por voz (lib voice.listen → es-ES).
  // FLUJO ACTUAL (post-fix):
  //   - El reconocedor ACUMULA en inputMessage los resultados isFinal.
  //   - Los interim results se muestran como preview, no se acumulan.
  //   - NO envía automáticamente — el usuario pulsa Enviar o el botón
  //     micrófono otra vez para detener.
  //   - Si onEnd dispara mientras isListening sigue true (corte
  //     involuntario del navegador / iOS), reintentamos hasta 3 veces.
  const startListening = () => {
    if (isListening) {
      // Stop solicitado por el usuario: cierra y deja el texto en el
      // input. Reset del contador de reintentos.
      wantsListeningRef.current = false;
      try { stopListenRef.current?.(); } catch {}
      setIsListening(false);
      setInterimText("");
      listenRetryRef.current = 0;
      return;
    }
    // Si Héctor estaba leyendo una respuesta previa, lo silenciamos antes
    // de abrir el mic. Sin esto, en iOS y desktop el reconocedor capta
    // la voz de Héctor como dictado del usuario y se mezclan.
    try { stopSpeaking(); } catch {}
    wantsListeningRef.current = true;
    setIsListening(true);
    listenRetryRef.current = 0;
    const startSession = () => {
      const stop = listen({
        continuous: true, // voice.js degrada a false en iOS automáticamente
        onInterim: (t) => setInterimText(t),
        onFinal: (t) => {
          // Acumular en inputMessage. Append con espacio si ya había
          // texto, capitalizar primera letra si arranca vacío.
          if (!t) return;
          setInputMessage(prev => {
            const base = (prev || "").trimEnd();
            const sep = base ? " " : "";
            return (base + sep + t).slice(0, 5000);
          });
          // Limpiar interim ahora que el final ya está consolidado.
          setInterimText("");
          // Reset retry: hubo audio válido, sigue escuchando.
          listenRetryRef.current = 0;
        },
        onError: (e) => {
          console.warn("[HectorPanel] listen error:", e?.message);
          // 'no-speech' y 'aborted' son cortes normales (silencio/stop);
          // los gestiona onEnd. Otros errores cierran sesión y avisan.
          if (e?.message !== "no-speech" && e?.message !== "aborted") {
            wantsListeningRef.current = false;
            setIsListening(false);
            setInterimText("");
            listenRetryRef.current = 0;
          }
        },
        onEnd: () => {
          // Solo auto-reabrir si el usuario NO ha pulsado stop. Sin
          // este check, el stop manual entraría en bucle de re-apertura.
          if (!wantsListeningRef.current || cancelledRef.current) {
            setIsListening(false);
            setInterimText("");
            return;
          }
          if (listenRetryRef.current < 3) {
            listenRetryRef.current++;
            // Pequeño delay para no spammear si el navegador rechaza.
            setTimeout(() => {
              if (wantsListeningRef.current && !cancelledRef.current) {
                try { stopListenRef.current = startSession(); } catch {}
              }
            }, 250);
          } else {
            // Agotados los reintentos: cerramos limpio.
            wantsListeningRef.current = false;
            setIsListening(false);
            setInterimText("");
            listenRetryRef.current = 0;
          }
        },
      });
      return stop;
    };
    stopListenRef.current = startSession();
  };

  // Setup al montar (commit 3 — Sala de Mando v2): carga el último
  // análisis desde Supabase. Si no hay fila (primera vez del CEO),
  // dispara generateHectorThought automáticamente. Si ya hay fila,
  // muestra el análisis guardado y NO regenera — el CEO controla
  // manualmente las nuevas generaciones con el botón ACTUALIZAR.
  // Eliminado el polling cada 60s del flujo legacy: ahora la única
  // llamada periódica es la del usuario.
  useEffect(() => {
    cancelledRef.current = false;
    let alive = true;
    (async () => {
      const loaded = await loadPanelState();
      if (!alive || cancelledRef.current) return;
      if (!loaded) {
        // Primera vez del CEO en este proyecto Supabase → generamos.
        generateHectorThought();
      }
    })();
    return () => { alive = false; cancelledRef.current = true; try { stopListenRef.current?.(); } catch {} };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authUid]);

  const toggleMute = () => {
    setMuted((prev) => {
      const next = !prev;
      try { localStorage.setItem("hector_muted", next ? "1" : "0"); } catch {}
      if (next) { try { stopSpeaking(); } catch {} }
      return next;
    });
  };

  const handleSubmit = (e) => {
    e?.preventDefault?.();
    if (chatLoading || !inputMessage.trim()) return;
    // Antes de enviar: cerrar el mic si sigue activo y silenciar
    // cualquier TTS en curso. Sin esto, la voz de Héctor entrante
    // se solapa con el dictado y el mic captura su respuesta como
    // si el CEO siguiera hablando.
    if (wantsListeningRef.current || isListening) {
      wantsListeningRef.current = false;
      try { stopListenRef.current?.(); } catch {}
      setIsListening(false);
      setInterimText("");
      listenRetryRef.current = 0;
    }
    try { stopSpeaking(); } catch {}
    setActiveTab("chat");
    sendOrderToHector(inputMessage);
  };

  // Wrappers de acciones para el tab Análisis: ejecutan + dejan rastro en
  // el chat + cambian al tab Chat para que el CEO vea la confirmación.
  // También publican en el timeline de la tarea — el CEO ve más adelante
  // el rastro de la decisión sin entrar al chat.
  const switchToChatWithMessage = (text) => {
    setActiveTab("chat");
    if (text) setChatHistory((prev) => [...prev, { role: "hector", text, ts: Date.now() }].slice(-CHAT_MAX));
  };
  const publishTimeline = (taskId, text) => {
    if (!onAddTimelineEntry || !taskId) return;
    onAddTimelineEntry(taskId, { type: "ai", author: "Héctor", authorId: "hector", authorAvatar: "🧙", text });
  };
  const handleViewTaskFromCard = (taskId, title) => {
    goToTask(taskId, title);
    switchToChatWithMessage(`Abriendo "${title}".`);
  };
  const handleCompleteFromCard = (taskId, title) => {
    completeFromCard(taskId, title);
    switchToChatWithMessage(`✓ Marcada como hecha: "${title}".`);
    publishTimeline(taskId, `Marcada como hecha desde la Sala de Mando.`);
  };
  const handlePostponeFromCard = (taskId, title) => {
    postponeFromCard(taskId, title);
    switchToChatWithMessage(`⏸ Pospuesta +1d: "${title}".`);
    publishTimeline(taskId, `Pospuesta 1 día desde la Sala de Mando.`);
  };

  // Sincroniza el contador de no-leídos cuando el tab Chat está activo.
  useEffect(() => {
    if (activeTab === "chat") setLastSeenChatLength(chatHistory.length);
  }, [activeTab, chatHistory.length]);

  // Análisis a mostrar en el tab Análisis = el último hector_analysis del
  // chatHistory. Si todavía no hay ninguno, se muestra placeholder.
  const latestAnalysis = (() => {
    for (let i = chatHistory.length - 1; i >= 0; i--) {
      const m = chatHistory[i];
      if (m.role === "hector_analysis" && m.analysis) return m.analysis;
    }
    return null;
  })();
  const unreadCount = Math.max(0, chatHistory.length - lastSeenChatLength);

  const stateInfo = STATE_LABEL[hectorState] || STATE_LABEL.listening;
  const displayName = userName || userId || "CEO";

  // ── Sub-renderers de cards (extraídos para reuso entre tabs) ────────────
  const URGENCY_GROUPS = [
    { key: "critical", label: "🔴 URGENTE",     fg: "#991B1B", border: "#FCA5A5", urgencyColor: "#B91C1C" },
    { key: "high",     label: "🟠 HOY",         fg: "#92400E", border: "#FCD34D", urgencyColor: "#B45309" },
    { key: "medium",   label: "🟡 ESTA SEMANA", fg: "#854D0E", border: "#FDE68A", urgencyColor: "#A16207" },
  ];

  // Formatea ISO/string a "DD mmm" en castellano. Devuelve "Sin fecha" si
  // la entrada es falsy o inválida — evita "Invalid Date" en el card.
  const formatDate = (dateStr) => {
    if (!dateStr) return null;
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return null;
    return d.toLocaleDateString("es-ES", { day: "numeric", month: "short" });
  };

  const PRIO_LABEL = (p) => {
    const x = (p || "").toLowerCase();
    if (x === "high" || x === "alta")   return "Alta";
    if (x === "medium" || x === "media") return "Media";
    if (x === "low" || x === "baja")    return "Baja";
    return p || "—";
  };

  const renderTaskCard = (t, key, onView, onComplete, onPostpone, urgencyColor, border) => {
    const startTxt = formatDate(t.startDate);
    const endTxt   = formatDate(t.dueDate);
    return (
      <div key={key} style={{ background: "#fff", border: `1px solid ${border}`, borderLeft: `4px solid ${border}`, borderRadius: 8, padding: "8px 10px", maxWidth: "100%", boxSizing: "border-box", overflow: "hidden" }}>
        {/* Línea 1: ref + título + badge proyecto (board) */}
        <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 3, flexWrap: "wrap" }}>
          {t.ref && (
            <button
              onClick={() => onView(t.taskId, t.title)}
              title={`Ir a ${t.ref}`}
              style={{
                backgroundColor: "#2C3E50",
                color: "white",
                borderRadius: 4,
                padding: "2px 8px",
                fontSize: 11,
                fontWeight: "bold",
                marginRight: 2,
                border: "none",
                fontFamily: "ui-monospace,SFMono-Regular,Menlo,Consolas,monospace",
                letterSpacing: "0.04em",
                cursor: "pointer",
                flexShrink: 0,
              }}
            >{t.ref}</button>
          )}
          <span style={{ flex: 1, minWidth: 0, fontSize: 12, fontWeight: 700, color: "#111827", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{t.title}</span>
          {t.board && (
            <span title={t.board} style={{ fontSize: 10, padding: "2px 8px", borderRadius: 4, background: "#EEEDFE", color: "#3C3489", border: "1px solid #AFA9EC", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.04em", flexShrink: 0, maxWidth: 120, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{t.board}</span>
          )}
        </div>
        {/* Línea 2: urgencia */}
        <div style={{ fontSize: 10.5, color: urgencyColor, fontWeight: 600, marginBottom: 4 }}>{t.urgency}</div>
        {/* Línea 3: metadata (fechas + prioridad + asignado) */}
        <div style={{ display: "flex", gap: 12, fontSize: 10.5, color: "#666", margin: "2px 0 4px", flexWrap: "wrap", alignItems: "center" }}>
          <span>📅 {startTxt || "Sin inicio"} → {endTxt || "Sin fin"}</span>
          <span>⚡ {PRIO_LABEL(t.priority)}</span>
          <span>👤 {t.assignedTo || "Sin asignar"}</span>
        </div>
        {/* Línea 4: acción imperativa */}
        {t.action && <div style={{ fontSize: 11, color: "#374151", fontStyle: "italic", marginBottom: 6 }}>{t.action}</div>}
        {/* Línea 5: botones */}
        <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
          <button onClick={() => onView(t.taskId, t.title)}      style={{ padding: "3px 8px", borderRadius: 5, background: "#fff", color: "#1E40AF", border: "1px solid #BFDBFE", fontSize: 10.5, fontWeight: 600, cursor: "pointer", fontFamily: "inherit" }}>→ Ver tarea</button>
          <button onClick={() => onComplete(t.taskId, t.title)}  style={{ padding: "3px 8px", borderRadius: 5, background: "#fff", color: "#065F46", border: "1px solid #86EFAC", fontSize: 10.5, fontWeight: 600, cursor: "pointer", fontFamily: "inherit" }}>✓ Hecho</button>
          <button onClick={() => onPostpone(t.taskId, t.title)}  style={{ padding: "3px 8px", borderRadius: 5, background: "#fff", color: "#92400E", border: "1px solid #FCD34D", fontSize: 10.5, fontWeight: 600, cursor: "pointer", fontFamily: "inherit" }}>⏸ Posponer</button>
        </div>
      </div>
    );
  };

  const renderAnalysisGroups = (analysis, onView, onComplete, onPostpone) => (
    <>
      {URGENCY_GROUPS.map((g) => {
        const items = (analysis.tasks || []).filter((t) => t.urgencyLevel === g.key);
        if (!items.length) return null;
        return (
          <div key={g.key} style={{ marginBottom: 8 }}>
            <div style={{ fontSize: 9.5, fontWeight: 700, color: g.fg, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 4 }}>{g.label}</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
              {items.slice(0, 5).map((t, j) => renderTaskCard(t, `${g.key}-${j}`, onView, onComplete, onPostpone, g.urgencyColor, g.border))}
            </div>
          </div>
        );
      })}
    </>
  );

  const fmtTs = (ts) => {
    if (!ts) return "";
    const d = new Date(ts);
    return d.toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit" });
  };

  return (
    <div style={{
      backgroundColor: "white",
      border: "2px solid #3498DB",
      borderRadius: 12,
      boxShadow: "0 4px 16px rgba(52,152,219,0.15)",
      fontFamily: "inherit",
      display: "flex",
      flexDirection: "column",
      height: "100%",
      minHeight: 560,
      maxWidth: "100%",
      overflow: "hidden",
      boxSizing: "border-box",
      // position:relative para anclar el botón flotante "↓ Ir al final"
      // dentro del panel sin que se desplace con el scroll interno.
      position: "relative",
    }}>
      <style>{`
        @keyframes hp-fade-tab { from { opacity: 0; } to { opacity: 1; } }
        @keyframes hp-fade { from { opacity: 0; transform: translateY(2px);} to { opacity: 1; transform: translateY(0);} }
        @keyframes hp-pulse-dot { 0%,100% { opacity:1;} 50% { opacity:0.4;} }
        @keyframes hp-mic-pulse { 0%,100% { box-shadow: 0 0 0 0 rgba(231,76,60,0.55);} 50% { box-shadow: 0 0 0 6px rgba(231,76,60,0);} }
        @keyframes fadeInSkills { from { opacity: 0; transform: translateY(-4px);} to { opacity: 1; transform: translateY(0);} }
        /* Banner urgente colapsable: solo móvil. En desktop se oculta. */
        [data-hp="urgent-banner"] { display: none; }
        @media (max-width: 768px) {
          [data-hp="urgent-banner"] { display: block; }
        }
        /* Mobile (≤768px): reordenar el panel para que el INPUT (acción
           principal del CEO) quede arriba y el chat de respuestas debajo.
           Usamos CSS order — el JSX no se mueve. El "Foco del momento"
           (pensamiento actual de Héctor) se oculta para no robar espacio.
           El form pierde su borde superior y gana borde inferior, ya que
           visualmente queda como header del chat, no como pie. */
        @media (max-width: 768px) {
          [data-hp="header"]        { order: 1; }
          [data-hp="chat-form"]     { order: 2; border-top: none !important; border-bottom: 1px solid #E5E7EB !important; }
          [data-hp="tabs-bar"]      { order: 3; }
          [data-hp="skills-bar"]    { order: 3; }
          [data-hp="content"]       { order: 4; min-height: 50vh; }
          [data-hp="urgent-banner"] { order: 5; flex-shrink: 0; }
          [data-hp="thought"]       { display: none !important; }
        }
        /* Mobile (≤768px): tamaños táctiles. Solo overrides — los estilos
           inline sirven de base. fontSize:16px en input evita zoom auto
           en iOS al enfocar. Botones 48px alto cumplen guideline táctil. */
        @media (max-width: 768px) {
          [data-hp="chat-form"] {
            height: auto !important;
            min-height: 80px;
            padding: 10px 12px !important;
            gap: 8px !important;
          }
          [data-hp="chat-input"] {
            min-height: 56px;
            font-size: 16px !important;
            padding: 12px 16px !important;
            border-radius: 28px !important;
          }
          [data-hp="chat-send"], [data-hp="chat-mic"] {
            min-width: 48px;
            min-height: 48px;
            width: 48px !important;
            height: 48px !important;
            border-radius: 50% !important;
            padding: 0 !important;
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 18px !important;
          }
        }
      `}</style>

      {/* Banner urgente colapsable (solo móvil ≤768px). Lee `riesgos`
          prop ya existente — sin nuevos handlers ni callbacks. Header
          siempre visible con conteo; cuerpo solo al expandir. */}
      {(() => {
        const urgentItems = (riesgos || []).filter(r => r.level === "critical");
        if (urgentItems.length === 0) return null;
        return (
          <div data-hp="urgent-banner" style={{
            background: "#FEE2E2",
            borderBottom: "1px solid #FCA5A5",
            overflow: "hidden",
            flexShrink: 0,
          }}>
            <button
              type="button"
              onClick={() => setUrgentExpanded(p => !p)}
              style={{
                width: "100%",
                padding: "10px 16px",
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                background: "transparent",
                border: "none",
                cursor: "pointer",
                fontFamily: "inherit",
                color: "#991B1B",
              }}
              aria-expanded={urgentExpanded}
            >
              <span style={{ fontSize: 14, fontWeight: 600 }}>
                🔴 {urgentItems.length} urgente{urgentItems.length > 1 ? "s" : ""}
              </span>
              <span style={{ fontSize: 12 }}>{urgentExpanded ? "▲" : "▼"}</span>
            </button>
            {urgentExpanded && (
              <div style={{ padding: "0 16px 12px", display: "flex", flexDirection: "column", gap: 6 }}>
                {urgentItems.slice(0, 8).map((r, idx) => (
                  <div key={idx} style={{ fontSize: 12.5, color: "#7F1D1D", lineHeight: 1.4 }}>
                    • {r.title || r.label || r.msg || "(sin título)"}
                  </div>
                ))}
                {urgentItems.length > 8 && (
                  <div style={{ fontSize: 11, color: "#7F1D1D", fontStyle: "italic", marginTop: 2 }}>
                    +{urgentItems.length - 8} más…
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })()}

      {/* PanelHeader Kluxor (commit 3 — Sala de Mando v2). Tres líneas
          stack izquierda: marca KLUXOR · Sala de Mando · timestamp.
          Botón ACTUALIZAR a la derecha = única vía de regenerar análisis
          desde la UI. Mute conservado como icono pequeño antes del CTA
          para no perder el toggle de voz. Border-radius 0 en todo. */}
      <div data-hp="header" style={{
        padding: "14px 20px",
        display: "flex",
        alignItems: "center",
        gap: 12,
        borderBottom: "0.5px solid #E5E0D5",
        background: "#FAFAF7",
        flexShrink: 0,
      }}>
        <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 2 }}>
          <div style={{ fontSize: 10, fontWeight: 600, letterSpacing: "0.12em", color: "#C9A84C", textTransform: "uppercase", lineHeight: 1 }}>KLUXOR</div>
          <div style={{ fontSize: 15, fontWeight: 500, color: "#1A1A1A", lineHeight: 1.2 }}>Sala de Mando</div>
          <div style={{ fontSize: 11, color: "#6B6B6B", lineHeight: 1.2 }}>
            {lastUpdatedAt ? (
              `Actualizado a las ${new Intl.DateTimeFormat("es-ES", { timeZone: "Europe/Madrid", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(lastUpdatedAt))}`
            ) : (
              isThinking || refreshLoading ? "Generando primer análisis…" : "Sin análisis aún"
            )}
          </div>
        </div>
        <button
          onClick={toggleMute}
          title={muted ? "Activar voz de Héctor" : "Silenciar voz de Héctor"}
          style={{
            background: "transparent",
            border: "0.5px solid #E5E0D5",
            width: 32,
            height: 32,
            fontSize: 13,
            cursor: "pointer",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 0,
            fontFamily: "inherit",
            color: muted ? "#9B9B9B" : "#1A1A1A",
            flexShrink: 0,
          }}
        >{muted ? "🔇" : "🔊"}</button>
        <button
          onClick={() => { if (refreshLoading || isThinking) return; setRefreshLoading(true); lastCallTime.current = 0; generateHectorThought().finally(() => setRefreshLoading(false)); }}
          disabled={refreshLoading || isThinking}
          title="Regenerar análisis con el contexto actual"
          style={{
            background: "transparent",
            border: "1px solid #C9A84C",
            color: refreshLoading || isThinking ? "#A07830" : "#C9A84C",
            fontSize: 11,
            fontWeight: 600,
            letterSpacing: "0.12em",
            textTransform: "uppercase",
            padding: "8px 16px",
            cursor: refreshLoading || isThinking ? "wait" : "pointer",
            fontFamily: "inherit",
            opacity: refreshLoading || isThinking ? 0.7 : 1,
            transition: "background .15s ease, color .15s ease",
            flexShrink: 0,
          }}
          onMouseEnter={(e) => { if (!refreshLoading && !isThinking) { e.currentTarget.style.background = "#C9A84C"; e.currentTarget.style.color = "#FFFFFF"; } }}
          onMouseLeave={(e) => { if (!refreshLoading && !isThinking) { e.currentTarget.style.background = "transparent"; e.currentTarget.style.color = "#C9A84C"; } }}
        >
          {refreshLoading || isThinking ? "ACTUALIZANDO…" : "ACTUALIZAR"}
        </button>
      </div>

      {/* SaludoCard (commit 3) — siempre visible bajo el header. Saludo
          cortés según hora local + nº de proyectos activos como "frentes
          activos hoy". Sin alarmismo, sin badges, lenguaje propositivo. */}
      <div style={{
        padding: "16px 20px",
        background: "#FAFAF7",
        borderBottom: "0.5px solid #E5E0D5",
        flexShrink: 0,
      }}>
        {(() => {
          const h = new Date().getHours();
          const saludo = h < 14 ? "Buenos días" : h < 20 ? "Buenas tardes" : "Buenas noches";
          const firstName = (userName || "Antonio").split(" ")[0];
          const frentes = (projects || []).length;
          const fechaLarga = new Intl.DateTimeFormat("es-ES", {
            timeZone: "Europe/Madrid",
            weekday: "long", day: "numeric", month: "long",
          }).format(new Date());
          return (
            <>
              <div style={{ fontSize: 15, color: "#1A1A1A", lineHeight: 1.5, fontWeight: 400 }}>
                {saludo}, {firstName}. <span style={{ color: "#1A1A1A", fontWeight: 500 }}>{frentes} {frentes === 1 ? "frente activo" : "frentes activos"}</span> hoy.
              </div>
              <div style={{ fontSize: 11, color: "#6B6B6B", marginTop: 4, textTransform: "capitalize" }}>
                {fechaLarga} · Marbella-Estepona
              </div>
            </>
          );
        })()}
      </div>

      {/* Chips de skills consultados — visible cuando Héctor detecta expertos */}
      {activeSkills.length > 0 && (
        <div
          key={activeSkills.join("|")}
          data-hp="skills-bar"
          style={{
            display: "flex",
            flexWrap: "wrap",
            alignItems: "center",
            gap: 6,
            padding: "8px 12px",
            backgroundColor: "#F8F9FA",
            borderBottom: "0.5px solid #ECF0F1",
            fontSize: 11,
            flexShrink: 0,
            animation: "fadeInSkills 0.3s ease-out",
          }}
        >
          <span style={{ color: "#7F8C8D", fontWeight: 600 }}>🧙 Consultando expertos:</span>
          {activeSkills.map((skill) => (
            <span
              key={skill}
              title={`Skill ${SKILL_LABELS[skill] || skill} activo en este análisis`}
              style={{
                backgroundColor: SKILL_COLORS[skill] || "#95A5A6",
                color: "white",
                padding: "3px 10px",
                borderRadius: 12,
                fontWeight: 600,
                fontSize: 10,
                letterSpacing: "0.3px",
              }}
            >{SKILL_LABELS[skill] || skill}</span>
          ))}
        </div>
      )}

      {/* Tab bar (40px fijo) */}
      <div data-hp="tabs-bar" style={{ height: 40, display: "flex", borderBottom: "0.5px solid #E5E7EB", background: "#FAFAFA", flexShrink: 0 }}>
        {[
          { key: "analysis", label: "📋 Análisis", badge: 0 },
          { key: "chat",     label: "💬 Chat",     badge: unreadCount },
        ].map((tab) => {
          const isActive = activeTab === tab.key;
          return (
            <button
              key={tab.key}
              onClick={() => setActiveTab(tab.key)}
              style={{
                flex: 1,
                background: isActive ? "#fff" : "transparent",
                border: "none",
                borderBottom: isActive ? "2px solid #3498DB" : "2px solid transparent",
                fontSize: 12,
                fontWeight: isActive ? 700 : 500,
                color: isActive ? "#1E40AF" : "#6B7280",
                cursor: "pointer",
                fontFamily: "inherit",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                gap: 6,
              }}
            >
              <span>{tab.label}</span>
              {tab.badge > 0 && (
                <span style={{ minWidth: 18, height: 18, padding: "0 5px", borderRadius: 9, background: "#E74C3C", color: "#fff", fontSize: 10, fontWeight: 700, display: "inline-flex", alignItems: "center", justifyContent: "center" }}>{tab.badge}</span>
              )}
            </button>
          );
        })}
      </div>

      {/* Contenido (flex: 1, scroll único) */}
      <div key={activeTab} data-hp="content" onScroll={handleChatScroll} style={{ flex: 1, overflowY: "auto", overflowX: "hidden", padding: 14, animation: "hp-fade-tab .2s ease", minHeight: 0, maxWidth: "100%", boxSizing: "border-box" }}>
        {activeTab === "analysis" ? (
          <>
            {/* Pensamiento actual — variantes según estado:
                - analyzing: spinner + "Héctor está analizando tu día…"
                - paused:    razón posible + botón Reintentar
                - resto:     pensamiento real o placeholder neutral
                Mobile: oculto (data-hp="thought" + display:none ≤768px)
                para priorizar el chat sobre el "Foco del momento". */}
            {/* FocoCard (commit 4) — sustituye al antiguo data-hp="thought".
                Visual Kluxor: contenedor exterior #FAFAF7 con padding
                12px 20px; card interior blanca con borde izquierdo 2.5px
                oro, padding 12px 14px, border-radius 0. Estados:
                - analyzing/thinking → spinner donde iría el título.
                - paused             → botón Reintentar inline.
                - normal             → label · badge · título · ✏️ · CTA · liberar */}
            <div data-hp="thought" key={thoughtFlash} style={{
              padding: "12px 20px",
              animation: "hp-fade .35s ease",
              flexShrink: 0,
            }}>
              <div style={{
                background: "#fff",
                borderLeft: "2.5px solid #C9A84C",
                padding: "12px 14px",
                display: "flex",
                flexDirection: "column",
                gap: 6,
              }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10, justifyContent: "space-between" }}>
                  <span style={{
                    fontSize: 10,
                    fontWeight: 600,
                    color: "#C9A84C",
                    letterSpacing: "0.12em",
                    textTransform: "uppercase",
                  }}>FOCO DEL MOMENTO</span>
                  {/* Badge source — solo cuando no estamos editando ni en
                      estados especiales (analyzing/paused) y hay foco real. */}
                  {!focoEditing && hectorState !== "analyzing" && hectorState !== "paused" && !isThinking && focoTexto && (
                    <span style={{
                      fontSize: 10,
                      fontWeight: 600,
                      padding: "2px 8px",
                      background: focoSource === "ceo" ? "#E8F0FF" : "#F1EFE8",
                      color: focoSource === "ceo" ? "#2B5CD9" : "#6B6B6B",
                      letterSpacing: "0.04em",
                    }}>
                      {focoSource === "ceo" ? "Fijado por ti" : "Decidido por Héctor"}
                    </span>
                  )}
                </div>

                {/* Cuerpo: tres ramas mutuamente excluyentes según estado. */}
                {hectorState === "analyzing" || isThinking ? (
                  <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12.5, color: "#6B6B6B" }}>
                    <span style={{ fontSize: 14, animation: "hp-pulse-dot 1.2s infinite" }}>⏳</span>
                    <span>Héctor está analizando tu día…</span>
                  </div>
                ) : hectorState === "paused" ? (
                  <div style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
                    <span style={{ fontSize: 14 }}>⏸</span>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontSize: 12.5, fontWeight: 600, color: "#1A1A1A", marginBottom: 2 }}>Héctor está pausado</div>
                      <div style={{ fontSize: 11, color: "#6B6B6B", marginBottom: 6 }}>Sin créditos API o error de conexión.</div>
                      <button
                        onClick={() => { lastCallTime.current = 0; generateHectorThought(); }}
                        style={{ padding: "4px 10px", background: "#fff", color: "#1A1A1A", border: "1px solid #C9A84C", fontSize: 11, fontWeight: 600, cursor: "pointer", fontFamily: "inherit", borderRadius: 0 }}
                      >↺ Reintentar</button>
                    </div>
                  </div>
                ) : focoEditing ? (
                  // Modo edición inline. Enter confirma, Esc cancela.
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <input
                      type="text"
                      autoFocus
                      value={focoEditValue}
                      onChange={(e) => setFocoEditValue(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") { e.preventDefault(); handleSaveFoco(); }
                        else if (e.key === "Escape") { e.preventDefault(); handleCancelEditFoco(); }
                      }}
                      placeholder="¿Cuál es tu foco hoy?"
                      maxLength={500}
                      style={{
                        flex: 1,
                        fontSize: 13,
                        fontWeight: 500,
                        color: "#1A1A1A",
                        padding: "6px 8px",
                        border: "1px solid #C9A84C",
                        borderRadius: 0,
                        outline: "none",
                        fontFamily: "inherit",
                        background: "#FAFAF7",
                      }}
                    />
                    <button
                      onClick={handleSaveFoco}
                      style={{ fontSize: 11, fontWeight: 600, padding: "5px 12px", border: "none", background: "#C9A84C", color: "#fff", cursor: "pointer", fontFamily: "inherit", borderRadius: 0, letterSpacing: "0.04em" }}
                    >Fijar</button>
                    <button
                      onClick={handleCancelEditFoco}
                      style={{ fontSize: 11, padding: "5px 8px", border: "none", background: "transparent", color: "#6B6B6B", cursor: "pointer", fontFamily: "inherit" }}
                    >Cancelar</button>
                  </div>
                ) : (
                  <>
                    {/* Modo lectura: título + ✏️ a la derecha */}
                    <div style={{ display: "flex", alignItems: "flex-start", gap: 10 }}>
                      <span style={{
                        flex: 1,
                        fontSize: 13,
                        fontWeight: 500,
                        color: "#1A1A1A",
                        lineHeight: 1.5,
                        wordBreak: "break-word",
                      }}>
                        {focoTexto || "Héctor aún no ha decidido tu foco. Pulsa Actualizar o fija el tuyo."}
                      </span>
                      <button
                        onClick={handleStartEditFoco}
                        title="Editar foco manualmente"
                        style={{
                          background: "transparent",
                          border: "none",
                          fontSize: 14,
                          cursor: "pointer",
                          padding: 2,
                          fontFamily: "inherit",
                          color: "#6B6B6B",
                          flexShrink: 0,
                          lineHeight: 1,
                        }}
                      >✏️</button>
                    </div>
                    {/* CTA Hablar con Héctor (siempre visible bajo el título) */}
                    <button
                      onClick={() => onNavigate?.("hector-direct")}
                      style={{
                        background: "transparent",
                        border: "none",
                        padding: 0,
                        fontSize: 11,
                        color: "#C9A84C",
                        textDecoration: "underline",
                        cursor: "pointer",
                        fontFamily: "inherit",
                        textAlign: "left",
                        marginTop: 2,
                      }}
                    >Hablar con Héctor sobre esto →</button>
                    {/* Liberar foco — solo si lo fijó el CEO */}
                    {focoSource === "ceo" && (
                      <button
                        onClick={handleReleaseFoco}
                        style={{
                          background: "transparent",
                          border: "none",
                          padding: 0,
                          fontSize: 11,
                          color: "#6B6B6B",
                          cursor: "pointer",
                          fontFamily: "inherit",
                          textAlign: "left",
                          marginTop: 2,
                        }}
                      >Liberar foco</button>
                    )}
                  </>
                )}
              </div>
            </div>
            {latestAnalysis && latestAnalysis.tasks && latestAnalysis.tasks.length > 0 ? (
              <>
                {/* Summary como banner destacado encima de las cards */}
                {latestAnalysis.summary && (
                  <div style={{
                    backgroundColor: "#1A252F",
                    color: "white",
                    borderRadius: 8,
                    padding: "14px 18px",
                    marginBottom: 16,
                    fontSize: 13,
                    fontStyle: "italic",
                    lineHeight: 1.6,
                    display: "flex",
                    gap: 10,
                    alignItems: "flex-start",
                    maxWidth: "100%",
                    boxSizing: "border-box",
                    wordBreak: "break-word",
                  }}>
                    <span style={{ fontSize: 16, color: "white", flexShrink: 0 }}>💭</span>
                    <span style={{ flex: 1 }}>{latestAnalysis.summary}</span>
                  </div>
                )}
                {renderAnalysisGroups(latestAnalysis, handleViewTaskFromCard, handleCompleteFromCard, handlePostponeFromCard)}
              </>
            ) : (
              <div style={{ fontSize: 12, color: "#9CA3AF", fontStyle: "italic", padding: "20px 8px", textAlign: "center" }}>Héctor está observando — el primer análisis llegará en cuanto tenga contexto suficiente.</div>
            )}
          </>
        ) : (
          <div ref={chatScrollRef} style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {chatHistory.length === 0 ? (
              <div style={{ fontSize: 11.5, color: "#9CA3AF", fontStyle: "italic", padding: "20px 8px", textAlign: "center" }}>Habla con Héctor o dale una orden — esto es el inicio.</div>
            ) : (() => {
              // Slice + map con tracking de timestamp previo para inyectar
              // separadores de sesión cuando hay >4h entre mensajes.
              const SESSION_GAP_MS = 4 * 60 * 60 * 1000; // 4 horas
              const visibleMessages = chatHistory.slice(-CHAT_MAX);
              const fmtSessionDate = (ts) => {
                const d = new Date(ts);
                if (isNaN(d.getTime())) return "";
                return d.toLocaleDateString("es-ES", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
              };
              return visibleMessages.map((m, i) => {
              // Separador de sesión: si han pasado >4h desde el mensaje
              // anterior (o es el primero del array), insertamos una
              // línea horizontal con la fecha. SOLO presentación.
              const prev = i > 0 ? visibleMessages[i-1] : null;
              const showSeparator = !prev || (
                m.ts && prev.ts && (m.ts - prev.ts) > SESSION_GAP_MS
              );
              const separatorNode = showSeparator && m.ts && i > 0 ? (
                <div key={`sep_${i}`} style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  margin: "8px 0",
                  opacity: 0.4,
                  color: "#6B7280",
                }}>
                  <div style={{ flex: 1, height: 1, background: "currentColor" }} />
                  <span style={{ fontSize: 10.5, whiteSpace: "nowrap" }}>{fmtSessionDate(m.ts)} — nueva sesión</span>
                  <div style={{ flex: 1, height: 1, background: "currentColor" }} />
                </div>
              ) : null;
              // Burbuja de análisis dentro del chat (renderiza task cards).
              if (m.role === "hector_analysis" && m.analysis) {
                return (
                  <React.Fragment key={i}>
                    {separatorNode}
                  <div style={{ display: "flex", justifyContent: "flex-start", gap: 6, alignItems: "flex-start" }}>
                    <span style={{ fontSize: 14, lineHeight: "20px", flexShrink: 0 }}>🧙</span>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ padding: "10px 12px", background: "#F0F7FF", border: "0.5px solid #BFDBFE", borderRadius: "12px 12px 12px 0", maxWidth: "100%", boxSizing: "border-box" }}>
                        {m.analysis.thought && <div style={{ fontSize: 11, fontStyle: "italic", color: "#1E3A8A", marginBottom: 8 }}>💭 {m.analysis.thought}</div>}
                        {/* Summary como banner destacado arriba de las cards */}
                        {m.analysis.summary && (
                          <div style={{
                            backgroundColor: "#1A252F",
                            color: "white",
                            borderRadius: 8,
                            padding: "14px 18px",
                            marginBottom: 16,
                            fontSize: 13,
                            fontStyle: "italic",
                            lineHeight: 1.6,
                            display: "flex",
                            gap: 10,
                            alignItems: "flex-start",
                            maxWidth: "100%",
                            boxSizing: "border-box",
                            wordBreak: "break-word",
                          }}>
                            <span style={{ fontSize: 16, color: "white", flexShrink: 0 }}>💭</span>
                            <span style={{ flex: 1 }}>{m.analysis.summary}</span>
                          </div>
                        )}
                        {renderAnalysisGroups(m.analysis, handleViewTaskFromCard, handleCompleteFromCard, handlePostponeFromCard)}
                      </div>
                      <div style={{ fontSize: 9.5, color: "#9CA3AF", marginTop: 3, paddingLeft: 4 }}>{fmtTs(m.ts)}</div>
                    </div>
                  </div>
                  </React.Fragment>
                );
              }
              // Follow-up con 2 botones de respuesta rápida.
              if (m.role === "hector" && m.isFollowUp) {
                const closeAndComplete = () => {
                  completeFromCard(m.taskId);
                  removeBlockedTask(m.taskId);
                  setChatHistory((prev) => [...prev, { role: "hector", text: "✓ Cerrada y archivada.", ts: Date.now() }].slice(-CHAT_MAX));
                  publishTimeline(m.taskId, `Cerrada tras seguimiento del bloqueo. La gestión quedó resuelta.`);
                };
                const reactivate = () => {
                  removeBlockedTask(m.taskId);
                  setChatHistory((prev) => [...prev, { role: "hector", text: "Vale, la dejo activa para volver a recomendártela.", ts: Date.now() }].slice(-CHAT_MAX));
                  publishTimeline(m.taskId, `Reactivada tras seguimiento — el bloqueo no resolvió la situación.`);
                  lastCallTime.current = 0;
                  generateHectorThought();
                };
                return (
                  <React.Fragment key={i}>
                    {separatorNode}
                  <div style={{ display: "flex", justifyContent: "flex-start", gap: 6, alignItems: "flex-start" }}>
                    <span style={{ fontSize: 14, lineHeight: "20px" }}>🧙</span>
                    <div style={{ maxWidth: "82%" }}>
                      <div style={{ padding: "8px 10px", background: "#FFF8E1", border: "1px solid #FCD34D", borderRadius: "12px 12px 12px 0", fontSize: 12, color: "#78350F", lineHeight: 1.4 }}>
                        <div style={{ fontSize: 9.5, fontWeight: 700, color: "#92400E", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 4 }}>⏰ Seguimiento</div>
                        <div style={{ marginBottom: 8 }}>{m.text}</div>
                        <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                          <button onClick={closeAndComplete} style={{ padding: "3px 9px", borderRadius: 5, background: "#fff", color: "#065F46", border: "1px solid #86EFAC", fontSize: 10.5, fontWeight: 600, cursor: "pointer", fontFamily: "inherit" }}>✓ Cerrado</button>
                          <button onClick={reactivate}      style={{ padding: "3px 9px", borderRadius: 5, background: "#fff", color: "#92400E", border: "1px solid #FCD34D", fontSize: 10.5, fontWeight: 600, cursor: "pointer", fontFamily: "inherit" }}>↩ Necesita acción</button>
                        </div>
                      </div>
                      <div style={{ fontSize: 9.5, color: "#9CA3AF", marginTop: 3, paddingLeft: 4 }}>{fmtTs(m.ts)}</div>
                    </div>
                  </div>
                  </React.Fragment>
                );
              }
              const isUser = m.role === "user";
              return (
                <React.Fragment key={i}>
                  {separatorNode}
                <div style={{ display: "flex", justifyContent: isUser ? "flex-end" : "flex-start", gap: 6, alignItems: "flex-start" }}>
                  {!isUser && <span style={{ fontSize: 14, lineHeight: "20px" }}>🧙</span>}
                  <div style={{ maxWidth: "82%", display: "flex", flexDirection: "column", alignItems: isUser ? "flex-end" : "flex-start" }}>
                    <div style={{
                      padding: "8px 12px",
                      borderRadius: isUser ? "12px 12px 0 12px" : "12px 12px 12px 0",
                      background: isUser ? "#F0F0F0" : "#F0F7FF",
                      border: `0.5px solid ${isUser ? "#E5E7EB" : "#BFDBFE"}`,
                      fontSize: 12,
                      color: "#111827",
                      whiteSpace: "pre-wrap",
                      lineHeight: 1.4,
                      wordBreak: "break-word",
                    }}>{m.text}</div>
                    {/* Si Héctor incluyó un bloque [ACTIONS] en su respuesta,
                        renderizamos ActionProposal aquí. El CEO confirma o
                        descarta. El bloque ya viene parseado en m.proposal. */}
                    {!isUser && m.proposal && onRunAgentActions && (
                      <ActionProposal
                        proposal={m.proposal}
                        agentName="Héctor"
                        agentEmoji="🧙"
                        color="#3498DB"
                        onConfirm={async (selected) => {
                          await onRunAgentActions(selected);
                        }}
                        onCancel={() => {
                          // Marcamos la propuesta como descartada para no
                          // volver a renderizar el panel al re-hidratar.
                          setChatHistory(prev => prev.map((x, idx) => idx === i ? { ...x, proposal: null, proposalDiscarded: true } : x));
                        }}
                      />
                    )}
                    {/* Banner anti-fake-success (Capa 2): se ancla a la
                        burbuja afectada cuando el detector marca fakeSuccess
                        y no hay propuesta válida. Mismo wording exacto que
                        en HectorDirect para no fragmentar la experiencia. */}
                    {!isUser && m.fakeSuccess && !m.proposal && (
                      <div style={{
                        marginTop: 6,
                        padding: "8px 12px",
                        background: "#FEF3C7",
                        border: "1px solid #FCD34D",
                        borderRadius: 8,
                        fontSize: 12,
                        color: "#92400E",
                        lineHeight: 1.4,
                      }}>
                        ⚠ Héctor afirma éxito pero <b>no emitió ninguna acción real</b>. Nada se ha guardado. Reformula la orden o pídele explícitamente que ejecute.
                      </div>
                    )}
                    <div style={{ fontSize: 9.5, color: "#9CA3AF", marginTop: 3, paddingLeft: 4, paddingRight: 4 }}>{fmtTs(m.ts)}</div>
                  </div>
                </div>
                </React.Fragment>
              );
              });
            })()}
            {chatLoading && (
              <div style={{ display: "flex", gap: 6 }}>
                <span style={{ fontSize: 14, lineHeight: "20px" }}>🧙</span>
                <div style={{ padding: "8px 12px", borderRadius: "12px 12px 12px 0", background: "#F0F7FF", border: "0.5px solid #BFDBFE", fontSize: 12, color: "#6B7280", fontStyle: "italic" }}>Héctor está pensando…</div>
              </div>
            )}
            <div ref={chatEndRef} style={{ height: 1 }} />
          </div>
        )}
      </div>

      {/* Input fijo (60px) */}
      <form onSubmit={handleSubmit} data-hp="chat-form" style={{ height: 60, padding: "0 12px", display: "flex", gap: 6, alignItems: "center", borderTop: "0.5px solid #E5E7EB", background: "#FAFAFA", flexShrink: 0 }}>
        <input
          type="text"
          data-hp="chat-input"
          value={inputMessage}
          onChange={(e) => setInputMessage(e.target.value)}
          placeholder="Escribe una orden a Héctor..."
          disabled={chatLoading}
          style={{ flex: 1, padding: "9px 11px", borderRadius: 8, border: "1px solid #D1D5DB", fontSize: 12.5, fontFamily: "inherit", outline: "none", background: chatLoading ? "#F9FAFB" : "#fff" }}
        />
        <button
          type="button"
          data-hp="chat-mic"
          onClick={startListening}
          title={isListening ? "Detener dictado" : "Dictar por voz"}
          style={{ width: 36, height: 36, borderRadius: 8, background: isListening ? "#FEE2E2" : "#fff", color: isListening ? "#B91C1C" : "#6B7280", border: `1px solid ${isListening ? "#FCA5A5" : "#D1D5DB"}`, fontSize: 14, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", padding: 0, fontFamily: "inherit", animation: isListening ? "hp-mic-pulse 1.2s infinite" : "none" }}
        >🎤</button>
        <button
          type="submit"
          data-hp="chat-send"
          disabled={chatLoading || !inputMessage.trim()}
          style={{ padding: "9px 14px", borderRadius: 8, background: chatLoading || !inputMessage.trim() ? "#E5E7EB" : "#1D9E75", color: chatLoading || !inputMessage.trim() ? "#9CA3AF" : "#fff", border: "none", fontSize: 12, fontWeight: 600, cursor: chatLoading || !inputMessage.trim() ? "not-allowed" : "pointer", fontFamily: "inherit" }}
        >Enviar</button>
      </form>
      {/* Preview del dictado: lo que el reconocedor está oyendo en tiempo
          real, antes de marcar como final. En cursiva gris para que el
          usuario vea cómo se está interpretando su voz. */}
      {isListening && interimText && (
        <div style={{ padding: "4px 12px 8px", fontSize: 11.5, color: "#9CA3AF", fontStyle: "italic", display: "flex", alignItems: "center", gap: 6 }}>
          <span style={{ width: 6, height: 6, borderRadius: "50%", background: "#E24B4A", animation: "hp-pulse-dot 1.2s infinite" }} />
          <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{interimText}</span>
        </div>
      )}
      {isListening && !interimText && (
        <div style={{ padding: "4px 12px 8px", fontSize: 11.5, color: "#9CA3AF", display: "flex", alignItems: "center", gap: 6 }}>
          <span style={{ width: 6, height: 6, borderRadius: "50%", background: "#E24B4A", animation: "hp-pulse-dot 1.2s infinite" }} />
          <span>Escuchando… (pulsa el micro o Enviar cuando termines)</span>
        </div>
      )}
      {/* Botón flotante "↓ Ir al final" — solo en chat y solo cuando el
          CEO está scrolleado arriba (>200px del fondo). Posicionado
          relativo al panel (root tiene position:relative). Encima del
          input fijo (60px) con offset extra de 20px. */}
      {activeTab === "chat" && showScrollBtn && (
        <button
          onClick={() => {
            try {
              chatEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
            } catch {}
          }}
          style={{
            position: "absolute",
            bottom: 80,
            right: 16,
            background: "#3498DB",
            color: "white",
            border: "none",
            borderRadius: 20,
            padding: "6px 14px",
            fontSize: 13,
            cursor: "pointer",
            boxShadow: "0 2px 8px rgba(0,0,0,0.2)",
            zIndex: 10,
            fontFamily: "inherit",
            fontWeight: 600,
          }}
        >↓ Ir al final</button>
      )}
    </div>
  );
}
