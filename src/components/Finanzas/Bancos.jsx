// Bancos — gestión de cuentas bancarias y movimientos bancarios por
// empresa. Las cuentas se asocian a una empresa de governance.companies
// (no se duplica el listado). Los movimientos bancarios se importan de
// extractos (commit siguiente) o se crean manualmente.
//
// Filtro por empresa:
//   - "all" → todas las cuentas activas + movimientos
//   - "<id>" → solo las de esa empresa
import React, { useMemo, useState } from "react";

const fmtEur = (n) => typeof n === "number"
  ? new Intl.NumberFormat("es-ES", { style: "currency", currency: "EUR", maximumFractionDigits: 2 }).format(n)
  : "—";

export default function Bancos({ data, canEdit, selectedCompanyId, onAddBankAccount, onUpdateBankAccount, onDeleteBankAccount }) {
  const allAccounts = data.bankAccounts || [];
  const allMovements = data.bankMovements || [];
  const companies = data.governance?.companies || [];
  const [editing, setEditing] = useState(null); // null | "new" | account
  const [showInactive, setShowInactive] = useState(false);

  // Filtro por empresa. "all" muestra todas (activas + opcionalmente
  // inactivas). Empresa específica filtra cuentas Y movimientos.
  const accounts = useMemo(() => {
    let list = allAccounts;
    if (selectedCompanyId !== "all") list = list.filter(a => a.companyId === selectedCompanyId);
    if (!showInactive) list = list.filter(a => a.isActive !== false);
    return list;
  }, [allAccounts, selectedCompanyId, showInactive]);

  const movements = useMemo(() => {
    if (selectedCompanyId === "all") return allMovements;
    return allMovements.filter(m => m.companyId === selectedCompanyId);
  }, [allMovements, selectedCompanyId]);

  const totalBalance = accounts.filter(a => a.isActive !== false).reduce((s, a) => s + (Number(a.currentBalance) || 0), 0);

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
      {/* Resumen */}
      <div style={{ background: "#fff", border: "1px solid #E5E7EB", borderRadius: 12, padding: "14px 18px", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
        <div>
          <div style={{ fontSize: 11, fontWeight: 700, color: "#6B7280", textTransform: "uppercase", letterSpacing: "0.06em" }}>Saldo total {selectedCompanyId === "all" ? "todas las empresas" : "(empresa filtrada)"}</div>
          <div style={{ fontSize: 22, fontWeight: 700, color: totalBalance >= 0 ? "#0E7C5A" : "#B91C1C", marginTop: 4 }}>{fmtEur(totalBalance)}</div>
          <div style={{ fontSize: 11, color: "#9CA3AF", marginTop: 2 }}>{accounts.filter(a=>a.isActive!==false).length} cuenta{accounts.filter(a=>a.isActive!==false).length!==1?"s":""} activa{accounts.filter(a=>a.isActive!==false).length!==1?"s":""} · {movements.length} movimiento{movements.length!==1?"s":""}</div>
        </div>
        {canEdit && (
          <button onClick={() => setEditing("new")} style={{ padding: "8px 16px", borderRadius: 8, background: "#27AE60", color: "#fff", border: "none", fontSize: 13, fontWeight: 600, cursor: "pointer", fontFamily: "inherit" }}>+ Nueva cuenta</button>
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
                      <button onClick={() => setEditing(a)} title="Editar" style={iconBtn}>✏️</button>
                      <button onClick={() => { if (confirm(movsCount > 0 ? `Esta cuenta tiene ${movsCount} movimientos. Se desactivará en lugar de borrarse para conservar histórico.\n¿Continuar?` : "¿Eliminar esta cuenta?")) onDeleteBankAccount?.(a.id); }} title={movsCount > 0 ? "Desactivar (tiene movimientos)" : "Eliminar"} style={iconBtnDanger}>🗑️</button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Movimientos bancarios — placeholder mientras no hay importación */}
      <div style={{ background: "#fff", border: "1px solid #E5E7EB", borderRadius: 12, padding: 18 }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: "#111827", marginBottom: 8 }}>📥 Movimientos bancarios {movements.length > 0 ? `(${movements.length})` : ""}</div>
        {movements.length === 0 ? (
          <div style={{ fontSize: 12, color: "#9CA3AF", fontStyle: "italic", padding: "12px 0" }}>
            Aún no hay movimientos. Próximamente: importación de extractos bancarios (CSV / N26 / BBVA / La Caixa / Sabadell).
          </div>
        ) : (
          <div style={{ fontSize: 12, color: "#6B7280" }}>Lista de movimientos — UI completa en siguiente commit.</div>
        )}
      </div>

      {editing && (
        <BankAccountModal
          account={editing === "new" ? null : editing}
          companies={companies}
          defaultCompanyId={selectedCompanyId === "all" ? (companies[0]?.id || "") : selectedCompanyId}
          onClose={() => setEditing(null)}
          onSave={(payload) => {
            if (editing === "new") onAddBankAccount?.(payload);
            else onUpdateBankAccount?.(editing.id, payload);
            setEditing(null);
          }}
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
    <div onClick={(e) => e.target === e.currentTarget && onClose()} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)", zIndex: 3000, display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}>
      <div style={{ background: "#fff", borderRadius: 14, width: 480, maxWidth: "94vw", borderTop: "4px solid #27AE60", overflow: "hidden" }}>
        <div style={{ padding: "14px 18px", borderBottom: "0.5px solid #E5E7EB", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ fontSize: 14, fontWeight: 700 }}>{isNew ? "+ Nueva cuenta bancaria" : "Editar cuenta"}</div>
          <button onClick={onClose} style={{ background: "none", border: "none", fontSize: 20, cursor: "pointer", color: "#6B7280" }}>×</button>
        </div>
        <div style={{ padding: 18, display: "flex", flexDirection: "column", gap: 12 }}>
          <Field label="Empresa">
            <select value={companyId} onChange={e => setCompanyId(e.target.value)} style={fieldStyle}>
              <option value="">— Selecciona empresa —</option>
              {companies.map(c => <option key={c.id} value={c.id}>{c.type === "holding" ? "🏛️" : c.type === "patrimonial" ? "🏠" : "⚙️"} {c.name}{c.cif ? ` · ${c.cif}` : ""}</option>)}
            </select>
          </Field>
          <Field label="Banco">
            <input value={bankName} onChange={e => setBankName(e.target.value)} placeholder="Ej: BBVA, Santander, La Caixa…" style={fieldStyle} />
          </Field>
          <Field label="IBAN (opcional)">
            <input value={iban} onChange={e => setIban(e.target.value.toUpperCase())} placeholder="ES12 3456 7890 1234 5678 9012" style={{ ...fieldStyle, fontFamily: "ui-monospace,monospace" }} />
          </Field>
          <Field label="Alias (opcional)">
            <input value={alias} onChange={e => setAlias(e.target.value)} placeholder="Ej: Cuenta operativa, Cuenta nóminas…" style={fieldStyle} />
          </Field>
          <Field label="Saldo actual (€)">
            <input type="number" step="0.01" value={currentBalance} onChange={e => setCurrentBalance(e.target.value)} style={fieldStyle} />
          </Field>
          <label style={{ display: "inline-flex", alignItems: "center", gap: 8, fontSize: 13, cursor: "pointer" }}>
            <input type="checkbox" checked={isActive} onChange={e => setIsActive(e.target.checked)} style={{ accentColor: "#27AE60" }} />
            Cuenta activa (visible en selectores)
          </label>
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 6 }}>
            <button onClick={onClose} style={{ padding: "8px 14px", borderRadius: 8, background: "transparent", border: "1px solid #D1D5DB", fontSize: 12, fontWeight: 500, cursor: "pointer", fontFamily: "inherit" }}>Cancelar</button>
            <button onClick={handleSave} disabled={!canSave} style={{ padding: "8px 18px", borderRadius: 8, background: canSave ? "#27AE60" : "#E5E7EB", color: canSave ? "#fff" : "#9CA3AF", border: "none", fontSize: 12, fontWeight: 600, cursor: canSave ? "pointer" : "default", fontFamily: "inherit" }}>{isNew ? "Crear cuenta" : "Guardar"}</button>
          </div>
        </div>
      </div>
    </div>
  );
}

function formatIban(iban) {
  if (!iban) return "";
  return iban.replace(/(.{4})/g, "$1 ").trim();
}

const fieldStyle = { width: "100%", padding: "8px 10px", borderRadius: 8, border: "0.5px solid #D1D5DB", fontSize: 13, fontFamily: "inherit", outline: "none", boxSizing: "border-box" };
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
