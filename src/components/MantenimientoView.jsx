import React, { useEffect, useMemo, useState } from "react";
import { supa } from "../lib/sync.js";

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

export default function MantenimientoView({ authUid }) {
  const [tab, setTab] = useState("incident");
  const [tickets, setTickets] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [showResolved, setShowResolved] = useState(false);

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
    </div>
  );
}
