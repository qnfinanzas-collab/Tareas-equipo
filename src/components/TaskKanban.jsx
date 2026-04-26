// Mini-Kanban del día — vista compacta de tareas del usuario activo
// agrupadas por columna. Complementa el timeline horizontal mostrando
// las tareas no en función del tiempo sino del flujo (Por hacer / En
// progreso / Hecho hoy). Se usa dentro de la Sala de Mando justo debajo
// del Pulso. Las tarjetas son densas pero clicables → abren la tarea.
import React from "react";
import { daysUntil, fmt } from "../lib/date.js";

const COLUMN_DEFS = [
  { key: "todo",     label: "Por hacer",   color: "#7F77DD", match: t => t.colName !== "Hecho" && t.colName !== "En progreso" },
  { key: "doing",    label: "En progreso", color: "#3B82F6", match: t => t.colName === "En progreso" },
  { key: "donetoday", label: "Hecho hoy",  color: "#1D9E75", match: t => t.colName === "Hecho" && (t.timeLogs || []).some(l => l.date === fmt(new Date())) },
];

export default function TaskKanban({ myTasks, onOpenTask, RefBadge }) {
  const grouped = COLUMN_DEFS.map(col => ({
    ...col,
    items: (myTasks || []).filter(col.match)
      .sort((a, b) => {
        const da = a.dueDate ? daysUntil(a.dueDate) : 9999;
        const db = b.dueDate ? daysUntil(b.dueDate) : 9999;
        if (da !== db) return da - db;
        const pa = a.priority === "alta" ? 0 : a.priority === "media" ? 1 : 2;
        const pb = b.priority === "alta" ? 0 : b.priority === "media" ? 1 : 2;
        return pa - pb;
      }),
  }));

  return (
    <div style={{ background: "#fff", border: "1px solid #E5E7EB", borderRadius: 12, padding: "14px 16px", marginBottom: 16 }}>
      <div style={{ fontSize: 11, fontWeight: 700, color: "#374151", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 10 }}>📋 Kanban del día</div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 10 }}>
        {grouped.map(col => (
          <div key={col.key} style={{ background: "#FAFAFA", border: "1px solid #F3F4F6", borderRadius: 8, padding: "10px 10px", minHeight: 120 }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
              <span style={{ fontSize: 11, fontWeight: 700, color: col.color }}>{col.label}</span>
              <span style={{ fontSize: 10, padding: "1px 7px", borderRadius: 10, background: `${col.color}18`, color: col.color, fontWeight: 600 }}>{col.items.length}</span>
            </div>
            {col.items.length === 0 ? (
              <div style={{ fontSize: 10.5, color: "#9CA3AF", fontStyle: "italic", padding: "6px 0" }}>—</div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 5, maxHeight: 240, overflowY: "auto" }}>
                {col.items.slice(0, 6).map(t => {
                  const days = t.dueDate ? daysUntil(t.dueDate) : null;
                  const dueColor = !t.dueDate ? "#9CA3AF" : days < 0 ? "#E24B4A" : days === 0 ? "#EF9F27" : "#6B7280";
                  return (
                    <div key={t.id} onClick={() => onOpenTask?.(t.id, t.projId)} style={{ background: "#fff", border: "0.5px solid #E5E7EB", borderLeft: `3px solid ${t.projColor || col.color}`, borderRadius: 6, padding: "6px 8px", cursor: "pointer" }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 4, marginBottom: 2, minWidth: 0 }}>
                        {RefBadge ? <RefBadge code={t.ref} /> : null}
                        <span style={{ fontSize: 11.5, fontWeight: 500, color: "#111827", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{t.title}</span>
                      </div>
                      <div style={{ fontSize: 9.5, color: "#9CA3AF", display: "flex", justifyContent: "space-between", gap: 4 }}>
                        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{t.projEmoji || "📋"} {t.projName}</span>
                        {t.dueDate && <span style={{ color: dueColor, fontWeight: 600, flexShrink: 0 }}>{days < 0 ? `-${-days}d` : days === 0 ? "hoy" : `${days}d`}</span>}
                      </div>
                    </div>
                  );
                })}
                {col.items.length > 6 && (
                  <div style={{ fontSize: 10, color: "#9CA3AF", textAlign: "center", padding: "3px 0" }}>+{col.items.length - 6} más</div>
                )}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
