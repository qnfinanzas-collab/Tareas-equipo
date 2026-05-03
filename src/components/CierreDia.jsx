// Cierre del día pasivo — modal que aparece la primera vez que el CEO
// abre la app a partir de las 18:00 (hora local) si no se mostró el cierre
// hoy. Resume lo cumplido vs. lo postergado y pide a Héctor una observación
// breve sobre el patrón del día. Marca "cierreDia.lastDate" en localStorage
// al cerrarse para no repetirse durante la jornada.
import React, { useEffect, useMemo, useState } from "react";
import { fmt, daysUntil } from "../lib/date.js";
import { PLAIN_TEXT_RULE } from "../lib/agent.js";

export default function CierreDia({ user, data, onClose }) {
  const today = fmt(new Date());
  // Cómputo determinista de cumplido vs. postergado para el resumen.
  const summary = useMemo(() => {
    const myTasks = [];
    Object.entries(data.boards || {}).forEach(([pid, cols]) => {
      const proj = (data.projects || []).find(p => p.id === Number(pid));
      cols.forEach(col => col.tasks.forEach(t => {
        if (!t.assignees?.includes(user.id)) return;
        myTasks.push({ ...t, colName: col.name, projName: proj?.name || "" });
      }));
    });
    const doneToday = myTasks.filter(t => t.colName === "Hecho" && (t.timeLogs || []).some(l => l.date === today));
    const overdueOpen = myTasks.filter(t => t.colName !== "Hecho" && t.dueDate && daysUntil(t.dueDate) < 0);
    const dueTodayOpen = myTasks.filter(t => t.colName !== "Hecho" && t.dueDate && daysUntil(t.dueDate) === 0);
    const total = myTasks.filter(t => t.colName !== "Hecho").length + doneToday.length;
    return { myTasks, doneToday, overdueOpen, dueTodayOpen, total };
  }, [data, user?.id, today]);

  const [observation, setObservation] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const hectorAgent = (data.agents || []).find(a => a.name === "Héctor");
        const baseSystem = hectorAgent?.promptBase
          ? hectorAgent.promptBase + "\n\n" + PLAIN_TEXT_RULE
          : "Eres Héctor, Chief of Staff estratégico. " + PLAIN_TEXT_RULE;
        const system = baseSystem + "\n\nIMPORTANTE: responde texto plano sin markdown, exactamente 2-3 frases.";
        const doneList = summary.doneToday.slice(0, 8).map(t => `- ${t.ref || ""} ${t.title} (${t.projName})`).join("\n") || "(ninguna)";
        const carryList = [...summary.overdueOpen, ...summary.dueTodayOpen].slice(0, 8).map(t => `- ${t.ref || ""} ${t.title} (vence ${t.dueDate})`).join("\n") || "(ninguna)";
        const prompt = `Cierre del día de ${user.name || "el CEO"} (${today}).\n\nCOMPLETADAS HOY (${summary.doneToday.length}):\n${doneList}\n\nQUEDAN ABIERTAS PARA MAÑANA (${summary.overdueOpen.length + summary.dueTodayOpen.length}):\n${carryList}\n\nDame 2-3 frases en castellano:\n1. Una observación sobre el patrón del día (qué tipo de trabajo dominó, dónde hubo bloqueo).\n2. Una sugerencia concreta para mañana.\n\nSin listas, sin markdown. Frases enteras.`;
        const r = await fetch("/api/agent", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ system, messages: [{ role: "user", content: prompt }], max_tokens: 250 }),
        });
        if (cancelled) return;
        const raw = await r.text();
        let parsed = null; try { parsed = JSON.parse(raw); } catch {}
        if (!r.ok) throw new Error(parsed?.error || `HTTP ${r.status}`);
        if (cancelled) return;
        setObservation((parsed?.text || raw || "").trim());
        setLoading(false);
      } catch (e) {
        if (cancelled) return;
        console.warn("[cierre-dia] LLM falló:", e?.message);
        setObservation("");
        setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [data, user?.id, user?.name, today, summary]);

  const handleClose = () => {
    try { localStorage.setItem("kluxor.cierreDia.lastDate", today); } catch {}
    onClose?.();
  };

  return (
    <div className="tf-overlay" onClick={e => e.target === e.currentTarget && handleClose()} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)", zIndex: 4000, display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}>
      <div style={{ background: "#fff", borderRadius: 16, width: 560, maxWidth: "94vw", overflow: "hidden", borderTop: "4px solid #6366F1" }}>
        <div style={{ padding: "16px 20px", borderBottom: "0.5px solid #e5e7eb", display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{ width: 38, height: 38, borderRadius: "50%", background: "linear-gradient(135deg,#6366F1,#4F46E5)", color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 18 }}>🌙</div>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 15, fontWeight: 700, color: "#4338CA" }}>Cierre del día</div>
            <div style={{ fontSize: 11, color: "#6B7280" }}>Lo que pasó hoy en una mirada</div>
          </div>
        </div>
        <div style={{ padding: "18px 22px", display: "flex", flexDirection: "column", gap: 14 }}>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 10 }}>
            <div style={{ background: "#F0FDF4", border: "1px solid #86EFAC", borderRadius: 10, padding: "10px 12px", textAlign: "center" }}>
              <div style={{ fontSize: 11, color: "#065F46", fontWeight: 600, marginBottom: 4 }}>Cumplidas</div>
              <div style={{ fontSize: 22, fontWeight: 700, color: "#059669" }}>{summary.doneToday.length}</div>
            </div>
            <div style={{ background: "#FEF3C7", border: "1px solid #FCD34D", borderRadius: 10, padding: "10px 12px", textAlign: "center" }}>
              <div style={{ fontSize: 11, color: "#92400E", fontWeight: 600, marginBottom: 4 }}>Pendientes hoy</div>
              <div style={{ fontSize: 22, fontWeight: 700, color: "#B45309" }}>{summary.dueTodayOpen.length}</div>
            </div>
            <div style={{ background: "#FEE2E2", border: "1px solid #FCA5A5", borderRadius: 10, padding: "10px 12px", textAlign: "center" }}>
              <div style={{ fontSize: 11, color: "#991B1B", fontWeight: 600, marginBottom: 4 }}>Vencidas</div>
              <div style={{ fontSize: 22, fontWeight: 700, color: "#B91C1C" }}>{summary.overdueOpen.length}</div>
            </div>
          </div>
          <div style={{ background: "#F5F3FF", border: "1px solid #DDD6FE", borderRadius: 10, padding: "12px 14px", fontSize: 13, color: "#4C1D95", lineHeight: 1.55, whiteSpace: "pre-wrap", minHeight: 70 }}>
            <div style={{ fontSize: 10, fontWeight: 700, color: "#6D28D9", marginBottom: 6, textTransform: "uppercase", letterSpacing: "0.06em" }}>Observación de Héctor</div>
            {loading ? <span style={{ fontStyle: "italic", color: "#6B7280" }}>Resumiendo el día…</span> : (observation || "Sin observación disponible.")}
          </div>
        </div>
        <div style={{ padding: "12px 20px", borderTop: "0.5px solid #e5e7eb", background: "#fafafa", display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button onClick={handleClose} disabled={loading} style={{ padding: "9px 18px", borderRadius: 8, background: loading ? "#E5E7EB" : "#6366F1", color: loading ? "#9CA3AF" : "#fff", border: "none", fontSize: 13, fontWeight: 700, cursor: loading ? "not-allowed" : "pointer", fontFamily: "inherit" }}>Buenas noches 🌙</button>
        </div>
      </div>
    </div>
  );
}
