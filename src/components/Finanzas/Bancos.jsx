// Bancos — gestión de cuentas bancarias y movimientos bancarios por
// empresa. Las cuentas se asocian a una empresa de governance.companies.
// Los movimientos llegan vía import (commit siguiente) o se crean
// manualmente con el modal "+ Movimiento manual".
//
// Convenciones:
//   - amount > 0 → ingreso, amount < 0 → gasto.
//   - companyId se hereda de la cuenta (account.companyId).
//   - Movimientos sin categoría se marcan con ❓ y se categorizan en click.
//   - reconciled se marca a mano (commit siguiente añade auto-reconciliación).
import React, { useMemo, useState } from "react";
import ImportExtractoModal from "./ImportExtractoModal.jsx";
import ConciliacionModal from "./ConciliacionModal.jsx";

const fmtEur = (n) => typeof n === "number"
  ? new Intl.NumberFormat("es-ES", { style: "currency", currency: "EUR", maximumFractionDigits: 2 }).format(n)
  : "—";
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

export default function Bancos({ data, canEdit, selectedCompanyId, onAddBankAccount, onUpdateBankAccount, onDeleteBankAccount, onAddBankMovement, onUpdateBankMovement, onDeleteBankMovement, onAddBankMovementsBatch, onDeleteBankMovementsByBatch, onReconcileMatches }) {
  const allAccounts = data.bankAccounts || [];
  const allMovements = data.bankMovements || [];
  const allInvoices  = data.invoices || [];
  const companies = data.governance?.companies || [];
  const categories = data.movementCategories || [];

  const [editingAccount, setEditingAccount]   = useState(null); // null | "new" | account
  const [editingMovement, setEditingMovement] = useState(null); // null | "new" | movement
  const [showInactive, setShowInactive]       = useState(false);
  const [showImport, setShowImport]           = useState(false);
  const [showReconcile, setShowReconcile]     = useState(false);

  // Filtros movimientos
  const [filterAccountId, setFilterAccountId] = useState("all");
  const [filterMonth, setFilterMonth]         = useState("all");
  const [filterCategory, setFilterCategory]   = useState("all"); // all | uncategorized | <id>
  const [filterType, setFilterType]           = useState("all"); // all | income | expense
  const [filterReconciled, setFilterReconciled] = useState("all"); // all | unreconciled
  const [search, setSearch]                   = useState("");

  // Cuentas filtradas por empresa seleccionada y por activas/inactivas.
  const accounts = useMemo(() => {
    let list = allAccounts;
    if (selectedCompanyId !== "all") list = list.filter(a => a.companyId === selectedCompanyId);
    if (!showInactive) list = list.filter(a => a.isActive !== false);
    return list;
  }, [allAccounts, selectedCompanyId, showInactive]);

  // Movimientos filtrados por empresa (legacy companyId:null siempre se ven).
  const movementsByCompany = useMemo(() => {
    if (selectedCompanyId === "all") return allMovements;
    return allMovements.filter(m => !m.companyId || m.companyId === selectedCompanyId);
  }, [allMovements, selectedCompanyId]);

  // Aplicación del resto de filtros UI.
  const filteredMovs = useMemo(() => {
    return movementsByCompany.filter(m => {
      if (filterAccountId !== "all" && m.accountId !== filterAccountId) return false;
      if (filterMonth !== "all" && monthKey(m.date) !== filterMonth) return false;
      if (filterCategory === "uncategorized") { if (m.category) return false; }
      else if (filterCategory !== "all" && m.category !== filterCategory) return false;
      if (filterType !== "all") {
        const isIncome = (Number(m.amount)||0) >= 0;
        if (filterType === "income"  && !isIncome) return false;
        if (filterType === "expense" &&  isIncome) return false;
      }
      if (filterReconciled === "unreconciled" && m.reconciled) return false;
      if (search) {
        const q = search.toLowerCase();
        if (!(m.concept||"").toLowerCase().includes(q) && !(m.notes||"").toLowerCase().includes(q)) return false;
      }
      return true;
    }).sort((a, b) => (b.date||"").localeCompare(a.date||""));
  }, [movementsByCompany, filterAccountId, filterMonth, filterCategory, filterType, filterReconciled, search]);

  // Lista de meses disponibles (para el filtro mes).
  const availableMonths = useMemo(() => {
    const set = new Set();
    movementsByCompany.forEach(m => { const k = monthKey(m.date); if (k) set.add(k); });
    return Array.from(set).sort().reverse();
  }, [movementsByCompany]);

  // Stats del período filtrado.
  const stats = useMemo(() => {
    let income = 0, expense = 0, uncategorized = 0;
    for (const m of filteredMovs) {
      const amt = Number(m.amount) || 0;
      if (amt >= 0) income += amt; else expense += Math.abs(amt);
      if (!m.category) uncategorized++;
    }
    return { income, expense, net: income - expense, uncategorized, total: filteredMovs.length };
  }, [filteredMovs]);

  const totalBalance = accounts.filter(a => a.isActive !== false).reduce((s, a) => s + (Number(a.currentBalance) || 0), 0);

  // Facturas e invoices visibles según filtro de empresa, para conciliación
  // y descuadres. Una factura sin companyId se ve siempre (legacy).
  const invoicesByCompany = useMemo(() => {
    if (selectedCompanyId === "all") return allInvoices;
    return allInvoices.filter(i => !i.companyId || i.companyId === selectedCompanyId);
  }, [allInvoices, selectedCompanyId]);

  // Descuadres: movs sin reconciliar y facturas pendientes/parcial.
  // Estos contadores alimentan el chip de descuadre.
  const descuadres = useMemo(() => {
    const movsSinFactura = movementsByCompany.filter(m => !m.reconciled).length;
    const facturasSinCobro = invoicesByCompany.filter(i =>
      i.status !== "pagada" && !i.bankMovementId
    ).length;
    return { movsSinFactura, facturasSinCobro };
  }, [movementsByCompany, invoicesByCompany]);

  // Último lote importado (para botón "Deshacer última importación").
  // Buscamos el movimiento más reciente con importBatchId dentro de los
  // movimientos visibles según el filtro de empresa actual.
  const lastBatch = useMemo(() => {
    let latest = null;
    for (const m of movementsByCompany) {
      if (!m.importBatchId) continue;
      if (!latest || (m.createdAt||"") > (latest.createdAt||"")) latest = m;
    }
    if (!latest) return null;
    const count = movementsByCompany.filter(m => m.importBatchId === latest.importBatchId).length;
    return { batchId: latest.importBatchId, count, createdAt: latest.createdAt };
  }, [movementsByCompany]);

  if (companies.length === 0) {
    return (
      <div style={{ background: "#fff", border: "1px solid #E5E7EB", borderRadius: 12, padding: "40px 20px", textAlign: "center" }}>
        <div style={{ fontSize: 36, marginBottom: 12 }}>🏦</div>
        <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 6, color: "#111827" }}>Aún no hay empresas registradas</div>
        <div style={{ fontSize: 12, color: "#7F8C8D", maxWidth: 380, margin: "0 auto" }}>
          Para gestionar cuentas bancarias, primero registra una empresa en 🏛️ Gobernanza ▸ Dashboard. Después podrás añadir aquí las cuentas asociadas a cada empresa.
        </div>
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {/* Resumen cuentas */}
      <div style={{ background: "#fff", border: "1px solid #E5E7EB", borderRadius: 12, padding: "14px 18px", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
        <div>
          <div style={{ fontSize: 11, fontWeight: 700, color: "#6B7280", textTransform: "uppercase", letterSpacing: "0.06em" }}>Saldo total {selectedCompanyId === "all" ? "todas las empresas" : "(empresa filtrada)"}</div>
          <div style={{ fontSize: 22, fontWeight: 700, color: totalBalance >= 0 ? "#0E7C5A" : "#B91C1C", marginTop: 4 }}>{fmtEur(totalBalance)}</div>
          <div style={{ fontSize: 11, color: "#9CA3AF", marginTop: 2 }}>{accounts.filter(a=>a.isActive!==false).length} cuenta{accounts.filter(a=>a.isActive!==false).length!==1?"s":""} activa{accounts.filter(a=>a.isActive!==false).length!==1?"s":""} · {movementsByCompany.length} movimiento{movementsByCompany.length!==1?"s":""} totales</div>
        </div>
        {canEdit && (
          <button onClick={() => setEditingAccount("new")} style={{ padding: "8px 16px", borderRadius: 8, background: "#27AE60", color: "#fff", border: "none", fontSize: 13, fontWeight: 600, cursor: "pointer", fontFamily: "inherit" }}>+ Nueva cuenta</button>
        )}
      </div>

      {/* Lista de cuentas */}
      <div style={{ background: "#fff", border: "1px solid #E5E7EB", borderRadius: 12, overflow: "hidden" }}>
        <div style={{ padding: "12px 18px", background: "#FAFAFA", borderBottom: "0.5px solid #E5E7EB", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: "#111827" }}>Cuentas bancarias</div>
          <label style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 11, color: "#6B7280", cursor: "pointer" }}>
            <input type="checkbox" checked={showInactive} onChange={e => setShowInactive(e.target.checked)} style={{ accentColor: "#27AE60" }} />
            Mostrar inactivas
          </label>
        </div>
        {accounts.length === 0 ? (
          <div style={{ padding: "32px 18px", textAlign: "center", color: "#9CA3AF", fontSize: 13, fontStyle: "italic" }}>
            {selectedCompanyId === "all" ? "Aún no hay cuentas registradas." : "Esta empresa no tiene cuentas bancarias asignadas."}
          </div>
        ) : (
          <div>
            {accounts.map(a => {
              const company = companies.find(c => c.id === a.companyId);
              const movsCount = allMovements.filter(m => m.accountId === a.id).length;
              return (
                <div key={a.id} style={{ padding: "14px 18px", borderTop: "0.5px solid #F3F4F6", display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap", opacity: a.isActive === false ? 0.55 : 1 }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                      <span style={{ fontSize: 14, fontWeight: 700, color: "#111827" }}>🏦 {a.bankName || "(sin nombre de banco)"}</span>
                      {a.alias && <span style={{ fontSize: 12, color: "#6B7280" }}>· {a.alias}</span>}
                      {a.isActive === false && <span style={{ fontSize: 10, fontWeight: 700, padding: "2px 7px", borderRadius: 8, background: "#F3F4F6", color: "#6B7280", border: "0.5px solid #D1D5DB", textTransform: "uppercase", letterSpacing: "0.04em" }}>Inactiva</span>}
                    </div>
                    {a.iban && <div style={{ fontSize: 11.5, color: "#6B7280", fontFamily: "ui-monospace,monospace", marginTop: 3 }}>{formatIban(a.iban)}</div>}
                    <div style={{ fontSize: 11, color: "#9CA3AF", marginTop: 3 }}>
                      {company ? `${company.type === "holding" ? "🏛️" : company.type === "patrimonial" ? "🏠" : "⚙️"} ${company.name}` : "(empresa borrada)"}
                      {movsCount > 0 && <span> · {movsCount} movimiento{movsCount!==1?"s":""}</span>}
                    </div>
                  </div>
                  <div style={{ textAlign: "right" }}>
                    <div style={{ fontSize: 16, fontWeight: 700, color: (Number(a.currentBalance)||0) >= 0 ? "#0E7C5A" : "#B91C1C" }}>{fmtEur(Number(a.currentBalance)||0)}</div>
                    <div style={{ fontSize: 10, color: "#9CA3AF" }}>saldo actual</div>
                  </div>
                  {canEdit && (
                    <div style={{ display: "flex", gap: 4 }}>
                      <button onClick={() => setEditingAccount(a)} title="Editar" style={iconBtn}>✏️</button>
                      <button onClick={() => { if (confirm(movsCount > 0 ? `Esta cuenta tiene ${movsCount} movimientos. Se desactivará en lugar de borrarse para conservar histórico.\n¿Continuar?` : "¿Eliminar esta cuenta?")) onDeleteBankAccount?.(a.id); }} title={movsCount > 0 ? "Desactivar (tiene movimientos)" : "Eliminar"} style={iconBtnDanger}>🗑️</button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Resumen del período filtrado */}
      <div style={{ background: "#fff", border: "1px solid #E5E7EB", borderRadius: 12, padding: "14px 18px", display: "flex", gap: 24, flexWrap: "wrap", alignItems: "center" }}>
        <div>
          <div style={{ fontSize: 10, fontWeight: 700, color: "#6B7280", textTransform: "uppercase", letterSpacing: "0.05em" }}>Ingresos</div>
          <div style={{ fontSize: 16, fontWeight: 700, color: "#0E7C5A", marginTop: 2 }}>{fmtEur(stats.income)}</div>
        </div>
        <div>
          <div style={{ fontSize: 10, fontWeight: 700, color: "#6B7280", textTransform: "uppercase", letterSpacing: "0.05em" }}>Gastos</div>
          <div style={{ fontSize: 16, fontWeight: 700, color: "#B91C1C", marginTop: 2 }}>{fmtEur(stats.expense)}</div>
        </div>
        <div>
          <div style={{ fontSize: 10, fontWeight: 700, color: "#6B7280", textTransform: "uppercase", letterSpacing: "0.05em" }}>Saldo neto</div>
          <div style={{ fontSize: 16, fontWeight: 700, color: stats.net >= 0 ? "#0E7C5A" : "#B91C1C", marginTop: 2 }}>{fmtEur(stats.net)}</div>
        </div>
        {stats.uncategorized > 0 && (
          <button
            onClick={() => setFilterCategory("uncategorized")}
            title="Filtrar movimientos sin categorizar"
            style={{ marginLeft: "auto", padding: "6px 12px", borderRadius: 8, background: "#FEF3C7", border: "1px solid #FCD34D", color: "#92400E", fontSize: 12, fontWeight: 600, cursor: "pointer", fontFamily: "inherit" }}
          >❓ {stats.uncategorized} sin categorizar</button>
        )}
      </div>

      {/* Filtros */}
      <div style={{ background: "#fff", border: "1px solid #E5E7EB", borderRadius: 12, padding: "12px 16px", display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <select value={filterAccountId} onChange={e => setFilterAccountId(e.target.value)} style={{ ...inputStyle, minWidth: 160 }}>
          <option value="all">Todas las cuentas</option>
          {accounts.map(a => <option key={a.id} value={a.id}>🏦 {a.bankName}{a.alias ? ` · ${a.alias}` : ""}</option>)}
        </select>
        <select value={filterMonth} onChange={e => setFilterMonth(e.target.value)} style={inputStyle}>
          <option value="all">Todos los meses</option>
          {availableMonths.map(k => <option key={k} value={k}>{monthLabel(k)}</option>)}
        </select>
        <select value={filterCategory} onChange={e => setFilterCategory(e.target.value)} style={{ ...inputStyle, minWidth: 180 }}>
          <option value="all">Todas las categorías</option>
          <option value="uncategorized">❓ Sin categorizar</option>
          <optgroup label="Ingresos">
            {categories.filter(c => c.type === "income").map(c => <option key={c.id} value={c.id}>{c.name}{c.pgc ? ` (${c.pgc})` : ""}</option>)}
          </optgroup>
          <optgroup label="Gastos">
            {categories.filter(c => c.type === "expense").map(c => <option key={c.id} value={c.id}>{c.name}{c.pgc ? ` (${c.pgc})` : ""}</option>)}
          </optgroup>
          <optgroup label="Neutros">
            {categories.filter(c => c.type === "neutral").map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
          </optgroup>
        </select>
        <select value={filterType} onChange={e => setFilterType(e.target.value)} style={inputStyle}>
          <option value="all">Todos</option>
          <option value="income">Ingresos</option>
          <option value="expense">Gastos</option>
        </select>
        <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Buscar concepto…" style={{ ...inputStyle, flex: 1, minWidth: 160 }} />
        {canEdit && accounts.length > 0 && (
          <>
            <button onClick={() => setShowReconcile(true)} title="Conciliar automáticamente movimientos con facturas" style={{ padding: "8px 14px", borderRadius: 8, background: "#fff", color: "#1E40AF", border: "1px solid #93C5FD", fontSize: 12, fontWeight: 600, cursor: "pointer", fontFamily: "inherit", whiteSpace: "nowrap" }}>🔄 Conciliar automáticamente</button>
            <button onClick={() => setShowImport(true)} title="Importar extracto bancario (Excel/CSV)" style={{ padding: "8px 14px", borderRadius: 8, background: "#fff", color: "#0E7C5A", border: "1px solid #27AE60", fontSize: 12, fontWeight: 600, cursor: "pointer", fontFamily: "inherit", whiteSpace: "nowrap" }}>📤 Importar extracto</button>
            <button onClick={() => setEditingMovement("new")} style={{ padding: "8px 14px", borderRadius: 8, background: "#27AE60", color: "#fff", border: "none", fontSize: 12, fontWeight: 600, cursor: "pointer", fontFamily: "inherit", whiteSpace: "nowrap" }}>+ Movimiento manual</button>
          </>
        )}
      </div>

      {/* Chip de descuadres + filtro activo "sin conciliar" */}
      {(descuadres.movsSinFactura > 0 || descuadres.facturasSinCobro > 0 || filterReconciled !== "all") && (
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", fontSize: 11.5 }}>
          <button
            onClick={() => setFilterReconciled(filterReconciled === "unreconciled" ? "all" : "unreconciled")}
            title="Filtrar movimientos sin conciliar"
            style={{
              padding: "5px 10px",
              borderRadius: 999,
              background: filterReconciled === "unreconciled" ? "#DBEAFE" : "#F9FAFB",
              border: filterReconciled === "unreconciled" ? "1px solid #93C5FD" : "0.5px solid #E5E7EB",
              color: filterReconciled === "unreconciled" ? "#1E40AF" : "#6B7280",
              fontSize: 11.5,
              fontWeight: 600,
              cursor: "pointer",
              fontFamily: "inherit",
            }}
          >❌ {descuadres.movsSinFactura} mov{descuadres.movsSinFactura!==1?"s":""} sin conciliar</button>
          <span style={{ color: "#9CA3AF" }}>·</span>
          <span style={{ color: "#6B7280" }}>📄 {descuadres.facturasSinCobro} factura{descuadres.facturasSinCobro!==1?"s":""} sin cobro/pago</span>
          {filterReconciled === "unreconciled" && (
            <button onClick={() => setFilterReconciled("all")} style={{ marginLeft: 4, padding: "3px 8px", borderRadius: 6, background: "transparent", border: "0.5px solid #D1D5DB", color: "#6B7280", fontSize: 10.5, cursor: "pointer", fontFamily: "inherit" }}>Limpiar filtro</button>
          )}
        </div>
      )}

      {/* Tabla movimientos */}
      <div style={{ background: "#fff", border: "1px solid #E5E7EB", borderRadius: 12, overflow: "hidden" }}>
        <div style={{ padding: "10px 18px", background: "#FAFAFA", borderBottom: "0.5px solid #E5E7EB", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: "#374151" }}>📥 Movimientos {filteredMovs.length > 0 ? `(${filteredMovs.length})` : ""}</div>
          {canEdit && lastBatch && (
            <button
              onClick={() => {
                if (confirm(`¿Deshacer última importación?\n\nSe eliminarán ${lastBatch.count} movimiento${lastBatch.count!==1?"s":""} importado${lastBatch.count!==1?"s":""} en este lote. Esta acción no afecta al saldo de la cuenta.`)) {
                  onDeleteBankMovementsByBatch?.(lastBatch.batchId);
                }
              }}
              title={`Eliminar los ${lastBatch.count} movimientos del último lote importado`}
              style={{ padding: "5px 10px", borderRadius: 6, background: "transparent", color: "#92400E", border: "1px solid #FCD34D", fontSize: 11, fontWeight: 600, cursor: "pointer", fontFamily: "inherit" }}
            >↩ Deshacer última importación ({lastBatch.count})</button>
          )}
        </div>
        {filteredMovs.length === 0 ? (
          <div style={{ padding: "32px 18px", textAlign: "center", color: "#9CA3AF", fontSize: 13, fontStyle: "italic" }}>
            {movementsByCompany.length === 0
              ? "Aún no hay movimientos. Próximamente: importación de extractos bancarios. Mientras tanto, añade movimientos manualmente."
              : "Ningún movimiento coincide con los filtros."}
          </div>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5 }}>
              <thead>
                <tr style={{ background: "#FAFAFA", borderBottom: "0.5px solid #E5E7EB" }}>
                  <th style={th}>Fecha</th>
                  <th style={{ ...th, textAlign: "left" }}>Concepto</th>
                  <th style={{ ...th, textAlign: "right" }}>Importe</th>
                  <th style={{ ...th, textAlign: "right" }}>Saldo</th>
                  <th style={th}>Categoría</th>
                  <th style={th}>Conc.</th>
                </tr>
              </thead>
              <tbody>
                {filteredMovs.map(m => {
                  const cat = categories.find(c => c.id === m.category);
                  const amt = Number(m.amount) || 0;
                  const isIncome = amt >= 0;
                  const account = allAccounts.find(a => a.id === m.accountId);
                  return (
                    <tr
                      key={m.id}
                      onClick={() => canEdit && setEditingMovement(m)}
                      style={{
                        borderTop: "0.5px solid #F3F4F6",
                        cursor: canEdit ? "pointer" : "default",
                        background: !m.category ? "#FFFBEB" : "transparent",
                      }}
                    >
                      <td style={td}>{fmtDate(m.date)}</td>
                      <td style={{ ...td, textAlign: "left" }}>
                        <div style={{ fontWeight: 600, color: "#111827" }}>{m.concept || "(sin concepto)"}</div>
                        <div style={{ fontSize: 10.5, color: "#9CA3AF", marginTop: 2 }}>
                          {account ? `🏦 ${account.bankName}${account.alias?` · ${account.alias}`:""}` : "(cuenta borrada)"}
                          {m.notes && <span> · {m.notes.slice(0, 60)}{m.notes.length > 60 ? "…" : ""}</span>}
                        </div>
                      </td>
                      <td style={{ ...td, textAlign: "right", fontWeight: 700, color: isIncome ? "#0E7C5A" : "#B91C1C", fontFamily: "ui-monospace,monospace" }}>
                        {isIncome ? "+" : ""}{fmtEur(amt)}
                      </td>
                      <td style={{ ...td, textAlign: "right", color: "#6B7280", fontFamily: "ui-monospace,monospace", fontSize: 11.5 }}>
                        {typeof m.balance === "number" ? fmtEur(m.balance) : "—"}
                      </td>
                      <td style={td}>
                        {!m.category ? (
                          <span style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 10.5, fontWeight: 700, padding: "2px 8px", borderRadius: 10, background: "#FEF3C7", color: "#92400E", border: "0.5px solid #FCD34D" }}>❓ Sin categorizar</span>
                        ) : (
                          <span style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 10.5, fontWeight: 600, padding: "2px 8px", borderRadius: 10, background: "#F3F4F6", color: "#374151", border: "0.5px solid #E5E7EB" }}>
                            {cat?.name || m.category}{cat?.pgc ? ` · ${cat.pgc}` : ""}
                          </span>
                        )}
                      </td>
                      <td style={{ ...td, textAlign: "center", fontSize: 14 }}>{m.reconciled ? "✅" : "❌"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {showReconcile && (
        <ConciliacionModal
          movements={movementsByCompany}
          invoices={invoicesByCompany}
          onClose={() => setShowReconcile(false)}
          onApply={(matches) => onReconcileMatches?.(matches)}
        />
      )}

      {showImport && (
        <ImportExtractoModal
          accounts={accounts}
          existingMovements={allMovements}
          defaultAccountId={filterAccountId !== "all" ? filterAccountId : (accounts[0]?.id || "")}
          onClose={() => setShowImport(false)}
          onImport={(list, batchId) => {
            if (!list || list.length === 0) return;
            if (onAddBankMovementsBatch) {
              onAddBankMovementsBatch(list);
            } else {
              list.forEach(p => onAddBankMovement?.({ ...p, importBatchId: batchId }));
            }
          }}
        />
      )}

      {editingAccount && (
        <BankAccountModal
          account={editingAccount === "new" ? null : editingAccount}
          companies={companies}
          defaultCompanyId={selectedCompanyId === "all" ? (companies[0]?.id || "") : selectedCompanyId}
          onClose={() => setEditingAccount(null)}
          onSave={(payload) => {
            if (editingAccount === "new") onAddBankAccount?.(payload);
            else onUpdateBankAccount?.(editingAccount.id, payload);
            setEditingAccount(null);
          }}
        />
      )}

      {editingMovement && (
        <BankMovementModal
          movement={editingMovement === "new" ? null : editingMovement}
          accounts={accounts}
          categories={categories}
          defaultAccountId={filterAccountId !== "all" ? filterAccountId : (accounts[0]?.id || "")}
          onClose={() => setEditingMovement(null)}
          onSave={(payload) => {
            if (editingMovement === "new") onAddBankMovement?.(payload);
            else onUpdateBankMovement?.(editingMovement.id, payload);
            setEditingMovement(null);
          }}
          onDelete={editingMovement !== "new" ? () => {
            if (confirm("¿Eliminar este movimiento? Si era manual, el saldo de la cuenta se ajustará.")) {
              onDeleteBankMovement?.(editingMovement.id);
              setEditingMovement(null);
            }
          } : null}
        />
      )}
    </div>
  );
}

function BankAccountModal({ account, companies, defaultCompanyId, onClose, onSave }) {
  const isNew = !account;
  const [companyId, setCompanyId] = useState(account?.companyId || defaultCompanyId || "");
  const [bankName, setBankName] = useState(account?.bankName || "");
  const [iban, setIban]         = useState(account?.iban || "");
  const [alias, setAlias]       = useState(account?.alias || "");
  const [currentBalance, setCurrentBalance] = useState(account?.currentBalance ?? 0);
  const [isActive, setIsActive] = useState(account?.isActive !== false);
  const canSave = !!companyId && !!bankName.trim();
  const handleSave = () => canSave && onSave({ companyId, bankName: bankName.trim(), iban: iban.trim(), alias: alias.trim(), currentBalance: Number(currentBalance) || 0, isActive });
  return (
    <div onClick={(e) => e.target === e.currentTarget && onClose()} style={overlayStyle}>
      <div style={{ ...modalStyle, borderTop: "4px solid #27AE60" }}>
        <div style={modalHeader}>
          <div style={{ fontSize: 14, fontWeight: 700 }}>{isNew ? "+ Nueva cuenta bancaria" : "Editar cuenta"}</div>
          <button onClick={onClose} style={closeBtn}>×</button>
        </div>
        <div style={modalBody}>
          <Field label="Empresa">
            <select value={companyId} onChange={e => setCompanyId(e.target.value)} style={inputStyle}>
              <option value="">— Selecciona empresa —</option>
              {companies.map(c => <option key={c.id} value={c.id}>{c.type === "holding" ? "🏛️" : c.type === "patrimonial" ? "🏠" : "⚙️"} {c.name}{c.cif ? ` · ${c.cif}` : ""}</option>)}
            </select>
          </Field>
          <Field label="Banco">
            <input value={bankName} onChange={e => setBankName(e.target.value)} placeholder="Ej: BBVA, Santander, La Caixa…" style={inputStyle} />
          </Field>
          <Field label="IBAN (opcional)">
            <input value={iban} onChange={e => setIban(e.target.value.toUpperCase())} placeholder="ES12 3456 7890 1234 5678 9012" style={{ ...inputStyle, fontFamily: "ui-monospace,monospace" }} />
          </Field>
          <Field label="Alias (opcional)">
            <input value={alias} onChange={e => setAlias(e.target.value)} placeholder="Ej: Cuenta operativa, Cuenta nóminas…" style={inputStyle} />
          </Field>
          <Field label="Saldo actual (€)">
            <input type="number" step="0.01" value={currentBalance} onChange={e => setCurrentBalance(e.target.value)} style={inputStyle} />
          </Field>
          <label style={{ display: "inline-flex", alignItems: "center", gap: 8, fontSize: 13, cursor: "pointer" }}>
            <input type="checkbox" checked={isActive} onChange={e => setIsActive(e.target.checked)} style={{ accentColor: "#27AE60" }} />
            Cuenta activa (visible en selectores)
          </label>
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 6 }}>
            <button onClick={onClose} style={cancelBtn}>Cancelar</button>
            <button onClick={handleSave} disabled={!canSave} style={canSave ? primaryBtn("#27AE60") : disabledBtn}>{isNew ? "Crear cuenta" : "Guardar"}</button>
          </div>
        </div>
      </div>
    </div>
  );
}

function BankMovementModal({ movement, accounts, categories, defaultAccountId, onClose, onSave, onDelete }) {
  const isNew = !movement;
  const todayStr = new Date().toISOString().slice(0,10);
  const [accountId, setAccountId] = useState(movement?.accountId || defaultAccountId || "");
  const [date, setDate]           = useState(movement?.date || todayStr);
  const [concept, setConcept]     = useState(movement?.concept || "");
  // Para nuevo: signo lo decide el usuario via radios. Para editar: usamos el amount real.
  const [amount, setAmount]       = useState(movement ? String(Math.abs(Number(movement.amount)||0)) : "");
  const [direction, setDirection] = useState(movement ? ((Number(movement.amount)||0) >= 0 ? "income" : "expense") : "expense");
  const [category, setCategory]   = useState(movement?.category || "");
  const [notes, setNotes]         = useState(movement?.notes || "");
  const [reconciled, setReconciled] = useState(!!movement?.reconciled);
  const canSave = !!accountId && !!concept.trim() && Number(amount) > 0;
  const handleSave = () => {
    if (!canSave) return;
    const signedAmount = direction === "income" ? Math.abs(Number(amount)) : -Math.abs(Number(amount));
    onSave({ accountId, date, concept: concept.trim(), amount: signedAmount, category: category || null, notes: notes.trim(), reconciled });
  };
  return (
    <div onClick={(e) => e.target === e.currentTarget && onClose()} style={overlayStyle}>
      <div style={{ ...modalStyle, borderTop: "4px solid #27AE60", width: 520 }}>
        <div style={modalHeader}>
          <div style={{ fontSize: 14, fontWeight: 700 }}>{isNew ? "+ Movimiento bancario" : "Editar movimiento"}</div>
          <button onClick={onClose} style={closeBtn}>×</button>
        </div>
        <div style={modalBody}>
          <Field label="Cuenta">
            <select value={accountId} onChange={e => setAccountId(e.target.value)} style={inputStyle}>
              <option value="">— Selecciona cuenta —</option>
              {accounts.map(a => <option key={a.id} value={a.id}>🏦 {a.bankName}{a.alias?` · ${a.alias}`:""}</option>)}
            </select>
          </Field>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
            <Field label="Fecha">
              <input type="date" value={date} onChange={e => setDate(e.target.value)} style={inputStyle} />
            </Field>
            <Field label="Tipo">
              <div style={{ display: "flex", gap: 6 }}>
                <button onClick={() => setDirection("income")} style={{ flex: 1, padding: "8px 10px", borderRadius: 8, border: `1.5px solid ${direction==="income"?"#86EFAC":"#E5E7EB"}`, background: direction==="income"?"#F0FDF4":"#fff", color: direction==="income"?"#0E7C5A":"#6B7280", fontSize: 12, fontWeight: 600, cursor: "pointer", fontFamily: "inherit" }}>↗ Ingreso</button>
                <button onClick={() => setDirection("expense")} style={{ flex: 1, padding: "8px 10px", borderRadius: 8, border: `1.5px solid ${direction==="expense"?"#FCA5A5":"#E5E7EB"}`, background: direction==="expense"?"#FEF2F2":"#fff", color: direction==="expense"?"#B91C1C":"#6B7280", fontSize: 12, fontWeight: 600, cursor: "pointer", fontFamily: "inherit" }}>↙ Gasto</button>
              </div>
            </Field>
          </div>
          <Field label="Concepto">
            <input value={concept} onChange={e => setConcept(e.target.value)} placeholder="Ej: Transferencia cliente XYZ" style={inputStyle} />
          </Field>
          <Field label="Importe (€)">
            <input type="number" step="0.01" min="0" value={amount} onChange={e => setAmount(e.target.value)} placeholder="0.00" style={inputStyle} />
          </Field>
          <Field label="Categoría">
            <select value={category} onChange={e => setCategory(e.target.value)} style={inputStyle}>
              <option value="">— Sin categorizar —</option>
              <optgroup label="Ingresos">
                {categories.filter(c => c.type === "income").map(c => <option key={c.id} value={c.id}>{c.name}{c.pgc?` (${c.pgc})`:""}</option>)}
              </optgroup>
              <optgroup label="Gastos">
                {categories.filter(c => c.type === "expense").map(c => <option key={c.id} value={c.id}>{c.name}{c.pgc?` (${c.pgc})`:""}</option>)}
              </optgroup>
              <optgroup label="Neutros">
                {categories.filter(c => c.type === "neutral").map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
              </optgroup>
            </select>
          </Field>
          <Field label="Notas (opcional)">
            <textarea value={notes} onChange={e => setNotes(e.target.value)} rows={2} placeholder="Detalles, referencias…" style={{ ...inputStyle, resize: "vertical", fontFamily: "inherit" }} />
          </Field>
          <label style={{ display: "inline-flex", alignItems: "center", gap: 8, fontSize: 13, cursor: "pointer" }}>
            <input type="checkbox" checked={reconciled} onChange={e => setReconciled(e.target.checked)} style={{ accentColor: "#27AE60" }} />
            ✅ Marcar como conciliado
          </label>
          <div style={{ display: "flex", gap: 8, justifyContent: "space-between", marginTop: 6 }}>
            {onDelete && (
              <button onClick={onDelete} style={{ padding: "8px 14px", borderRadius: 8, background: "transparent", border: "1px solid #FCA5A5", color: "#B91C1C", fontSize: 12, fontWeight: 600, cursor: "pointer", fontFamily: "inherit" }}>Eliminar</button>
            )}
            <div style={{ display: "flex", gap: 8, marginLeft: "auto" }}>
              <button onClick={onClose} style={cancelBtn}>Cancelar</button>
              <button onClick={handleSave} disabled={!canSave} style={canSave ? primaryBtn("#27AE60") : disabledBtn}>{isNew ? "Crear" : "Guardar"}</button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function formatIban(iban) { if (!iban) return ""; return iban.replace(/(.{4})/g, "$1 ").trim(); }

const inputStyle = { padding: "8px 10px", borderRadius: 8, border: "0.5px solid #D1D5DB", fontSize: 13, fontFamily: "inherit", outline: "none", boxSizing: "border-box", background: "#fff" };
const overlayStyle = { position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)", zIndex: 3000, display: "flex", alignItems: "center", justifyContent: "center", padding: 20 };
const modalStyle = { background: "#fff", borderRadius: 14, width: 480, maxWidth: "94vw", overflow: "hidden", maxHeight: "92vh", display: "flex", flexDirection: "column" };
const modalHeader = { padding: "14px 18px", borderBottom: "0.5px solid #E5E7EB", display: "flex", alignItems: "center", justifyContent: "space-between" };
const modalBody = { padding: 18, display: "flex", flexDirection: "column", gap: 12, overflowY: "auto" };
const closeBtn = { background: "none", border: "none", fontSize: 20, cursor: "pointer", color: "#6B7280" };
const cancelBtn = { padding: "8px 14px", borderRadius: 8, background: "transparent", border: "1px solid #D1D5DB", fontSize: 12, fontWeight: 500, cursor: "pointer", fontFamily: "inherit" };
const disabledBtn = { padding: "8px 18px", borderRadius: 8, background: "#E5E7EB", color: "#9CA3AF", border: "none", fontSize: 12, fontWeight: 600, cursor: "default", fontFamily: "inherit" };
const primaryBtn = (color) => ({ padding: "8px 18px", borderRadius: 8, background: color, color: "#fff", border: "none", fontSize: 12, fontWeight: 600, cursor: "pointer", fontFamily: "inherit" });
const th = { padding: "10px 14px", textAlign: "center", fontSize: 11, fontWeight: 700, color: "#6B7280", textTransform: "uppercase", letterSpacing: "0.05em" };
const td = { padding: "10px 14px", textAlign: "center", color: "#111827" };
function Field({ label, children }) {
  return (
    <div>
      <div style={{ fontSize: 10, fontWeight: 600, color: "#6B7280", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 4 }}>{label}</div>
      {children}
    </div>
  );
}
const iconBtn = { width: 28, height: 28, borderRadius: 6, background: "#fff", border: "0.5px solid #E5E7EB", fontSize: 12, cursor: "pointer", fontFamily: "inherit" };
const iconBtnDanger = { ...iconBtn, color: "#B91C1C", borderColor: "#FCA5A5" };
