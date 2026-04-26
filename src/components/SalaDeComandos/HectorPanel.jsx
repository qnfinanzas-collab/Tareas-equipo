// HectorPanel — análisis proactivo visible. Comparte el MISMO stack que el
// resto de la app:
//   • voz: speak() de lib/voice.js con la config exacta de Héctor
//     (gender:"male", rate:1.1, pitch:0.9) → la lib hace pickVoice("male"),
//     getVoicesReady() y exclusión de voces femeninas.
//   • prompt: agent.promptBase + PLAIN_TEXT_RULE (igual que decideFocus y
//     NegotiationDetailView) + memoria CEO formateada con
//     formatCeoMemoryForPrompt para que Héctor "recuerde" entre sesiones.
//   • energía: getEnergyLevel(hour) compartido en lib/agent.js.
//   • persistencia: las recomendaciones se guardan en localStorage con
//     clave scoped por usuario y se rehidratan al montar — sobreviven a
//     reloads y permiten que Héctor aprenda iterativamente del histórico.
import React, { useEffect, useState, useRef } from "react";
import { speak, stopSpeaking } from "../../lib/voice.js";
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
// Misma config de voz que en NegotiationDetailView (App.jsx:6072) y que la
// guardada en data.agents para Héctor: {gender:"male", rate:1.1, pitch:0.9}.
const HECTOR_VOICE = { gender: "male", rate: 1.1, pitch: 0.9 };

const timeAgo = (ts) => {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return "ahora";
  if (s < 3600) return `hace ${Math.floor(s / 60)} min`;
  if (s < 86400) return `hace ${Math.floor(s / 3600)} h`;
  return `hace ${Math.floor(s / 86400)} d`;
};

// Voz: delega en speak() de lib/voice.js — la MISMA función que usa Héctor
// en Deal Room. Respeta la preferencia "hector_muted" en localStorage.
const speakRecommendation = (text) => {
  if (typeof window === "undefined" || !window.speechSynthesis) return;
  try { if (localStorage.getItem("hector_muted") === "1") return; } catch {}
  if (!text) return;
  try { speak(text, HECTOR_VOICE); }
  catch (e) { console.warn("[HectorPanel] speak fallo:", e?.message); }
};

export default function HectorPanel({
  tasks = [],
  currentFocus = null,
  riesgos = [],
  agent,                 // Héctor de data.agents (con promptBase real)
  ceoMemory,             // data.ceoMemory (preferences, keyFacts, decisions, lessons)
  onRecommendationClick,
  onStateChange,
  onNewRecommendation,
  userId,                // userId numérico — clave para localStorage
  userName,              // display name (lo viejo `userId` se vuelve userName por compat)
}) {
  // Clave de localStorage scoped por usuario (mismo patrón que FOCUS_CACHE_KEY).
  const STORAGE_KEY = `soulbaric.hector.recs.${userId ?? "anon"}`;

  const [hectorState, setHectorState] = useState("listening");
  const [currentThought, setCurrentThought] = useState("Esperando contexto del día…");
  const [recommendations, setRecommendations] = useState(()=>{
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if(!raw) return [];
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed?.recommendations) ? parsed.recommendations.slice(0,3) : [];
    } catch { return []; }
  });
  const [isThinking, setIsThinking] = useState(false);
  const [expandedRecId, setExpandedRecId] = useState(null);
  const [thoughtFlash, setThoughtFlash] = useState(0);
  const [muted, setMuted] = useState(() => {
    try { return localStorage.getItem("hector_muted") === "1"; } catch { return false; }
  });

  // Refs para que generateHectorThought lea SIEMPRE el valor más reciente
  // sin reinstalar el interval (deps refs no cambian la identidad).
  const tasksRef = useRef(tasks);
  const riesgosRef = useRef(riesgos);
  const focusRef = useRef(currentFocus);
  const agentRef = useRef(agent);
  const memoryRef = useRef(ceoMemory);
  tasksRef.current = tasks;
  riesgosRef.current = riesgos;
  focusRef.current = currentFocus;
  agentRef.current = agent;
  memoryRef.current = ceoMemory;

  // Guards anti-bucle
  const lastCallTime = useRef(0);
  const isGenerating = useRef(false);
  const lastRecTitleRef = useRef("");
  const cancelledRef = useRef(false);

  // Persiste recomendaciones cada vez que cambian. localStorage con misma
  // convención de claves que el resto de la app (soulbaric.* scoped).
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        recommendations,
        lastRecTitle: lastRecTitleRef.current,
        ts: Date.now(),
      }));
    } catch {}
  }, [recommendations, STORAGE_KEY]);

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
      const pending = tasksNow.filter((t) => t.colName !== "Hecho" && t.colName !== "Cancelada");
      const top3 = pending
        .slice()
        .sort((a, b) => {
          const da = a.dueDate ? new Date(a.dueDate).getTime() : Infinity;
          const db = b.dueDate ? new Date(b.dueDate).getTime() : Infinity;
          return da - db;
        })
        .slice(0, 3);
      const criticalRisks = riesgosNow.filter((r) => r.level === "critical");

      // System prompt — promptBase real de Héctor + reglas comunes. Mismo
      // patrón que decideFocus (App.jsx:3950-3954) y NegotiationDetailView.
      const baseSystem = ag?.promptBase
        ? ag.promptBase + "\n\n" + PLAIN_TEXT_RULE
        : "Eres Héctor, Chief of Staff estratégico. Conciso, directo, accionable. " + PLAIN_TEXT_RULE;
      const memBlock = formatCeoMemoryForPrompt(mem);
      const system = baseSystem
        + (memBlock ? ("\n\n---\n" + memBlock) : "")
        + "\n\nIMPORTANTE: en este turno responde ÚNICAMENTE con JSON válido sin markdown ni prosa.";

      const userPrompt = `Hora: ${now.toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit" })}.
Día: ${now.toLocaleDateString("es-ES", { weekday: "long" })}.
Energía esperada del CEO: ${energyLevel}.
Tarea en foco: ${focusNow?.title || "Ninguna"}.
Tareas pendientes: ${pending.length}.
Riesgos críticos: ${criticalRisks.length}.
Top 3 tareas por urgencia:
${top3.map((t) => `- ${t.title}${t.dueDate ? ` (vence ${t.dueDate})` : ""}`).join("\n") || "(ninguna)"}
Riesgos activos:
${riesgosNow.slice(0, 5).map((r) => `- ${r.title || r.label || r.msg || ""}`).join("\n") || "(ninguno)"}

Devuelve JSON estricto con esta forma exacta:
{"thought":"qué estás analizando en 1 línea","recommendation":"acción concreta recomendada","reason":"por qué en máximo 2 líneas","priority":"urgent|high|medium","timeframe":"30min|1h|today"}`;

      const r = await fetch("/api/agent", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ system, messages: [{ role: "user", content: userPrompt }], max_tokens: 300 }),
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
      setCurrentThought(decision.thought || "");
      setThoughtFlash((v) => v + 1);
      const recTitle = (decision.recommendation || "").trim();
      // Dedup: misma recomendación que la última = no añadir, no leer voz.
      if (recTitle && recTitle === lastRecTitleRef.current) {
        setState("listening");
        return;
      }
      const rec = {
        id: `rec_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        title: recTitle,
        reason: decision.reason || "",
        priority: decision.priority || "medium",
        timeframe: decision.timeframe || "today",
        ts: Date.now(),
      };
      lastRecTitleRef.current = recTitle;
      setRecommendations((prev) => [rec, ...prev].slice(0, 3));
      setState("recommending");
      onNewRecommendation?.(rec);
      speakRecommendation(rec.title);
    } catch (e) {
      if (cancelledRef.current) return;
      console.warn("[HectorPanel] generateHectorThought fallo:", e?.message);
      setState("paused");
    } finally {
      isGenerating.current = false;
      if (!cancelledRef.current) setIsThinking(false);
    }
  };

  // Setup UNA sola vez: trigger inmediato + interval cada 60 s con throttle
  // real de 5 min dentro de la función. No depende de tasks/riesgos.
  useEffect(() => {
    cancelledRef.current = false;
    generateHectorThought();
    const id = setInterval(generateHectorThought, 60 * 1000);
    return () => { cancelledRef.current = true; clearInterval(id); };
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
    }}>
      <style>{`
        @keyframes hp-fade { from { opacity: 0; transform: translateY(2px);} to { opacity: 1; transform: translateY(0);} }
        @keyframes hp-pulse-dot { 0%,100% { opacity:1;} 50% { opacity:0.4;} }
      `}</style>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14 }}>
        <div style={{ width: 38, height: 38, borderRadius: "50%", background: "linear-gradient(135deg,#1D9E75,#0E7C5A)", color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 20 }}>🧙</div>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: "#111827", lineHeight: 1.1 }}>Héctor</div>
          <div style={{ fontSize: 10.5, color: "#6B7280" }}>Chief of Staff · {displayName}</div>
        </div>
        <button
          onClick={toggleMute}
          title={muted ? "Activar voz de Héctor" : "Silenciar voz de Héctor"}
          style={{ background: "transparent", border: "1px solid #E5E7EB", borderRadius: 8, width: 30, height: 30, fontSize: 14, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", padding: 0, fontFamily: "inherit", color: muted ? "#9CA3AF" : "#1D9E75" }}
        >{muted ? "🔇" : "🔊"}</button>
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
        marginBottom: 14,
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
      <div style={{ fontSize: 10.5, fontWeight: 700, color: "#6B7280", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 6 }}>Recomendaciones</div>
      {recommendations.length === 0 ? (
        <div style={{ fontSize: 12, color: "#9CA3AF", fontStyle: "italic", padding: "10px 0" }}>Aún sin recomendaciones — Héctor está observando.</div>
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
                      <button onClick={() => { onRecommendationClick?.(rec); setExpandedRecId(null); }} style={{ padding: "6px 12px", borderRadius: 6, background: "#1D9E75", color: "#fff", border: "none", fontSize: 11.5, fontWeight: 600, cursor: "pointer", fontFamily: "inherit" }}>Implementar</button>
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
  );
}
