// ConciliacionModal — busca matches automáticos entre bankMovements sin
// conciliar y facturas pendientes/parciales por importe similar (±2%) y
// fecha cercana (±7 días). Cada match recibe un nivel de confianza
// (alta/media/baja) según cómo de exactos sean el importe y la fecha.
//
// Reglas de matching:
//   - Movimiento gasto (amount<0)  → busca facturas RECIBIDAS pendientes/parcial
//   - Movimiento ingreso (amount>0)→ busca facturas EMITIDAS pendientes/parcial
//   - Una factura solo puede emparejarse con UN movimiento (no duplicamos);
//     elegimos el match de mayor confianza si compite.
//
// La ejecución la hace App.jsx vía onApply([{movementId, invoiceId}]).
import React, { useEffect, useMemo, useState } from "react";

const fmtEur = (n) => new Intl.NumberFormat("es-ES", { style: "currency", currency: "EUR", maximumFractionDigits: 2 }).format(Number(n)||0);
const fmtDate = (s) => {
  if (!s) return "—";
  const d = new Date(s);
  if (isNaN(d.getTime())) return s;
  return d.toLocaleDateString("es-ES", { day: "numeric", month: "short", year: "2-digit" });
};
const daysBetween = (a, b) => {
  const da = new Date(a), db = new Date(b);
  if (isNaN(da.getTime()) || isNaN(db.getTime())) return Infinity;
  return Math.abs(Math.floor((da - db) / 86400000));
};

const CONFIDENCE_META = {
  alta:  { label: "Alta",  bg: "#DCFCE7", color: "#065F46", border: "#86EFAC" },
  media: { label: "Media", bg: "#FEF3C7", color: "#92400E", border: "#FCD34D" },
  baja:  { label: "Baja",  bg: "#FEE2E2", color: "#991B1B", border: "#FCA5A5" },
};

function classifyConfidence(amountDelta, dateDelta) {
  if (amountDelta < 0.005 && dateDelta <= 3) return "alta";
  if (amountDelta < 0.02  && dateDelta <= 7) return "media";
  return "baja";
}

export default function ConciliacionModal({ movements, invoices, onClose, onApply }) {
  // Cálculo de matches: un emparejamiento posible por (movimiento, factura).
  // Para cada movimiento sin conciliar, buscamos todas las facturas que
  // cumplan los criterios y nos quedamos con la mejor (menor delta importe,
  // luego menor delta fecha). Una factura no puede emparejarse a dos
  // movimientos: aplicamos asignación greedy ordenada por confianza.
  const allMatches = useMemo(() => {
    const candidates = []; // {movementId, invoiceId, confidence, amountDelta, dateDelta}
    const unreconciled = (movements||[]).filter(m => !m.reconciled);
    const eligible = (invoices||[]).filter(i => i.status !== "pagada" || !i.bankMovementId);
    for (const m of unreconciled) {
      const amt = Number(m.amount)||0;
      if (!amt || !m.date) continue;
      const isIncome = amt > 0;
      // Para ingresos buscamos emitidas; para gastos, recibidas.
      const want = isIncome ? "emitida" : "recibida";
      for (const inv of eligible) {
        if (inv.type !== want) continue;
        if (inv.bankMovementId && inv.bankMovementId !== m.id) continue; // ya vinculada
        const total = Number(inv.total)||0;
        if (!total) continue;
        const amountDelta = Math.abs(Math.abs(amt) - total) / total;
        const dateDelta = daysBetween(m.date, inv.date);
        if (amountDelta > 0.02 || dateDelta > 7) continue;
        candidates.push({
          movementId: m.id,
          invoiceId: inv.id,
          confidence: classifyConfidence(amountDelta, dateDelta),
          amountDelta, dateDelta,
        });
      }
    }
    // Ordenar por confianza (alta primero), luego por amountDelta y dateDelta.
    const order = { alta: 0, media: 1, baja: 2 };
    candidates.sort((a, b) =>
      order[a.confidence] - order[b.confidence]
      || a.amountDelta - b.amountDelta
      || a.dateDelta - b.dateDelta
    );
    // Greedy: cada movimiento y cada factura se usan UNA vez.
    const usedMovs = new Set(), usedInvs = new Set();
    const out = [];
    for (const c of candidates) {
      if (usedMovs.has(c.movementId) || usedInvs.has(c.invoiceId)) continue;
      usedMovs.add(c.movementId); usedInvs.add(c.invoiceId);
      out.push(c);
    }
    return out;
  }, [movements, invoices]);

  // Por defecto seleccionamos los matches de confianza alta/media. El CEO
  // revisa los baja antes de aceptar.
  const [selected, setSelected] = useState(() => {
    const set = new Set();
    allMatches.forEach((m, i) => { if (m.confidence !== "baja") set.add(i); });
    return set;
  });

  // ESC cierra
  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const toggle = (idx) => setSelected(s => {
    const n = new Set(s); n.has(idx) ? n.delete(idx) : n.add(idx); return n;
  });
  const toggleAll = () => {
    if (selected.size === allMatches.length) setSelected(new Set());
    else setSelected(new Set(allMatches.map((_, i) => i)));
  };
  const apply = () => {
    if (selected.size === 0) return;
    const list = Array.from(selected).map(i => ({
      movementId: allMatches[i].movementId,
      invoiceId: allMatches[i].invoiceId,
    }));
    onApply(list);
    onClose();
  };

  // Para la tabla necesitamos referencias rápidas al movimiento/factura.
  const movsById = useMemo(() => new Map((movements||[]).map(m => [m.id, m])), [movements]);
  const invsById = useMemo(() => new Map((invoices||[]).map(i => [i.id, i])), [invoices]);

  return (
    <div onClick={(e) => e.target === e.currentTarget && onClose()} style={overlayStyle}>
      <div style={{ ...modalStyle, borderTop: "4px solid #27AE60" }}>
        <div style={modalHeader}>
          <div style={{ fontSize: 14, fontWeight: 700 }}>🔄 Conciliación automática banco ↔ facturas</div>
          <button onClick={onClose} style={closeBtn}>×</button>
        </div>
        <div style={modalBody}>
          {allMatches.length === 0 ? (
            <div style={{ padding: "32px 18px", textAlign: "center", color: "#9CA3AF", fontSize: 13, fontStyle: "italic" }}>
              No se han encontrado emparejamientos automáticos. Revisa que existan movimientos sin conciliar y facturas pendientes con importes similares (±2%) en fechas cercanas (±7 días).
            </div>
          ) : (
            <>
              <div style={{ background: "#F0FDF4", border: "1px solid #86EFAC", borderRadius: 8, padding: "10px 14px", fontSize: 12.5, color: "#065F46" }}>
                Encontrados <b>{allMatches.length}</b> emparejamiento{allMatches.length!==1?"s":""} potenciales.
                Por defecto se seleccionan los de confianza alta y media. Revisa los de confianza baja antes de aplicar.
              </div>
              <div style={{ background: "#fff", border: "1px solid #E5E7EB", borderRadius: 8, overflow: "hidden", maxHeight: 420, overflowY: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11.5 }}>
                  <thead style={{ position: "sticky", top: 0, background: "#FAFAFA", borderBottom: "0.5px solid #E5E7EB" }}>
                    <tr>
                      <th style={{ ...th, width: 36 }}>
                        <input type="checkbox" checked={selected.size === allMatches.length} onChange={toggleAll} />
                      </th>
                      <th style={{ ...th, textAlign: "left" }}>Movimiento</th>
                      <th style={{ ...th, width: 30 }}>↔</th>
                      <th style={{ ...th, textAlign: "left" }}>Factura</th>
                      <th style={th}>Confianza</th>
                    </tr>
                  </thead>
                  <tbody>
                    {allMatches.map((m, i) => {
                      const mov = movsById.get(m.movementId);
                      const inv = invsById.get(m.invoiceId);
                      if (!mov || !inv) return null;
                      const isIncome = (Number(mov.amount)||0) > 0;
                      const conf = CONFIDENCE_META[m.confidence];
                      return (
                        <tr key={i} style={{ borderTop: "0.5px solid #F3F4F6" }}>
                          <td style={{ ...td, padding: "6px 10px" }}>
                            <input type="checkbox" checked={selected.has(i)} onChange={() => toggle(i)} />
                          </td>
                          <td style={{ ...td, textAlign: "left" }}>
                            <div style={{ fontFamily: "ui-monospace,monospace", fontSize: 11, color: "#6B7280" }}>{fmtDate(mov.date)}</div>
                            <div style={{ fontWeight: 600, color: "#111827" }}>{mov.concept || "(sin concepto)"}</div>
                            <div style={{ fontFamily: "ui-monospace,monospace", fontWeight: 700, color: isIncome ? "#0E7C5A" : "#B91C1C" }}>{isIncome?"+":""}{fmtEur(mov.amount)}</div>
                          </td>
                          <td style={{ ...td, fontSize: 16, color: "#27AE60", fontWeight: 700 }}>↔</td>
                          <td style={{ ...td, textAlign: "left" }}>
                            <div style={{ fontFamily: "ui-monospace,monospace", fontSize: 11, color: "#6B7280" }}>{inv.number || "(sin nº)"} · {fmtDate(inv.date)}</div>
                            <div style={{ fontWeight: 600, color: "#111827" }}>{inv.counterparty?.name || "(sin nombre)"}</div>
                            <div style={{ fontFamily: "ui-monospace,monospace", fontWeight: 700, color: "#111827" }}>{fmtEur(inv.total)}</div>
                          </td>
                          <td style={td}>
                            <span style={{ display: "inline-flex", alignItems: "center", padding: "2px 8px", borderRadius: 10, background: conf.bg, color: conf.color, border: `0.5px solid ${conf.border}`, fontSize: 10.5, fontWeight: 700 }}>{conf.label}</span>
                            <div style={{ fontSize: 10, color: "#9CA3AF", marginTop: 2 }}>±{(m.amountDelta*100).toFixed(1)}% · {m.dateDelta}d</div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </>
          )}

          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 6 }}>
            <button onClick={onClose} style={{ padding: "8px 14px", borderRadius: 8, background: "transparent", border: "1px solid #D1D5DB", fontSize: 12, fontWeight: 500, cursor: "pointer", fontFamily: "inherit" }}>Cancelar</button>
            <button
              onClick={apply}
              disabled={selected.size === 0}
              style={selected.size > 0
                ? { padding: "8px 18px", borderRadius: 8, background: "#27AE60", color: "#fff", border: "none", fontSize: 12, fontWeight: 600, cursor: "pointer", fontFamily: "inherit" }
                : { padding: "8px 18px", borderRadius: 8, background: "#E5E7EB", color: "#9CA3AF", border: "none", fontSize: 12, fontWeight: 600, cursor: "default", fontFamily: "inherit" }
              }
            >Aplicar conciliación{selected.size > 0 ? ` (${selected.size})` : ""}</button>
          </div>
        </div>
      </div>
    </div>
  );
}

const overlayStyle = { position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)", zIndex: 3000, display: "flex", alignItems: "center", justifyContent: "center", padding: 20 };
const modalStyle = { background: "#fff", borderRadius: 14, width: 820, maxWidth: "96vw", overflow: "hidden", maxHeight: "92vh", display: "flex", flexDirection: "column" };
const modalHeader = { padding: "14px 18px", borderBottom: "0.5px solid #E5E7EB", display: "flex", alignItems: "center", justifyContent: "space-between", flexShrink: 0 };
const modalBody = { padding: 18, display: "flex", flexDirection: "column", gap: 14, overflowY: "auto" };
const closeBtn = { background: "none", border: "none", fontSize: 20, cursor: "pointer", color: "#6B7280" };
const th = { padding: "8px 10px", textAlign: "center", fontSize: 10.5, fontWeight: 700, color: "#6B7280", textTransform: "uppercase", letterSpacing: 0.4 };
const td = { padding: "8px 10px", textAlign: "center", color: "#111827" };
