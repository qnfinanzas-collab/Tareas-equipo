// GobernanzaView — sección dedicada de gobernanza empresarial. Tres tabs:
//   1) Dashboard societario: estructura del grupo + KPIs + alertas
//   2) Calendario fiscal: obligaciones mes a mes con estado por color
//   3) Chat con Gonzalo: conversación 1:1 con el agente especialista
// La vista se monta cuando activeTab === "gobernanza" y solo es visible
// para admin global o miembros con permission view en "gobernanza".
import React, { useState } from "react";

const TAB_DEFS = [
  { key: "dashboard", label: "🏛️ Dashboard" },
  { key: "calendar",  label: "📅 Calendario Fiscal" },
  { key: "chat",      label: "💬 Gonzalo" },
];

export default function GobernanzaView({ data, currentMember, onUpdateGovernance, onCallAgent }) {
  const [tab, setTab] = useState("dashboard");
  const governance = data?.governance || { companies: [], obligations: [], alerts: [] };

  return (
    <div style={{ padding: 20, maxWidth: 1100, margin: "0 auto" }}>
      <div style={{ marginBottom: 20 }}>
        <div style={{ fontSize: 20, fontWeight: 700, marginBottom: 4, color: "#111827", display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontSize: 24 }}>🏛️</span> Gobernanza Empresarial
        </div>
        <div style={{ fontSize: 13, color: "#6B7280" }}>
          Estructura societaria, calendario fiscal y consulta con Gonzalo, tu estratega de gobernanza.
        </div>
      </div>

      {/* Tabs */}
      <div style={{ display: "flex", gap: 6, marginBottom: 20, borderBottom: "0.5px solid #E5E7EB" }}>
        {TAB_DEFS.map(t => {
          const active = tab === t.key;
          return (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              style={{
                padding: "9px 16px",
                background: "transparent",
                border: "none",
                borderBottom: active ? "2px solid #8E44AD" : "2px solid transparent",
                fontSize: 13,
                fontWeight: active ? 700 : 500,
                color: active ? "#8E44AD" : "#6B7280",
                cursor: "pointer",
                fontFamily: "inherit",
              }}
            >{t.label}</button>
          );
        })}
      </div>

      {tab === "dashboard" && <GovDashboardTab governance={governance} onUpdateGovernance={onUpdateGovernance} />}
      {tab === "calendar"  && <GovCalendarTab  governance={governance} onUpdateGovernance={onUpdateGovernance} />}
      {tab === "chat"      && <GovChatTab      currentMember={currentMember} onCallAgent={onCallAgent} />}
    </div>
  );
}

// ── TAB 1: Dashboard societario (placeholder, contenido en siguiente commit) ──
function GovDashboardTab({ governance, onUpdateGovernance }) {
  return (
    <div style={{ background: "#fff", border: "1px solid #E5E7EB", borderRadius: 12, padding: 20 }}>
      <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 8 }}>Dashboard societario</div>
      <div style={{ fontSize: 12, color: "#9CA3AF" }}>Estructura del grupo y KPIs — disponible en breve.</div>
    </div>
  );
}

// ── TAB 2: Calendario fiscal (placeholder, contenido en siguiente commit) ──
function GovCalendarTab({ governance, onUpdateGovernance }) {
  return (
    <div style={{ background: "#fff", border: "1px solid #E5E7EB", borderRadius: 12, padding: 20 }}>
      <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 8 }}>Calendario fiscal</div>
      <div style={{ fontSize: 12, color: "#9CA3AF" }}>Obligaciones mes a mes — disponible en breve.</div>
    </div>
  );
}

// ── TAB 3: Chat con Gonzalo (placeholder, contenido en siguiente commit) ──
function GovChatTab({ currentMember, onCallAgent }) {
  return (
    <div style={{ background: "#fff", border: "1px solid #E5E7EB", borderRadius: 12, padding: 20 }}>
      <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 8 }}>💬 Gonzalo Gobernanza</div>
      <div style={{ fontSize: 12, color: "#9CA3AF" }}>Chat 1:1 con Gonzalo — disponible en breve.</div>
    </div>
  );
}
