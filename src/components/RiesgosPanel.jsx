// Panel de Riesgos Activos — 3 tarjetas compactas con métricas en vivo
// derivadas del estado del board y las negociaciones. Cada tarjeta es
// clicable y dispara una ruta filtrada de la app (Mis tareas con filtro,
// Deal Room con filtro, etc.). Pure presentational — el cómputo de los
// conjuntos lo hace el padre y los pasa por props.
import React from "react";
import { daysUntil } from "../lib/date.js";

export default function RiesgosPanel({ active, negotiations, onGoMytasks, onGoDealRoom }) {
  const overdueCold = (active || []).filter(t => {
    if (!t.dueDate || daysUntil(t.dueDate) >= 0) return false;
    const lastLog = (t.timeLogs || []).slice(-1)[0]?.date || t.startDate;
    const days = lastLog ? Math.floor((Date.now() - new Date(lastLog).getTime()) / 86400000) : 999;
    return days >= 2;
  });
  const coldNegs = (negotiations || []).filter(n => {
    if (n.status !== "active" && n.status !== "open" && n.status !== "negotiating") return false;
    const ts = n.updatedAt ? new Date(n.updatedAt).getTime() : 0;
    if (!ts) return false;
    return (Date.now() - ts) > 5 * 86400000;
  });
  const waiting = (active || []).filter(t =>
    (t.comments || []).some(c => /esperando respuesta/i.test(c.text || ""))
  );

  const cards = [
    {
      key: "overdue",
      title: "🔴 Vencidas sin tocar",
      count: overdueCold.length,
      desc: overdueCold.length === 0 ? "Limpio — ningún olvido" : "+2 días sin actualización",
      color: { fg: "#991B1B", count: "#B91C1C", border: "#FCA5A5", accent: "#E24B4A" },
      onClick: () => onGoMytasks?.("overdue"),
    },
    {
      key: "cold",
      title: "⏳ Negociaciones frías",
      count: coldNegs.length,
      desc: coldNegs.length === 0 ? "Todas en movimiento" : "+5 días sin actividad",
      color: { fg: "#92400E", count: "#B45309", border: "#FCD34D", accent: "#EF9F27" },
      onClick: () => onGoDealRoom?.("cold"),
    },
    {
      key: "waiting",
      title: "📨 Esperan respuesta",
      count: waiting.length,
      desc: waiting.length === 0 ? "Sin pendientes externos" : "Con etiqueta en comentarios",
      color: { fg: "#1E3A8A", count: "#1E40AF", border: "#BFDBFE", accent: "#3B82F6" },
      onClick: () => onGoMytasks?.("waiting"),
    },
  ];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      {cards.map(c => (
        <div key={c.key} onClick={c.onClick} style={{ background: "#fff", border: `1px solid ${c.count > 0 ? c.color.border : "#E5E7EB"}`, borderLeft: `4px solid ${c.count > 0 ? c.color.accent : "#D1D5DB"}`, borderRadius: 10, padding: "12px 14px", cursor: "pointer" }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: c.color.fg, marginBottom: 4, textTransform: "uppercase", letterSpacing: "0.06em" }}>{c.title}</div>
          <div style={{ fontSize: 24, fontWeight: 700, color: c.count > 0 ? c.color.count : "#9CA3AF", lineHeight: 1.1 }}>{c.count}</div>
          <div style={{ fontSize: 11, color: "#6B7280", marginTop: 2 }}>{c.desc}</div>
        </div>
      ))}
    </div>
  );
}
