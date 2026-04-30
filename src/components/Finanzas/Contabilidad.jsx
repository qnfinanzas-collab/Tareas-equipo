// Contabilidad — pestaña con dos vistas:
//   1) Libro Diario: asientos cronológicos del periodo, agrupados por
//      número, con líneas debe/haber.
//   2) Balance de sumas y saldos: agrupa todas las líneas por cuenta PGC,
//      mostrando totales debe/haber y saldo. Subagrupado por grupo (1-7).
//
// Modal "+ Asiento manual" con líneas dinámicas, autocomplete de cuentas
// del chartOfAccounts y validación dura "total debe = total haber". Solo
// se permite borrar asientos en estado "borrador" (los confirmados son
// históricos y se rectifican con un asiento de regularización — convención
// contable, no permitimos editar el pasado).
//
// Diego propone asientos vía [ACTIONS]/add_accounting_entry; aquí el CEO
// ve los resultados y puede editar los borradores.
import React, { useMemo, useState } from "react";

const fmtEur = (n) => new Intl.NumberFormat("es-ES", { style: "currency", currency: "EUR", maximumFractionDigits: 2 }).format(Number(n)||0);
const fmtDate = (s) => {
  if (!s) return "—";
  const d = new Date(s);
  if (isNaN(d.getTime())) return s;
  return d.toLocaleDateString("es-ES", { day: "numeric", month: "short", year: "2-digit" });
};
const todayISO = () => new Date().toISOString().slice(0, 10);
const monthKey = (s) => {
  const d = new Date(s);
  if (isNaN(d.getTime())) return null;
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}`;
};
const monthLabel = (key) => {
  if (!key) return "";
  const [y, m] = key.split("-");
  return new Date(Number(y), Number(m)-1, 1).toLocaleDateString("es-ES", { month: "long", year: "numeric" });
};

const SOURCE_META = {
  diego:  { icon: "🤖", label: "Diego",  color: "#0E7C5A", bg: "#F0FDF4" },
  manual: { icon: "✋", label: "Manual", color: "#374151", bg: "#F9FAFB" },
  auto:   { icon: "⚡", label: "Auto",   color: "#1E40AF", bg: "#DBEAFE" },
};
const STATUS_META = {
  borrador:    { color: "#6B7280", bg: "#F3F4F6", border: "#D1D5DB", label: "borrador" },
  confirmado:  { color: "#0E7C5A", bg: "#DCFCE7", border: "#86EFAC", label: "confirmado" },
};

const GROUP_META = {
  1: { name: "Financiación básica" },
  2: { name: "Inmovilizado" },
  3: { name: "Existencias" },
  4: { name: "Acreedores y deudores" },
  5: { name: "Cuentas financieras" },
  6: { name: "Compras y gastos" },
  7: { name: "Ventas e ingresos" },
};

export default function Contabilidad({ data, canEdit, selectedCompanyId, onAddAccountingEntry, onUpdateAccountingEntry, onDeleteAccountingEntry, onAddCustomAccount }) {
  const allEntries = data.accountingEntries || [];
  const chart = data.chartOfAccounts || [];
  const companies = data.governance?.companies || [];

  const [view, setView]               = useState("diario"); // diario | balance
  const [filterMonth, setFilterMonth] = useState("all");
  const [filterSource, setFilterSource] = useState("all");
  const [editing, setEditing]         = useState(null);    // null | "new" | entry

  if (companies.length === 0) {
    return (
      <div style={{ background: "#fff", border: "1px solid #E5E7EB", borderRadius: 12, padding: "40px 20px", textAlign: "center" }}>
        <div style={{ fontSize: 36, marginBottom: 12 }}>📒</div>
        <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 6, color: "#111827" }}>Aún no hay empresas registradas</div>
        <div style={{ fontSize: 12, color: "#7F8C8D", maxWidth: 380, margin: "0 auto" }}>
          Para llevar contabilidad, primero registra una empresa en 🏛️ Gobernanza ▸ Dashboard.
        </div>
      </div>
    );
  }

  // Filtrado por empresa: legacy companyId:null se incluye siempre.
  const entriesByCompany = useMemo(() => {
    if (selectedCompanyId === "all") return allEntries;
    return allEntries.filter(e => !e.companyId || e.companyId === selectedCompanyId);
  }, [allEntries, selectedCompanyId]);

  // Filtros UI.
  const filtered = useMemo(() => {
    return entriesByCompany.filter(e => {
      if (filterMonth !== "all" && monthKey(e.date) !== filterMonth) return false;
      if (filterSource !== "all" && (e.source || "manual") !== filterSource) return false;
      return true;
    }).sort((a, b) => (b.date||"").localeCompare(a.date||""));
  }, [entriesByCompany, filterMonth, filterSource]);

  const availableMonths = useMemo(() => {
    const set = new Set();
    entriesByCompany.forEach(e => { const k = monthKey(e.date); if (k) set.add(k); });
    return Array.from(set).sort().reverse();
  }, [entriesByCompany]);

  // Totales debe/haber del periodo.
  const totals = useMemo(() => {
    let totalD = 0, totalC = 0;
    for (const e of filtered) {
      for (const l of (e.lines||[])) {
        totalD += Number(l.debit) ||0;
        totalC += Number(l.credit)||0;
      }
    }
    return { totalD: Math.round(totalD*100)/100, totalC: Math.round(totalC*100)/100 };
  }, [filtered]);

  // Balance de sumas y saldos: agrupa todas las líneas (filtradas) por
  // cuenta y luego por grupo PGC. El grupo se deduce del primer dígito
  // del código (pyme: 1-7).
  const balance = useMemo(() => {
    const byAccount = new Map(); // code → { name, debit, credit }
    for (const e of filtered) {
      for (const l of (e.lines||[])) {
        const code = String(l.account||"").trim();
        if (!code) continue;
        const cur = byAccount.get(code) || { name: l.accountName || "", debit: 0, credit: 0 };
        cur.debit  += Number(l.debit) ||0;
        cur.credit += Number(l.credit)||0;
        // Si la línea tiene nombre y la cuenta no lo tenía, lo guardamos.
        if (!cur.name && l.accountName) cur.name = l.accountName;
        // Si no tenemos nombre ni en la línea ni en cuenta, buscamos en chart.
        if (!cur.name) {
          const ch = chart.find(x => x.code === code) || chart.find(x => code.startsWith(x.code));
          if (ch) cur.name = ch.name;
        }
        byAccount.set(code, cur);
      }
    }
    const rows = Array.from(byAccount.entries())
      .map(([code, v]) => ({
        code,
        name: v.name || "(sin nombre)",
        group: Number(String(code).charAt(0)) || 0,
        debit: Math.round(v.debit*100)/100,
        credit: Math.round(v.credit*100)/100,
        saldo: Math.round((v.debit - v.credit)*100)/100,
      }))
      .sort((a, b) => a.code.localeCompare(b.code));
    const grouped = new Map();
    let sumD = 0, sumC = 0;
    for (const r of rows) {
      sumD += r.debit; sumC += r.credit;
      if (!grouped.has(r.group)) grouped.set(r.group, []);
      grouped.get(r.group).push(r);
    }
    return {
      groups: Array.from(grouped.entries()).sort((a, b) => a[0] - b[0]),
      totalD: Math.round(sumD*100)/100,
      totalC: Math.round(sumC*100)/100,
    };
  }, [filtered, chart]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {/* Toggle libro diario / balance + acción */}
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <div style={{ display: "inline-flex", background: "#fff", border: "1px solid #E5E7EB", borderRadius: 10, padding: 4 }}>
          {[
            { k: "diario",  label: "📒 Libro diario" },
            { k: "balance", label: "📊 Sumas y saldos" },
          ].map(opt => {
            const active = view === opt.k;
            return (
              <button
                key={opt.k}
                onClick={() => setView(opt.k)}
                style={{
                  padding: "7px 16px", borderRadius: 7, border: "none",
                  background: active ? "#27AE60" : "transparent",
                  color: active ? "#fff" : "#6B7280",
                  fontSize: 13, fontWeight: 600, cursor: "pointer", fontFamily: "inherit",
                }}
              >{opt.label}</button>
            );
          })}
        </div>
        <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
          {canEdit && (
            <button
              onClick={() => setEditing("new")}
              disabled={!selectedCompanyId || selectedCompanyId === "all"}
              title={!selectedCompanyId || selectedCompanyId === "all" ? "Selecciona una empresa concreta" : "Crear asiento manual"}
              style={{ padding: "8px 16px", borderRadius: 8, background: "#27AE60", color: "#fff", border: "none", fontSize: 13, fontWeight: 600, cursor: (!selectedCompanyId || selectedCompanyId === "all") ? "not-allowed" : "pointer", opacity: (!selectedCompanyId || selectedCompanyId === "all") ? 0.55 : 1, fontFamily: "inherit" }}
            >+ Asiento manual</button>
          )}
        </div>
      </div>

      {/* Filtros */}
      <div style={{ background: "#fff", border: "1px solid #E5E7EB", borderRadius: 12, padding: "12px 16px", display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <select value={filterMonth} onChange={e => setFilterMonth(e.target.value)} style={inputStyle}>
          <option value="all">Todos los meses</option>
          {availableMonths.map(k => <option key={k} value={k}>{monthLabel(k)}</option>)}
        </select>
        <select value={filterSource} onChange={e => setFilterSource(e.target.value)} style={inputStyle}>
          <option value="all">Todas las fuentes</option>
          <option value="diego">🤖 Diego</option>
          <option value="manual">✋ Manual</option>
          <option value="auto">⚡ Auto</option>
        </select>
        <div style={{ marginLeft: "auto", fontSize: 11.5, color: "#6B7280" }}>
          {filtered.length} asiento{filtered.length!==1?"s":""} · Debe {fmtEur(totals.totalD)} · Haber {fmtEur(totals.totalC)}
        </div>
      </div>

      {/* Vista libro diario */}
      {view === "diario" && (
        <div style={{ background: "#fff", border: "1px solid #E5E7EB", borderRadius: 12, overflow: "hidden" }}>
          <div style={{ padding: "10px 18px", background: "#FAFAFA", borderBottom: "0.5px solid #E5E7EB", fontSize: 12, fontWeight: 700, color: "#374151" }}>
            📒 Libro diario {filtered.length > 0 ? `(${filtered.length} asiento${filtered.length!==1?"s":""})` : ""}
          </div>
          {filtered.length === 0 ? (
            <div style={{ padding: "32px 18px", textAlign: "center", color: "#9CA3AF", fontSize: 13, fontStyle: "italic" }}>
              {entriesByCompany.length === 0
                ? "Aún no hay asientos contables. Crea el primero manualmente o pídele a Diego que analice una factura."
                : "Ningún asiento coincide con los filtros."}
            </div>
          ) : (
            <div>
              {filtered.map(e => (
                <EntryRow
                  key={e.id}
                  entry={e}
                  canEdit={canEdit}
                  onClick={() => canEdit && setEditing(e)}
                  onDelete={canEdit ? () => onDeleteAccountingEntry?.(e.id) : null}
                />
              ))}
            </div>
          )}
        </div>
      )}

      {/* Vista balance */}
      {view === "balance" && (
        <BalanceView balance={balance} />
      )}

      {editing && (
        <EntryModal
          entry={editing === "new" ? null : editing}
          companyId={selectedCompanyId === "all" ? null : selectedCompanyId}
          chart={chart}
          onClose={() => setEditing(null)}
          onSave={(payload) => {
            if (editing === "new") {
              const id = onAddAccountingEntry?.(payload);
              if (id) setEditing(null); // si id null, asiento descuadrado: dejamos abierto
            } else {
              onUpdateAccountingEntry?.(editing.id, payload);
              setEditing(null);
            }
          }}
          onDelete={editing !== "new"
            ? () => { onDeleteAccountingEntry?.(editing.id); setEditing(null); }
            : null}
          onAddCustomAccount={onAddCustomAccount}
        />
      )}
    </div>
  );
}

// ── EntryRow: asiento individual con cabecera + líneas ─────────────────
function EntryRow({ entry, canEdit, onClick, onDelete }) {
  const [open, setOpen] = useState(true);
  const source = SOURCE_META[entry.source] || SOURCE_META.manual;
  const status = STATUS_META[entry.status] || STATUS_META.confirmado;
  const totalD = (entry.lines||[]).reduce((s, l) => s + (Number(l.debit) ||0), 0);
  const totalC = (entry.lines||[]).reduce((s, l) => s + (Number(l.credit)||0), 0);

  return (
    <div style={{ borderTop: "0.5px solid #F3F4F6" }}>
      <div style={{ padding: "10px 18px", display: "flex", alignItems: "center", gap: 10, background: source.bg, cursor: "pointer" }}
           onClick={() => setOpen(o => !o)}>
        <span style={{ fontSize: 11, color: "#6B7280", fontFamily: "ui-monospace,monospace", minWidth: 24 }}>{open ? "▼" : "▶"}</span>
        <span style={{ fontFamily: "ui-monospace,monospace", fontWeight: 700, color: "#111827", minWidth: 50 }}>#{entry.number}</span>
        <span style={{ fontSize: 12, color: "#374151", minWidth: 80 }}>{fmtDate(entry.date)}</span>
        <span style={{ fontSize: 12.5, color: "#111827", flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{entry.description || "(sin descripción)"}</span>
        <span style={{ fontSize: 10.5, fontWeight: 700, padding: "2px 8px", borderRadius: 10, background: "#fff", color: source.color, border: `0.5px solid ${source.color}` }}>{source.icon} {source.label}</span>
        <span style={{ fontSize: 10.5, fontWeight: 700, padding: "2px 8px", borderRadius: 10, background: status.bg, color: status.color, border: `0.5px solid ${status.border}` }}>{status.label}</span>
        {canEdit && (
          <button
            onClick={(e) => { e.stopPropagation(); onClick(); }}
            title="Editar asiento"
            style={{ width: 26, height: 26, borderRadius: 6, background: "#fff", border: "0.5px solid #E5E7EB", fontSize: 12, cursor: "pointer", fontFamily: "inherit" }}
          >✏️</button>
        )}
        {onDelete && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              if (window.confirm(`¿Eliminar este asiento? Esta acción no se puede deshacer.`)) onDelete();
            }}
            title="Eliminar asiento"
            style={{ width: 26, height: 26, borderRadius: 6, background: "#fff", border: "0.5px solid #FCA5A5", color: "#B91C1C", fontSize: 12, cursor: "pointer", fontFamily: "inherit" }}
          >🗑</button>
        )}
      </div>
      {open && (
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
          <thead>
            <tr style={{ background: "#FAFAFA" }}>
              <th style={lineTh}>Cuenta</th>
              <th style={{ ...lineTh, textAlign: "left" }}>Nombre</th>
              <th style={{ ...lineTh, textAlign: "right" }}>Debe</th>
              <th style={{ ...lineTh, textAlign: "right" }}>Haber</th>
            </tr>
          </thead>
          <tbody>
            {(entry.lines||[]).map((l, i) => (
              <tr key={i} style={{ borderTop: "0.5px solid #F3F4F6" }}>
                <td style={{ ...lineTd, fontFamily: "ui-monospace,monospace", fontWeight: 600, color: "#111827", textAlign: "center", width: 100 }}>{l.account}</td>
                <td style={{ ...lineTd, color: "#374151", textAlign: "left" }}>{l.accountName || "—"}</td>
                <td style={{ ...lineTd, textAlign: "right", fontFamily: "ui-monospace,monospace", color: l.debit > 0 ? "#0E7C5A" : "#9CA3AF", width: 100 }}>{l.debit > 0 ? fmtEur(l.debit) : ""}</td>
                <td style={{ ...lineTd, textAlign: "right", fontFamily: "ui-monospace,monospace", color: l.credit > 0 ? "#B91C1C" : "#9CA3AF", width: 100 }}>{l.credit > 0 ? fmtEur(l.credit) : ""}</td>
              </tr>
            ))}
            <tr style={{ borderTop: "0.5px solid #E5E7EB", background: "#FAFAFA" }}>
              <td style={lineTd}></td>
              <td style={{ ...lineTd, textAlign: "right", fontWeight: 700, color: "#374151" }}>Totales</td>
              <td style={{ ...lineTd, textAlign: "right", fontFamily: "ui-monospace,monospace", fontWeight: 700, color: "#0E7C5A" }}>{fmtEur(totalD)}</td>
              <td style={{ ...lineTd, textAlign: "right", fontFamily: "ui-monospace,monospace", fontWeight: 700, color: "#B91C1C" }}>{fmtEur(totalC)}</td>
            </tr>
          </tbody>
        </table>
      )}
    </div>
  );
}

// ── Vista Balance de Sumas y Saldos ────────────────────────────────────
function BalanceView({ balance }) {
  if (balance.groups.length === 0) {
    return (
      <div style={{ background: "#fff", border: "1px solid #E5E7EB", borderRadius: 12, padding: "32px 18px", textAlign: "center", color: "#9CA3AF", fontSize: 13, fontStyle: "italic" }}>
        Sin movimientos contables en el periodo seleccionado.
      </div>
    );
  }
  return (
    <div style={{ background: "#fff", border: "1px solid #E5E7EB", borderRadius: 12, overflow: "hidden" }}>
      <div style={{ padding: "10px 18px", background: "#FAFAFA", borderBottom: "0.5px solid #E5E7EB", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div style={{ fontSize: 12, fontWeight: 700, color: "#374151" }}>📊 Balance de sumas y saldos</div>
        <div style={{ fontSize: 11, color: "#9CA3AF", fontStyle: "italic" }}>Agrupado por cuenta PGC</div>
      </div>
      {balance.groups.map(([group, rows]) => {
        const meta = GROUP_META[group] || { name: `Grupo ${group}` };
        const grpD = rows.reduce((s, r) => s + r.debit,  0);
        const grpC = rows.reduce((s, r) => s + r.credit, 0);
        return (
          <div key={group}>
            <div style={{ padding: "8px 18px", background: "#F9FAFB", borderTop: "0.5px solid #E5E7EB", borderBottom: "0.5px solid #E5E7EB", fontSize: 11.5, fontWeight: 700, color: "#374151", textTransform: "uppercase", letterSpacing: "0.04em" }}>
              Grupo {group} — {meta.name}
            </div>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5 }}>
              <thead>
                <tr style={{ background: "#FAFAFA" }}>
                  <th style={{ ...lineTh, width: 100 }}>Código</th>
                  <th style={{ ...lineTh, textAlign: "left" }}>Cuenta</th>
                  <th style={{ ...lineTh, textAlign: "right", width: 110 }}>Debe</th>
                  <th style={{ ...lineTh, textAlign: "right", width: 110 }}>Haber</th>
                  <th style={{ ...lineTh, textAlign: "right", width: 110 }}>Saldo</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(r => (
                  <tr key={r.code} style={{ borderTop: "0.5px solid #F3F4F6" }}>
                    <td style={{ ...lineTd, fontFamily: "ui-monospace,monospace", fontWeight: 600, textAlign: "center" }}>{r.code}</td>
                    <td style={{ ...lineTd, textAlign: "left", color: "#374151" }}>{r.name}</td>
                    <td style={{ ...lineTd, textAlign: "right", fontFamily: "ui-monospace,monospace", color: r.debit > 0 ? "#0E7C5A" : "#9CA3AF" }}>{r.debit > 0 ? fmtEur(r.debit) : "—"}</td>
                    <td style={{ ...lineTd, textAlign: "right", fontFamily: "ui-monospace,monospace", color: r.credit > 0 ? "#B91C1C" : "#9CA3AF" }}>{r.credit > 0 ? fmtEur(r.credit) : "—"}</td>
                    <td style={{ ...lineTd, textAlign: "right", fontFamily: "ui-monospace,monospace", fontWeight: 700, color: r.saldo >= 0 ? "#0E7C5A" : "#B91C1C" }}>{fmtEur(r.saldo)}</td>
                  </tr>
                ))}
                <tr style={{ borderTop: "0.5px solid #E5E7EB", background: "#FAFAFA" }}>
                  <td style={lineTd}></td>
                  <td style={{ ...lineTd, textAlign: "right", fontWeight: 700, color: "#374151" }}>Subtotal G{group}</td>
                  <td style={{ ...lineTd, textAlign: "right", fontFamily: "ui-monospace,monospace", fontWeight: 700, color: "#0E7C5A" }}>{fmtEur(grpD)}</td>
                  <td style={{ ...lineTd, textAlign: "right", fontFamily: "ui-monospace,monospace", fontWeight: 700, color: "#B91C1C" }}>{fmtEur(grpC)}</td>
                  <td style={{ ...lineTd, textAlign: "right", fontFamily: "ui-monospace,monospace", fontWeight: 700, color: grpD - grpC >= 0 ? "#0E7C5A" : "#B91C1C" }}>{fmtEur(grpD - grpC)}</td>
                </tr>
              </tbody>
            </table>
          </div>
        );
      })}
      <div style={{ padding: "12px 18px", background: "#27AE60", color: "#fff", display: "flex", justifyContent: "space-between", fontSize: 13, fontWeight: 700 }}>
        <span>TOTAL GENERAL</span>
        <span style={{ fontFamily: "ui-monospace,monospace" }}>D {fmtEur(balance.totalD)} · H {fmtEur(balance.totalC)} · Saldo {fmtEur(balance.totalD - balance.totalC)}</span>
      </div>
    </div>
  );
}

// ── Modal alta/edición de asiento ──────────────────────────────────────
function EntryModal({ entry, companyId: forcedCompanyId, chart, onClose, onSave, onDelete, onAddCustomAccount }) {
  const isNew = !entry;
  const [date, setDate]               = useState(entry?.date || todayISO());
  const [description, setDescription] = useState(entry?.description || "");
  const [status, setStatus]           = useState(entry?.status || "confirmado");
  const [lines, setLines]             = useState(entry?.lines?.length ? entry.lines : [
    { account: "", accountName: "", debit: 0, credit: 0 },
    { account: "", accountName: "", debit: 0, credit: 0 },
  ]);
  const [showAddAccount, setShowAddAccount] = useState(false);

  const updateLine = (idx, patch) => setLines(prev => prev.map((l, i) => i === idx ? { ...l, ...patch } : l));
  const addLine    = () => setLines(prev => [...prev, { account: "", accountName: "", debit: 0, credit: 0 }]);
  const removeLine = (idx) => setLines(prev => prev.length > 2 ? prev.filter((_, i) => i !== idx) : prev);

  const onPickAccount = (idx, code) => {
    const c = chart.find(x => x.code === code);
    updateLine(idx, { account: code, accountName: c?.name || "" });
  };

  const totalD = lines.reduce((s, l) => s + (Number(l.debit) ||0), 0);
  const totalC = lines.reduce((s, l) => s + (Number(l.credit)||0), 0);
  const cuadrado = Math.abs(totalD - totalC) < 0.011 && totalD > 0;
  const canSave = !!description.trim() && cuadrado && lines.every(l => l.account && (Number(l.debit) > 0 || Number(l.credit) > 0));

  const handleSave = () => {
    if (!canSave) return;
    onSave({
      companyId: forcedCompanyId || entry?.companyId,
      date, description: description.trim(),
      status,
      lines: lines.map(l => ({
        account: String(l.account||"").trim(),
        accountName: String(l.accountName||"").trim(),
        debit:  Number(l.debit) ||0,
        credit: Number(l.credit)||0,
      })),
    });
  };

  return (
    <div onClick={(e) => e.target === e.currentTarget && onClose()} style={overlayStyle}>
      <div style={{ ...modalStyle, borderTop: "4px solid #27AE60" }}>
        <div style={modalHeader}>
          <div style={{ fontSize: 14, fontWeight: 700 }}>
            {isNew ? "+ Nuevo asiento contable" : `Asiento #${entry.number}${entry.status === "borrador" ? " · borrador" : ""}`}
          </div>
          <button onClick={onClose} style={closeBtn}>×</button>
        </div>
        <div style={modalBody}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 2fr 1fr", gap: 10 }}>
            <Field label="Fecha">
              <input type="date" value={date} onChange={e => setDate(e.target.value)} style={inputStyle} />
            </Field>
            <Field label="Descripción">
              <input value={description} onChange={e => setDescription(e.target.value)} placeholder="Ej: Compra cámara hiperbárica MC4000U - Factura 017" style={inputStyle} />
            </Field>
            <Field label="Estado">
              <select value={status} onChange={e => setStatus(e.target.value)} style={inputStyle}>
                <option value="borrador">📝 Borrador</option>
                <option value="confirmado">✅ Confirmado</option>
              </select>
            </Field>
          </div>

          {/* Líneas */}
          <div style={sectionStyle}>
            <div style={{ ...sectionTitle, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <span>Líneas del asiento (mín. 2 · debe = haber)</span>
              <button onClick={addLine} style={{ padding: "5px 10px", borderRadius: 6, background: "#27AE60", color: "#fff", border: "none", fontSize: 11, fontWeight: 600, cursor: "pointer", fontFamily: "inherit" }}>+ Línea</button>
            </div>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
              <thead>
                <tr>
                  <th style={{ ...lineTh, width: 130 }}>Cuenta PGC</th>
                  <th style={{ ...lineTh, textAlign: "left" }}>Nombre</th>
                  <th style={{ ...lineTh, width: 100, textAlign: "right" }}>Debe</th>
                  <th style={{ ...lineTh, width: 100, textAlign: "right" }}>Haber</th>
                  <th style={{ ...lineTh, width: 36 }}></th>
                </tr>
              </thead>
              <tbody>
                {lines.map((l, i) => {
                  const matchesChart = !!chart.find(c => c.code === l.account);
                  return (
                    <tr key={i} style={{ borderTop: "0.5px solid #F3F4F6" }}>
                      <td style={lineTd}>
                        <AccountInput
                          value={l.account}
                          chart={chart}
                          onChange={(code) => onPickAccount(i, code)}
                        />
                      </td>
                      <td style={lineTd}>
                        <input
                          value={l.accountName}
                          onChange={e => updateLine(i, { accountName: e.target.value })}
                          placeholder={matchesChart ? "" : "(libre)"}
                          style={{ ...inputStyle, padding: "6px 8px", fontSize: 12 }}
                        />
                      </td>
                      <td style={lineTd}>
                        <input type="number" step="0.01" min="0" value={l.debit||""} onChange={e => updateLine(i, { debit: Number(e.target.value)||0, credit: 0 })} style={{ ...inputStyle, padding: "6px 8px", fontSize: 12, textAlign: "right" }} />
                      </td>
                      <td style={lineTd}>
                        <input type="number" step="0.01" min="0" value={l.credit||""} onChange={e => updateLine(i, { credit: Number(e.target.value)||0, debit: 0 })} style={{ ...inputStyle, padding: "6px 8px", fontSize: 12, textAlign: "right" }} />
                      </td>
                      <td style={lineTd}>
                        <button onClick={() => removeLine(i)} disabled={lines.length <= 2} title="Eliminar línea" style={{ width: 26, height: 26, borderRadius: 6, border: "0.5px solid #FCA5A5", background: lines.length<=2?"#F9FAFB":"#fff", color: lines.length<=2?"#D1D5DB":"#B91C1C", fontSize: 13, cursor: lines.length<=2?"not-allowed":"pointer" }}>×</button>
                      </td>
                    </tr>
                  );
                })}
                <tr style={{ borderTop: "0.5px solid #E5E7EB", background: "#FAFAFA" }}>
                  <td style={lineTd}></td>
                  <td style={{ ...lineTd, textAlign: "right", fontWeight: 700, color: "#374151" }}>Totales</td>
                  <td style={{ ...lineTd, textAlign: "right", fontFamily: "ui-monospace,monospace", fontWeight: 700, color: "#0E7C5A" }}>{fmtEur(totalD)}</td>
                  <td style={{ ...lineTd, textAlign: "right", fontFamily: "ui-monospace,monospace", fontWeight: 700, color: "#B91C1C" }}>{fmtEur(totalC)}</td>
                  <td style={lineTd}></td>
                </tr>
              </tbody>
            </table>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: 4 }}>
              <span style={{ fontSize: 11.5, fontWeight: 600, color: cuadrado ? "#0E7C5A" : "#B91C1C" }}>
                {cuadrado ? "✅ Asiento cuadrado" : `❌ Descuadrado por ${fmtEur(Math.abs(totalD - totalC))}`}
              </span>
              <button onClick={() => setShowAddAccount(true)} style={{ padding: "4px 10px", borderRadius: 6, background: "transparent", border: "0.5px solid #D1D5DB", fontSize: 11, color: "#6B7280", cursor: "pointer", fontFamily: "inherit" }}>+ Cuenta personalizada al plan</button>
            </div>
          </div>

          {showAddAccount && (
            <AddAccountInline
              onClose={() => setShowAddAccount(false)}
              onAdd={(payload) => { onAddCustomAccount?.(payload); setShowAddAccount(false); }}
            />
          )}

          <div style={{ display: "flex", gap: 8, justifyContent: "space-between", marginTop: 6 }}>
            {onDelete && (
              <button onClick={() => { if (window.confirm("¿Eliminar este asiento? Esta acción no se puede deshacer.")) onDelete(); }} style={{ padding: "8px 14px", borderRadius: 8, background: "transparent", border: "1px solid #FCA5A5", color: "#B91C1C", fontSize: 12, fontWeight: 600, cursor: "pointer", fontFamily: "inherit" }}>Eliminar</button>
            )}
            <div style={{ display: "flex", gap: 8, marginLeft: "auto" }}>
              <button onClick={onClose} style={cancelBtn}>Cancelar</button>
              <button
                onClick={handleSave}
                disabled={!canSave}
                style={canSave
                  ? { padding: "8px 18px", borderRadius: 8, background: "#27AE60", color: "#fff", border: "none", fontSize: 12, fontWeight: 600, cursor: "pointer", fontFamily: "inherit" }
                  : { padding: "8px 18px", borderRadius: 8, background: "#E5E7EB", color: "#9CA3AF", border: "none", fontSize: 12, fontWeight: 600, cursor: "default", fontFamily: "inherit" }
                }
              >{isNew ? "Crear asiento" : "Guardar"}</button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// AccountInput — input con datalist para autocompletar desde chart.
function AccountInput({ value, chart, onChange }) {
  const id = useMemo(() => `chart_${Math.random().toString(36).slice(2,8)}`, []);
  return (
    <>
      <input
        list={id}
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder="ej: 600 o 2130001"
        style={{ ...inputStyle, padding: "6px 8px", fontSize: 12, fontFamily: "ui-monospace,monospace" }}
      />
      <datalist id={id}>
        {chart.map(c => <option key={c.code} value={c.code}>{c.name}</option>)}
      </datalist>
    </>
  );
}

// AddAccountInline — formulario inline para añadir cuenta al plan.
function AddAccountInline({ onClose, onAdd }) {
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const ok = code.trim().length >= 3 && name.trim().length >= 2;
  return (
    <div style={{ ...sectionStyle, background: "#F0FDF4", borderColor: "#86EFAC" }}>
      <div style={sectionTitle}>+ Añadir cuenta al plan PGC</div>
      <div style={{ display: "grid", gridTemplateColumns: "120px 1fr auto", gap: 8, alignItems: "center" }}>
        <input value={code} onChange={e => setCode(e.target.value)} placeholder="Código (ej: 2130001)" style={{ ...inputStyle, fontFamily: "ui-monospace,monospace" }} />
        <input value={name} onChange={e => setName(e.target.value)} placeholder="Nombre (ej: Cámara hiperbárica 1)" style={inputStyle} />
        <div style={{ display: "flex", gap: 6 }}>
          <button onClick={onClose} style={cancelBtn}>Cancelar</button>
          <button
            disabled={!ok}
            onClick={() => onAdd({ code: code.trim(), name: name.trim(), group: Number(String(code).charAt(0)) || 9 })}
            style={ok
              ? { padding: "6px 12px", borderRadius: 6, background: "#27AE60", color: "#fff", border: "none", fontSize: 11.5, fontWeight: 600, cursor: "pointer", fontFamily: "inherit" }
              : { padding: "6px 12px", borderRadius: 6, background: "#E5E7EB", color: "#9CA3AF", border: "none", fontSize: 11.5, fontWeight: 600, cursor: "default", fontFamily: "inherit" }
            }
          >Añadir</button>
        </div>
      </div>
    </div>
  );
}

function Field({ label, children }) {
  return (
    <div>
      <div style={{ fontSize: 10, fontWeight: 600, color: "#6B7280", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 4 }}>{label}</div>
      {children}
    </div>
  );
}

const inputStyle = { padding: "8px 10px", borderRadius: 8, border: "0.5px solid #D1D5DB", fontSize: 13, fontFamily: "inherit", outline: "none", boxSizing: "border-box", background: "#fff", width: "100%" };
const overlayStyle = { position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)", zIndex: 3000, display: "flex", alignItems: "center", justifyContent: "center", padding: 20 };
const modalStyle = { background: "#fff", borderRadius: 14, width: 800, maxWidth: "96vw", overflow: "hidden", maxHeight: "94vh", display: "flex", flexDirection: "column" };
const modalHeader = { padding: "14px 18px", borderBottom: "0.5px solid #E5E7EB", display: "flex", alignItems: "center", justifyContent: "space-between", flexShrink: 0 };
const modalBody = { padding: 18, display: "flex", flexDirection: "column", gap: 14, overflowY: "auto" };
const closeBtn = { background: "none", border: "none", fontSize: 20, cursor: "pointer", color: "#6B7280" };
const sectionStyle = { background: "#FAFAFA", border: "0.5px solid #E5E7EB", borderRadius: 10, padding: 12, display: "flex", flexDirection: "column", gap: 10 };
const sectionTitle = { fontSize: 11, fontWeight: 700, color: "#6B7280", textTransform: "uppercase", letterSpacing: "0.05em" };
const cancelBtn = { padding: "8px 14px", borderRadius: 8, background: "transparent", border: "1px solid #D1D5DB", fontSize: 12, fontWeight: 500, cursor: "pointer", fontFamily: "inherit" };
const lineTh = { padding: "6px 8px", fontSize: 10.5, fontWeight: 700, color: "#6B7280", textTransform: "uppercase", letterSpacing: 0.4, textAlign: "center" };
const lineTd = { padding: "5px 8px", verticalAlign: "middle" };
