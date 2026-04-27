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
import { PLAIN_TEXT_RULE, getEnergyLevel } from "../../lib/agent.js";
import { formatCeoMemoryForPrompt } from "../../lib/memory.js";

const STATE_LABEL = {
  analyzing:   { label: "Analizando…",  bg: "#FEF3C7", fg: "#92400E", border: "#F59E0B" },
  recommending:{ label: "Recomendando", bg: "#DCFCE7", fg: "#065F46", border: "#10B981" },
  listening:   { label: "Escuchando",   bg: "#DBEAFE", fg: "#1E40AF", border: "#3B82F6" },
  paused:      { label: "Pausado",      bg: "#F3F4F6", fg: "#6B7280", border: "#9CA3AF" },
};

const PRIORITY_STYLE = {
  urgent: { bg: "#FEE2E2", fg: "#991B1B", border: "#F87171", label: "URGENTE" },
  high:   { bg: "#FEF3C7", fg: "#92400E", border: "#F59E0B", label: "ALTA"    },
  medium: { bg: "#DBEAFE", fg: "#1E40AF", border: "#3B82F6", label: "MEDIA"   },
};

const FIVE_MIN_MS = 5 * 60 * 1000;
const HECTOR_VOICE = { gender: "male", rate: 1.1, pitch: 0.9 };
const CHAT_MAX = 50;

const timeAgo = (ts) => {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return "ahora";
  if (s < 3600) return `hace ${Math.floor(s / 60)} min`;
  if (s < 86400) return `hace ${Math.floor(s / 3600)} h`;
  return `hace ${Math.floor(s / 86400)} d`;
};

const speakRecommendation = (text) => {
  if (typeof window === "undefined" || !window.speechSynthesis) return;
  try { if (localStorage.getItem("hector_muted") === "1") return; } catch {}
  if (!text) return;
  try { speak(text, HECTOR_VOICE); }
  catch (e) { console.warn("[HectorPanel] speak fallo:", e?.message); }
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
    return {
      id: t.id,
      title: t.title,
      project: (t.project && (t.project.name || t.project)) || t.projName || "",
      priority: t.priority || "media",
      urgency,
      daysOverdue,
      diffDays,
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
  onOpenTask,
  userId,
  userName,
}) {
  const STORAGE_KEY = `soulbaric.hector.recs.${userId ?? "anon"}`;
  const CHAT_KEY = `soulbaric.hector.chat.${userId ?? "anon"}`;

  const [hectorState, setHectorState] = useState("listening");
  const [currentThought, setCurrentThought] = useState("Esperando contexto del día…");
  const [recommendations, setRecommendations] = useState(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed?.recommendations) ? parsed.recommendations.slice(0, 3) : [];
    } catch { return []; }
  });
  const [chatHistory, setChatHistory] = useState(() => {
    try {
      const raw = localStorage.getItem(CHAT_KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.slice(-CHAT_MAX) : [];
    } catch { return []; }
  });
  const [inputMessage, setInputMessage] = useState("");
  const [isListening, setIsListening] = useState(false);
  const [chatLoading, setChatLoading] = useState(false);
  const [isThinking, setIsThinking] = useState(false);
  const [expandedRecId, setExpandedRecId] = useState(null);
  const [thoughtFlash, setThoughtFlash] = useState(0);
  const [muted, setMuted] = useState(() => {
    try { return localStorage.getItem("hector_muted") === "1"; } catch { return false; }
  });

  // Refs para el contexto siempre fresco sin reinstalar el interval.
  const tasksRef = useRef(tasks);
  const riesgosRef = useRef(riesgos);
  const focusRef = useRef(currentFocus);
  const agentRef = useRef(agent);
  const memoryRef = useRef(ceoMemory);
  const chatHistoryRef = useRef(chatHistory);
  const recommendationsRef = useRef(recommendations);
  tasksRef.current = tasks;
  riesgosRef.current = riesgos;
  focusRef.current = currentFocus;
  agentRef.current = agent;
  memoryRef.current = ceoMemory;
  chatHistoryRef.current = chatHistory;
  recommendationsRef.current = recommendations;

  // Guards anti-bucle (proactive thought)
  const lastCallTime = useRef(0);
  const isGenerating = useRef(false);
  const lastRecTitleRef = useRef("");
  const cancelledRef = useRef(false);
  const stopListenRef = useRef(null);
  const chatScrollRef = useRef(null);

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

  // Persistencia: chat (últimos CHAT_MAX)
  useEffect(() => {
    try {
      localStorage.setItem(CHAT_KEY, JSON.stringify(chatHistory.slice(-CHAT_MAX)));
    } catch {}
  }, [chatHistory, CHAT_KEY]);

  // Auto-scroll al último mensaje
  useEffect(() => {
    const el = chatScrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [chatHistory.length, chatLoading]);

  const setState = (s) => { setHectorState(s); onStateChange?.(s); };

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
      const tasksWithContext = buildTasksWithContext(tasksNow, now);
      const top3 = tasksWithContext.slice(0, 3);
      const criticalRisks = riesgosNow.filter((r) => r.level === "critical");

      const baseSystem = ag?.promptBase
        ? ag.promptBase + "\n\n" + PLAIN_TEXT_RULE
        : "Eres Héctor, Chief of Staff estratégico. Conciso, directo, accionable. " + PLAIN_TEXT_RULE;
      const memBlock = formatCeoMemoryForPrompt(mem);
      const system = baseSystem
        + (memBlock ? ("\n\n---\n" + memBlock) : "")
        + "\n\nIMPORTANTE: en este turno responde ÚNICAMENTE con JSON válido sin markdown ni prosa. USA EL CAMPO \"urgency\" tal cual viene calculado — NO recalcules fechas absolutas y NO menciones la fecha cruda; siempre habla en términos relativos al momento actual.";

      // Lista enriquecida — Héctor recibe id, ref, título, proyecto y la
      // urgency PRE-CALCULADA. Le pedimos que copie estos campos tal cual.
      const tasksForPrompt = tasksWithContext.slice(0, 20).map((t) => ({
        taskId: t.id,
        ref: t.ref || null,
        title: t.title,
        board: t.project || "(sin proyecto)",
        priority: t.priority,
        urgency: t.urgency,
        daysOverdue: t.daysOverdue,
      }));
      const userPrompt = `Hora: ${now.toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit" })}.
Día: ${now.toLocaleDateString("es-ES", { weekday: "long" })} (${now.toLocaleDateString("es-ES")}).
Energía esperada del CEO: ${energyLevel}.
Tarea en foco: ${focusNow?.title || "Ninguna"}.
Tareas pendientes: ${tasksWithContext.length}.
Riesgos críticos: ${criticalRisks.length}.

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
      "timeframe": "ahora|hoy|esta semana"
    }
  ],
  "summary": "frase de cierre estratégica de 1 línea"
}

Reglas:
- Selecciona 1-5 tareas que el CEO debe atender. Vencidas y high-priority primero.
- urgencyLevel: "critical" si está vencida o vence en horas; "high" si vence hoy/mañana o priority alta; "medium" en el resto.
- NO inventes taskId — usa solo los de la lista.
- NO recalcules fechas — usa el campo urgency provisto.`;

      const r = await fetch("/api/agent", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ system, messages: [{ role: "user", content: userPrompt }], max_tokens: 800 }),
      });
      const raw = await r.text();
      if (cancelledRef.current) return;
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      let parsed = null; try { parsed = JSON.parse(raw); } catch {}
      const text = parsed?.text || raw;
      const m = text.match(/\{[\s\S]*\}/);
      if (!m) throw new Error("JSON no encontrado en respuesta");
      const decision = JSON.parse(m[0]);
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
        })) : [],
      };
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
      // Voz: lee el summary (más estratégico que cada acción individual).
      if (analysis.summary) speakRecommendation(analysis.summary);
    } catch (e) {
      if (cancelledRef.current) return;
      console.warn("[HectorPanel] generateHectorThought fallo:", e?.message);
      setState("paused");
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
    if (parsed.action === "complete_task") {
      onCompleteTask?.(task.id, task.projId, task.colId);
    } else if (parsed.action === "postpone_task") {
      // Posponer +1 día por defecto. App calcula la fecha label.
      onPostponeTask?.(task);
    } else if (parsed.action === "assign_task") {
      onAssignTask?.(task, parsed.assigneeId);
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
      const system = baseSystem
        + (memBlock ? ("\n\n---\n" + memBlock) : "")
        + "\n\nIMPORTANTE: en este turno responde ÚNICAMENTE con JSON válido sin markdown ni prosa. USA EL CAMPO \"urgency\" de cada tarea tal cual viene calculado — NO recalcules fechas absolutas; habla en términos relativos al momento actual.";

      // Tareas con urgencia calculada en tiempo real para que Héctor no
      // razone sobre fechas absolutas y no diga "vence 2024-12-15" cuando
      // hoy ya estamos en 2026.
      const tasksWithContext = buildTasksWithContext(tasksNow, now);
      const tasksList = tasksWithContext.slice(0, 30).map((t) => `- ${t.id} :: ${t.title} · proyecto ${t.project} · prio ${t.priority} · ${t.urgency}`).join("\n") || "(ninguna)";
      const histLines = (chatHistoryRef.current || []).slice(-8).map((m) => `${m.role === "user" ? "CEO" : "Héctor"}: ${m.text}`).join("\n");

      const userPrompt = `Hora: ${now.toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit" })} (${now.toLocaleDateString("es-ES")}).
Última recomendación tuya: ${recsNow[0]?.title || "(ninguna)"}.
Tarea en foco: ${focusNow?.title || "Ninguna"}.
Riesgos críticos: ${riesgosNow.filter((r) => r.level === "critical").length}.

TAREAS DISPONIBLES (id :: título · proyecto · prio · urgency):
${tasksList}

CONVERSACIÓN PREVIA (últimos turnos):
${histLines || "(sin turnos previos)"}

EL CEO TE DICE AHORA:
"${userMessage}"

Devuelve JSON estricto. Si solo es conversación:
{"reply":"tu respuesta breve","action":"none"}
Si pide ejecutar algo (marcar hecho, posponer, asignar) usa una acción y referencia la tarea por id real:
{"reply":"confirmación verbal corta","action":"complete_task|postpone_task|assign_task","taskId":"id de la tarea","taskTitle":"título","message":"detalle de lo hecho"}`;

      const r = await fetch("/api/agent", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ system, messages: [{ role: "user", content: userPrompt }], max_tokens: 400 }),
      });
      const raw = await r.text();
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      let proxied = null; try { proxied = JSON.parse(raw); } catch {}
      const text = proxied?.text || raw;
      const m = text.match(/\{[\s\S]*\}/);
      if (!m) throw new Error("JSON no encontrado");
      const parsedReply = JSON.parse(m[0]);
      const reply = (parsedReply.reply || "").trim();
      setChatHistory((prev) => [...prev, { role: "hector", text: reply || "(sin respuesta)", ts: Date.now() }].slice(-CHAT_MAX));
      executeAction(parsedReply);
      if (reply) speakRecommendation(reply);
    } catch (e) {
      console.warn("[HectorPanel] sendOrderToHector fallo:", e?.message);
      setChatHistory((prev) => [...prev, { role: "hector", text: `⚠ ${e.message || "Error procesando orden"}`, ts: Date.now() }].slice(-CHAT_MAX));
    } finally {
      setChatLoading(false);
    }
  };

  // SpeechRecognition para dictado por voz (lib voice.listen → es-ES).
  const startListening = () => {
    if (isListening) {
      try { stopListenRef.current?.(); } catch {}
      setIsListening(false);
      return;
    }
    setIsListening(true);
    const stop = listen({
      onInterim: (t) => setInputMessage(t),
      onFinal: (t) => {
        setIsListening(false);
        sendOrderToHector(t);
      },
      onError: (e) => {
        console.warn("[HectorPanel] listen error:", e?.message);
        setIsListening(false);
      },
      onEnd: () => setIsListening(false),
    });
    stopListenRef.current = stop;
  };

  // Setup proactivo: una sola vez con interval cada 60s + throttle interno.
  useEffect(() => {
    cancelledRef.current = false;
    generateHectorThought();
    const id = setInterval(generateHectorThought, 60 * 1000);
    return () => { cancelledRef.current = true; clearInterval(id); try { stopListenRef.current?.(); } catch {} };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
    sendOrderToHector(inputMessage);
  };

  const handleImplementRec = (rec) => {
    setExpandedRecId(null);
    onRecommendationClick?.(rec);
    sendOrderToHector(`Implementa esta recomendación: ${rec.title}`);
  };

  const stateInfo = STATE_LABEL[hectorState] || STATE_LABEL.listening;
  const displayName = userName || userId || "CEO";

  return (
    <div style={{
      backgroundColor: "white",
      border: "2px solid #3498DB",
      borderRadius: 12,
      padding: 20,
      boxShadow: "0 4px 16px rgba(52,152,219,0.15)",
      fontFamily: "inherit",
      display: "flex",
      flexDirection: "column",
      gap: 14,
    }}>
      <style>{`
        @keyframes hp-fade { from { opacity: 0; transform: translateY(2px);} to { opacity: 1; transform: translateY(0);} }
        @keyframes hp-pulse-dot { 0%,100% { opacity:1;} 50% { opacity:0.4;} }
        @keyframes hp-mic-pulse { 0%,100% { box-shadow: 0 0 0 0 rgba(231,76,60,0.55);} 50% { box-shadow: 0 0 0 6px rgba(231,76,60,0);} }
      `}</style>

      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <div style={{ width: 38, height: 38, borderRadius: "50%", background: "linear-gradient(135deg,#1D9E75,#0E7C5A)", color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 20 }}>🧙</div>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: "#111827", lineHeight: 1.1 }}>Héctor</div>
          <div style={{ fontSize: 10.5, color: "#6B7280" }}>Chief of Staff · {displayName}</div>
        </div>
        <button onClick={toggleMute} title={muted ? "Activar voz de Héctor" : "Silenciar voz de Héctor"} style={{ background: "transparent", border: "1px solid #E5E7EB", borderRadius: 8, width: 30, height: 30, fontSize: 14, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", padding: 0, fontFamily: "inherit", color: muted ? "#9CA3AF" : "#1D9E75" }}>{muted ? "🔇" : "🔊"}</button>
        <span style={{ fontSize: 10.5, fontWeight: 700, padding: "3px 9px", borderRadius: 12, background: stateInfo.bg, color: stateInfo.fg, border: `1px solid ${stateInfo.border}`, display: "inline-flex", alignItems: "center", gap: 5 }}>
          <span style={{ width: 6, height: 6, borderRadius: "50%", background: stateInfo.border, animation: isThinking ? "hp-pulse-dot 1.2s infinite" : "none" }} />
          {stateInfo.label}
        </span>
      </div>

      {/* Pensamiento actual */}
      <div key={thoughtFlash} style={{
        background: "#F0F7FF",
        border: "2px solid #3498DB",
        borderRadius: 10,
        padding: "10px 14px",
        fontSize: 12.5,
        color: "#1E3A8A",
        lineHeight: 1.5,
        animation: "hp-fade .35s ease",
        display: "flex",
        gap: 8,
        alignItems: "flex-start",
      }}>
        <span style={{ fontSize: 14 }}>💭</span>
        <span style={{ flex: 1 }}>{currentThought || "—"}</span>
      </div>

      {/* Recomendaciones */}
      <div>
        <div style={{ fontSize: 10.5, fontWeight: 700, color: "#6B7280", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 6 }}>Recomendaciones</div>
        {recommendations.length === 0 ? (
          <div style={{ fontSize: 12, color: "#9CA3AF", fontStyle: "italic", padding: "8px 0" }}>Aún sin recomendaciones — Héctor está observando.</div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {recommendations.map((rec) => {
              const pri = PRIORITY_STYLE[rec.priority] || PRIORITY_STYLE.medium;
              const isExpanded = expandedRecId === rec.id;
              return (
                <div key={rec.id} style={{
                  border: `1px solid ${pri.border}55`,
                  borderLeft: `4px solid ${pri.border}`,
                  borderRadius: 8,
                  background: "#fff",
                  overflow: "hidden",
                  cursor: "pointer",
                }} onClick={() => setExpandedRecId(isExpanded ? null : rec.id)}>
                  <div style={{ padding: "10px 12px", display: "flex", alignItems: "center", gap: 8 }}>
                    <span style={{ fontSize: 9.5, fontWeight: 700, padding: "2px 7px", borderRadius: 10, background: pri.bg, color: pri.fg, border: `1px solid ${pri.border}`, flexShrink: 0 }}>{pri.label}</span>
                    <span style={{ flex: 1, minWidth: 0, fontSize: 12.5, color: "#111827", fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{rec.title}</span>
                    <span style={{ fontSize: 10, color: "#9CA3AF", flexShrink: 0 }}>{timeAgo(rec.ts)}</span>
                  </div>
                  {isExpanded && (
                    <div style={{ padding: "0 12px 10px", borderTop: "0.5px solid #F3F4F6" }}>
                      <div style={{ fontSize: 11.5, color: "#374151", lineHeight: 1.5, marginTop: 8, marginBottom: 8 }}>{rec.reason}</div>
                      {rec.timeframe && <div style={{ fontSize: 10.5, color: "#6B7280", marginBottom: 10 }}>⏱ Marco: <b style={{ color: "#374151" }}>{rec.timeframe}</b></div>}
                      <div style={{ display: "flex", gap: 6 }} onClick={(e) => e.stopPropagation()}>
                        <button onClick={() => handleImplementRec(rec)} style={{ padding: "6px 12px", borderRadius: 6, background: "#1D9E75", color: "#fff", border: "none", fontSize: 11.5, fontWeight: 600, cursor: "pointer", fontFamily: "inherit" }}>Implementar</button>
                        <button onClick={() => { setExpandedRecId(null); }} style={{ padding: "6px 12px", borderRadius: 6, background: "#fff", color: "#92400E", border: "1px solid #FCD34D", fontSize: 11.5, fontWeight: 600, cursor: "pointer", fontFamily: "inherit" }}>Posponer</button>
                        <button onClick={() => { setRecommendations((r) => r.filter((x) => x.id !== rec.id)); setExpandedRecId(null); }} style={{ padding: "6px 12px", borderRadius: 6, background: "transparent", color: "#6B7280", border: "1px solid #D1D5DB", fontSize: 11.5, fontWeight: 600, cursor: "pointer", fontFamily: "inherit" }}>Cerrar</button>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Chat bidireccional */}
      <div>
        <div style={{ fontSize: 10.5, fontWeight: 700, color: "#6B7280", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 6 }}>Conversación</div>
        <div ref={chatScrollRef} style={{
          maxHeight: 240,
          overflowY: "auto",
          padding: "8px 4px",
          background: "#FAFAFA",
          border: "1px solid #F3F4F6",
          borderRadius: 8,
          marginBottom: 8,
          display: "flex",
          flexDirection: "column",
          gap: 6,
        }}>
          {chatHistory.length === 0 ? (
            <div style={{ fontSize: 11.5, color: "#9CA3AF", fontStyle: "italic", padding: "10px 8px", textAlign: "center" }}>Habla con Héctor o dale una orden — esto es el inicio.</div>
          ) : chatHistory.slice(-CHAT_MAX).map((m, i) => {
            // Mensaje rico de análisis estructurado: agrupa por urgencyLevel
            // y renderiza una card por tarea con acciones inline.
            if (m.role === "hector_analysis" && m.analysis) {
              const groups = [
                { key: "critical", label: "🔴 URGENTE",      bg: "#FEE2E2", fg: "#991B1B", border: "#FCA5A5", urgencyColor: "#B91C1C" },
                { key: "high",     label: "🟠 HOY",          bg: "#FEF3C7", fg: "#92400E", border: "#FCD34D", urgencyColor: "#B45309" },
                { key: "medium",   label: "🟡 ESTA SEMANA",  bg: "#FEF9C3", fg: "#854D0E", border: "#FDE68A", urgencyColor: "#A16207" },
              ];
              return (
                <div key={i} style={{ display: "flex", justifyContent: "flex-start", gap: 6, alignItems: "flex-start", padding: "0 6px" }}>
                  <span style={{ fontSize: 14, lineHeight: "20px", flexShrink: 0 }}>🧙</span>
                  <div style={{ flex: 1, minWidth: 0, padding: "8px 10px", borderRadius: 10, background: "#F0F7FF", border: "0.5px solid #BFDBFE" }}>
                    {m.analysis.thought && (
                      <div style={{ fontSize: 11, fontStyle: "italic", color: "#1E3A8A", marginBottom: 8 }}>💭 {m.analysis.thought}</div>
                    )}
                    {groups.map((g) => {
                      const items = (m.analysis.tasks || []).filter((t) => t.urgencyLevel === g.key);
                      if (!items.length) return null;
                      return (
                        <div key={g.key} style={{ marginBottom: 8 }}>
                          <div style={{ fontSize: 9.5, fontWeight: 700, color: g.fg, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 4 }}>{g.label}</div>
                          <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                            {items.map((t, j) => (
                              <div key={`${i}-${g.key}-${j}`} style={{ background: "#fff", border: `1px solid ${g.border}`, borderLeft: `4px solid ${g.border}`, borderRadius: 8, padding: "7px 9px" }}>
                                <div style={{ display: "flex", alignItems: "center", gap: 5, marginBottom: 3, flexWrap: "wrap" }}>
                                  {t.ref && (
                                    <button
                                      onClick={() => goToTask(t.taskId, t.title)}
                                      title={`Ir a ${t.ref}`}
                                      style={{ fontSize: 9.5, padding: "1px 6px", borderRadius: 4, background: "#F3F4F6", color: "#374151", border: "0.5px solid #E5E7EB", fontFamily: "ui-monospace,monospace", fontWeight: 700, cursor: "pointer" }}
                                    >{t.ref}</button>
                                  )}
                                  <span style={{ flex: 1, minWidth: 0, fontSize: 12, fontWeight: 700, color: "#111827", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{t.title}</span>
                                  {t.board && (
                                    <span style={{ fontSize: 9.5, padding: "1px 6px", borderRadius: 10, background: "#EEEDFE", color: "#3C3489", border: "0.5px solid #AFA9EC", fontWeight: 600, flexShrink: 0 }}>{t.board}</span>
                                  )}
                                </div>
                                <div style={{ fontSize: 10.5, color: g.urgencyColor, fontWeight: 600, marginBottom: 4 }}>{t.urgency}</div>
                                {t.action && <div style={{ fontSize: 11, color: "#374151", fontStyle: "italic", marginBottom: 6 }}>{t.action}</div>}
                                <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                                  <button onClick={() => goToTask(t.taskId, t.title)}      style={{ padding: "3px 8px", borderRadius: 5, background: "#fff", color: "#1E40AF", border: "1px solid #BFDBFE", fontSize: 10.5, fontWeight: 600, cursor: "pointer", fontFamily: "inherit" }}>→ Ver tarea</button>
                                  <button onClick={() => completeFromCard(t.taskId, t.title)} style={{ padding: "3px 8px", borderRadius: 5, background: "#fff", color: "#065F46", border: "1px solid #86EFAC", fontSize: 10.5, fontWeight: 600, cursor: "pointer", fontFamily: "inherit" }}>✓ Hecho</button>
                                  <button onClick={() => postponeFromCard(t.taskId, t.title)} style={{ padding: "3px 8px", borderRadius: 5, background: "#fff", color: "#92400E", border: "1px solid #FCD34D", fontSize: 10.5, fontWeight: 600, cursor: "pointer", fontFamily: "inherit" }}>⏸ Posponer</button>
                                </div>
                              </div>
                            ))}
                          </div>
                        </div>
                      );
                    })}
                    {m.analysis.summary && (
                      <div style={{ fontSize: 11.5, color: "#1E3A8A", fontWeight: 600, marginTop: 6, paddingTop: 6, borderTop: "0.5px dashed #BFDBFE" }}>{m.analysis.summary}</div>
                    )}
                  </div>
                </div>
              );
            }
            const isUser = m.role === "user";
            return (
              <div key={i} style={{ display: "flex", justifyContent: isUser ? "flex-end" : "flex-start", gap: 6, alignItems: "flex-start", padding: "0 6px" }}>
                {!isUser && <span style={{ fontSize: 14, lineHeight: "20px" }}>🧙</span>}
                <div style={{
                  maxWidth: "82%",
                  padding: "7px 10px",
                  borderRadius: 10,
                  background: isUser ? "#F0F0F0" : "#F0F7FF",
                  border: `0.5px solid ${isUser ? "#E5E7EB" : "#BFDBFE"}`,
                  fontSize: 12,
                  color: "#111827",
                  whiteSpace: "pre-wrap",
                  lineHeight: 1.4,
                  wordBreak: "break-word",
                }}>{m.text}</div>
              </div>
            );
          })}
          {chatLoading && (
            <div style={{ display: "flex", gap: 6, padding: "0 6px" }}>
              <span style={{ fontSize: 14, lineHeight: "20px" }}>🧙</span>
              <div style={{ padding: "7px 10px", borderRadius: 10, background: "#F0F7FF", border: "0.5px solid #BFDBFE", fontSize: 12, color: "#6B7280", fontStyle: "italic" }}>Héctor está pensando…</div>
            </div>
          )}
        </div>

        {/* Input bar */}
        <form onSubmit={handleSubmit} style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <input
            type="text"
            value={inputMessage}
            onChange={(e) => setInputMessage(e.target.value)}
            placeholder="Escribe una orden a Héctor…"
            disabled={chatLoading}
            style={{ flex: 1, padding: "8px 10px", borderRadius: 8, border: "1px solid #D1D5DB", fontSize: 12.5, fontFamily: "inherit", outline: "none", background: chatLoading ? "#F9FAFB" : "#fff" }}
          />
          <button
            type="button"
            onClick={startListening}
            title={isListening ? "Detener dictado" : "Dictar por voz"}
            style={{
              width: 36,
              height: 36,
              borderRadius: 8,
              background: isListening ? "#FEE2E2" : "#fff",
              color: isListening ? "#B91C1C" : "#6B7280",
              border: `1px solid ${isListening ? "#FCA5A5" : "#D1D5DB"}`,
              fontSize: 14,
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              padding: 0,
              fontFamily: "inherit",
              animation: isListening ? "hp-mic-pulse 1.2s infinite" : "none",
            }}
          >🎤</button>
          <button
            type="submit"
            disabled={chatLoading || !inputMessage.trim()}
            style={{ padding: "8px 14px", borderRadius: 8, background: chatLoading || !inputMessage.trim() ? "#E5E7EB" : "#1D9E75", color: chatLoading || !inputMessage.trim() ? "#9CA3AF" : "#fff", border: "none", fontSize: 12, fontWeight: 600, cursor: chatLoading || !inputMessage.trim() ? "not-allowed" : "pointer", fontFamily: "inherit" }}
          >Enviar</button>
        </form>
      </div>
    </div>
  );
}
