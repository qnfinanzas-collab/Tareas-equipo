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

  // Conteos para el resumen. El guard del botón "Crear todo" se basa en
  // `enabled` (total de acciones seleccionadas, agnóstico al tipo), así
  // que cualquier nuevo tipo añadido en agentActions.js sigue funcionando
  // sin tocar este componente. Los chips visibles agrupan por familia
  // (proyectos/tareas/negociaciones/movs/bancarios/asientos/facturas) y
  // hay un cubo "otros" para tipos desconocidos.
  const totals = useMemo(() => {
    let projects = 0, tasks = 0, negs = 0, movs = 0, bank = 0, accEntries = 0, invoices = 0, others = 0;
    proposal.actions.forEach((a, i) => {
      if (excludedActions.has(i)) return;
      switch (a.type) {
        case "create_project":
          projects++;
          tasks += (a.tasks || []).filter((_, j) => !excludedTasks.has(`${i}_${j}`)).length;
          break;
        case "create_tasks":
          tasks += (a.tasks || []).filter((_, j) => !excludedTasks.has(`${i}_${j}`)).length;
          break;
        case "create_negotiation":
          negs++;
          break;
        case "create_movement":
          movs++;
          break;
        case "update_bank_movement":
        case "add_bank_movement":
          bank++;
          break;
        case "add_accounting_entry":
          accEntries++;
          break;
        case "add_invoice":
        case "update_invoice":
          invoices++;
          break;
        default:
          others++;
      }
    });
    return { projects, tasks, negs, movs, bank, accEntries, invoices, others };
  }, [proposal.actions, excludedActions, excludedTasks]);

  // Total de acciones efectivamente seleccionadas (agnóstico al tipo).
  // Es el guard que decide si el botón "Crear todo" está habilitado.
  const enabled = proposal.actions.length - excludedActions.size;

  if (done) {
    return (
      <div style={{ marginTop: 10, padding: "12px 14px", background: "#F0FDF4", border: "1.5px solid #86EFAC", borderRadius: 12, fontSize: 13, color: "#065F46", display: "flex", alignItems: "center", gap: 10 }}>
        <span style={{ fontSize: 20 }}>✅</span>
        <span style={{ flex: 1 }}>Acciones ejecutadas correctamente.</span>
      </div>
    );
  }

  return (
    <div data-ap="card" style={{ marginTop: 10, background: `${color}10`, border: `2px solid ${color}`, borderRadius: 12, padding: 14 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
        <span style={{ fontSize: 20 }}>{agentEmoji}</span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: "#111827" }}>{agentName} propone:</div>
          <div style={{ fontSize: 11.5, color: "#6B7280", marginTop: 2 }}>{proposal.summary}</div>
        </div>
        <div style={{ display: "flex", gap: 6, fontSize: 11, color, flexWrap: "wrap", justifyContent: "flex-end" }}>
          {totals.projects > 0   && <span>📁 {totals.projects}</span>}
          {totals.tasks > 0      && <span>✅ {totals.tasks}</span>}
          {totals.negs > 0       && <span>🤝 {totals.negs}</span>}
          {totals.movs > 0       && <span>💰 {totals.movs}</span>}
          {totals.bank > 0       && <span>🏦 {totals.bank}</span>}
          {totals.accEntries > 0 && <span>📒 {totals.accEntries}</span>}
          {totals.invoices > 0   && <span>🧾 {totals.invoices}</span>}
          {totals.others > 0     && <span>⚙️ {totals.others}</span>}
        </div>
      </div>

      {/* Acciones */}
      <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 12 }}>
        {proposal.actions.map((a, i) => {
          const excluded = excludedActions.has(i);
          const isExpanded = expanded.has(i);
          return (
            <div key={i} data-ap="item" style={{ background: "#fff", border: `1px solid ${excluded ? "#E5E7EB" : color + "55"}`, borderRadius: 8, padding: "8px 12px", opacity: excluded ? 0.55 : 1 }}>
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
                        {t._dateFixed && (
                          <span
                            title="Fecha ajustada automáticamente: el modelo emitió un año pasado y se corrigió al actual."
                            aria-label="Fecha ajustada automáticamente"
                            style={{ fontSize: 11, color: "#A07830", marginLeft: 2, cursor: "help", userSelect: "none" }}
                          >ℹ</span>
                        )}
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
      {/* Mobile (≤768px): card de ancho completo, ítems generosos y
          botones apilados (Crear todo arriba, Cancelar debajo). Solo
          presentación, mismo handler/lógica. */}
      <style>{`
        @media (max-width: 768px) {
          [data-ap="card"] {
            width: 100%;
            padding: 16px !important;
            margin-top: 12px !important;
          }
          [data-ap="item"] {
            padding: 10px 12px !important;
            font-size: 15px !important;
            line-height: 1.5;
            border-bottom: 1px solid rgba(0,0,0,0.06);
          }
          [data-ap="item"]:last-child {
            border-bottom: none;
          }
          [data-ap="actions-row"] {
            flex-direction: column-reverse !important;
            gap: 8px !important;
          }
          [data-ap="confirm-btn"] {
            width: 100%;
            min-height: 48px;
            font-size: 15px !important;
            font-weight: 600 !important;
            padding: 12px 18px !important;
          }
          [data-ap="cancel-btn"] {
            width: 100%;
            min-height: 44px;
            font-size: 14px !important;
            padding: 10px 14px !important;
          }
        }
      `}</style>
      <div data-ap="actions-row" style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
        <button
          data-ap="cancel-btn"
          onClick={() => { if (!busy) onCancel?.(); }}
          disabled={busy}
          style={{ padding: "7px 14px", borderRadius: 8, background: "transparent", border: "1px solid #D1D5DB", color: "#6B7280", fontSize: 12, fontWeight: 500, cursor: busy ? "not-allowed" : "pointer", fontFamily: "inherit" }}
        >❌ No crear</button>
        <button
          data-ap="confirm-btn"
          onClick={handleConfirm}
          disabled={busy || enabled === 0}
          style={{ padding: "7px 18px", borderRadius: 8, background: busy || enabled === 0 ? "#9CA3AF" : color, color: "#fff", border: "none", fontSize: 12, fontWeight: 600, cursor: busy ? "wait" : enabled === 0 ? "not-allowed" : "pointer", fontFamily: "inherit" }}
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
  if (t === "update_bank_movement") {
    const fields = [
      action.category    !== undefined && "categoría",
      action.subcategory !== undefined && "subcategoría",
      action.reconciled  !== undefined && (action.reconciled ? "marcar conciliado" : "desconciliar"),
      action.notes       !== undefined && "notas",
      action.concept     !== undefined && "concepto",
    ].filter(Boolean);
    return (
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ fontSize: 12.5, fontWeight: 600, color: "#111827" }}>🏦 Actualizar movimiento bancario</div>
        <div style={{ fontSize: 11, color: "#6B7280", marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {fields.length > 0 ? fields.join(" · ") : "(sin cambios)"}
          {action.id ? ` · id ${String(action.id).slice(0, 8)}` : ""}
        </div>
      </div>
    );
  }
  if (t === "add_bank_movement") {
    return (
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ fontSize: 12.5, fontWeight: 600, color: "#111827" }}>🏦 Nuevo movimiento bancario {action.amount != null ? <b>· {action.amount}€</b> : null}</div>
        <div style={{ fontSize: 11, color: "#6B7280", marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{action.concept || "(sin concepto)"}{action.date ? ` · ${action.date}` : ""}</div>
      </div>
    );
  }
  if (t === "add_accounting_entry") {
    const lineCount = Array.isArray(action.lines) ? action.lines.length : 0;
    const totalD = Array.isArray(action.lines) ? action.lines.reduce((s, l) => s + (Number(l.debit)||0), 0) : 0;
    return (
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ fontSize: 12.5, fontWeight: 600, color: "#111827", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>📒 Asiento: <b>{action.description || "(sin descripción)"}</b></div>
        <div style={{ fontSize: 11, color: "#6B7280", marginTop: 2 }}>{lineCount} línea{lineCount!==1?"s":""}{totalD>0?` · ${totalD.toFixed(2)}€ debe = haber`:""}{action.date?` · ${action.date}`:""}</div>
      </div>
    );
  }
  if (t === "add_invoice" || t === "update_invoice") {
    const isUpdate = t === "update_invoice";
    return (
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ fontSize: 12.5, fontWeight: 600, color: "#111827" }}>🧾 {isUpdate ? "Actualizar" : "Nueva"} factura{action.invoiceType ? ` ${action.invoiceType}` : ""}{action.total != null ? <span> · <b>{action.total}€</b></span> : null}</div>
        <div style={{ fontSize: 11, color: "#6B7280", marginTop: 2 }}>{action.counterparty?.name || action.counterpartyName || "(sin contraparte)"}{action.number ? ` · nº ${action.number}` : ""}{action.date ? ` · ${action.date}` : ""}</div>
      </div>
    );
  }
  return <div style={{ flex: 1, fontSize: 12, color: "#6B7280" }}>⚙️ Acción: <code style={{ fontFamily: "ui-monospace,monospace" }}>{t}</code></div>;
}
