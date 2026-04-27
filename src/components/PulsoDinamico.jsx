// Pulso del Día — timeline horizontal de 16 bloques de 30 min con tooltip
// hover por bloque + popover persistente al click (con botón Abrir tarea
// y Cerrar). Línea vertical roja viva — un setInterval de 60 s fuerza
// re-render para que la línea avance en tiempo real sin recargar la app.
// Asignación a bloques: vencidas (rojo) → hoy (naranja) → alta prio (azul).
import React, { useEffect, useState } from "react";
import { daysUntil } from "../lib/date.js";

// Decodifica el "tipo" del bloque a partir de su color para el tooltip.
const COLOR_TO_TYPE = {
  "#FCA5A5": { label: "Crítico",       color: "#B91C1C" },
  "#FDBA74": { label: "Hoy",           color: "#B45309" },
  "#93C5FD": { label: "Trabajo profundo", color: "#1E40AF" },
  "#86EFAC": { label: "Comunicación",  color: "#065F46" },
  "#E5E7EB": { label: "Libre",         color: "#6B7280" },
};

export default function PulsoDinamico({ active, negotiations, onOpenTask, RefBadge }) {
  const [hoverBlock, setHoverBlock] = useState(null);
  const [pinnedBlock, setPinnedBlock] = useState(null);
  // Tick para que la línea de "hora actual" avance cada minuto. No
  // necesitamos guardar el valor — el render lee Date.now() directamente.
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick(t => t + 1), 60 * 1000);
    return () => clearInterval(id);
  }, []);

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

  // Cierra popover pinned con ESC.
  useEffect(() => {
    if (pinnedBlock === null) return;
    const onKey = (e) => { if (e.key === "Escape") setPinnedBlock(null); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pinnedBlock]);

  const renderBlockPopover = (b, i, pinned) => {
    const type = COLOR_TO_TYPE[b.color] || COLOR_TO_TYPE["#E5E7EB"];
    const t = b.task;
    const neg = t?.negotiationId ? (negotiations || []).find(n => n.id === t.negotiationId) : null;
    const priColors = !t ? null
      : t.priority === "alta" ? { bg: "#FCEBEB", fg: "#A32D2D", bd: "#E24B4A" }
      : t.priority === "media" ? { bg: "#FEF3C7", fg: "#92400E", bd: "#FCD34D" }
      : { bg: "#F0FDF4", fg: "#0E7C5A", bd: "#86EFAC" };
    const transformX = i <= 1 ? "0" : i >= 14 ? "-100%" : "-50%";
    return (
      <div style={{
        position: "absolute",
        left: i <= 1 ? "0" : i >= 14 ? "100%" : "50%",
        bottom: "calc(100% + 8px)",
        transform: `translateX(${transformX})`,
        width: 260,
        padding: "10px 12px",
        background: "#fff",
        border: `1px solid ${pinned ? "#7F77DD" : "#E5E7EB"}`,
        borderRadius: 10,
        boxShadow: "0 8px 24px rgba(0,0,0,0.12)",
        zIndex: 50,
        pointerEvents: pinned ? "auto" : "none",
        textAlign: "left",
      }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
          <div style={{ fontSize: 10, color: "#9CA3AF", fontWeight: 600 }}>🕒 {b.label}</div>
          <span style={{ fontSize: 9.5, fontWeight: 700, padding: "1px 6px", borderRadius: 4, color: type.color, background: `${type.color}18`, border: `1px solid ${type.color}55`, textTransform: "uppercase", letterSpacing: "0.04em" }}>{type.label}</span>
        </div>
        {!t ? (
          <div style={{ fontSize: 12, color: "#9CA3AF", fontStyle: "italic", padding: "8px 0" }}>Tramo sin tareas asignadas.</div>
        ) : (
          <>
            <div style={{ display: "flex", alignItems: "center", gap: 5, marginBottom: 5, flexWrap: "wrap" }}>
              {RefBadge ? <RefBadge code={t.ref} /> : null}
              <span style={{ fontSize: 10.5, color: t.projColor || "#6B7280", fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 160 }}>{t.projEmoji || "📋"} {t.projName}</span>
            </div>
            <div style={{ fontSize: 13, fontWeight: 600, color: "#111827", lineHeight: 1.3, marginBottom: 6, wordBreak: "break-word" }}>{t.title}</div>
            {neg && <div style={{ fontSize: 11, color: "#6B7280", marginBottom: 4 }}>🤝 Contraparte: <b style={{ color: "#374151" }}>{neg.counterparty}</b></div>}
            <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", marginTop: 6, marginBottom: pinned ? 8 : 0 }}>
              <span style={{ fontSize: 10, fontWeight: 600, padding: "2px 7px", borderRadius: 10, background: priColors.bg, border: `1px solid ${priColors.bd}`, color: priColors.fg }}>Prio {t.priority || "media"}</span>
              <span style={{ fontSize: 10, fontWeight: 500, padding: "2px 7px", borderRadius: 10, background: "#F3F4F6", color: "#374151", border: "1px solid #E5E7EB" }}>{t.colName || "—"}</span>
              {t.estimatedHours > 0 && <span style={{ fontSize: 10, color: "#6B7280" }}>⌛ {t.estimatedHours}h est.</span>}
            </div>
            {pinned && (
              <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
                <button onClick={(e) => { e.stopPropagation(); onOpenTask?.(t.id, t.projId); setPinnedBlock(null); }} style={{ flex: 1, padding: "6px 10px", borderRadius: 6, background: "#7F77DD", color: "#fff", border: "none", fontSize: 11.5, fontWeight: 600, cursor: "pointer", fontFamily: "inherit" }}>→ Abrir tarea</button>
                <button onClick={(e) => { e.stopPropagation(); setPinnedBlock(null); }} style={{ padding: "6px 10px", borderRadius: 6, background: "transparent", color: "#6B7280", border: "1px solid #D1D5DB", fontSize: 11.5, fontWeight: 600, cursor: "pointer", fontFamily: "inherit" }}>Cerrar</button>
              </div>
            )}
          </>
        )}
      </div>
    );
  };

  return (
    <div style={{ background: "#fff", border: "1px solid #E5E7EB", borderRadius: 12, padding: "14px 16px", marginBottom: 16 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10, flexWrap: "wrap", gap: 6 }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: "#374151", textTransform: "uppercase", letterSpacing: "0.08em" }}>⏱ Pulso del día — próximas 8 h</div>
        <div style={{ display: "flex", gap: 8, fontSize: 10, color: "#9CA3AF", flexWrap: "wrap" }}>
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
          const isPinned = pinnedBlock === i;
          const showPopover = isPinned || (isHover && pinnedBlock === null);
          const type = COLOR_TO_TYPE[b.color] || COLOR_TO_TYPE["#E5E7EB"];
          const titleAttr = b.task
            ? `${b.label} · ${type.label} · ${b.task.title}`
            : `${b.label} · ${type.label} · Sin tareas`;
          return (
            <div
              key={i}
              title={titleAttr}
              onMouseEnter={() => setHoverBlock(i)}
              onMouseLeave={() => setHoverBlock(h => h === i ? null : h)}
              onClick={() => {
                if (!b.task) return;
                setPinnedBlock(p => p === i ? null : i);
              }}
              style={{
                background: b.color,
                borderRadius: 4,
                position: "relative",
                cursor: b.task ? "pointer" : "default",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                outline: isPinned ? "2px solid #7F77DD" : "none",
              }}
            >
              {i % 2 === 0 && <span style={{ fontSize: 9, color: "#374151", fontWeight: 600, opacity: 0.7 }}>{b.label}</span>}
              {showPopover && renderBlockPopover(b, i, isPinned)}
            </div>
          );
        })}
        {(() => {
          const start = blocks[0]?.ts; if (!start) return null;
          const ratio = ((Date.now() - start) / (8 * 3600000));
          if (ratio < 0 || ratio > 1) return null;
          return (
            <div style={{ position: "absolute", top: -4, bottom: -4, left: `${ratio * 100}%`, width: 2, background: "#E24B4A", pointerEvents: "none", boxShadow: "0 0 6px rgba(231,76,60,0.4)" }}>
              <div style={{ position: "absolute", top: -6, left: -3, width: 8, height: 8, borderRadius: "50%", background: "#E24B4A" }} />
            </div>
          );
        })()}
      </div>
    </div>
  );
}
