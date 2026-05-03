// Briefing matinal automático — modal que aparece la primera vez que el
// CEO abre la app en el día (>4h desde la última apertura) si todavía no
// se mostró el briefing hoy. Llama a Héctor (LLM) vía /api/agent para
// generar saludo + top tareas + pregunta de coaching. Cero llamadas a
// api.anthropic.com directas (la API key vive server-side).
import React, { useEffect, useState } from "react";
import { fmt, daysUntil } from "../lib/date.js";
import { PLAIN_TEXT_RULE } from "../lib/agent.js";

export default function BriefingMatinal({ user, data, onClose }) {
  const [text, setText] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const myTasks = [];
        Object.entries(data.boards || {}).forEach(([pid, cols]) => {
          const proj = (data.projects || []).find(p => p.id === Number(pid));
          cols.forEach(col => col.tasks.forEach(t => {
            if (!t.assignees?.includes(user.id)) return;
            if (col.name === "Hecho") return;
            myTasks.push({ ref: t.ref, title: t.title, project: proj?.name || "", code: proj?.code, dueDate: t.dueDate, priority: t.priority, days: t.dueDate ? daysUntil(t.dueDate) : null });
          }));
        });
        const top = myTasks
          .sort((a, b) => (a.days ?? 9999) - (b.days ?? 9999))
          .slice(0, 8);
        const today = fmt(new Date());
        const hectorAgent = (data.agents || []).find(a => a.name === "Héctor");
        const baseSystem = hectorAgent?.promptBase
          ? hectorAgent.promptBase + "\n\n" + PLAIN_TEXT_RULE
          : "Eres Héctor, Chief of Staff estratégico. Briefing matinal corto, directo, accionable. " + PLAIN_TEXT_RULE;
        const system = baseSystem + "\n\nIMPORTANTE: responde texto plano sin markdown, máximo 5 frases, en castellano.";
        const prompt = `Genera un briefing matinal para ${user.name || "el CEO"} (${today}).\n\nTareas pendientes top (orden por urgencia):\n${top.map(t => `- ${t.ref || ""} ${t.title} · ${t.project} · ${t.dueDate ? `vence ${t.dueDate}${t.days < 0 ? ` (vencida ${-t.days}d)` : t.days === 0 ? " (hoy)" : ` (en ${t.days}d)`}` : "sin fecha"} · prio ${t.priority || "media"}`).join("\n") || "(sin tareas pendientes)"}\n\nFormato exacto:\n1. Una frase de saludo breve (sin "Buenos días" genérico — algo concreto del día).\n2. Las 3 tareas más críticas resumidas en 1 frase cada una.\n3. Una pregunta de coaching abierta para activar el día (ej: "¿Qué impacto buscas hoy?").\n\nSin listas con guiones ni markdown. Frases separadas por saltos de línea simples.`;
        const r = await fetch("/api/agent", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ system, messages: [{ role: "user", content: prompt }], max_tokens: 400 }),
        });
        if (cancelled) return;
        const raw = await r.text();
        let parsed = null; try { parsed = JSON.parse(raw); } catch {}
        if (!r.ok) throw new Error(parsed?.error || `HTTP ${r.status}`);
        const txt = (parsed?.text || raw || "").trim();
        if (cancelled) return;
        setText(txt || "Sin briefing disponible.");
        setLoading(false);
      } catch (e) {
        if (cancelled) return;
        console.warn("[briefing-matinal] LLM falló:", e?.message);
        setError("No pude generar el briefing — revisa la conexión.");
        setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [data, user?.id, user?.name]);

  const handleClose = () => {
    try { localStorage.setItem("kluxor.briefingMatinal.lastDate", fmt(new Date())); } catch {}
    onClose?.();
  };

  return (
    <div className="tf-overlay" onClick={e => e.target === e.currentTarget && handleClose()} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)", zIndex: 4000, display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}>
      <div style={{ background: "#fff", borderRadius: 16, width: 560, maxWidth: "94vw", overflow: "hidden", borderTop: "4px solid #1D9E75" }}>
        <div style={{ padding: "16px 20px", borderBottom: "0.5px solid #e5e7eb", display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{ width: 38, height: 38, borderRadius: "50%", background: "linear-gradient(135deg,#1D9E75,#0E7C5A)", color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 18, fontWeight: 700 }}>H</div>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 15, fontWeight: 700, color: "#0E7C5A" }}>Briefing matinal — Héctor</div>
            <div style={{ fontSize: 11, color: "#6B7280" }}>Tu primer punto del día</div>
          </div>
        </div>
        <div style={{ padding: "20px 22px", minHeight: 160, fontSize: 13.5, color: "#1F2937", lineHeight: 1.6, whiteSpace: "pre-wrap" }}>
          {loading
            ? <div style={{ color: "#6B7280", fontStyle: "italic" }}>⏳ Héctor está preparando el briefing…</div>
            : error
              ? <div style={{ color: "#A32D2D" }}>{error}</div>
              : <div>{text}</div>
          }
        </div>
        <div style={{ padding: "12px 20px", borderTop: "0.5px solid #e5e7eb", background: "#fafafa", display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button onClick={handleClose} disabled={loading} style={{ padding: "9px 18px", borderRadius: 8, background: loading ? "#E5E7EB" : "#1D9E75", color: loading ? "#9CA3AF" : "#fff", border: "none", fontSize: 13, fontWeight: 700, cursor: loading ? "not-allowed" : "pointer", fontFamily: "inherit" }}>Empecemos →</button>
        </div>
      </div>
    </div>
  );
}
