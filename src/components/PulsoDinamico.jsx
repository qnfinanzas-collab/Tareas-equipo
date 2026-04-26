// Pulso del Día — timeline horizontal de 16 bloques de 30 min con popover
// hover por bloque. Recibe las tareas activas ya enriquecidas (projName,
// projColor, ref, etc.) y RefBadge como prop para no duplicar el chip.
// Asignación automática a bloques: vencidas (rojo) → hoy (naranja) →
// alta prioridad (azul). Línea vertical roja marca la hora actual.
import React, { useState } from "react";
import { daysUntil } from "../lib/date.js";

export default function PulsoDinamico({ active, negotiations, onOpenTask, RefBadge }) {
  const [hoverBlock, setHoverBlock] = useState(null);
  const now = new Date();
  const blocks = (() => {
    const out = [];
    const start = new Date(now);
    start.setMinutes(start.getMinutes() - (start.getMinutes() % 30), 0, 0);
    for (let i = 0; i < 16; i++) {
      const t = new Date(start.getTime() + i * 30 * 60000);
      const hh = String(t.getHours()).padStart(2, "0");
      const mm = String(t.getMinutes()).padStart(2, "0");
      out.push({ label: `${hh}:${mm}`, ts: t.getTime(), color: "#E5E7EB", task: null });
    }
    return out;
  })();

  const overdueList = active.filter(t => t.dueDate && daysUntil(t.dueDate) < 0).slice(0, 2);
  const todayList   = active.filter(t => t.dueDate && daysUntil(t.dueDate) === 0).slice(0, 2);
  const highList    = active.filter(t => t.priority === "alta" && !overdueList.includes(t) && !todayList.includes(t)).slice(0, 3);

  let bIdx = 0;
  const paint = (list, color) => list.forEach(t => {
    if (blocks[bIdx]) { blocks[bIdx].color = color; blocks[bIdx].task = t; bIdx++; }
    if (blocks[bIdx]) { blocks[bIdx].color = color; blocks[bIdx].task = t; bIdx++; }
  });
  paint(overdueList, "#FCA5A5");
  paint(todayList,   "#FDBA74");
  paint(highList,    "#93C5FD");

  return (
    <div style={{ background: "#fff", border: "1px solid #E5E7EB", borderRadius: 12, padding: "14px 16px", marginBottom: 16 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: "#374151", textTransform: "uppercase", letterSpacing: "0.08em" }}>⏱ Pulso del día — próximas 8 h</div>
        <div style={{ display: "flex", gap: 8, fontSize: 10, color: "#9CA3AF" }}>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}><span style={{ width: 8, height: 8, background: "#FCA5A5", borderRadius: 2 }} />Crítico</span>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}><span style={{ width: 8, height: 8, background: "#FDBA74", borderRadius: 2 }} />Hoy</span>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}><span style={{ width: 8, height: 8, background: "#93C5FD", borderRadius: 2 }} />Profundo</span>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}><span style={{ width: 8, height: 8, background: "#86EFAC", borderRadius: 2 }} />Comunicación</span>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}><span style={{ width: 8, height: 8, background: "#E5E7EB", borderRadius: 2 }} />Libre</span>
        </div>
      </div>
      <div style={{ position: "relative", display: "grid", gridTemplateColumns: "repeat(16,1fr)", gap: 3, height: 36 }}>
        {blocks.map((b, i) => {
          const isHover = hoverBlock === i;
          const transformX = i <= 1 ? "0" : i >= 14 ? "-100%" : "-50%";
          return (
            <div
              key={i}
              onMouseEnter={() => setHoverBlock(i)}
              onMouseLeave={() => setHoverBlock(h => h === i ? null : h)}
              style={{ background: b.color, borderRadius: 4, position: "relative", cursor: b.task ? "pointer" : "default", display: "flex", alignItems: "center", justifyContent: "center" }}
              onClick={() => b.task && onOpenTask?.(b.task.id, b.task.projId)}
            >
              {i % 2 === 0 && <span style={{ fontSize: 9, color: "#374151", fontWeight: 600, opacity: 0.7 }}>{b.label}</span>}
              {isHover && b.task && (() => {
                const t = b.task;
                const neg = t.negotiationId ? (negotiations || []).find(n => n.id === t.negotiationId) : null;
                const priColors = t.priority === "alta" ? { bg: "#FCEBEB", fg: "#A32D2D", bd: "#E24B4A" }
                                : t.priority === "media" ? { bg: "#FEF3C7", fg: "#92400E", bd: "#FCD34D" }
                                : { bg: "#F0FDF4", fg: "#0E7C5A", bd: "#86EFAC" };
                return (
                  <div style={{ position: "absolute", left: "50%", bottom: "calc(100% + 8px)", transform: `translateX(${transformX})`, width: 240, padding: "10px 12px", background: "#fff", border: "1px solid #E5E7EB", borderRadius: 10, boxShadow: "0 8px 24px rgba(0,0,0,0.12)", zIndex: 50, pointerEvents: "none", textAlign: "left" }}>
                    <div style={{ fontSize: 10, color: "#9CA3AF", fontWeight: 600, marginBottom: 4 }}>🕒 {b.label}</div>
                    <div style={{ display: "flex", alignItems: "center", gap: 5, marginBottom: 5, flexWrap: "wrap" }}>
                      {RefBadge ? <RefBadge code={t.ref} /> : null}
                      <span style={{ fontSize: 10.5, color: t.projColor || "#6B7280", fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 160 }}>{t.projEmoji || "📋"} {t.projName}</span>
                    </div>
                    <div style={{ fontSize: 13, fontWeight: 600, color: "#111827", lineHeight: 1.3, marginBottom: 6, wordBreak: "break-word" }}>{t.title}</div>
                    {neg && <div style={{ fontSize: 11, color: "#6B7280", marginBottom: 4 }}>🤝 Contraparte: <b style={{ color: "#374151" }}>{neg.counterparty}</b></div>}
                    <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", marginTop: 6 }}>
                      <span style={{ fontSize: 10, fontWeight: 600, padding: "2px 7px", borderRadius: 10, background: priColors.bg, border: `1px solid ${priColors.bd}`, color: priColors.fg }}>Prio {t.priority || "media"}</span>
                      <span style={{ fontSize: 10, fontWeight: 500, padding: "2px 7px", borderRadius: 10, background: "#F3F4F6", color: "#374151", border: "1px solid #E5E7EB" }}>{t.colName || "—"}</span>
                      {t.estimatedHours > 0 && <span style={{ fontSize: 10, color: "#6B7280" }}>⌛ {t.estimatedHours}h est.</span>}
                    </div>
                  </div>
                );
              })()}
            </div>
          );
        })}
        {(() => {
          const start = blocks[0]?.ts; if (!start) return null;
          const ratio = ((now.getTime() - start) / (8 * 3600000));
          if (ratio < 0 || ratio > 1) return null;
          return <div style={{ position: "absolute", top: -3, bottom: -3, left: `${ratio * 100}%`, width: 2, background: "#E24B4A", pointerEvents: "none" }} />;
        })()}
      </div>
    </div>
  );
}
