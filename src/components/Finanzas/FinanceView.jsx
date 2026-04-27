// FinanceView — contenedor del módulo de Finanzas con 2 tabs internos.
// Las llamadas mutators (add/update/delete) son inyectadas por App.jsx;
// los flags de permisos (canEdit) se calculan también aguas arriba con
// hasPermission(member, "finance", "edit", data.permissions). El módulo
// no decide quién puede editar — solo respeta lo que recibe.
import React, { useState } from "react";
import FinanceDashboard from "./FinanceDashboard.jsx";
import Tesoreria from "./Tesoreria.jsx";

export default function FinanceView({ data, member, canEdit, onAddMovement, onUpdateMovement, onDeleteMovement }) {
  const [tab, setTab] = useState("dashboard");
  return (
    <div style={{ padding: "24px 22px", maxWidth: 1280, margin: "0 auto" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 18, flexWrap: "wrap", gap: 10 }}>
        <div>
          <div style={{ fontSize: 11, fontWeight: 700, color: "#27AE60", textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 4 }}>💰 Finanzas</div>
          <div style={{ fontSize: 22, fontWeight: 700, color: "#111827" }}>Gestión financiera</div>
          <div style={{ fontSize: 12, color: "#6B7280", marginTop: 2 }}>{(data.financeMovements || []).length} movimientos · {canEdit ? "Acceso completo" : "Solo lectura"}</div>
        </div>
      </div>
      <div style={{ display: "flex", gap: 4, marginBottom: 18, borderBottom: "1px solid #E5E7EB" }}>
        {[
          { key: "dashboard", label: "📊 Dashboard" },
          { key: "tesoreria", label: "💵 Tesorería" },
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
      {tab === "dashboard" && <FinanceDashboard data={data} />}
      {tab === "tesoreria" && (
        <Tesoreria
          data={data}
          canEdit={canEdit}
          onAddMovement={onAddMovement}
          onUpdateMovement={onUpdateMovement}
          onDeleteMovement={onDeleteMovement}
        />
      )}
    </div>
  );
}
