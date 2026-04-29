// Tesorería — CRUD de movimientos financieros con filtros y modal de
// edición. Categorías predefinidas según PGC español. Acciones write
// (crear/editar/eliminar) gated por la prop canEdit (proviene de
// hasPermission(member,"finance","edit")). Persistencia vía data en App
// (mismo flujo localStorage → sync.js → Supabase taskflow_state).
import React, { useMemo, useState } from "react";

const FINANCE_CATEGORIES = {
  income: [
    "Ventas / Servicios",
    "Inversión / Capital",
    "Financiación / Préstamos",
    "Devoluciones impuestos",
    "Otros ingresos",
  ],
  expense: [
    "Nóminas y SS",
    "Alquileres",
    "Proveedores",
    "Servicios profesionales",
    "Impuestos (IVA/IS/IRPF)",
    "Marketing",
    "Suministros",
    "Seguros",
    "Servicios bancarios",
    "Inversión en activos",
    "Devolución préstamos",
    "Otros gastos",
  ],
};

const PAYMENT_METHODS = [
  { key: "transfer", label: "Transferencia" },
  { key: "cash",     label: "Efectivo" },
  { key: "card",     label: "Tarjeta" },
  { key: "other",    label: "Otro" },
];

const formatEuros = (amount) => new Intl.NumberFormat("es-ES", { style: "currency", currency: "EUR" }).format(amount || 0);
const formatDate = (date) => new Date(date).toLocaleDateString("es-ES", { day: "numeric", month: "short", year: "numeric" });

export default function Tesoreria({ data, canEdit, selectedCompanyId = "all", onAddMovement, onUpdateMovement, onDeleteMovement }) {
  // Filtro por empresa antes de aplicar el resto de filtros UI. Legacy
  // (companyId:null) siempre visible para que el CEO los reasigne.
  const allMovements = data?.financeMovements || [];
  const movements = selectedCompanyId === "all"
    ? allMovements
    : allMovements.filter(m => !m.companyId || m.companyId === selectedCompanyId);
  const projects = data?.projects || [];

  const [filterType, setFilterType] = useState("all"); // all | income | expense
  const [filterPeriod, setFilterPeriod] = useState("month"); // month | quarter | year | all
  const [filterCategory, setFilterCategory] = useState("");
  const [filterProject, setFilterProject] = useState("");
  const [search, setSearch] = useState("");
  const [expandedId, setExpandedId] = useState(null);
  const [pendingDel, setPendingDel] = useState(null);
  const [modal, setModal] = useState(null); // {type:"new"|"edit", initial?:movement, kind?:"income"|"expense"}

  // Filtros
  const filtered = useMemo(() => {
    const now = new Date();
    return movements.filter(m => {
      if (filterType !== "all" && m.type !== filterType) return false;
      if (filterCategory && m.category !== filterCategory) return false;
      if (filterProject && String(m.projectId) !== String(filterProject)) return false;
      if (search.trim()) {
        const q = search.trim().toLowerCase();
        const hay = ((m.concept || "") + " " + (m.notes || "") + " " + (m.category || "")).toLowerCase();
        if (!hay.includes(q)) return false;
      }
      const d = new Date(m.date);
      if (filterPeriod === "month") {
        if (d.getFullYear() !== now.getFullYear() || d.getMonth() !== now.getMonth()) return false;
      } else if (filterPeriod === "quarter") {
        const qNow = Math.floor(now.getMonth() / 3);
        const qD = Math.floor(d.getMonth() / 3);
        if (d.getFullYear() !== now.getFullYear() || qNow !== qD) return false;
      } else if (filterPeriod === "year") {
        if (d.getFullYear() !== now.getFullYear()) return false;
      }
      return true;
    }).sort((a, b) => new Date(b.date) - new Date(a.date));
  }, [movements, filterType, filterPeriod, filterCategory, filterProject, search]);

  const totalNeto = filtered.reduce((acc, m) => acc + (m.type === "income" ? Number(m.amount || 0) : -Number(m.amount || 0)), 0);

  return (
    <div>
      {/* Acciones principales */}
      <div style={{ display: "flex", gap: 8, marginBottom: 14, flexWrap: "wrap" }}>
        {canEdit && (
          <>
            <button onClick={() => setModal({ type: "new", kind: "income" })} style={{ padding: "9px 14px", borderRadius: 8, background: "#27AE60", color: "#fff", border: "none", fontSize: 13, fontWeight: 600, cursor: "pointer", fontFamily: "inherit" }}>+ Entrada</button>
            <button onClick={() => setModal({ type: "new", kind: "expense" })} style={{ padding: "9px 14px", borderRadius: 8, background: "#E74C3C", color: "#fff", border: "none", fontSize: 13, fontWeight: 600, cursor: "pointer", fontFamily: "inherit" }}>− Salida</button>
          </>
        )}
        <input
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="🔍 Buscar concepto, nota o categoría…"
          style={{ flex: 1, minWidth: 200, padding: "9px 12px", borderRadius: 8, border: "1px solid #D1D5DB", fontSize: 13, fontFamily: "inherit", outline: "none" }}
        />
      </div>

      {/* Filtros */}
      <div style={{ background: "#fff", border: "1px solid #E5E7EB", borderRadius: 10, padding: "10px 14px", marginBottom: 12, display: "flex", flexWrap: "wrap", gap: 14, alignItems: "center", fontSize: 12 }}>
        <FilterRow label="Tipo">
          {[["all", "Todo"], ["income", "Entradas"], ["expense", "Salidas"]].map(([k, l]) => (
            <Chip key={k} active={filterType === k} onClick={() => setFilterType(k)}>{l}</Chip>
          ))}
        </FilterRow>
        <FilterRow label="Periodo">
          {[["month", "Este mes"], ["quarter", "Trim."], ["year", "Año"], ["all", "Todo"]].map(([k, l]) => (
            <Chip key={k} active={filterPeriod === k} onClick={() => setFilterPeriod(k)}>{l}</Chip>
          ))}
        </FilterRow>
        <select value={filterCategory} onChange={e => setFilterCategory(e.target.value)} style={{ padding: "5px 9px", borderRadius: 6, border: "1px solid #D1D5DB", fontSize: 12, fontFamily: "inherit", background: "#fff" }}>
          <option value="">Todas las categorías</option>
          {[...FINANCE_CATEGORIES.income, ...FINANCE_CATEGORIES.expense].map(c => <option key={c} value={c}>{c}</option>)}
        </select>
        <select value={filterProject} onChange={e => setFilterProject(e.target.value)} style={{ padding: "5px 9px", borderRadius: 6, border: "1px solid #D1D5DB", fontSize: 12, fontFamily: "inherit", background: "#fff" }}>
          <option value="">Todos los proyectos</option>
          {projects.map(p => <option key={p.id} value={p.id}>{p.emoji || "📋"} {p.name}</option>)}
        </select>
      </div>

      {/* Total */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10, fontSize: 12, color: "#6B7280" }}>
        <span>{filtered.length} movimiento{filtered.length !== 1 ? "s" : ""}</span>
        <span style={{ fontSize: 14, fontWeight: 700, color: totalNeto >= 0 ? "#27AE60" : "#E74C3C" }}>Neto: {totalNeto >= 0 ? "+" : "−"} {formatEuros(Math.abs(totalNeto))}</span>
      </div>

      {/* Lista */}
      {filtered.length === 0 ? (
        <div style={{ background: "#F8F9FA", border: "1px dashed #D1D5DB", borderRadius: 10, padding: "30px 20px", textAlign: "center", color: "#9CA3AF", fontSize: 13, fontStyle: "italic" }}>
          {movements.length === 0 ? "Sin movimientos. Empieza añadiendo el primero." : "Ningún movimiento cumple los filtros aplicados."}
        </div>
      ) : (
        <div style={{ background: "#fff", border: "1px solid #E5E7EB", borderRadius: 10, overflow: "hidden" }}>
          {filtered.map(m => {
            const isExpanded = expandedId === m.id;
            const proj = projects.find(p => String(p.id) === String(m.projectId));
            const isIncome = m.type === "income";
            const arrowColor = isIncome ? "#27AE60" : "#E74C3C";
            const statusIcon = m.status === "paid" ? "✓" : "⏳";
            const isPending = pendingDel === m.id;
            return (
              <div key={m.id} style={{ borderBottom: "0.5px solid #F3F4F6" }}>
                <div onClick={() => setExpandedId(isExpanded ? null : m.id)} style={{ padding: "12px 14px", display: "flex", alignItems: "center", gap: 12, cursor: "pointer" }}>
                  <span style={{ fontSize: 18, color: arrowColor, fontWeight: 700, flexShrink: 0 }}>{isIncome ? "↑" : "↓"}</span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 600, color: "#111827", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{m.concept}</div>
                    <div style={{ fontSize: 11, color: "#6B7280", marginTop: 2, display: "flex", gap: 8, flexWrap: "wrap" }}>
                      <span>{formatDate(m.date)}</span>
                      <span>· {m.category}</span>
                      {proj && <span>· {proj.emoji || "📋"} {proj.name}</span>}
                      <span title={m.status === "paid" ? "Pagado/Cobrado" : "Pendiente"}>· {statusIcon} {m.status === "paid" ? "Pagado" : "Pendiente"}</span>
                    </div>
                  </div>
                  <div style={{ fontSize: 14, fontWeight: 700, color: arrowColor, flexShrink: 0, fontFamily: "ui-monospace,monospace" }}>{isIncome ? "+" : "−"} {formatEuros(m.amount)}</div>
                </div>
                {isExpanded && (
                  <div style={{ padding: "0 14px 12px 44px", display: "flex", flexDirection: "column", gap: 8, background: "#FAFAFA" }}>
                    {m.notes && <div style={{ fontSize: 12, color: "#374151", fontStyle: "italic", paddingTop: 6 }}>{m.notes}</div>}
                    <div style={{ fontSize: 11, color: "#6B7280" }}>Pago: {(PAYMENT_METHODS.find(p => p.key === m.paymentMethod) || PAYMENT_METHODS[0]).label}</div>
                    {canEdit && (
                      isPending ? (
                        <div style={{ display: "flex", gap: 6, alignItems: "center", marginTop: 4 }}>
                          <span style={{ fontSize: 12, color: "#A32D2D" }}>¿Eliminar definitivamente?</span>
                          <button onClick={() => { onDeleteMovement?.(m.id); setPendingDel(null); }} style={{ padding: "5px 10px", borderRadius: 6, background: "#E24B4A", color: "#fff", border: "none", fontSize: 11, fontWeight: 600, cursor: "pointer", fontFamily: "inherit" }}>Sí, eliminar</button>
                          <button onClick={() => setPendingDel(null)} style={{ padding: "5px 10px", borderRadius: 6, background: "transparent", color: "#6B7280", border: "1px solid #D1D5DB", fontSize: 11, cursor: "pointer", fontFamily: "inherit" }}>Cancelar</button>
                        </div>
                      ) : (
                        <div style={{ display: "flex", gap: 6, marginTop: 4 }}>
                          <button onClick={(e) => { e.stopPropagation(); setModal({ type: "edit", initial: m }); }} style={{ padding: "5px 12px", borderRadius: 6, background: "#fff", color: "#3498DB", border: "1px solid #BFDBFE", fontSize: 11.5, fontWeight: 600, cursor: "pointer", fontFamily: "inherit" }}>Editar</button>
                          <button onClick={(e) => { e.stopPropagation(); setPendingDel(m.id); }} style={{ padding: "5px 12px", borderRadius: 6, background: "#fff", color: "#A32D2D", border: "1px solid #FCA5A5", fontSize: 11.5, fontWeight: 600, cursor: "pointer", fontFamily: "inherit" }}>Eliminar</button>
                        </div>
                      )
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {modal && (
        <MovementModal
          mode={modal.type}
          initial={modal.initial}
          kind={modal.initial?.type || modal.kind}
          projects={projects}
          onClose={() => setModal(null)}
          onSave={(payload) => {
            if (modal.type === "new") onAddMovement?.(payload);
            else onUpdateMovement?.(modal.initial.id, payload);
            setModal(null);
          }}
        />
      )}
    </div>
  );
}

function FilterRow({ label, children }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
      <span style={{ fontSize: 10.5, fontWeight: 700, color: "#6B7280", textTransform: "uppercase", letterSpacing: "0.06em" }}>{label}</span>
      {children}
    </div>
  );
}

function Chip({ active, onClick, children }) {
  return (
    <button onClick={onClick} style={{ padding: "3px 9px", borderRadius: 14, border: `1px solid ${active ? "#27AE60" : "#D1D5DB"}`, background: active ? "#DCFCE7" : "#fff", color: active ? "#065F46" : "#6B7280", fontSize: 11, fontWeight: 600, cursor: "pointer", fontFamily: "inherit" }}>{children}</button>
  );
}

function MovementModal({ mode, initial, kind, projects, onClose, onSave }) {
  const [form, setForm] = useState({
    type: initial?.type || kind || "expense",
    concept: initial?.concept || "",
    amount: initial?.amount || "",
    date: initial?.date || new Date().toISOString().slice(0, 10),
    category: initial?.category || (FINANCE_CATEGORIES[initial?.type || kind || "expense"] || [])[0] || "",
    projectId: initial?.projectId || "",
    paymentMethod: initial?.paymentMethod || "transfer",
    status: initial?.status || "paid",
    notes: initial?.notes || "",
  });
  const [error, setError] = useState("");
  const set = (k, v) => setForm(p => ({ ...p, [k]: v }));

  const handleSave = () => {
    if (!form.concept.trim()) { setError("El concepto es obligatorio."); return; }
    const amt = Number(form.amount);
    if (!Number.isFinite(amt) || amt <= 0) { setError("Importe debe ser mayor que 0."); return; }
    if (!form.date) { setError("La fecha es obligatoria."); return; }
    onSave({ ...form, amount: amt, projectId: form.projectId || null });
  };

  const isIncome = form.type === "income";
  const accent = isIncome ? "#27AE60" : "#E74C3C";
  const cats = FINANCE_CATEGORIES[form.type] || [];

  return (
    <div onClick={(e) => e.target === e.currentTarget && onClose()} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)", zIndex: 4000, display: "flex", alignItems: "flex-start", justifyContent: "center", paddingTop: 60, padding: 20, overflowY: "auto" }}>
      <div style={{ background: "#fff", borderRadius: 14, width: 540, maxWidth: "96vw", borderTop: `4px solid ${accent}`, overflow: "hidden" }}>
        <div style={{ padding: "14px 20px", borderBottom: "0.5px solid #E5E7EB", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ fontSize: 15, fontWeight: 700, color: accent }}>{mode === "edit" ? "Editar movimiento" : (isIncome ? "+ Nueva entrada" : "− Nueva salida")}</div>
          <button onClick={onClose} style={{ background: "none", border: "none", fontSize: 22, cursor: "pointer", color: "#9CA3AF" }}>×</button>
        </div>
        <div style={{ padding: 20, display: "flex", flexDirection: "column", gap: 12 }}>
          {/* Toggle tipo si es nuevo */}
          {mode !== "edit" && (
            <div style={{ display: "flex", gap: 6 }}>
              {["expense", "income"].map(t => (
                <button key={t} onClick={() => { set("type", t); set("category", FINANCE_CATEGORIES[t][0] || ""); }} style={{ flex: 1, padding: "8px 12px", borderRadius: 8, border: `1.5px solid ${form.type === t ? (t === "income" ? "#27AE60" : "#E74C3C") : "#E5E7EB"}`, background: form.type === t ? (t === "income" ? "#DCFCE7" : "#FEE2E2") : "#fff", color: form.type === t ? (t === "income" ? "#065F46" : "#991B1B") : "#6B7280", fontSize: 13, fontWeight: 600, cursor: "pointer", fontFamily: "inherit" }}>{t === "income" ? "↑ Entrada" : "↓ Salida"}</button>
              ))}
            </div>
          )}

          <Field label="Concepto *">
            <input value={form.concept} onChange={e => set("concept", e.target.value)} placeholder="Ej. Pago nómina abril" style={inputStyle} />
          </Field>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
            <Field label="Importe (€) *">
              <input type="number" min="0" step="0.01" value={form.amount} onChange={e => set("amount", e.target.value)} placeholder="0.00" style={inputStyle} />
            </Field>
            <Field label="Fecha *">
              <input type="date" value={form.date} onChange={e => set("date", e.target.value)} style={inputStyle} />
            </Field>
          </div>

          <Field label="Categoría">
            <select value={form.category} onChange={e => set("category", e.target.value)} style={inputStyle}>
              {cats.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
          </Field>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
            <Field label="Proyecto (opcional)">
              <select value={form.projectId} onChange={e => set("projectId", e.target.value)} style={inputStyle}>
                <option value="">— Sin proyecto —</option>
                {projects.map(p => <option key={p.id} value={p.id}>{p.emoji || "📋"} {p.name}</option>)}
              </select>
            </Field>
            <Field label="Método de pago">
              <select value={form.paymentMethod} onChange={e => set("paymentMethod", e.target.value)} style={inputStyle}>
                {PAYMENT_METHODS.map(p => <option key={p.key} value={p.key}>{p.label}</option>)}
              </select>
            </Field>
          </div>

          <Field label="Estado">
            <div style={{ display: "flex", gap: 6 }}>
              {[["paid", isIncome ? "✓ Cobrado" : "✓ Pagado"], ["pending", "⏳ Pendiente"]].map(([k, l]) => (
                <button key={k} onClick={() => set("status", k)} style={{ flex: 1, padding: "7px 10px", borderRadius: 8, border: `1px solid ${form.status === k ? accent : "#D1D5DB"}`, background: form.status === k ? `${accent}18` : "#fff", color: form.status === k ? accent : "#6B7280", fontSize: 12, fontWeight: 600, cursor: "pointer", fontFamily: "inherit" }}>{l}</button>
              ))}
            </div>
          </Field>

          <Field label="Notas (opcional)">
            <textarea value={form.notes} onChange={e => set("notes", e.target.value)} rows={2} placeholder="Detalles, referencia, factura…" style={{ ...inputStyle, resize: "vertical", fontFamily: "inherit" }} />
          </Field>

          {error && <div style={{ fontSize: 12, color: "#A32D2D", padding: "6px 10px", background: "#FCEBEB", border: "1px solid #FCA5A5", borderRadius: 6 }}>{error}</div>}
        </div>
        <div style={{ padding: "12px 20px", borderTop: "0.5px solid #E5E7EB", background: "#FAFAFA", display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button onClick={onClose} style={{ padding: "8px 16px", borderRadius: 8, background: "transparent", color: "#6B7280", border: "1px solid #D1D5DB", fontSize: 13, cursor: "pointer", fontFamily: "inherit" }}>Cancelar</button>
          <button onClick={handleSave} style={{ padding: "8px 18px", borderRadius: 8, background: accent, color: "#fff", border: "none", fontSize: 13, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>{mode === "edit" ? "Guardar cambios" : "Crear movimiento"}</button>
        </div>
      </div>
    </div>
  );
}

const inputStyle = { width: "100%", padding: "8px 10px", borderRadius: 8, border: "1px solid #D1D5DB", fontSize: 13, outline: "none", fontFamily: "inherit", background: "#fff", boxSizing: "border-box" };

function Field({ label, children }) {
  return (
    <div>
      <div style={{ fontSize: 10.5, fontWeight: 700, color: "#6B7280", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 4 }}>{label}</div>
      {children}
    </div>
  );
}
