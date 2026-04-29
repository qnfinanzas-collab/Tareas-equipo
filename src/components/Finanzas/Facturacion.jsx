// Facturacion — gestión de facturas emitidas y recibidas multi-empresa.
// Toggle Emitidas/Recibidas, lista filtrable, modal CRUD con líneas, IVA
// (4/10/21%) y retención IRPF (0/7/15/19%). Resumen trimestral inferior
// con base del Modelo 303 (IVA repercutido vs soportado por trimestre).
//
// La numeración (YYYY/NNN por empresa+tipo+año) la genera App.jsx en el
// mutator addInvoice. vatQuarter se calcula desde la fecha de factura.
import React, { useMemo, useState } from "react";
import ExportGestoriaModal from "./ExportGestoriaModal.jsx";

const VAT_RATES = [0, 4, 10, 21];
const IRPF_RATES = [0, 7, 15, 19];

const fmtEur = (n) => new Intl.NumberFormat("es-ES", { style: "currency", currency: "EUR", maximumFractionDigits: 2 }).format(Number(n)||0);
const fmtDate = (s) => {
  if (!s) return "—";
  const d = new Date(s);
  if (isNaN(d.getTime())) return s;
  return d.toLocaleDateString("es-ES", { day: "numeric", month: "short", year: "2-digit" });
};
const monthKey = (s) => {
  const d = new Date(s);
  if (isNaN(d.getTime())) return null;
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}`;
};
const monthLabel = (key) => {
  if (!key) return "";
  const [y, m] = key.split("-");
  const d = new Date(Number(y), Number(m)-1, 1);
  return d.toLocaleDateString("es-ES", { month: "long", year: "numeric" });
};
const todayISO = () => new Date().toISOString().slice(0,10);
const computeStatus = (inv) => {
  // El status "vencida" se deriva: si due < hoy y no está pagada/parcial.
  if (inv.status === "pagada" || inv.status === "parcial") return inv.status;
  if (inv.dueDate && inv.dueDate < todayISO()) return "vencida";
  return "pendiente";
};
const STATUS_META = {
  pagada:    { icon: "✅", label: "Pagada",    bg: "#DCFCE7", border: "#86EFAC", color: "#065F46" },
  pendiente: { icon: "🟡", label: "Pendiente", bg: "#FEF3C7", border: "#FCD34D", color: "#92400E" },
  vencida:   { icon: "🔴", label: "Vencida",   bg: "#FEE2E2", border: "#FCA5A5", color: "#991B1B" },
  parcial:   { icon: "🔵", label: "Parcial",   bg: "#DBEAFE", border: "#93C5FD", color: "#1E40AF" },
};

export default function Facturacion({ data, canEdit, selectedCompanyId, onAddInvoice, onUpdateInvoice, onDeleteInvoice }) {
  const allInvoices = data.invoices || [];
  const companies = data.governance?.companies || [];
  const allBankMovements = data.bankMovements || [];

  const [type, setType]                 = useState("emitida"); // emitida | recibida
  const [filterStatus, setFilterStatus] = useState("all");
  const [filterMonth, setFilterMonth]   = useState("all");
  const [search, setSearch]             = useState("");
  const [editing, setEditing]           = useState(null); // null | "new" | invoice
  const [showExport, setShowExport]     = useState(false);

  // Filtro por empresa. Una factura sin companyId (legacy) se muestra
  // siempre, igual que con bankMovements.
  const invoicesByCompany = useMemo(() => {
    if (selectedCompanyId === "all") return allInvoices;
    return allInvoices.filter(i => !i.companyId || i.companyId === selectedCompanyId);
  }, [allInvoices, selectedCompanyId]);

  const invoicesByType = useMemo(
    () => invoicesByCompany.filter(i => i.type === type),
    [invoicesByCompany, type]
  );

  const filtered = useMemo(() => {
    return invoicesByType.filter(inv => {
      const st = computeStatus(inv);
      if (filterStatus !== "all" && st !== filterStatus) return false;
      if (filterMonth !== "all" && monthKey(inv.date) !== filterMonth) return false;
      if (search) {
        const q = search.toLowerCase();
        const hay = [
          inv.number, inv.counterparty?.name, inv.counterparty?.cif, inv.notes,
        ].filter(Boolean).join(" ").toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    }).sort((a, b) => (b.date||"").localeCompare(a.date||""));
  }, [invoicesByType, filterStatus, filterMonth, search]);

  const availableMonths = useMemo(() => {
    const set = new Set();
    invoicesByType.forEach(i => { const k = monthKey(i.date); if (k) set.add(k); });
    return Array.from(set).sort().reverse();
  }, [invoicesByType]);

  const stats = useMemo(() => {
    let total = 0, vat = 0, irpf = 0, pending = 0;
    for (const inv of filtered) {
      total += Number(inv.total)||0;
      vat   += Number(inv.vatAmount)||0;
      irpf  += Number(inv.irpfAmount)||0;
      const st = computeStatus(inv);
      if (st !== "pagada") pending += Number(inv.total)||0;
    }
    return { count: filtered.length, total, vat, irpf, pending };
  }, [filtered]);

  // Resumen trimestral del IVA. Basado en TODAS las facturas de la empresa
  // (emitidas + recibidas, no solo el toggle activo) para poder calcular
  // el saldo del Modelo 303 = repercutido − soportado.
  const vatQuarterly = useMemo(() => {
    const acc = new Map(); // key=YYYY-Q → { rep, sop }
    for (const inv of invoicesByCompany) {
      const d = new Date(inv.date);
      if (isNaN(d.getTime())) continue;
      const q = Math.floor(d.getMonth()/3) + 1;
      const key = `${d.getFullYear()}-${q}T`;
      const cur = acc.get(key) || { rep: 0, sop: 0, year: d.getFullYear(), q };
      if (inv.type === "emitida") cur.rep += Number(inv.vatAmount)||0;
      else                         cur.sop += Number(inv.vatAmount)||0;
      acc.set(key, cur);
    }
    return Array.from(acc.entries())
      .map(([key, v]) => ({ key, year: v.year, q: v.q, repercutido: v.rep, soportado: v.sop, balance: v.rep - v.sop }))
      .sort((a, b) => b.key.localeCompare(a.key))
      .slice(0, 8); // últimos 8 trimestres = 2 años
  }, [invoicesByCompany]);

  if (companies.length === 0) {
    return (
      <div style={{ background: "#fff", border: "1px solid #E5E7EB", borderRadius: 12, padding: "40px 20px", textAlign: "center" }}>
        <div style={{ fontSize: 36, marginBottom: 12 }}>🧾</div>
        <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 6, color: "#111827" }}>Aún no hay empresas registradas</div>
        <div style={{ fontSize: 12, color: "#7F8C8D", maxWidth: 380, margin: "0 auto" }}>
          Para emitir o registrar facturas, primero registra una empresa en 🏛️ Gobernanza ▸ Dashboard.
        </div>
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {/* Toggle emitidas/recibidas */}
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <div style={{ display: "inline-flex", background: "#fff", border: "1px solid #E5E7EB", borderRadius: 10, padding: 4 }}>
          {[{k:"emitida", label:"📤 Emitidas"}, {k:"recibida", label:"📥 Recibidas"}].map(opt => {
            const active = type === opt.k;
            return (
              <button
                key={opt.k}
                onClick={() => setType(opt.k)}
                style={{
                  padding: "7px 16px",
                  borderRadius: 7,
                  border: "none",
                  background: active ? "#27AE60" : "transparent",
                  color: active ? "#fff" : "#6B7280",
                  fontSize: 13,
                  fontWeight: 600,
                  cursor: "pointer",
                  fontFamily: "inherit",
                }}
              >{opt.label}</button>
            );
          })}
        </div>
        <div style={{ marginLeft: "auto", display: "flex", gap: 8, alignItems: "center" }}>
          <button onClick={() => setShowExport(true)} title="Exportar facturas y resumen IVA para la gestoría" style={{ padding: "8px 14px", borderRadius: 8, background: "#fff", color: "#0E7C5A", border: "1px solid #27AE60", fontSize: 12, fontWeight: 600, cursor: "pointer", fontFamily: "inherit" }}>📥 Exportar para gestoría</button>
          {canEdit && (
            <button onClick={() => setEditing("new")} style={{ padding: "8px 16px", borderRadius: 8, background: "#27AE60", color: "#fff", border: "none", fontSize: 13, fontWeight: 600, cursor: "pointer", fontFamily: "inherit" }}>+ Nueva factura</button>
          )}
        </div>
      </div>

      {/* Stats */}
      <div style={{ background: "#fff", border: "1px solid #E5E7EB", borderRadius: 12, padding: "14px 18px", display: "flex", gap: 24, flexWrap: "wrap" }}>
        <Stat label={type === "emitida" ? "Facturado" : "Recibido"} value={fmtEur(stats.total)} color="#111827" />
        <Stat label={type === "emitida" ? "IVA repercutido" : "IVA soportado"} value={fmtEur(stats.vat)} color="#0E7C5A" />
        {stats.irpf > 0 && <Stat label="IRPF retenido" value={fmtEur(stats.irpf)} color="#B91C1C" />}
        <Stat label="Pendiente cobro/pago" value={fmtEur(stats.pending)} color={stats.pending > 0 ? "#92400E" : "#9CA3AF"} />
        <Stat label="Nº facturas" value={String(stats.count)} color="#6B7280" />
      </div>

      {/* Filtros */}
      <div style={{ background: "#fff", border: "1px solid #E5E7EB", borderRadius: 12, padding: "12px 16px", display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <select value={filterStatus} onChange={e => setFilterStatus(e.target.value)} style={inputStyle}>
          <option value="all">Todos los estados</option>
          <option value="pendiente">🟡 Pendiente</option>
          <option value="pagada">✅ Pagada</option>
          <option value="vencida">🔴 Vencida</option>
          <option value="parcial">🔵 Parcial</option>
        </select>
        <select value={filterMonth} onChange={e => setFilterMonth(e.target.value)} style={inputStyle}>
          <option value="all">Todos los meses</option>
          {availableMonths.map(k => <option key={k} value={k}>{monthLabel(k)}</option>)}
        </select>
        <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Buscar por nº, nombre o CIF…" style={{ ...inputStyle, flex: 1, minWidth: 180 }} />
      </div>

      {/* Tabla */}
      <div style={{ background: "#fff", border: "1px solid #E5E7EB", borderRadius: 12, overflow: "hidden" }}>
        <div style={{ padding: "10px 18px", background: "#FAFAFA", borderBottom: "0.5px solid #E5E7EB", fontSize: 12, fontWeight: 700, color: "#374151" }}>
          {type === "emitida" ? "📤 Facturas emitidas" : "📥 Facturas recibidas"} {filtered.length > 0 ? `(${filtered.length})` : ""}
        </div>
        {filtered.length === 0 ? (
          <div style={{ padding: "32px 18px", textAlign: "center", color: "#9CA3AF", fontSize: 13, fontStyle: "italic" }}>
            {invoicesByType.length === 0
              ? `Aún no hay facturas ${type === "emitida" ? "emitidas" : "recibidas"}.`
              : "Ningún resultado con los filtros actuales."}
          </div>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5 }}>
              <thead>
                <tr style={{ background: "#FAFAFA", borderBottom: "0.5px solid #E5E7EB" }}>
                  <th style={th}>Nº</th>
                  <th style={{ ...th, textAlign: "left" }}>{type === "emitida" ? "Cliente" : "Proveedor"}</th>
                  <th style={th}>Fecha</th>
                  <th style={th}>Vencim.</th>
                  <th style={{ ...th, textAlign: "right" }}>Base</th>
                  <th style={{ ...th, textAlign: "right" }}>IVA</th>
                  <th style={{ ...th, textAlign: "right" }}>Total</th>
                  <th style={th}>Estado</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map(inv => {
                  const st = computeStatus(inv);
                  const meta = STATUS_META[st];
                  return (
                    <tr key={inv.id}
                      onClick={() => canEdit && setEditing(inv)}
                      style={{ borderTop: "0.5px solid #F3F4F6", cursor: canEdit ? "pointer" : "default" }}
                    >
                      <td style={{ ...td, fontFamily: "ui-monospace,monospace", fontWeight: 600 }}>{inv.number || "—"}</td>
                      <td style={{ ...td, textAlign: "left" }}>
                        <div style={{ fontWeight: 600, color: "#111827" }}>{inv.counterparty?.name || "(sin nombre)"}</div>
                        {inv.counterparty?.cif && <div style={{ fontSize: 10.5, color: "#9CA3AF", fontFamily: "ui-monospace,monospace", marginTop: 1 }}>{inv.counterparty.cif}</div>}
                      </td>
                      <td style={td}>{fmtDate(inv.date)}</td>
                      <td style={{ ...td, color: st === "vencida" ? "#B91C1C" : "#6B7280", fontWeight: st === "vencida" ? 700 : 400 }}>{fmtDate(inv.dueDate)}</td>
                      <td style={{ ...td, textAlign: "right", fontFamily: "ui-monospace,monospace", color: "#374151" }}>{fmtEur(inv.subtotal)}</td>
                      <td style={{ ...td, textAlign: "right", fontFamily: "ui-monospace,monospace", color: "#0E7C5A" }}>{fmtEur(inv.vatAmount)}</td>
                      <td style={{ ...td, textAlign: "right", fontFamily: "ui-monospace,monospace", fontWeight: 700, color: "#111827" }}>{fmtEur(inv.total)}</td>
                      <td style={td}>
                        <span style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 10.5, fontWeight: 700, padding: "2px 8px", borderRadius: 10, background: meta.bg, color: meta.color, border: `0.5px solid ${meta.border}` }}>
                          {meta.icon} {meta.label}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Resumen trimestral del IVA */}
      <div style={{ background: "#fff", border: "1px solid #E5E7EB", borderRadius: 12, overflow: "hidden" }}>
        <div style={{ padding: "10px 18px", background: "#FAFAFA", borderBottom: "0.5px solid #E5E7EB", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: "#374151" }}>📊 Resumen IVA trimestral · base del Modelo 303</div>
          <div style={{ fontSize: 10.5, color: "#9CA3AF", fontStyle: "italic" }}>{selectedCompanyId === "all" ? "(consolidado)" : "(empresa filtrada)"}</div>
        </div>
        {vatQuarterly.length === 0 ? (
          <div style={{ padding: "24px 18px", textAlign: "center", color: "#9CA3AF", fontSize: 12, fontStyle: "italic" }}>
            Aún no hay datos. Registra al menos una factura emitida y otra recibida para calcular el balance trimestral.
          </div>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5 }}>
              <thead>
                <tr style={{ background: "#FAFAFA", borderBottom: "0.5px solid #E5E7EB" }}>
                  <th style={th}>Trimestre</th>
                  <th style={{ ...th, textAlign: "right" }}>IVA repercutido</th>
                  <th style={{ ...th, textAlign: "right" }}>IVA soportado</th>
                  <th style={{ ...th, textAlign: "right" }}>Saldo (Mod. 303)</th>
                  <th style={{ ...th, textAlign: "left" }}>Resultado</th>
                </tr>
              </thead>
              <tbody>
                {vatQuarterly.map(row => {
                  const aIngresar = row.balance > 0.005;
                  const aDevolver = row.balance < -0.005;
                  return (
                    <tr key={row.key} style={{ borderTop: "0.5px solid #F3F4F6" }}>
                      <td style={{ ...td, fontWeight: 700 }}>{row.q}T-{row.year}</td>
                      <td style={{ ...td, textAlign: "right", fontFamily: "ui-monospace,monospace", color: "#0E7C5A" }}>{fmtEur(row.repercutido)}</td>
                      <td style={{ ...td, textAlign: "right", fontFamily: "ui-monospace,monospace", color: "#B91C1C" }}>{fmtEur(row.soportado)}</td>
                      <td style={{ ...td, textAlign: "right", fontFamily: "ui-monospace,monospace", fontWeight: 700, color: aIngresar ? "#B91C1C" : aDevolver ? "#0E7C5A" : "#6B7280" }}>{fmtEur(row.balance)}</td>
                      <td style={{ ...td, textAlign: "left", fontWeight: 600, color: aIngresar ? "#B91C1C" : aDevolver ? "#0E7C5A" : "#6B7280" }}>
                        {aIngresar ? `🔴 A ingresar ${fmtEur(row.balance)}` : aDevolver ? `🟢 A devolver ${fmtEur(Math.abs(row.balance))}` : "Neutro"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {showExport && (
        <ExportGestoriaModal
          data={data}
          selectedCompanyId={selectedCompanyId}
          onClose={() => setShowExport(false)}
        />
      )}

      {editing && (
        <InvoiceModal
          invoice={editing === "new" ? null : editing}
          defaultType={type}
          companies={companies}
          defaultCompanyId={selectedCompanyId === "all" ? (companies[0]?.id || "") : selectedCompanyId}
          bankMovements={allBankMovements}
          onClose={() => setEditing(null)}
          onSave={(payload) => {
            if (editing === "new") onAddInvoice?.(payload);
            else onUpdateInvoice?.(editing.id, payload);
            setEditing(null);
          }}
          onDelete={editing !== "new" ? () => {
            if (window.confirm("¿Eliminar esta factura? Esta acción no se puede deshacer.")) {
              onDeleteInvoice?.(editing.id);
              setEditing(null);
            }
          } : null}
        />
      )}
    </div>
  );
}

function Stat({ label, value, color }) {
  return (
    <div>
      <div style={{ fontSize: 10, fontWeight: 700, color: "#6B7280", textTransform: "uppercase", letterSpacing: "0.05em" }}>{label}</div>
      <div style={{ fontSize: 16, fontWeight: 700, color: color || "#111827", marginTop: 2 }}>{value}</div>
    </div>
  );
}

// ── Modal CRUD de factura ──
function InvoiceModal({ invoice, defaultType, companies, defaultCompanyId, bankMovements, onClose, onSave, onDelete }) {
  const isNew = !invoice;
  const [type, setType] = useState(invoice?.type || defaultType || "emitida");
  const [companyId, setCompanyId] = useState(invoice?.companyId || defaultCompanyId || "");
  const [number, setNumber] = useState(invoice?.number || "");
  const [date, setDate] = useState(invoice?.date || todayISO());
  const [dueDate, setDueDate] = useState(invoice?.dueDate || "");
  const [name, setName] = useState(invoice?.counterparty?.name || "");
  const [cif,  setCif]  = useState(invoice?.counterparty?.cif  || "");
  const [address, setAddress] = useState(invoice?.counterparty?.address || "");
  const [lines, setLines] = useState(invoice?.lines?.length ? invoice.lines : [{ description: "", quantity: 1, unitPrice: 0, vatRate: 21 }]);
  const [irpfRate, setIrpfRate] = useState(invoice?.irpfRate || 0);
  const [notes, setNotes] = useState(invoice?.notes || "");
  // Sección de pago (solo en edición)
  const [status, setStatus] = useState(invoice?.status || "pendiente");
  const [paidAmount, setPaidAmount] = useState(invoice?.paidAmount || 0);
  const [paidDate, setPaidDate]     = useState(invoice?.paidDate || "");
  const [bankMovementId, setBankMovementId] = useState(invoice?.bankMovementId || "");

  // Cálculos en tiempo real.
  const totals = useMemo(() => {
    let subtotal = 0;
    const vatByRate = new Map();
    for (const l of lines) {
      const qty = Number(l.quantity)||0;
      const price = Number(l.unitPrice)||0;
      const rate = Number(l.vatRate)||0;
      const base = qty * price;
      subtotal += base;
      const cur = vatByRate.get(rate) || { base: 0, vat: 0 };
      cur.base += base;
      cur.vat  += base * rate / 100;
      vatByRate.set(rate, cur);
    }
    let vatAmount = 0;
    for (const v of vatByRate.values()) vatAmount += v.vat;
    const irpf = subtotal * (Number(irpfRate)||0) / 100;
    const total = subtotal + vatAmount - irpf;
    return {
      subtotal: Math.round(subtotal*100)/100,
      vatAmount: Math.round(vatAmount*100)/100,
      irpfAmount: Math.round(irpf*100)/100,
      total: Math.round(total*100)/100,
      vatByRate: Array.from(vatByRate.entries()).filter(([, v]) => v.base > 0).sort((a,b)=>a[0]-b[0]),
    };
  }, [lines, irpfRate]);

  // Movimientos bancarios candidatos a vincular: sin reconciliar y con
  // importe similar (±5%) al total de la factura. Si ya hay vinculado un
  // movimiento (edición), lo incluimos siempre aunque ya no encaje.
  const bankCandidates = useMemo(() => {
    if (!Array.isArray(bankMovements)) return [];
    const targetAbs = Math.abs(totals.total);
    if (!targetAbs) return [];
    const tol = Math.max(0.5, targetAbs * 0.05);
    const list = bankMovements.filter(m => {
      if (m.id === bankMovementId) return true; // siempre visible
      if (m.reconciled) return false;
      // Para emitidas buscamos ingresos (amount > 0); recibidas → gastos (amount < 0).
      const isIncome = (Number(m.amount)||0) > 0;
      if (type === "emitida" && !isIncome) return false;
      if (type === "recibida" && isIncome) return false;
      return Math.abs(Math.abs(Number(m.amount)||0) - targetAbs) <= tol;
    });
    return list.slice(0, 30);
  }, [bankMovements, bankMovementId, totals.total, type]);

  const updateLine = (idx, patch) => setLines(prev => prev.map((l, i) => i === idx ? { ...l, ...patch } : l));
  const addLine = () => setLines(prev => [...prev, { description: "", quantity: 1, unitPrice: 0, vatRate: 21 }]);
  const removeLine = (idx) => setLines(prev => prev.length > 1 ? prev.filter((_, i) => i !== idx) : prev);

  const canSave = !!companyId && !!name.trim() && lines.length > 0 && lines.every(l => Number(l.quantity) >= 0 && Number(l.unitPrice) >= 0);

  const handleSave = () => {
    if (!canSave) return;
    onSave({
      type, companyId, number: number.trim() || null, date, dueDate: dueDate || null,
      counterparty: { name: name.trim(), cif: cif.trim(), address: address.trim() },
      lines: lines.map(l => ({
        description: (l.description||"").trim(),
        quantity: Number(l.quantity)||0,
        unitPrice: Number(l.unitPrice)||0,
        vatRate: Number(l.vatRate)||0,
      })),
      irpfRate: Number(irpfRate)||0,
      notes: notes.trim(),
      status,
      paidAmount: Number(paidAmount)||0,
      paidDate: paidDate || null,
      bankMovementId: bankMovementId || null,
    });
  };

  return (
    <div onClick={(e) => e.target === e.currentTarget && onClose()} style={overlayStyle}>
      <div style={{ ...modalStyle, borderTop: "4px solid #27AE60", width: 720, maxWidth: "96vw" }}>
        <div style={modalHeader}>
          <div style={{ fontSize: 14, fontWeight: 700 }}>{isNew ? "+ Nueva factura" : `Factura ${invoice.number || "(sin número)"}`}</div>
          <button onClick={onClose} style={closeBtn}>×</button>
        </div>
        <div style={modalBody}>
          {/* Tipo + empresa */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <Field label="Tipo">
              <div style={{ display: "flex", gap: 6 }}>
                <button onClick={() => setType("emitida")} style={typeBtn(type === "emitida", "#27AE60")}>📤 Emitida</button>
                <button onClick={() => setType("recibida")} style={typeBtn(type === "recibida", "#E67E22")}>📥 Recibida</button>
              </div>
            </Field>
            <Field label="Empresa">
              <select value={companyId} onChange={e => setCompanyId(e.target.value)} style={inputStyle}>
                <option value="">— Selecciona —</option>
                {companies.map(c => <option key={c.id} value={c.id}>{c.type === "holding" ? "🏛️" : c.type === "patrimonial" ? "🏠" : "⚙️"} {c.name}{c.cif?` · ${c.cif}`:""}</option>)}
              </select>
            </Field>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12 }}>
            <Field label={isNew ? "Nº (auto si vacío)" : "Nº factura"}>
              <input value={number} onChange={e => setNumber(e.target.value)} placeholder={isNew ? "YYYY/NNN" : ""} style={{ ...inputStyle, fontFamily: "ui-monospace,monospace" }} />
            </Field>
            <Field label="Fecha factura">
              <input type="date" value={date} onChange={e => setDate(e.target.value)} style={inputStyle} />
            </Field>
            <Field label="Vencimiento">
              <input type="date" value={dueDate} onChange={e => setDueDate(e.target.value)} style={inputStyle} />
            </Field>
          </div>

          {/* Contraparte */}
          <div style={sectionStyle}>
            <div style={sectionTitle}>{type === "emitida" ? "Cliente" : "Proveedor"}</div>
            <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr", gap: 10 }}>
              <Field label="Nombre / Razón social">
                <input value={name} onChange={e => setName(e.target.value)} placeholder="Ej: Acme S.L." style={inputStyle} />
              </Field>
              <Field label="CIF / NIF">
                <input value={cif} onChange={e => setCif(e.target.value.toUpperCase())} placeholder="B12345678" style={{ ...inputStyle, fontFamily: "ui-monospace,monospace" }} />
              </Field>
            </div>
            <Field label="Dirección (opcional)">
              <input value={address} onChange={e => setAddress(e.target.value)} placeholder="Calle, nº, CP, ciudad" style={inputStyle} />
            </Field>
          </div>

          {/* Líneas */}
          <div style={sectionStyle}>
            <div style={{ ...sectionTitle, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <span>Líneas de factura</span>
              <button onClick={addLine} style={{ padding: "5px 10px", borderRadius: 6, background: "#27AE60", color: "#fff", border: "none", fontSize: 11, fontWeight: 600, cursor: "pointer", fontFamily: "inherit" }}>+ Línea</button>
            </div>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
              <thead>
                <tr>
                  <th style={{ ...lineTh, textAlign: "left" }}>Descripción</th>
                  <th style={{ ...lineTh, width: 70 }}>Cant.</th>
                  <th style={{ ...lineTh, width: 100, textAlign: "right" }}>Precio (€)</th>
                  <th style={{ ...lineTh, width: 80 }}>IVA</th>
                  <th style={{ ...lineTh, width: 90, textAlign: "right" }}>Subtotal</th>
                  <th style={{ ...lineTh, width: 36 }}></th>
                </tr>
              </thead>
              <tbody>
                {lines.map((l, i) => {
                  const sub = (Number(l.quantity)||0) * (Number(l.unitPrice)||0);
                  return (
                    <tr key={i} style={{ borderTop: "0.5px solid #F3F4F6" }}>
                      <td style={lineTd}>
                        <input value={l.description} onChange={e => updateLine(i, { description: e.target.value })} placeholder="Servicio / producto" style={{ ...inputStyle, padding: "6px 8px", fontSize: 12 }} />
                      </td>
                      <td style={lineTd}>
                        <input type="number" step="0.01" min="0" value={l.quantity} onChange={e => updateLine(i, { quantity: e.target.value })} style={{ ...inputStyle, padding: "6px 8px", fontSize: 12, textAlign: "right" }} />
                      </td>
                      <td style={lineTd}>
                        <input type="number" step="0.01" min="0" value={l.unitPrice} onChange={e => updateLine(i, { unitPrice: e.target.value })} style={{ ...inputStyle, padding: "6px 8px", fontSize: 12, textAlign: "right" }} />
                      </td>
                      <td style={lineTd}>
                        <select value={l.vatRate} onChange={e => updateLine(i, { vatRate: e.target.value })} style={{ ...inputStyle, padding: "6px 8px", fontSize: 12 }}>
                          {VAT_RATES.map(r => <option key={r} value={r}>{r}%</option>)}
                        </select>
                      </td>
                      <td style={{ ...lineTd, textAlign: "right", fontFamily: "ui-monospace,monospace", color: "#374151" }}>{fmtEur(sub)}</td>
                      <td style={lineTd}>
                        <button onClick={() => removeLine(i)} disabled={lines.length === 1} title="Eliminar línea" style={{ width: 26, height: 26, borderRadius: 6, border: "0.5px solid #FCA5A5", background: lines.length===1?"#F9FAFB":"#fff", color: lines.length===1?"#D1D5DB":"#B91C1C", fontSize: 13, cursor: lines.length===1?"not-allowed":"pointer" }}>×</button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* IRPF y resumen */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 2fr", gap: 12 }}>
            <Field label="Retención IRPF">
              <select value={irpfRate} onChange={e => setIrpfRate(e.target.value)} style={inputStyle}>
                {IRPF_RATES.map(r => <option key={r} value={r}>{r}%{r === 7 ? " · profesional inicio" : r === 15 ? " · profesional general" : r === 19 ? " · alquileres" : ""}</option>)}
              </select>
            </Field>
            <div style={{ background: "#F9FAFB", border: "0.5px solid #E5E7EB", borderRadius: 10, padding: "10px 14px", fontSize: 12.5, display: "flex", flexDirection: "column", gap: 3 }}>
              <SummaryRow label="Subtotal" value={fmtEur(totals.subtotal)} />
              {totals.vatByRate.length > 1 ? totals.vatByRate.map(([rate, v]) => (
                <SummaryRow key={rate} label={`IVA ${rate}% (sobre ${fmtEur(v.base)})`} value={fmtEur(v.vat)} muted />
              )) : (
                <SummaryRow label={`IVA total`} value={fmtEur(totals.vatAmount)} />
              )}
              {totals.irpfAmount > 0 && <SummaryRow label={`Retención IRPF (-${irpfRate}%)`} value={`-${fmtEur(totals.irpfAmount)}`} negative />}
              <div style={{ height: 1, background: "#E5E7EB", margin: "4px 0" }} />
              <SummaryRow label="TOTAL" value={fmtEur(totals.total)} bold />
            </div>
          </div>

          {/* Pago (solo edición) */}
          {!isNew && (
            <div style={sectionStyle}>
              <div style={sectionTitle}>Pago</div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10 }}>
                <Field label="Estado">
                  <select value={status} onChange={e => setStatus(e.target.value)} style={inputStyle}>
                    <option value="pendiente">🟡 Pendiente</option>
                    <option value="parcial">🔵 Parcial</option>
                    <option value="pagada">✅ Pagada</option>
                  </select>
                </Field>
                <Field label="Importe pagado">
                  <input type="number" step="0.01" min="0" value={paidAmount} onChange={e => setPaidAmount(e.target.value)} placeholder="0.00" style={inputStyle} />
                </Field>
                <Field label="Fecha pago">
                  <input type="date" value={paidDate} onChange={e => setPaidDate(e.target.value)} style={inputStyle} />
                </Field>
              </div>
              {bankCandidates.length > 0 && (
                <Field label={`Vincular movimiento bancario (${bankCandidates.length} candidato${bankCandidates.length!==1?"s":""} ±5% del total)`}>
                  <select value={bankMovementId} onChange={e => setBankMovementId(e.target.value)} style={inputStyle}>
                    <option value="">— Sin vincular —</option>
                    {bankCandidates.map(m => (
                      <option key={m.id} value={m.id}>
                        {fmtDate(m.date)} · {fmtEur(m.amount)} · {m.concept?.slice(0, 60) || "(sin concepto)"}
                      </option>
                    ))}
                  </select>
                </Field>
              )}
            </div>
          )}

          <Field label="Notas (opcional)">
            <textarea value={notes} onChange={e => setNotes(e.target.value)} rows={2} placeholder="Detalles, condiciones, etc." style={{ ...inputStyle, resize: "vertical", fontFamily: "inherit" }} />
          </Field>

          <div style={{ display: "flex", gap: 8, justifyContent: "space-between", marginTop: 6 }}>
            {onDelete && (
              <button onClick={onDelete} style={{ padding: "8px 14px", borderRadius: 8, background: "transparent", border: "1px solid #FCA5A5", color: "#B91C1C", fontSize: 12, fontWeight: 600, cursor: "pointer", fontFamily: "inherit" }}>Eliminar</button>
            )}
            <div style={{ display: "flex", gap: 8, marginLeft: "auto" }}>
              <button onClick={onClose} style={cancelBtn}>Cancelar</button>
              <button onClick={handleSave} disabled={!canSave} style={canSave ? primaryBtn("#27AE60") : disabledBtn}>{isNew ? "Crear factura" : "Guardar"}</button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function SummaryRow({ label, value, muted, bold, negative }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", fontSize: bold ? 14 : 12.5, fontWeight: bold ? 700 : 500, color: muted ? "#6B7280" : negative ? "#B91C1C" : "#111827" }}>
      <span>{label}</span>
      <span style={{ fontFamily: "ui-monospace,monospace" }}>{value}</span>
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
const modalStyle = { background: "#fff", borderRadius: 14, overflow: "hidden", maxHeight: "94vh", display: "flex", flexDirection: "column" };
const modalHeader = { padding: "14px 18px", borderBottom: "0.5px solid #E5E7EB", display: "flex", alignItems: "center", justifyContent: "space-between", flexShrink: 0 };
const modalBody = { padding: 18, display: "flex", flexDirection: "column", gap: 14, overflowY: "auto" };
const closeBtn = { background: "none", border: "none", fontSize: 20, cursor: "pointer", color: "#6B7280" };
const sectionStyle = { background: "#FAFAFA", border: "0.5px solid #E5E7EB", borderRadius: 10, padding: 12, display: "flex", flexDirection: "column", gap: 10 };
const sectionTitle = { fontSize: 11, fontWeight: 700, color: "#6B7280", textTransform: "uppercase", letterSpacing: "0.05em" };
const cancelBtn = { padding: "8px 14px", borderRadius: 8, background: "transparent", border: "1px solid #D1D5DB", fontSize: 12, fontWeight: 500, cursor: "pointer", fontFamily: "inherit" };
const disabledBtn = { padding: "8px 18px", borderRadius: 8, background: "#E5E7EB", color: "#9CA3AF", border: "none", fontSize: 12, fontWeight: 600, cursor: "default", fontFamily: "inherit" };
const primaryBtn = (color) => ({ padding: "8px 18px", borderRadius: 8, background: color, color: "#fff", border: "none", fontSize: 12, fontWeight: 600, cursor: "pointer", fontFamily: "inherit" });
const th = { padding: "10px 14px", textAlign: "center", fontSize: 11, fontWeight: 700, color: "#6B7280", textTransform: "uppercase", letterSpacing: "0.05em" };
const td = { padding: "10px 14px", textAlign: "center", color: "#111827" };
const lineTh = { padding: "6px 8px", fontSize: 10.5, fontWeight: 700, color: "#6B7280", textTransform: "uppercase", letterSpacing: "0.04em" };
const lineTd = { padding: "5px 4px", verticalAlign: "middle" };
const typeBtn = (active, color) => ({ flex: 1, padding: "8px 10px", borderRadius: 8, border: `1.5px solid ${active ? color : "#E5E7EB"}`, background: active ? `${color}15` : "#fff", color: active ? color : "#6B7280", fontSize: 12, fontWeight: 600, cursor: "pointer", fontFamily: "inherit" });
