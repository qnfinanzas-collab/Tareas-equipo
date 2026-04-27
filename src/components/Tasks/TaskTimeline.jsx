// TaskTimeline — visor del avance de una tarea con cards diferenciadas
// por tipo (humano / IA / hito). En este commit cubre el render +
// plegado (>3 entradas se colapsan, mostrar las 3 más recientes con
// botón "Ver todas N"). El input para añadir entradas y los filtros
// llegan en los siguientes commits.
import React, { useState } from "react";

const TYPE_STYLE = {
  human:     { border: "#3498DB", bg: "#fff",     label: "" },
  ai:        { border: "#9B59B6", bg: "#fff",     label: "IA" },
  milestone: { border: "#F39C12", bg: "#FFF8E7",  label: "HITO" },
};

const fmtRelative = (ts) => {
  const d = new Date(ts);
  if (isNaN(d.getTime())) return "";
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const diffH = Math.floor((now - d) / 3600000);
  if (sameDay && diffH < 1) {
    const m = Math.floor((now - d) / 60000);
    return m <= 0 ? "ahora" : `hace ${m} min`;
  }
  if (sameDay) return `hace ${diffH}h`;
  return d.toLocaleDateString("es-ES", { day: "numeric", month: "short" }) + " " + d.toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit" });
};

function resolveAuthorName(entry, members) {
  if (entry.author) return entry.author;
  if (entry.authorId == null) return entry.type === "ai" ? "Héctor" : "Usuario";
  const m = (members || []).find(x => x.id === entry.authorId);
  return m?.name || (entry.type === "ai" ? "Héctor" : "Usuario");
}

function resolveAuthorAvatar(entry) {
  if (entry.authorAvatar) return entry.authorAvatar;
  if (entry.type === "ai") return "🧙";
  if (entry.type === "milestone") return "📍";
  return "👤";
}

export default function TaskTimeline({ task, members = [], currentMember, onAddEntry, onToggleMilestone }) {
  const all = Array.isArray(task?.timeline) ? task.timeline : [];
  // Más reciente arriba
  const sorted = all.slice().sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
  const [expanded, setExpanded] = useState(false);
  const visible = (sorted.length > 3 && !expanded) ? sorted.slice(0, 3) : sorted;
  const hidden = sorted.length - visible.length;

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
        <div style={{ fontSize: 12, fontWeight: 700, color: "#374151", textTransform: "uppercase", letterSpacing: "0.06em" }}>
          ▼ Avance ({sorted.length} actualizacion{sorted.length === 1 ? "" : "es"})
        </div>
      </div>

      {sorted.length === 0 ? (
        <div style={{ fontSize: 12, color: "#9CA3AF", fontStyle: "italic", padding: "12px 0" }}>Aún sin avances registrados.</div>
      ) : (
        <div>
          {visible.map((entry) => {
            const isMilestone = entry.type === "milestone" || entry.isMilestone;
            const styleKey = isMilestone ? "milestone" : (entry.type === "ai" ? "ai" : "human");
            const style = TYPE_STYLE[styleKey];
            const authorName = resolveAuthorName(entry, members);
            const avatar = resolveAuthorAvatar(entry);
            const time = entry.legacyTime || fmtRelative(entry.timestamp);
            return (
              <div key={entry.id} style={{
                background: style.bg,
                borderLeft: `3px solid ${style.border}`,
                borderTop: "0.5px solid #E5E7EB",
                borderRight: "0.5px solid #E5E7EB",
                borderBottom: "0.5px solid #E5E7EB",
                borderRadius: 8,
                padding: "12px 14px",
                marginBottom: 10,
                boxShadow: "0 1px 3px rgba(0,0,0,0.05)",
                display: "flex",
                gap: 10,
                alignItems: "flex-start",
              }}>
                <div style={{ fontSize: isMilestone ? 22 : 20, flexShrink: 0, lineHeight: 1.1 }}>{isMilestone ? "📍" : avatar}</div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4, flexWrap: "wrap" }}>
                    <span style={{ fontSize: 12.5, fontWeight: 700, color: "#111827" }}>{authorName}</span>
                    <span style={{ fontSize: 11, color: "#9CA3AF" }}>· {time}</span>
                    {style.label && (
                      <span style={{
                        backgroundColor: isMilestone ? "#F39C12" : "#9B59B6",
                        color: "white",
                        padding: "2px 6px",
                        borderRadius: 3,
                        fontSize: 10,
                        fontWeight: 700,
                        textTransform: "uppercase",
                        letterSpacing: "0.04em",
                      }}>{style.label}</span>
                    )}
                  </div>
                  <div style={{ fontSize: 13, color: "#374151", lineHeight: 1.5, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{entry.text}</div>
                  {onToggleMilestone && (
                    <div style={{ marginTop: 6, opacity: 0.7 }}>
                      <button
                        onClick={() => onToggleMilestone(task.id, entry.id)}
                        style={{
                          padding: "3px 9px",
                          borderRadius: 5,
                          background: isMilestone ? "#FFF8E7" : "transparent",
                          color: isMilestone ? "#92400E" : "#6B7280",
                          border: `1px solid ${isMilestone ? "#FCD34D" : "#E5E7EB"}`,
                          fontSize: 10.5,
                          fontWeight: 600,
                          cursor: "pointer",
                          fontFamily: "inherit",
                        }}
                      >📍 {isMilestone ? "Quitar hito" : "Marcar hito"}</button>
                    </div>
                  )}
                </div>
              </div>
            );
          })}
          {hidden > 0 && (
            <button
              onClick={() => setExpanded(true)}
              style={{ width: "100%", padding: "8px 12px", borderRadius: 8, background: "transparent", color: "#3498DB", border: "1px dashed #BFDBFE", fontSize: 12, fontWeight: 600, cursor: "pointer", fontFamily: "inherit", marginBottom: 8 }}
            >Ver {hidden} actualizacion{hidden === 1 ? "" : "es"} anterior{hidden === 1 ? "" : "es"} →</button>
          )}
          {expanded && sorted.length > 3 && (
            <button
              onClick={() => setExpanded(false)}
              style={{ width: "100%", padding: "8px 12px", borderRadius: 8, background: "transparent", color: "#6B7280", border: "1px dashed #D1D5DB", fontSize: 12, fontWeight: 500, cursor: "pointer", fontFamily: "inherit", marginBottom: 8 }}
            >Plegar a las 3 más recientes ↑</button>
          )}
        </div>
      )}
    </div>
  );
}
