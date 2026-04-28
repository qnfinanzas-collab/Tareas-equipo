// ActionProposal — panel de confirmación cuando un agente propone crear
// proyectos, tareas, negociaciones o movimientos. Se renderiza debajo del
// mensaje del agente en el chat. El CEO puede aceptar todo, deseleccionar
// tareas individuales, o descartar.
//
// Props:
//   proposal:    { summary, actions, confirmRequired }  (de parseAgentActions)
//   agentName:   "Gonzalo" / "Héctor" / etc — para el header del panel
//   agentEmoji:  emoji del agente
//   color:       color identidad del agente (border + accent)
//   onConfirm:   (selectedActions) => void
//   onCancel:    () => void
import React, { useMemo, useState } from "react";

const PRIORITY_LABEL = { alta: "Alta", media: "Media", baja: "Baja" };
const PRIORITY_COLOR = { alta: "#B91C1C", media: "#92400E", baja: "#0E7C5A" };

export default function ActionProposal({ proposal, agentName = "Agente", agentEmoji = "🤖", color = "#8E44AD", onConfirm, onCancel }) {
  // Estado local: sets de IDs deseleccionados por acción / tarea.
  // Por defecto todo seleccionado. El CEO puede desactivar tareas
  // individuales o acciones enteras.
  const [excludedActions, setExcludedActions] = useState(new Set());
  const [excludedTasks, setExcludedTasks]     = useState(new Set()); // key: `${actionIdx}_${taskIdx}`
  const [expanded, setExpanded]               = useState(new Set([0])); // primera acción abierta
  const [busy, setBusy]                       = useState(false);
  const [done, setDone]                       = useState(false);

  if (!proposal || !Array.isArray(proposal.actions) || proposal.actions.length === 0) return null;

  const toggleAction = (idx) => setExcludedActions(s => {
    const n = new Set(s); n.has(idx) ? n.delete(idx) : n.add(idx); return n;
  });
  const toggleTask = (key) => setExcludedTasks(s => {
    const n = new Set(s); n.has(key) ? n.delete(key) : n.add(key); return n;
  });
  const toggleExpand = (idx) => setExpanded(s => {
    const n = new Set(s); n.has(idx) ? n.delete(idx) : n.add(idx); return n;
  });

  const handleConfirm = async () => {
    if (busy) return;
    // Construye la lista final excluyendo lo deseleccionado.
    const selected = proposal.actions
      .map((a, i) => {
        if (excludedActions.has(i)) return null;
        // Si tiene tareas, filtramos las excluidas.
        if (Array.isArray(a.tasks)) {
          const tasks = a.tasks.filter((_, j) => !excludedTasks.has(`${i}_${j}`));
          return { ...a, tasks, _agentName: agentName };
        }
        return { ...a, _agentName: agentName };
      })
      .filter(Boolean);
    if (selected.length === 0) { onCancel?.(); return; }
    setBusy(true);
    try {
      await onConfirm?.(selected);
      setDone(true);
    } catch (e) {
      console.error("ActionProposal confirm error:", e);
      setBusy(false);
    }
  };

  // Conteos para el resumen.
  const totals = useMemo(() => {
    let projects = 0, tasks = 0, negs = 0, movs = 0;
    proposal.actions.forEach((a, i) => {
      if (excludedActions.has(i)) return;
      if (a.type === "create_project") {
        projects++;
        tasks += (a.tasks || []).filter((_, j) => !excludedTasks.has(`${i}_${j}`)).length;
      } else if (a.type === "create_tasks") {
        tasks += (a.tasks || []).filter((_, j) => !excludedTasks.has(`${i}_${j}`)).length;
      } else if (a.type === "create_negotiation") {
        negs++;
      } else if (a.type === "create_movement") {
        movs++;
      }
    });
    return { projects, tasks, negs, movs };
  }, [proposal.actions, excludedActions, excludedTasks]);

  if (done) {
    return (
      <div style={{ marginTop: 10, padding: "12px 14px", background: "#F0FDF4", border: "1.5px solid #86EFAC", borderRadius: 12, fontSize: 13, color: "#065F46", display: "flex", alignItems: "center", gap: 10 }}>
        <span style={{ fontSize: 20 }}>✅</span>
        <span style={{ flex: 1 }}>Acciones ejecutadas correctamente.</span>
      </div>
    );
  }

  return (
    <div style={{ marginTop: 10, background: `${color}10`, border: `2px solid ${color}`, borderRadius: 12, padding: 14 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
        <span style={{ fontSize: 20 }}>{agentEmoji}</span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: "#111827" }}>{agentName} propone:</div>
          <div style={{ fontSize: 11.5, color: "#6B7280", marginTop: 2 }}>{proposal.summary}</div>
        </div>
        <div style={{ display: "flex", gap: 6, fontSize: 11, color }}>
          {totals.projects > 0 && <span>📁 {totals.projects}</span>}
          {totals.tasks > 0    && <span>✅ {totals.tasks}</span>}
          {totals.negs > 0     && <span>🤝 {totals.negs}</span>}
          {totals.movs > 0     && <span>💰 {totals.movs}</span>}
        </div>
      </div>

      {/* Acciones */}
      <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 12 }}>
        {proposal.actions.map((a, i) => {
          const excluded = excludedActions.has(i);
          const isExpanded = expanded.has(i);
          return (
            <div key={i} style={{ background: "#fff", border: `1px solid ${excluded ? "#E5E7EB" : color + "55"}`, borderRadius: 8, padding: "8px 12px", opacity: excluded ? 0.55 : 1 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <input type="checkbox" checked={!excluded} onChange={() => toggleAction(i)} style={{ accentColor: color }} />
                <ActionHeader action={a} />
                {(a.tasks?.length > 0) && (
                  <button onClick={() => toggleExpand(i)} style={{ background: "transparent", border: "none", fontSize: 11, color: "#6B7280", cursor: "pointer", fontFamily: "inherit", marginLeft: "auto" }}>
                    {isExpanded ? "▲ Ocultar" : `▼ Ver ${a.tasks.length} tareas`}
                  </button>
                )}
              </div>
              {!excluded && isExpanded && Array.isArray(a.tasks) && a.tasks.length > 0 && (
                <div style={{ marginTop: 8, paddingTop: 8, borderTop: "0.5px dashed #E5E7EB", display: "flex", flexDirection: "column", gap: 4 }}>
                  {a.tasks.map((t, j) => {
                    const key = `${i}_${j}`;
                    const taskExcluded = excludedTasks.has(key);
                    const prio = (t.priority || "media").toLowerCase();
                    return (
                      <label key={j} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: taskExcluded ? "#9CA3AF" : "#374151", cursor: "pointer", padding: "3px 0" }}>
                        <input type="checkbox" checked={!taskExcluded} onChange={() => toggleTask(key)} style={{ accentColor: color }} />
                        <span style={{ flex: 1, textDecoration: taskExcluded ? "line-through" : "none" }}>{t.title}</span>
                        <span style={{ fontSize: 10, fontWeight: 600, padding: "1px 6px", borderRadius: 8, background: PRIORITY_COLOR[prio] + "18", color: PRIORITY_COLOR[prio], border: `1px solid ${PRIORITY_COLOR[prio]}55` }}>
                          {PRIORITY_LABEL[prio] || prio}
                        </span>
                        {t.dueDate && <span style={{ fontSize: 10.5, color: "#9CA3AF" }}>{t.dueDate}</span>}
                      </label>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Botones */}
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
        <button
          onClick={() => { if (!busy) onCancel?.(); }}
          disabled={busy}
          style={{ padding: "7px 14px", borderRadius: 8, background: "transparent", border: "1px solid #D1D5DB", color: "#6B7280", fontSize: 12, fontWeight: 500, cursor: busy ? "not-allowed" : "pointer", fontFamily: "inherit" }}
        >❌ No crear</button>
        <button
          onClick={handleConfirm}
          disabled={busy || (totals.projects + totals.tasks + totals.negs + totals.movs === 0)}
          style={{ padding: "7px 18px", borderRadius: 8, background: busy ? "#9CA3AF" : color, color: "#fff", border: "none", fontSize: 12, fontWeight: 600, cursor: busy ? "wait" : "pointer", fontFamily: "inherit" }}
        >{busy ? "Creando…" : "✅ Crear todo"}</button>
      </div>
    </div>
  );
}

function ActionHeader({ action }) {
  const t = action.type;
  if (t === "create_project") {
    return (
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ fontSize: 12.5, fontWeight: 600, color: "#111827", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          📁 Proyecto: <b>{action.name || "(sin nombre)"}</b>
          {action.code && <span style={{ marginLeft: 6, fontFamily: "ui-monospace,monospace", fontSize: 10, color: "#6B7280" }}>[{action.code}]</span>}
        </div>
        {action.description && <div style={{ fontSize: 11, color: "#6B7280", marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{action.description}</div>}
      </div>
    );
  }
  if (t === "create_negotiation") {
    return (
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ fontSize: 12.5, fontWeight: 600, color: "#111827", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>🤝 Negociación: <b>{action.title || "(sin título)"}</b></div>
        <div style={{ fontSize: 11, color: "#6B7280", marginTop: 2 }}>
          {action.facts?.length > 0 ? `${action.facts.length} hecho${action.facts.length!==1?"s":""}` : ""}
          {action.redFlags?.length > 0 ? ` · ${action.redFlags.length} red flag${action.redFlags.length!==1?"s":""}` : ""}
          {action.stakeholders?.length > 0 ? ` · ${action.stakeholders.length} stakeholder${action.stakeholders.length!==1?"s":""}` : ""}
        </div>
      </div>
    );
  }
  if (t === "create_tasks") {
    return (
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ fontSize: 12.5, fontWeight: 600, color: "#111827" }}>✅ {action.tasks?.length || 0} tareas en proyecto <b>{action.projectCode}</b></div>
      </div>
    );
  }
  if (t === "create_movement") {
    return (
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ fontSize: 12.5, fontWeight: 600, color: "#111827" }}>💰 {action.concept} — <b>{action.amount}€</b></div>
        <div style={{ fontSize: 11, color: "#6B7280" }}>{action.movementType === "income" ? "Ingreso" : "Gasto"} · {action.category || "Otros"}</div>
      </div>
    );
  }
  return <div style={{ flex: 1, fontSize: 12, color: "#6B7280" }}>Acción: {t}</div>;
}
