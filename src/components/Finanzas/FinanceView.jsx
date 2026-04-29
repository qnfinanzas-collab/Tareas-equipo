// FinanceView — contenedor del módulo de Finanzas con 5 tabs internas y
// selector de empresa multi-tenant. La fuente de verdad de las empresas
// es data.governance.companies (NO duplicamos el listado aquí).
//
// Selector de empresa:
//   - "all"  → "Todas las empresas" (consolidado, default)
//   - "<id>" → empresa concreta
// Persistido en localStorage("finanzas_selectedCompany"). Movimientos
// legacy (companyId === null) se muestran en TODOS los filtros porque no
// los podemos asignar automáticamente — el CEO los reasignará a mano.
import React, { useState, useEffect } from "react";
import FinanceDashboard from "./FinanceDashboard.jsx";
import Tesoreria from "./Tesoreria.jsx";
import Bancos from "./Bancos.jsx";
import Facturacion from "./Facturacion.jsx";
import Contabilidad from "./Contabilidad.jsx";
import Diego from "./Diego.jsx";

const SELECTED_COMPANY_KEY = "finanzas_selectedCompany";

export default function FinanceView({ data, member, canEdit, onAddMovement, onUpdateMovement, onDeleteMovement, onAddBankAccount, onUpdateBankAccount, onDeleteBankAccount, onAddBankMovement, onUpdateBankMovement, onDeleteBankMovement, onAddBankMovementsBatch, onDeleteBankMovementsByBatch, onAddInvoice, onUpdateInvoice, onDeleteInvoice, onReconcileMatches, onAddAccountingEntry, onUpdateAccountingEntry, onDeleteAccountingEntry, onAddCustomAccount, onCallAgent, onRunAgentActions, onToast }) {
  const [tab, setTab] = useState("dashboard");
  const companies = (data.governance?.companies) || [];

  // Selector de empresa con persistencia. Si la empresa guardada ya no
  // existe (borrada) volvemos a "all" para no quedar en estado inválido.
  const [selectedCompanyId, setSelectedCompanyId] = useState(() => {
    try {
      const saved = localStorage.getItem(SELECTED_COMPANY_KEY);
      return saved || "all";
    } catch { return "all"; }
  });
  useEffect(() => {
    if (selectedCompanyId !== "all" && !companies.some(c => c.id === selectedCompanyId)) {
      setSelectedCompanyId("all");
    }
  }, [companies, selectedCompanyId]);
  useEffect(() => {
    try { localStorage.setItem(SELECTED_COMPANY_KEY, selectedCompanyId); } catch {}
  }, [selectedCompanyId]);

  const selectedCompany = selectedCompanyId === "all" ? null : companies.find(c => c.id === selectedCompanyId);
  const movementsCount = (data.financeMovements || []).length;

  return (
    <div style={{ padding: "24px 22px", maxWidth: 1280, margin: "0 auto" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14, flexWrap: "wrap", gap: 10 }}>
        <div>
          <div style={{ fontSize: 11, fontWeight: 700, color: "#27AE60", textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 4 }}>💰 Finanzas</div>
          <div style={{ fontSize: 22, fontWeight: 700, color: "#111827" }}>Gestión financiera</div>
          <div style={{ fontSize: 12, color: "#6B7280", marginTop: 2 }}>{movementsCount} movimientos · {canEdit ? "Acceso completo" : "Solo lectura"}</div>
        </div>
      </div>

      {/* Selector de empresa: filtra todas las pestañas. Movimientos
          legacy (companyId:null) se mantienen visibles en todos los modos
          para que el CEO los pueda reasignar manualmente. */}
      <div style={{ marginBottom: 18, display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <span style={{ fontSize: 11, fontWeight: 700, color: "#6B7280", textTransform: "uppercase", letterSpacing: "0.06em" }}>Empresa:</span>
        <select
          value={selectedCompanyId}
          onChange={e => setSelectedCompanyId(e.target.value)}
          style={{ padding: "7px 12px", borderRadius: 8, border: "0.5px solid #D1D5DB", fontSize: 13, fontFamily: "inherit", background: "#fff", minWidth: 220, fontWeight: 600, color: selectedCompanyId === "all" ? "#1D9E75" : "#111827" }}
        >
          <option value="all">📊 Todas las empresas (consolidado)</option>
          {companies.length > 0 && (
            <optgroup label="Empresas registradas">
              {companies.map(c => (
                <option key={c.id} value={c.id}>{c.type === "holding" ? "🏛️" : c.type === "patrimonial" ? "🏠" : "⚙️"} {c.name}{c.cif ? ` · ${c.cif}` : ""}</option>
              ))}
            </optgroup>
          )}
        </select>
        {companies.length === 0 && (
          <span style={{ fontSize: 11, color: "#9CA3AF", fontStyle: "italic" }}>Aún no hay empresas. Añádelas en 🏛️ Gobernanza ▸ Dashboard.</span>
        )}
        {selectedCompany && (
          <span style={{ fontSize: 11, color: "#6B7280" }}>· filtrando por <b style={{ color: "#111827" }}>{selectedCompany.name}</b></span>
        )}
      </div>

      {/* Tabs */}
      <div style={{ display: "flex", gap: 4, marginBottom: 18, borderBottom: "1px solid #E5E7EB", flexWrap: "wrap" }}>
        {[
          { key: "dashboard",    label: "📊 Dashboard"    },
          { key: "tesoreria",    label: "💵 Tesorería"    },
          { key: "bancos",       label: "🏦 Bancos"       },
          { key: "facturacion",  label: "🧾 Facturación"  },
          { key: "contabilidad", label: "📒 Contabilidad" },
          { key: "diego",        label: "💬 Diego"        },
        ].map(t => {
          const active = tab === t.key;
          return (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              style={{
                padding: "9px 18px",
                background: active ? "#fff" : "transparent",
                border: "none",
                borderBottom: active ? "2px solid #27AE60" : "2px solid transparent",
                fontSize: 13,
                fontWeight: active ? 700 : 500,
                color: active ? "#0E7C5A" : "#6B7280",
                cursor: "pointer",
                fontFamily: "inherit",
              }}
            >{t.label}</button>
          );
        })}
      </div>
      {tab === "dashboard"   && <FinanceDashboard data={data} selectedCompanyId={selectedCompanyId} onNavigate={(target)=>setTab(target)} />}
      {tab === "tesoreria"   && (
        <Tesoreria
          data={data}
          canEdit={canEdit}
          selectedCompanyId={selectedCompanyId}
          onAddMovement={onAddMovement}
          onUpdateMovement={onUpdateMovement}
          onDeleteMovement={onDeleteMovement}
        />
      )}
      {tab === "bancos"      && (
        <Bancos
          data={data}
          canEdit={canEdit}
          selectedCompanyId={selectedCompanyId}
          onAddBankAccount={onAddBankAccount}
          onUpdateBankAccount={onUpdateBankAccount}
          onDeleteBankAccount={onDeleteBankAccount}
          onAddBankMovement={onAddBankMovement}
          onUpdateBankMovement={onUpdateBankMovement}
          onDeleteBankMovement={onDeleteBankMovement}
          onAddBankMovementsBatch={onAddBankMovementsBatch}
          onDeleteBankMovementsByBatch={onDeleteBankMovementsByBatch}
          onReconcileMatches={onReconcileMatches}
        />
      )}
      {tab === "facturacion" && (
        <Facturacion
          data={data}
          canEdit={canEdit}
          selectedCompanyId={selectedCompanyId}
          onAddInvoice={onAddInvoice}
          onUpdateInvoice={onUpdateInvoice}
          onDeleteInvoice={onDeleteInvoice}
          onToast={onToast}
        />
      )}
      {tab === "contabilidad" && (
        <Contabilidad
          data={data}
          canEdit={canEdit}
          selectedCompanyId={selectedCompanyId}
          onAddAccountingEntry={onAddAccountingEntry}
          onUpdateAccountingEntry={onUpdateAccountingEntry}
          onDeleteAccountingEntry={onDeleteAccountingEntry}
          onAddCustomAccount={onAddCustomAccount}
        />
      )}
      {tab === "diego"       && (
        <Diego
          data={data}
          currentMember={member}
          canEdit={canEdit}
          selectedCompanyId={selectedCompanyId}
          onCallAgent={onCallAgent}
          onRunAgentActions={onRunAgentActions}
        />
      )}
    </div>
  );
}
