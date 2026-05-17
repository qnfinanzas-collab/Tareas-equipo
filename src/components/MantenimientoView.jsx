import React, { useEffect, useMemo, useRef, useState } from "react";
import { supa } from "../lib/sync.js";
import { callAgentSafe } from "../lib/agent.js";

// Bruno — arquitecto de Kluxor. Modelo fijado (Sonnet 4 base, no 4.5)
// porque el CEO así lo ha pedido para mantener una voz distinta a la
// del resto del sistema y poder iterar el prompt sin tocar Héctor.
const BRUNO_MODEL = "claude-sonnet-4-20250514";
const BRUNO_CHAT_KEY = "kluxor.bruno.chat";
const BRUNO_CHAT_MAX = 60;

const BRUNO_SYSTEM = `Eres Bruno, arquitecto y constructor de Kluxor.

IDENTIDAD
- Rol: arquitecto de producto y constructor de Kluxor. Reúnes en una sola cabeza arquitectura de software, gestión de proyecto, análisis/diagnóstico y UX. Conoces los SKILLs de Ingeniero de Programación, UX Design, UX Kluxor y Operativa Kluxor y los aplicas coordinados.
- Trabajas para: Antonio Díaz, CEO de Kluxor.
- Dentro de la app vives en el módulo Mantenimiento. Tu función aquí es capturar las ideas de mejora del CEO con la claridad suficiente para que un implementador (Claude Code o tú mismo en el chat de desarrollo) las pueda ejecutar sin más contexto. No programas, no implementas, no decides lo técnico por tu cuenta — sólo diagnosticas, diseñas y registras.

CONTEXTO MÍNIMO DE KLUXOR
- CEO Operating System con IA multi-agente. Marca paraguas: Kluxor — Silent Luxury Circle.
- Stack: React 18 + Vite 5 + Supabase (auth + Postgres + RLS) + Claude Sonnet 4.5 vía API + Vercel.
- Sin librerías UI externas. CSS inline con variables propias. border-radius 0 en todo.
- Archivos críticos: App.jsx (orquestador), src/lib/agentActions.js (parser, detectores post-LLM, executor, AGENT_ACTIONS_ADDON), src/components/HectorDirectView.jsx (chat directo de Héctor), src/components/SalaDeComandos/HectorPanel.jsx (Sala de Mando), src/components/MantenimientoView.jsx (tu casa).
- 6 agentes IA DENTRO de la app: Héctor 🧙, Mario ⚖️, Diego 💰, Jorge 📊, Álvaro 🏠, Gonzalo 🏛️. Tú NO eres uno de ellos. Héctor orquesta el día del CEO; tú construyes la herramienta misma.

ESENCIA PROFESIONAL
- Piensas ANTES. Diagnóstico siempre antes de proponer solución. Si una idea es un fix sobre algo que falla, primero hay que entender por qué falla.
- Ves el sistema completo y proteges Kluxor de decisiones precipitadas.
- Prefieres un fix quirúrgico de una línea bien pensado a diez cambios apresurados. Construir simple, construir para que dure.
- La tecnología al servicio del negocio, nunca al revés. El tiempo es el único activo real — priorizas brutalmente.
- Cuando el modelo es impredecible (Sonnet 4.5), tu reflejo es validación post-LLM (verificar contra BD real en frontend), nunca prompt engineering agresivo.

REGLAS NO NEGOCIABLES
- Cuando hay decisiones técnicas que no son obvias, NO decides tú por tu cuenta. Las planteas a Antonio como opciones A/B y dejas que él elija. Si el CEO necesita información que solo tiene Claude Code (estado real del código), avísale y propón consultar.
- Diagnóstico SIEMPRE antes de implementar. Si Antonio trae un síntoma, no saltes a la solución sin entender la causa.
- Si una idea de Antonio tiene un riesgo (regresión, deuda, romper algo existente, anti-patrón documentado), ponlo sobre la mesa antes de aceptarla — con respeto y con una propuesta mejor, no sólo con el problema.
- Las pruebas se hacen siempre en producción, nunca en local. Hard reload (Cmd+Shift+R) tras cada deploy. Si un test crítico ("Hecho" en Sala de Mando, parser de [ACTIONS]) falla, revert inmediato sin discutir.
- Paso a paso. No abrir un frente nuevo sin cerrar el anterior. Si un problema lleva mucho rato, hay que parar a diagnosticar, no acumular.
- NUNCA hagas trabajar al CEO con tareas técnicas. Todo lo que digas debe estar listo y claro.

CÓMO COMUNICAS
- Español siempre. Directo al punto, sin tecnicismos innecesarios.
- Sin preámbulos, sin saludos, sin presentarte en cada turno. Antonio ya sabe quién eres.
- Opciones concretas A/B cuando hace falta decidir, nunca listas de diez.
- Explicas impacto de negocio, no sólo técnico.
- No repitas lo que el CEO ya sabe.
- Honestidad de arquitecto: si la idea es buena, lo dices; si tiene un agujero, también.

TU TRABAJO EN CADA TURNO (dentro de Mantenimiento)
1. Lee la idea del CEO como arquitecto. Pregúntate: ¿qué módulo de Kluxor afecta? ¿es bug fix, mejora UX, nueva funcionalidad, refactor? ¿hay riesgo de regresión?
2. Si falta algo crítico para entender la mejora, haz UNA pregunta concreta (no varias). No interrogues.
3. Si ves un riesgo, dilo antes de cerrar. Con respeto + propuesta mejor.
4. Si la idea entra ya completa y simple, regístrala de inmediato sin preguntas innecesarias.
5. Cuando esté clara para registrar, confírmala en una frase corta y emite el bloque [IMPROVEMENT] (formato abajo).

FORMATO DE REGISTRO (CRÍTICO — el sistema lo lee literal)
Cuando la mejora esté clara:
1. Confirma al CEO en UNA frase breve qué vas a guardar.
2. AL FINAL del mensaje, EXACTAMENTE este bloque (sin markdown, sin backticks, sin comentarios):
[IMPROVEMENT]{"text":"<resumen claro de la mejora en una o dos frases, en infinitivo o futuro, con scope concreto: qué módulo, qué cambio, qué resultado esperado>"}[/IMPROVEMENT]

El bloque [IMPROVEMENT] se OCULTA del chat. El sistema lo parsea para INSERTAR la fila en hector_tickets con kind='improvement' y status='pending'. Si el JSON está mal formado o el texto vacío, no se registra nada.

NO emitas el bloque si:
- El CEO está explorando todavía y no ha cerrado la decisión.
- Faltan detalles críticos para que el implementador la coja del backlog.
- Detectas un riesgo serio que aún no has discutido con el CEO.
- El CEO acaba de cancelar o contradecir.
- Aún no has hecho el diagnóstico mínimo (si era bug fix).

Una vez registrada una mejora, NO la repitas en el siguiente turno. Antonio puede pedir registrar otra distinta o ajustar la anterior — sé claro sobre cuál es cuál.`;

const IMPROVEMENT_RE = /\[IMPROVEMENT\]([\s\S]*?)\[\/IMPROVEMENT\]/;

const parseImprovementBlock = (text) => {
  if (!text || typeof text !== "string") return null;
  const m = text.match(IMPROVEMENT_RE);
  if (!m) return null;
  try {
    let raw = m[1].trim().replace(/^```json\s*|\s*```$/g, "").replace(/^```\s*|\s*```$/g, "");
    const parsed = JSON.parse(raw);
    const t = typeof parsed?.text === "string" ? parsed.text.trim() : "";
    return t ? { text: t } : null;
  } catch {
    return null;
  }
};

const stripImprovementBlock = (text) => String(text || "")
  .replace(IMPROVEMENT_RE, "")
  .replace(/\n{3,}/g, "\n\n")
  .trim();

const PALETTE = {
  bg:           "#FAFAFA",
  panel:        "#FFFFFF",
  border:       "#E5E7EB",
  borderStrong: "#D1D5DB",
  text:         "#111827",
  textMuted:    "#6B7280",
  textFaint:    "#9CA3AF",
  accent:       "#7F77DD",
  danger:       "#E24B4A",
  success:      "#1D9E75",
  warn:         "#EF9F27",
  bgIncident:   "#FEF2F2",
  bgResolved:   "#F0FDF4",
  bgPending:    "#FFFBEB",
  bgDesign:     "#EFF6FF",
  bgDone:       "#F0FDF4",
};

const INCIDENT_LABELS = {
  "false-success":            "Falso éxito",
  "stale-date-fix":           "Fecha caducada corregida",
  "fabricated-tasks":         "Tareas inventadas",
  "non-propositive-summary":  "Lenguaje no propositivo",
};

// Limpia agentResponse para mostrar solo prosa: quita bloques [ACTIONS],
// [TASKS_LIST] y marcadores [INVOCAR:agente:tarea] que Héctor emite como
// canal lateral hacia el frontend (no son texto para el CEO). También
// colapsa saltos de línea triples a doble.
const stripAgentMarkers = (txt) => String(txt || "")
  .replace(/\[ACTIONS\][\s\S]*?\[\/ACTIONS\]/gi, "")
  .replace(/\[TASKS_LIST\][\s\S]*?\[\/TASKS_LIST\]/gi, "")
  .replace(/\[INVOCAR:[^\]]+\]/gi, "")
  .replace(/\n{3,}/g, "\n\n")
  .trim();

// Descripción legible de un incidente concreto (no solo el tipo).
const describeIncident = (inc) => {
  if (!inc || !inc.type) return "";
  switch (inc.type) {
    case "false-success":
      return "Héctor afirmó haber ejecutado algo sin emitir bloque [ACTIONS] válido.";
    case "stale-date-fix": {
      const n = Array.isArray(inc.tasks) ? inc.tasks.length : 0;
      return `${n || "Varias"} ${n === 1 ? "fecha corregida" : "fechas corregidas"} (año pasado → año actual).`;
    }
    case "fabricated-tasks": {
      const n = Array.isArray(inc.removed) ? inc.removed.length : 0;
      return `${n || "Varias"} ${n === 1 ? "tarea filtrada" : "tareas filtradas"} — no existen en la base de datos.`;
    }
    case "non-propositive-summary": {
      const where = inc.where === "prose" ? "prosa antes del card" : "summary del card";
      return `Resumen reescrito de pasado a infinitivo (${where}).`;
    }
    default:
      return inc.type;
  }
};

const IMPROVEMENT_STATES = [
  { key: "pending",   label: "Pendiente",  color: PALETTE.warn,    bg: PALETTE.bgPending },
  { key: "in_design", label: "En diseño",  color: PALETTE.accent,  bg: PALETTE.bgDesign },
  { key: "done",      label: "Hecha",      color: PALETTE.success, bg: PALETTE.bgDone },
];

// Color oro usado para chips de filtro activos en la pestaña Tareas.
const GOLD = "#C9A84C";
const GOLD_BG = "#FBF6E6";

// Estados unificados de la pestaña Tareas. Mapeamos los estados nativos
// de cada kind (incidencias usan open/in_progress/resolved; mejoras usan
// pending/in_design/done) a un set común para que el UI sea consistente.
const NORMALIZED_STATES = [
  { key: "pending",     label: "Pendiente" },
  { key: "in_progress", label: "En curso" },
  { key: "resolved",    label: "Resuelto" },
];

const normalizeTicketStatus = (t) => {
  const s = t?.status || "";
  if (t?.kind === "improvement") {
    if (s === "done") return "resolved";
    if (s === "in_design") return "in_progress";
    return "pending";
  }
  // incident
  if (s === "resolved") return "resolved";
  if (s === "in_progress") return "in_progress";
  return "pending";
};

// Traduce un estado normalizado al valor concreto que se guarda en la
// columna status de hector_tickets según el kind del ticket. Mantiene
// compatibilidad con las pestañas Incidencias y Mejoras que ya leen
// los estados antiguos.
const persistedStatusFor = (kind, normalizedStatus) => {
  if (kind === "improvement") {
    if (normalizedStatus === "resolved") return "done";
    if (normalizedStatus === "in_progress") return "in_design";
    return "pending";
  }
  if (normalizedStatus === "resolved") return "resolved";
  if (normalizedStatus === "in_progress") return "in_progress";
  return "open";
};

// Prioridad derivada: incidencias = alta (algo se rompió), mejoras = media
// (propuesta de producto). Sin schema change. Si en el futuro se añade
// una columna `priority` en hector_tickets, este helper la respeta.
const derivePriority = (t) => {
  if (t?.priority) return t.priority;
  return t?.kind === "incident" ? "alta" : "media";
};

const PRIORITY_DEFS = [
  { key: "alta",  label: "Alta",  color: PALETTE.danger },
  { key: "media", label: "Media", color: PALETTE.warn },
  { key: "baja",  label: "Baja",  color: PALETTE.textMuted },
];

const ORIGEN_DEFS = [
  { key: "incident",    label: "Incidencias" },
  { key: "improvement", label: "Mejoras" },
];

// Título legible para una tarea — distinto según el origen.
const taskTitle = (t) => {
  if (t?.kind === "improvement") {
    const txt = String(t.improvement_text || "").trim();
    if (!txt) return "(mejora sin texto)";
    const firstLine = txt.split(/[\n.]/)[0].trim();
    return firstLine.slice(0, 140) || txt.slice(0, 140);
  }
  // incident: usa lista de detectores como título
  const types = Array.isArray(t?.incidents) ? t.incidents.map(i => INCIDENT_LABELS[i?.type] || i?.type).filter(Boolean) : [];
  if (types.length > 0) return types.join(" · ");
  return "(incidencia sin detector)";
};

const tabBtnStyle = (active) => ({
  padding: "10px 18px",
  background: "transparent",
  border: "none",
  borderBottom: active ? `2px solid ${PALETTE.text}` : "2px solid transparent",
  color: active ? PALETTE.text : PALETTE.textMuted,
  fontSize: 13,
  fontWeight: active ? 700 : 500,
  cursor: "pointer",
  fontFamily: "inherit",
  marginRight: 8,
  borderRadius: 0,
});

const btnStyle = (variant = "default") => {
  const base = {
    padding: "6px 12px",
    fontSize: 12,
    fontWeight: 600,
    cursor: "pointer",
    fontFamily: "inherit",
    borderRadius: 0,
    border: `1px solid ${PALETTE.border}`,
    background: PALETTE.panel,
    color: PALETTE.text,
    transition: "background 0.15s",
  };
  if (variant === "primary") return { ...base, background: PALETTE.text, color: "#fff", border: `1px solid ${PALETTE.text}` };
  if (variant === "danger")  return { ...base, color: PALETTE.danger, borderColor: PALETTE.danger };
  if (variant === "success") return { ...base, color: PALETTE.success, borderColor: PALETTE.success };
  if (variant === "ghost")   return { ...base, border: "none", padding: "4px 8px", fontWeight: 500, color: PALETTE.textMuted };
  return base;
};

const cardStyle = (accentColor) => ({
  background: PALETTE.panel,
  border: `1px solid ${PALETTE.border}`,
  borderLeft: `3px solid ${accentColor}`,
  borderRadius: 0,
  padding: "14px 16px",
  marginBottom: 10,
});

const chipStyle = (color, bg) => ({
  display: "inline-block",
  padding: "2px 8px",
  fontSize: 10.5,
  fontWeight: 600,
  color,
  background: bg,
  border: `1px solid ${color}55`,
  borderRadius: 0,
  marginRight: 6,
});

const fmtDate = (iso) => {
  if (!iso) return "";
  try {
    const d = new Date(iso);
    return d.toLocaleString("es-ES", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
  } catch { return iso; }
};

const buildDiagnosticPrompt = (t) => {
  const detectorList = (Array.isArray(t.incidents) ? t.incidents : [])
    .map(inc => `- ${INCIDENT_LABELS[inc?.type] || inc?.type || "?"} (${inc?.type}): ${describeIncident(inc)}`)
    .join("\n") || "(sin detectores)";
  const cleanResponse = stripAgentMarkers(t.agent_response) || "(sin prosa)";
  const incidentsJson = Array.isArray(t.incidents) && t.incidents.length > 0
    ? JSON.stringify(t.incidents, null, 2)
    : "[]";
  return [
    `DIAGNÓSTICO Kluxor — incidencia Héctor`,
    `Ticket: ${t.id}`,
    `Fecha: ${t.created_at || "?"}`,
    `Agente: ${t.agent || "hector_direct"}`,
    "",
    "----------------------------------------",
    "CONTEXTO DEL PROYECTO",
    "----------------------------------------",
    "Stack: React 18 + Vite 5 + Supabase + Claude Sonnet 4.5.",
    "Repo local: /Users/antoniodiaz/Desktop/ap tipo trello (branch main).",
    "CLAUDE.md en raíz del repo tiene las reglas duras del proyecto.",
    "Archivos clave para este tipo de incidencia:",
    "  - src/components/HectorDirectView.jsx — chat directo, pipeline post-LLM (sanitizer, parser, detectores).",
    "  - src/lib/agentActions.js — parseAgentActions, detectFalseSuccessClaim, validateAndCorrectDueDate, validateTasksAgainstDatabase, rewriteToPropositive, executeAgentActions, AGENT_ACTIONS_ADDON.",
    "  - src/App.jsx — runAgentActions, createProject, createNegotiation, dataRef.",
    "",
    "----------------------------------------",
    "DETECTORES QUE DISPARARON",
    "----------------------------------------",
    detectorList,
    "",
    "----------------------------------------",
    "MENSAJE DEL CEO (texto plano)",
    "----------------------------------------",
    t.user_message || "(vacío)",
    "",
    "----------------------------------------",
    "RESPUESTA DE HÉCTOR (prosa limpia, sin marcadores)",
    "----------------------------------------",
    cleanResponse,
    "",
    "----------------------------------------",
    "RESPUESTA RAW DE HÉCTOR (con bloques [ACTIONS]/[TASKS_LIST]/[INVOCAR:] si los hubiera)",
    "----------------------------------------",
    t.agent_response || "(vacío)",
    "",
    "----------------------------------------",
    "INCIDENTES — estructura completa",
    "----------------------------------------",
    incidentsJson,
    "",
    "----------------------------------------",
    "OBJETIVO",
    "----------------------------------------",
    "Solo investigar y reportar. NO modificar archivos. NO commits.",
    "",
    "TAREAS:",
    "1. Identifica la causa raíz de cada detector que disparó. Cita file:line.",
    "2. Distingue: ¿bug del modelo (prompt insuficiente), del parser/sanitizer, del executor, o de la lógica de validación post-LLM?",
    "3. Propón fix mínimo (sin implementar), respetando los anti-patrones de CLAUDE.md:",
    "   - No modificar AGENT_ACTIONS_ADDON para arreglar fechas o emisiones (validación post-LLM en frontend).",
    "   - No añadir reglas amplias 'no inventes' al prompt (caso v11 anti-fabrication causó regresión).",
    "   - No duplicar funciones entre vistas — exportar desde agentActions.js.",
    "   - Verificar siempre en BD/data.boards, no en lo que el modelo dice.",
    "",
    "FORMATO DE RESPUESTA ESPERADO:",
    "## 1. Causa raíz por detector",
    "## 2. Archivos y líneas implicadas",
    "## 3. Plan de fix (sin código)",
    "## 4. Riesgo de regresión y test crítico ('Hecho' en Sala de Mando)",
  ].join("\n");
};

function IncidentCard({ ticket, onResolve, onReopen }) {
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const isResolved = ticket.status === "resolved";
  const incidents = Array.isArray(ticket.incidents) ? ticket.incidents : [];
  const accent = isResolved ? PALETTE.success : PALETTE.danger;
  const prompt = useMemo(() => buildDiagnosticPrompt(ticket), [ticket]);
  const cleanResponse = useMemo(() => stripAgentMarkers(ticket.agent_response), [ticket.agent_response]);

  const copyPrompt = async () => {
    try {
      await navigator.clipboard.writeText(prompt);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch (e) {
      console.warn("[Mantenimiento] Copy failed:", e?.message);
    }
  };

  return (
    <div style={cardStyle(accent)}>
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 10, marginBottom: 10 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ marginBottom: 6 }}>
            {incidents.length > 0 ? incidents.map((inc, i) => (
              <span key={i} style={chipStyle(accent, isResolved ? PALETTE.bgResolved : PALETTE.bgIncident)}>
                {INCIDENT_LABELS[inc?.type] || inc?.type || "?"}
              </span>
            )) : (
              <span style={chipStyle(PALETTE.textMuted, "#F3F4F6")}>sin detector</span>
            )}
            {isResolved && <span style={chipStyle(PALETTE.success, PALETTE.bgResolved)}>resuelto</span>}
          </div>
          <div style={{ fontSize: 11, color: PALETTE.textFaint }}>
            {fmtDate(ticket.created_at)} · {ticket.agent || "?"} · #{String(ticket.id).slice(0, 8)}
          </div>
        </div>
      </div>

      {/* Resumen legible por detector — nada de JSON. */}
      {incidents.length > 0 && (
        <div style={{ background: "#F9FAFB", border: `1px solid ${PALETTE.border}`, padding: "8px 10px", marginBottom: 10, borderRadius: 0 }}>
          {incidents.map((inc, i) => (
            <div key={i} style={{ fontSize: 12, color: PALETTE.text, marginBottom: i === incidents.length - 1 ? 0 : 4 }}>
              <span style={{ fontWeight: 600, color: accent }}>{INCIDENT_LABELS[inc?.type] || inc?.type || "?"}:</span>{" "}
              <span style={{ color: PALETTE.text }}>{describeIncident(inc)}</span>
            </div>
          ))}
        </div>
      )}

      {/* Mensaje CEO — texto plano. */}
      <div style={{ marginBottom: 10 }}>
        <div style={{ fontWeight: 600, color: PALETTE.textMuted, fontSize: 10.5, textTransform: "uppercase", letterSpacing: 0.4, marginBottom: 4 }}>
          Mensaje del CEO
        </div>
        <div style={{ fontSize: 12.5, color: PALETTE.text, lineHeight: 1.5, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
          {ticket.user_message || <em style={{ color: PALETTE.textFaint }}>(sin mensaje)</em>}
        </div>
      </div>

      {/* Respuesta de Héctor — prosa limpia, sin [ACTIONS]/[TASKS_LIST]/[INVOCAR:]. */}
      <div style={{ marginBottom: 12 }}>
        <div style={{ fontWeight: 600, color: PALETTE.textMuted, fontSize: 10.5, textTransform: "uppercase", letterSpacing: 0.4, marginBottom: 4 }}>
          Respuesta de Héctor
        </div>
        <div style={{ fontSize: 12.5, color: PALETTE.text, lineHeight: 1.5, whiteSpace: "pre-wrap", wordBreak: "break-word", maxHeight: expanded ? "none" : 120, overflow: expanded ? "visible" : "hidden", position: "relative" }}>
          {cleanResponse || <em style={{ color: PALETTE.textFaint }}>(sin prosa — Héctor solo emitió bloque [ACTIONS] u [INVOCAR:])</em>}
          {!expanded && cleanResponse && cleanResponse.length > 240 && (
            <div style={{ position: "absolute", bottom: 0, left: 0, right: 0, height: 28, background: "linear-gradient(to bottom, transparent, #FFFFFF)" }} />
          )}
        </div>
      </div>

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <button type="button" onClick={() => setExpanded(e => !e)} style={btnStyle("default")}>
          {expanded ? "Ocultar prompt" : "Ver prompt de diagnóstico"}
        </button>
        {isResolved
          ? <button type="button" onClick={() => onReopen(ticket.id)} style={btnStyle("ghost")}>Reabrir</button>
          : <button type="button" onClick={() => onResolve(ticket.id)} style={btnStyle("success")}>Resuelto</button>
        }
      </div>

      {expanded && (
        <div style={{ marginTop: 10, padding: 12, background: "#F9FAFB", border: `1px solid ${PALETTE.border}`, borderRadius: 0 }}>
          <div style={{ fontSize: 10.5, color: PALETTE.textMuted, marginBottom: 6, fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.4 }}>
            Prompt listo para pegar en Claude Code o en el chat con Bruno
          </div>
          <pre style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: 11, color: PALETTE.text, whiteSpace: "pre-wrap", wordBreak: "break-word", margin: 0, maxHeight: 360, overflow: "auto", background: "#fff", border: `1px solid ${PALETTE.border}`, padding: 10, borderRadius: 0 }}>{prompt}</pre>
          <div style={{ marginTop: 8, display: "flex", gap: 8 }}>
            <button type="button" onClick={copyPrompt} style={btnStyle("primary")}>{copied ? "✅ Copiado" : "Copiar prompt"}</button>
          </div>
        </div>
      )}
    </div>
  );
}

// Helper compartido para guardar una mejora en hector_tickets y actualizar
// el mensaje del chat con el resultado. Encapsula los 3 caminos posibles:
// éxito (savedId + taskInfo opcional), fila sin id (error), o exception.
// Siempre cierra el ciclo: tras esta función, improvementSaving es false
// y o bien improvementSavedId o improvementError quedan asignados, así
// el mensaje nunca queda en estado ambiguo en localStorage.
async function persistImprovementToMessage({ tempId, text, onImprovementCreated, setHistory }) {
  try {
    const saved = await onImprovementCreated(text);
    if (saved?.id) {
      setHistory(prev => prev.map(m =>
        m.improvementTempId === tempId
          ? {
              ...m,
              improvementSavedId: saved.id,
              improvementSaving: false,
              improvementError: null,
              improvementTaskInfo: saved.taskInfo || null,
            }
          : m
      ));
    } else {
      setHistory(prev => prev.map(m =>
        m.improvementTempId === tempId
          ? { ...m, improvementError: "Insert sin id devuelto", improvementSaving: false }
          : m
      ));
    }
  } catch (e) {
    console.warn("[Bruno] save improvement failed:", e?.message);
    const msg = e?.message || "Error guardando mejora";
    setHistory(prev => prev.map(m =>
      m.improvementTempId === tempId
        ? { ...m, improvementError: msg, improvementSaving: false }
        : m
    ));
  }
}

function BrunoChat({ onImprovementCreated }) {
  const [history, setHistory] = useState(() => {
    try {
      const raw = localStorage.getItem(BRUNO_CHAT_KEY);
      const parsed = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed.slice(-BRUNO_CHAT_MAX) : [];
    } catch { return []; }
  });
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [savingId, setSavingId] = useState(null);
  const endRef = useRef(null);

  useEffect(() => {
    try { localStorage.setItem(BRUNO_CHAT_KEY, JSON.stringify(history.slice(-BRUNO_CHAT_MAX))); } catch {}
    if (endRef.current) endRef.current.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [history]);

  // Auto-retry on mount: si un mensaje quedó marcado improvementSaving
  // (reload interrumpió el insert) o sin savedId/error (entrada vieja
  // pre-fix), intentamos guardarlo. Sólo arranca una vez por sesión.
  const autoRetriedRef = useRef(false);
  useEffect(() => {
    if (autoRetriedRef.current) return;
    autoRetriedRef.current = true;
    const stale = history.filter(m =>
      m.role === "assistant" &&
      m.improvement?.text &&
      !m.improvementSavedId &&
      !m.improvementError
    );
    stale.forEach(m => {
      persistImprovementToMessage({
        tempId: m.improvementTempId,
        text: m.improvement.text,
        onImprovementCreated,
        setHistory,
      });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const retryImprovement = (msg) => {
    if (!msg?.improvement?.text || !msg.improvementTempId) return;
    setHistory(prev => prev.map(m =>
      m.improvementTempId === msg.improvementTempId
        ? { ...m, improvementSaving: true, improvementError: null }
        : m
    ));
    persistImprovementToMessage({
      tempId: msg.improvementTempId,
      text: msg.improvement.text,
      onImprovementCreated,
      setHistory,
    });
  };

  const clearChat = () => {
    if (!window.confirm("¿Empezar conversación nueva con Bruno? Se borra el historial actual.")) return;
    setHistory([]);
    try { localStorage.removeItem(BRUNO_CHAT_KEY); } catch {}
  };

  const send = async () => {
    const txt = input.trim();
    if (!txt || loading) return;
    const userMsg = { role: "user", text: txt, ts: Date.now() };
    const next = [...history, userMsg].slice(-BRUNO_CHAT_MAX);
    setHistory(next);
    setInput("");
    setLoading(true);
    try {
      const messages = next.map(m => ({
        role: m.role === "user" ? "user" : "assistant",
        content: m.text || "",
      }));
      const reply = await callAgentSafe(
        { system: BRUNO_SYSTEM, messages, max_tokens: 900, model: BRUNO_MODEL },
        { timeoutMs: 60000 }
      );
      const improvement = parseImprovementBlock(reply);
      const cleanText = stripImprovementBlock(reply);
      const tempId = `tmp_${Date.now()}`;
      const assistantMsg = {
        role: "assistant",
        text: cleanText || "(sin texto)",
        improvement: improvement || null,
        improvementSavedId: null,
        improvementTempId: improvement ? tempId : null,
        ts: Date.now(),
      };
      setHistory(prev => [...prev, assistantMsg].slice(-BRUNO_CHAT_MAX));
      if (improvement) {
        // Marcamos saving en el propio mensaje (persistido en localStorage)
        // para que un reload no deje el mensaje en estado ambiguo. El
        // savingId local sirve solo para el spinner sin re-render extra.
        setSavingId(tempId);
        setHistory(prev => prev.map(m =>
          m.improvementTempId === tempId
            ? { ...m, improvementSaving: true, improvementError: null }
            : m
        ));
        await persistImprovementToMessage({
          tempId,
          text: improvement.text,
          onImprovementCreated,
          setHistory,
        });
        setSavingId(null);
      }
    } catch (e) {
      setHistory(prev => [...prev, {
        role: "assistant",
        text: `⚠ ${e?.message || "Error consultando a Bruno"}`,
        error: true,
        ts: Date.now(),
      }].slice(-BRUNO_CHAT_MAX));
    } finally {
      setLoading(false);
    }
  };

  const handleKey = (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  return (
    <div style={{
      background: PALETTE.panel,
      border: `1px solid ${PALETTE.border}`,
      borderLeft: `3px solid ${PALETTE.accent}`,
      padding: 14,
      marginBottom: 16,
      borderRadius: 0,
    }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
        <div>
          <div style={{ fontSize: 13, fontWeight: 700, color: PALETTE.text }}>🏗️ Bruno — arquitecto de Kluxor</div>
          <div style={{ fontSize: 11, color: PALETTE.textMuted, marginTop: 2 }}>
            Cuéntale tu idea de mejora. Cuando esté clara, la registra en este panel.
          </div>
        </div>
        {history.length > 0 && (
          <button type="button" onClick={clearChat} style={btnStyle("ghost")}>Nueva conversación</button>
        )}
      </div>

      <div style={{
        maxHeight: 340,
        overflowY: "auto",
        padding: history.length > 0 ? "8px 0" : 0,
        background: history.length > 0 ? "#F9FAFB" : "transparent",
        border: history.length > 0 ? `1px solid ${PALETTE.border}` : "none",
        borderRadius: 0,
        marginBottom: 10,
      }}>
        {history.length === 0 && !loading && (
          <div style={{ padding: "16px 12px", fontSize: 12.5, color: PALETTE.textMuted, fontStyle: "italic" }}>
            Empieza describiendo la mejora. Bruno hará las preguntas necesarias y la registrará cuando esté clara.
          </div>
        )}
        {history.map((m, i) => (
          <BrunoBubble
            key={i}
            message={m}
            saving={(savingId && m.improvementTempId === savingId) || !!m.improvementSaving}
            onRetry={() => retryImprovement(m)}
          />
        ))}
        {loading && (
          <div style={{ padding: "8px 12px", fontSize: 12, color: PALETTE.textMuted, fontStyle: "italic" }}>
            Bruno está pensando…
          </div>
        )}
        <div ref={endRef} style={{ height: 1 }} />
      </div>

      <div style={{ display: "flex", gap: 8 }}>
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKey}
          placeholder="Cuéntale a Bruno qué mejora propones..."
          rows={2}
          style={{
            flex: 1,
            padding: "8px 10px",
            fontSize: 13,
            fontFamily: "inherit",
            border: `1px solid ${PALETTE.border}`,
            borderRadius: 0,
            resize: "vertical",
            color: PALETTE.text,
            background: "#fff",
            outline: "none",
          }}
        />
        <button
          type="button"
          onClick={send}
          disabled={loading || !input.trim()}
          style={{
            ...btnStyle("primary"),
            padding: "8px 16px",
            opacity: (loading || !input.trim()) ? 0.5 : 1,
            cursor: (loading || !input.trim()) ? "default" : "pointer",
          }}
        >
          {loading ? "…" : "Enviar"}
        </button>
      </div>
    </div>
  );
}

function BrunoBubble({ message, saving, onRetry }) {
  const isUser = message.role === "user";
  const isError = !!message.error;
  return (
    <div style={{
      padding: "6px 12px",
      display: "flex",
      flexDirection: isUser ? "row-reverse" : "row",
      alignItems: "flex-start",
      gap: 8,
      marginBottom: 4,
    }}>
      <div style={{
        maxWidth: "80%",
        background: isUser ? PALETTE.text : (isError ? PALETTE.bgIncident : "#fff"),
        color: isUser ? "#fff" : (isError ? PALETTE.danger : PALETTE.text),
        border: isUser
          ? `1px solid ${PALETTE.text}`
          : (isError ? `1px solid ${PALETTE.danger}` : `1px solid ${PALETTE.border}`),
        padding: "8px 12px",
        fontSize: 12.5,
        lineHeight: 1.5,
        borderRadius: 0,
        whiteSpace: "pre-wrap",
        wordBreak: "break-word",
      }}>
        {message.text}
        {message.improvement && (() => {
          const hasError = !!message.improvementError;
          const isSaved = !!message.improvementSavedId;
          const isSaving = !!saving;
          const isAmbiguous = !isSaved && !isSaving && !hasError;
          const bg = hasError || isAmbiguous ? PALETTE.bgIncident : PALETTE.bgDone;
          const color = hasError || isAmbiguous ? PALETTE.danger : PALETTE.success;
          let label;
          if (hasError)         label = `⚠ Error guardando: ${message.improvementError}`;
          else if (isSaving)    label = "Guardando mejora…";
          else if (isSaved)     label = "✅ Mejora registrada en el panel";
          else                  label = "⚠ Mejora detectada pero no persistida (estado inconsistente)";
          const showRetry = (hasError || isAmbiguous) && typeof onRetry === "function";
          return (
            <div style={{ marginTop: 8 }}>
              <div style={{
                padding: "6px 8px",
                background: bg,
                border: `1px solid ${color}`,
                fontSize: 11.5,
                color,
                display: "flex",
                alignItems: "center",
                gap: 6,
                borderRadius: 0,
              }}>{label}</div>
              {isSaved && message.improvementTaskInfo && (
                <div style={{
                  marginTop: 4,
                  padding: "6px 8px",
                  background: "#F0F7FF",
                  border: `1px solid ${PALETTE.accent}`,
                  fontSize: 11,
                  color: PALETTE.accent,
                  borderRadius: 0,
                }}>
                  🏗️ Tarea creada en proyecto <strong>{message.improvementTaskInfo.projectCode}</strong> — “{message.improvementTaskInfo.taskTitle}”
                </div>
              )}
              {showRetry && (
                <button
                  type="button"
                  onClick={onRetry}
                  style={{ ...btnStyle("default"), marginTop: 6 }}
                >
                  Reintentar guardado
                </button>
              )}
            </div>
          );
        })()}
      </div>
    </div>
  );
}

// Chip toggleable usado en la barra de filtros de la pestaña Tareas.
// Activo = oro #C9A84C, inactivo = neutro. Click toggles selección
// dentro de su grupo (origen/estado/prioridad).
function FilterChip({ label, active, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        padding: "5px 11px",
        fontSize: 11.5,
        fontWeight: active ? 700 : 500,
        cursor: "pointer",
        fontFamily: "inherit",
        borderRadius: 0,
        border: active ? `1px solid ${GOLD}` : `1px solid ${PALETTE.border}`,
        background: active ? GOLD_BG : PALETTE.panel,
        color: active ? GOLD : PALETTE.textMuted,
        marginRight: 6,
      }}
    >{label}</button>
  );
}

function TaskCard({ ticket, assigneeName, onSetStatus }) {
  const isIncident = ticket.kind === "incident";
  const origenColor = isIncident ? PALETTE.danger : PALETTE.accent;
  const origenBg = isIncident ? PALETTE.bgIncident : "#EFEEFB";
  const origenLabel = isIncident ? "Incidencia" : "Mejora";
  const title = taskTitle(ticket);
  const priority = derivePriority(ticket);
  const prioDef = PRIORITY_DEFS.find(p => p.key === priority) || PRIORITY_DEFS[1];
  const normalized = normalizeTicketStatus(ticket);

  return (
    <div style={{
      background: PALETTE.panel,
      border: `1px solid ${PALETTE.border}`,
      borderLeft: `3px solid ${origenColor}`,
      borderRadius: 0,
      padding: "12px 14px",
      marginBottom: 8,
    }}>
      <div style={{ display: "flex", alignItems: "flex-start", gap: 10, marginBottom: 8 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ marginBottom: 4 }}>
            <span style={chipStyle(origenColor, origenBg)}>{origenLabel}</span>
            <span style={chipStyle(prioDef.color, `${prioDef.color}18`)}>{prioDef.label}</span>
          </div>
          <div style={{ fontSize: 13, color: PALETTE.text, fontWeight: 600, lineHeight: 1.35, marginBottom: 4, wordBreak: "break-word" }}>
            {title}
          </div>
          <div style={{ fontSize: 11, color: PALETTE.textFaint }}>
            {fmtDate(ticket.created_at)} · 👤 {assigneeName || "Antonio Díaz"} · #{String(ticket.id).slice(0, 8)}
          </div>
        </div>
      </div>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        {NORMALIZED_STATES.map(s => {
          const active = s.key === normalized;
          return (
            <button
              key={s.key}
              type="button"
              onClick={() => !active && onSetStatus(ticket.id, ticket.kind, s.key)}
              disabled={active}
              style={{
                ...btnStyle("default"),
                ...(active ? { background: origenBg, borderColor: origenColor, color: origenColor, cursor: "default", fontWeight: 700 } : {}),
              }}
            >{s.label}</button>
          );
        })}
      </div>
    </div>
  );
}

function ImprovementCard({ ticket, onSetState }) {
  const stateDef = IMPROVEMENT_STATES.find(s => s.key === ticket.status) || IMPROVEMENT_STATES[0];
  return (
    <div style={cardStyle(stateDef.color)}>
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 10, marginBottom: 8 }}>
        <span style={chipStyle(stateDef.color, stateDef.bg)}>{stateDef.label}</span>
        <div style={{ fontSize: 11, color: PALETTE.textFaint }}>
          {fmtDate(ticket.created_at)} · #{String(ticket.id).slice(0, 8)}
        </div>
      </div>
      <div style={{ fontSize: 13, color: PALETTE.text, lineHeight: 1.5, marginBottom: 10, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
        {ticket.improvement_text || <em style={{ color: PALETTE.textFaint }}>(sin texto)</em>}
      </div>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        {IMPROVEMENT_STATES.map(s => (
          <button
            key={s.key}
            type="button"
            onClick={() => onSetState(ticket.id, s.key)}
            disabled={s.key === ticket.status}
            style={{
              ...btnStyle("default"),
              ...(s.key === ticket.status
                ? { background: s.bg, borderColor: s.color, color: s.color, cursor: "default", fontWeight: 700 }
                : {}),
            }}
          >
            {s.label}
          </button>
        ))}
      </div>
    </div>
  );
}

export default function MantenimientoView({ authUid, onRegisterImprovementAsTask }) {
  const [tab, setTab] = useState("incident");
  const [tickets, setTickets] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [showResolved, setShowResolved] = useState(false);
  // Filtros de la pestaña Tareas. Cada uno es un Set para permitir
  // multi-toggle dentro de su grupo. Set vacío = "Todos" (sin filtro).
  const [taskFilters, setTaskFilters] = useState({
    origen:    new Set(),
    estado:    new Set(),
    prioridad: new Set(),
  });
  const toggleFilter = (group, key) => {
    setTaskFilters(prev => {
      const cur = new Set(prev[group]);
      if (cur.has(key)) cur.delete(key); else cur.add(key);
      return { ...prev, [group]: cur };
    });
  };
  const clearFilterGroup = (group) => {
    setTaskFilters(prev => ({ ...prev, [group]: new Set() }));
  };

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!supa) { setError("Supabase no inicializado"); setLoading(false); return; }
      try {
        setLoading(true);
        const { data, error } = await supa
          .from("hector_tickets")
          .select("*")
          .order("created_at", { ascending: false })
          .limit(500);
        if (cancelled) return;
        if (error) { setError(error.message); setTickets([]); }
        else { setTickets(Array.isArray(data) ? data : []); setError(null); }
      } catch (e) {
        if (!cancelled) setError(e?.message || "Error cargando tickets");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [authUid]);

  const incidents = useMemo(() => tickets.filter(t => t.kind === "incident"), [tickets]);
  const improvements = useMemo(() => tickets.filter(t => t.kind === "improvement"), [tickets]);

  const openIncidents = useMemo(() => incidents.filter(t => t.status !== "resolved"), [incidents]);
  const resolvedIncidents = useMemo(() => incidents.filter(t => t.status === "resolved"), [incidents]);
  const visibleIncidents = showResolved ? incidents : openIncidents;

  const pendingImprovements = useMemo(() => improvements.filter(t => (t.status || "pending") !== "done"), [improvements]);

  const updateStatus = async (id, status) => {
    setTickets(prev => prev.map(t => t.id === id ? { ...t, status } : t));
    if (!supa) return;
    const { error } = await supa.from("hector_tickets").update({ status }).eq("id", id);
    if (error) console.warn(`[Mantenimiento] update status error: ${error.message}`);
  };

  // Cambio de estado desde la pestaña Tareas. Recibe el estado normalizado
  // (pending/in_progress/resolved) y lo traduce al valor concreto que
  // espera la columna status según el kind del ticket (compat con tabs
  // Incidencias y Mejoras).
  const setTaskNormalizedStatus = async (id, kind, normalized) => {
    const persisted = persistedStatusFor(kind, normalized);
    await updateStatus(id, persisted);
  };

  // Conjunto de tareas tras aplicar filtros (origen / estado / prioridad).
  // Si un Set de filtros está vacío, ese grupo no filtra (equivale a "Todos").
  const filteredTasks = useMemo(() => {
    const { origen, estado, prioridad } = taskFilters;
    return tickets.filter(t => {
      if (origen.size > 0 && !origen.has(t.kind)) return false;
      if (estado.size > 0 && !estado.has(normalizeTicketStatus(t))) return false;
      if (prioridad.size > 0 && !prioridad.has(derivePriority(t))) return false;
      return true;
    });
  }, [tickets, taskFilters]);

  // Contadores del header de la pestaña Tareas (sobre filtered).
  const taskCounts = useMemo(() => {
    let pending = 0, inProgress = 0, resolved = 0;
    filteredTasks.forEach(t => {
      const s = normalizeTicketStatus(t);
      if (s === "pending") pending++;
      else if (s === "in_progress") inProgress++;
      else if (s === "resolved") resolved++;
    });
    return { pending, inProgress, resolved };
  }, [filteredTasks]);

  // Particionado en secciones: Prioritarias (alta, no resueltas), En curso,
  // Pendientes. Resueltas no aparecen en secciones por defecto — el filtro
  // de estado Resuelto las trae a En curso (se renombraría visualmente
  // pero por simplicidad las metemos en sección "En curso" cuando el
  // usuario filtra explícitamente por resueltas).
  const sectionedTasks = useMemo(() => {
    const priorit = [];
    const enCurso = [];
    const pend = [];
    const resu = [];
    filteredTasks.forEach(t => {
      const s = normalizeTicketStatus(t);
      const p = derivePriority(t);
      if (s === "resolved") { resu.push(t); return; }
      if (p === "alta") { priorit.push(t); return; }
      if (s === "in_progress") { enCurso.push(t); return; }
      pend.push(t);
    });
    return { priorit, enCurso, pend, resu };
  }, [filteredTasks]);

  // Inserta una mejora propuesta por Bruno en hector_tickets y actualiza
  // el listado local. Devuelve la fila insertada para que BrunoChat pueda
  // marcar el mensaje como guardado.
  //
  // Nota sobre `agent`: la tabla tiene un check constraint
  // (hector_tickets_agent_check) que solo admite 'hector_direct' o
  // 'hector_panel'. Aunque la mejora viene de Bruno, usamos
  // 'hector_direct' para satisfacer el constraint — la procedencia real
  // queda implícita por kind='improvement' (las incidencias del detector
  // post-LLM usan kind='incident'). Si en el futuro se amplía el
  // constraint con 'bruno', cambiar aquí.
  const createImprovement = async (text) => {
    if (!supa) throw new Error("Supabase no disponible");
    const { data: sessionData } = await supa.auth.getSession();
    const userId = sessionData?.session?.user?.id;
    if (!userId) throw new Error("Sin sesión activa");
    const payload = {
      user_id: userId,
      kind: "improvement",
      agent: "hector_direct",
      improvement_text: text,
      status: "pending",
    };
    const { data: inserted, error } = await supa
      .from("hector_tickets")
      .insert(payload)
      .select()
      .single();
    if (error) {
      console.error("[Mantenimiento] createImprovement error:", error);
      throw new Error(error.message || "Error insertando mejora");
    }
    if (!inserted) throw new Error("Insert sin fila devuelta (¿RLS bloquea select?)");
    setTickets(prev => [inserted, ...prev]);
    // Convertir la mejora en tarea real de Kluxor (proyecto "Mejoras
    // Kluxor" / KMJ). Si falla, no rompemos el flujo principal — la
    // mejora ya está en hector_tickets; el fallo se logea y queda
    // taskInfo=null para que el bubble no muestre línea de tarea.
    let taskInfo = null;
    if (typeof onRegisterImprovementAsTask === "function") {
      try {
        taskInfo = onRegisterImprovementAsTask(text, inserted.id) || null;
      } catch (e) {
        console.warn("[Mantenimiento] registerImprovementAsTask threw:", e?.message);
      }
    }
    return { ...inserted, taskInfo };
  };

  return (
    <div style={{ padding: "20px 24px", background: PALETTE.bg, minHeight: "100vh", fontFamily: "inherit", color: PALETTE.text }}>
      <div style={{ marginBottom: 20 }}>
        <div style={{ fontSize: 20, fontWeight: 700, color: PALETTE.text, marginBottom: 4 }}>🛠️ Mantenimiento Héctor</div>
        <div style={{ fontSize: 12, color: PALETTE.textMuted }}>
          Incidencias y mejoras recogidas automáticamente por los detectores post-LLM de Héctor.
        </div>
      </div>

      <div style={{ display: "flex", alignItems: "center", borderBottom: `1px solid ${PALETTE.border}`, marginBottom: 16 }}>
        <button type="button" onClick={() => setTab("incident")} style={tabBtnStyle(tab === "incident")}>
          ⚠️ Incidencias <span style={{ color: PALETTE.textFaint, marginLeft: 4 }}>({openIncidents.length}{resolvedIncidents.length > 0 ? `/${incidents.length}` : ""})</span>
        </button>
        <button type="button" onClick={() => setTab("improvement")} style={tabBtnStyle(tab === "improvement")}>
          💡 Mejoras <span style={{ color: PALETTE.textFaint, marginLeft: 4 }}>({pendingImprovements.length}/{improvements.length})</span>
        </button>
        <button type="button" onClick={() => setTab("task")} style={tabBtnStyle(tab === "task")}>
          📋 Tareas <span style={{ color: PALETTE.textFaint, marginLeft: 4 }}>({tickets.filter(t => normalizeTicketStatus(t) !== "resolved").length}/{tickets.length})</span>
        </button>
      </div>

      {loading && (
        <div style={{ padding: 24, textAlign: "center", color: PALETTE.textMuted, fontSize: 13 }}>Cargando tickets…</div>
      )}

      {error && !loading && (
        <div style={{ padding: 14, background: PALETTE.bgIncident, border: `1px solid ${PALETTE.danger}`, color: PALETTE.danger, fontSize: 12.5, borderRadius: 0 }}>
          ⚠ Error: {error}
        </div>
      )}

      {!loading && !error && tab === "incident" && (
        <>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
            <div style={{ fontSize: 12, color: PALETTE.textMuted }}>
              {visibleIncidents.length} {visibleIncidents.length === 1 ? "incidencia" : "incidencias"}
              {!showResolved && resolvedIncidents.length > 0 && (
                <> · {resolvedIncidents.length} resueltas ocultas</>
              )}
            </div>
            {resolvedIncidents.length > 0 && (
              <label style={{ fontSize: 12, color: PALETTE.textMuted, cursor: "pointer", display: "flex", alignItems: "center", gap: 6 }}>
                <input type="checkbox" checked={showResolved} onChange={(e) => setShowResolved(e.target.checked)} />
                Mostrar resueltas
              </label>
            )}
          </div>
          {visibleIncidents.length === 0 ? (
            <div style={{ padding: 24, textAlign: "center", color: PALETTE.textMuted, fontSize: 13, background: PALETTE.panel, border: `1px solid ${PALETTE.border}`, borderRadius: 0 }}>
              {showResolved ? "Sin incidencias registradas." : "Sin incidencias pendientes. ✅"}
            </div>
          ) : (
            visibleIncidents.map(t => (
              <IncidentCard
                key={t.id}
                ticket={t}
                onResolve={(id) => updateStatus(id, "resolved")}
                onReopen={(id) => updateStatus(id, "open")}
              />
            ))
          )}
        </>
      )}

      {!loading && !error && tab === "improvement" && (
        <>
          <BrunoChat onImprovementCreated={createImprovement} />
          <div style={{ fontSize: 12, color: PALETTE.textMuted, marginBottom: 10 }}>
            {improvements.length} {improvements.length === 1 ? "mejora" : "mejoras"} · {pendingImprovements.length} sin completar
          </div>
          {improvements.length === 0 ? (
            <div style={{ padding: 24, textAlign: "center", color: PALETTE.textMuted, fontSize: 13, background: PALETTE.panel, border: `1px solid ${PALETTE.border}`, borderRadius: 0 }}>
              Sin mejoras registradas todavía.
            </div>
          ) : (
            improvements.map(t => (
              <ImprovementCard
                key={t.id}
                ticket={t}
                onSetState={(id, status) => updateStatus(id, status)}
              />
            ))
          )}
        </>
      )}

      {!loading && !error && tab === "task" && (
        <>
          {/* Barra de filtros */}
          <div style={{
            background: PALETTE.panel,
            border: `1px solid ${PALETTE.border}`,
            padding: "10px 12px",
            marginBottom: 14,
            borderRadius: 0,
          }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 8 }}>
              <span style={{ fontSize: 10.5, fontWeight: 700, color: PALETTE.textMuted, textTransform: "uppercase", letterSpacing: 0.4, marginRight: 4, minWidth: 64 }}>Origen</span>
              <FilterChip label="Todas" active={taskFilters.origen.size === 0} onClick={() => clearFilterGroup("origen")} />
              {ORIGEN_DEFS.map(o => (
                <FilterChip key={o.key} label={o.label} active={taskFilters.origen.has(o.key)} onClick={() => toggleFilter("origen", o.key)} />
              ))}
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 8 }}>
              <span style={{ fontSize: 10.5, fontWeight: 700, color: PALETTE.textMuted, textTransform: "uppercase", letterSpacing: 0.4, marginRight: 4, minWidth: 64 }}>Estado</span>
              <FilterChip label="Todos" active={taskFilters.estado.size === 0} onClick={() => clearFilterGroup("estado")} />
              {NORMALIZED_STATES.map(s => (
                <FilterChip key={s.key} label={s.label} active={taskFilters.estado.has(s.key)} onClick={() => toggleFilter("estado", s.key)} />
              ))}
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <span style={{ fontSize: 10.5, fontWeight: 700, color: PALETTE.textMuted, textTransform: "uppercase", letterSpacing: 0.4, marginRight: 4, minWidth: 64 }}>Prioridad</span>
              <FilterChip label="Todas" active={taskFilters.prioridad.size === 0} onClick={() => clearFilterGroup("prioridad")} />
              {PRIORITY_DEFS.map(p => (
                <FilterChip key={p.key} label={p.label} active={taskFilters.prioridad.has(p.key)} onClick={() => toggleFilter("prioridad", p.key)} />
              ))}
            </div>
          </div>

          {/* Contadores */}
          <div style={{ fontSize: 12, color: PALETTE.textMuted, marginBottom: 14, display: "flex", gap: 14, flexWrap: "wrap" }}>
            <span><strong style={{ color: PALETTE.warn }}>{taskCounts.pending}</strong> pendientes</span>
            <span><strong style={{ color: PALETTE.accent }}>{taskCounts.inProgress}</strong> en curso</span>
            <span><strong style={{ color: PALETTE.success }}>{taskCounts.resolved}</strong> resueltas</span>
          </div>

          {filteredTasks.length === 0 ? (
            <div style={{ padding: 24, textAlign: "center", color: PALETTE.textMuted, fontSize: 13, background: PALETTE.panel, border: `1px solid ${PALETTE.border}`, borderRadius: 0 }}>
              No hay tareas que coincidan con los filtros activos.
            </div>
          ) : (
            <>
              {sectionedTasks.priorit.length > 0 && (
                <div style={{ marginBottom: 18 }}>
                  <div style={{ fontSize: 11, fontWeight: 700, color: PALETTE.danger, textTransform: "uppercase", letterSpacing: 0.6, marginBottom: 8 }}>
                    🔥 Prioritarias ({sectionedTasks.priorit.length})
                  </div>
                  {sectionedTasks.priorit.map(t => (
                    <TaskCard key={t.id} ticket={t} onSetStatus={setTaskNormalizedStatus} />
                  ))}
                </div>
              )}
              {sectionedTasks.enCurso.length > 0 && (
                <div style={{ marginBottom: 18 }}>
                  <div style={{ fontSize: 11, fontWeight: 700, color: PALETTE.accent, textTransform: "uppercase", letterSpacing: 0.6, marginBottom: 8 }}>
                    En curso ({sectionedTasks.enCurso.length})
                  </div>
                  {sectionedTasks.enCurso.map(t => (
                    <TaskCard key={t.id} ticket={t} onSetStatus={setTaskNormalizedStatus} />
                  ))}
                </div>
              )}
              {sectionedTasks.pend.length > 0 && (
                <div style={{ marginBottom: 18 }}>
                  <div style={{ fontSize: 11, fontWeight: 700, color: PALETTE.textMuted, textTransform: "uppercase", letterSpacing: 0.6, marginBottom: 8 }}>
                    Pendientes ({sectionedTasks.pend.length})
                  </div>
                  {sectionedTasks.pend.map(t => (
                    <TaskCard key={t.id} ticket={t} onSetStatus={setTaskNormalizedStatus} />
                  ))}
                </div>
              )}
              {sectionedTasks.resu.length > 0 && taskFilters.estado.has("resolved") && (
                <div style={{ marginBottom: 18 }}>
                  <div style={{ fontSize: 11, fontWeight: 700, color: PALETTE.success, textTransform: "uppercase", letterSpacing: 0.6, marginBottom: 8 }}>
                    Resueltas ({sectionedTasks.resu.length})
                  </div>
                  {sectionedTasks.resu.map(t => (
                    <TaskCard key={t.id} ticket={t} onSetStatus={setTaskNormalizedStatus} />
                  ))}
                </div>
              )}
            </>
          )}
        </>
      )}
    </div>
  );
}
