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

// ── TAB 1: Dashboard societario ──
// Tres bloques: estructura del grupo (diagrama tipo árbol con holding +
// filiales), KPIs de gobernanza (tax rate, compliance, fondos propios) y
// alertas activas (vencimientos próximos, documentación pendiente).
const COMPANY_TYPE_META = {
  holding:    { label: "Holding",     icon: "🏛️", bg: "#F5EEFA", border: "#B07DD8", color: "#6B21A8" },
  operativa:  { label: "Operativa",   icon: "⚙️", bg: "#EFF6FF", border: "#93C5FD", color: "#1E40AF" },
  patrimonial:{ label: "Patrimonial", icon: "🏠", bg: "#FFF7ED", border: "#FDBA74", color: "#9A3412" },
  spv:        { label: "SPV",         icon: "📦", bg: "#F0FDF4", border: "#86EFAC", color: "#065F46" },
};

function GovDashboardTab({ governance, onUpdateGovernance }) {
  const [editingCompany, setEditingCompany] = useState(null);
  const [adding, setAdding] = useState(false);
  const companies = governance.companies || [];
  const holdings = companies.filter(c => c.type === "holding");
  const subs = companies.filter(c => c.type !== "holding");

  // KPIs heurísticos. Si no hay datos, mostramos placeholders explícitos.
  const taxRate = governance.kpis?.taxRate ?? null;
  const compliance = governance.alerts ? Math.max(0, 100 - governance.alerts.filter(a => a.level === "critical").length * 15) : 95;
  const fondosPropios = governance.kpis?.fondosPropios ?? null;
  const patrimonioNeto = governance.kpis?.patrimonioNeto ?? null;

  const alerts = governance.alerts || [];

  const onSaveCompany = (company) => {
    const list = companies.slice();
    if (editingCompany && editingCompany.id) {
      const idx = list.findIndex(c => c.id === editingCompany.id);
      if (idx >= 0) list[idx] = { ...list[idx], ...company };
    } else {
      const id = `co_${Date.now()}_${Math.random().toString(36).slice(2,6)}`;
      list.push({ id, participation: 100, ...company });
    }
    onUpdateGovernance?.({ companies: list });
    setEditingCompany(null);
    setAdding(false);
  };
  const onDeleteCompany = (id) => {
    onUpdateGovernance?.({ companies: companies.filter(c => c.id !== id) });
    setEditingCompany(null);
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {/* Estructura del grupo */}
      <div style={{ background: "#fff", border: "1px solid #E5E7EB", borderRadius: 12, padding: 20 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: "#111827" }}>📊 Estructura del Grupo</div>
          <button onClick={() => { setAdding(true); setEditingCompany({ name: "", type: "operativa", parentId: holdings[0]?.id || null, cif: "", participation: 100 }); }} style={{ padding: "6px 12px", borderRadius: 8, background: "#8E44AD", color: "#fff", border: "none", fontSize: 12, fontWeight: 600, cursor: "pointer", fontFamily: "inherit" }}>+ Añadir empresa</button>
        </div>
        {companies.length === 0 ? (
          <div style={{ padding: "32px 16px", textAlign: "center", color: "#9CA3AF", fontSize: 13, background: "#FAFAFA", border: "1px dashed #E5E7EB", borderRadius: 10 }}>
            Aún no has registrado ninguna empresa. Empieza añadiendo el holding o tu sociedad principal.
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 10 }}>
            {/* Holdings (nivel raíz) */}
            <div style={{ display: "flex", flexWrap: "wrap", gap: 10, justifyContent: "center" }}>
              {holdings.map(h => <CompanyCard key={h.id} company={h} onEdit={() => { setAdding(false); setEditingCompany(h); }} />)}
              {holdings.length === 0 && subs.length > 0 && (
                <div style={{ fontSize: 11, color: "#9CA3AF", fontStyle: "italic" }}>Sin holding raíz — añade uno para visualizar la jerarquía.</div>
              )}
            </div>
            {/* Filiales y patrimoniales */}
            {subs.length > 0 && (
              <>
                <div style={{ width: 1, height: 16, background: "#D1D5DB" }} />
                <div style={{ display: "flex", flexWrap: "wrap", gap: 10, justifyContent: "center" }}>
                  {subs.map(s => <CompanyCard key={s.id} company={s} onEdit={() => { setAdding(false); setEditingCompany(s); }} />)}
                </div>
              </>
            )}
          </div>
        )}
      </div>

      {/* KPIs de gobernanza */}
      <div style={{ background: "#fff", border: "1px solid #E5E7EB", borderRadius: 12, padding: 20 }}>
        <div style={{ fontSize: 14, fontWeight: 700, color: "#111827", marginBottom: 14 }}>📐 KPIs de Gobernanza</div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))", gap: 10 }}>
          <KpiTile label="Tax rate efectivo" value={taxRate != null ? `${taxRate}%` : "—"} hint={taxRate != null && taxRate < 25 ? "Por debajo del 25% nominal" : "IS general 25%"} color="#27AE60" />
          <KpiTile label="Compliance" value={`${compliance}%`} hint={compliance >= 90 ? "OK" : "Revisar alertas críticas"} color={compliance >= 90 ? "#27AE60" : "#E67E22"} />
          <KpiTile label="Fondos propios" value={fondosPropios != null ? formatEur(fondosPropios) : "—"} hint="≥ 50% capital social" color="#3498DB" />
          <KpiTile label="Patrimonio neto" value={patrimonioNeto != null ? formatEur(patrimonioNeto) : "—"} hint="Vigila desequilibrio (art.363 LSC)" color="#8E44AD" />
        </div>
      </div>

      {/* Alertas activas */}
      <div style={{ background: "#fff", border: "1px solid #E5E7EB", borderRadius: 12, padding: 20 }}>
        <div style={{ fontSize: 14, fontWeight: 700, color: "#111827", marginBottom: 14 }}>⚠️ Alertas activas {alerts.length > 0 ? `(${alerts.length})` : ""}</div>
        {alerts.length === 0 ? (
          <div style={{ padding: "20px 16px", textAlign: "center", color: "#9CA3AF", fontSize: 12, fontStyle: "italic" }}>
            Sin alertas activas. Las obligaciones próximas a vencer aparecerán aquí automáticamente.
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {alerts.map(a => {
              const palette = a.level === "critical" ? { bg: "#FEE2E2", bd: "#FCA5A5", icon: "🔴" }
                : a.level === "warning" ? { bg: "#FEF3C7", bd: "#FCD34D", icon: "🟠" }
                : { bg: "#DBEAFE", bd: "#93C5FD", icon: "🟡" };
              return (
                <div key={a.id} style={{ background: palette.bg, border: `1px solid ${palette.bd}`, borderRadius: 8, padding: "8px 12px", display: "flex", alignItems: "center", gap: 8 }}>
                  <span>{palette.icon}</span>
                  <span style={{ fontSize: 12.5, color: "#111827", flex: 1 }}>{a.title || a.message}</span>
                  {a.dueDate && <span style={{ fontSize: 11, color: "#6B7280" }}>{a.dueDate}</span>}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {(editingCompany) && (
        <CompanyEditModal
          company={editingCompany}
          isNew={adding}
          companies={companies}
          onClose={() => { setEditingCompany(null); setAdding(false); }}
          onSave={onSaveCompany}
          onDelete={onDeleteCompany}
        />
      )}
    </div>
  );
}

function CompanyCard({ company, onEdit }) {
  const meta = COMPANY_TYPE_META[company.type] || COMPANY_TYPE_META.operativa;
  return (
    <button
      onClick={onEdit}
      title="Editar empresa"
      style={{
        display: "flex", flexDirection: "column", alignItems: "center", gap: 4,
        padding: "10px 14px", minWidth: 140,
        background: meta.bg, border: `1.5px solid ${meta.border}`, borderRadius: 10,
        cursor: "pointer", fontFamily: "inherit",
      }}
    >
      <div style={{ fontSize: 22 }}>{meta.icon}</div>
      <div style={{ fontSize: 12, fontWeight: 700, color: meta.color, textAlign: "center" }}>{company.name || "(sin nombre)"}</div>
      <div style={{ fontSize: 10, color: "#6B7280", textTransform: "uppercase", letterSpacing: 0.5 }}>{meta.label}</div>
      {company.cif && <div style={{ fontSize: 10, color: "#9CA3AF", fontFamily: "ui-monospace,monospace" }}>{company.cif}</div>}
      {typeof company.participation === "number" && company.participation < 100 && (
        <div style={{ fontSize: 10, color: meta.color, fontWeight: 600 }}>{company.participation}%</div>
      )}
    </button>
  );
}

function KpiTile({ label, value, hint, color }) {
  return (
    <div style={{ background: "#FAFAFA", border: "0.5px solid #E5E7EB", borderRadius: 10, padding: "10px 12px" }}>
      <div style={{ fontSize: 10, fontWeight: 600, color: "#6B7280", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 16, fontWeight: 700, color: color || "#111827", marginBottom: 2 }}>{value}</div>
      <div style={{ fontSize: 10.5, color: "#9CA3AF" }}>{hint}</div>
    </div>
  );
}

function CompanyEditModal({ company, isNew, companies, onClose, onSave, onDelete }) {
  const [name, setName] = useState(company.name || "");
  const [type, setType] = useState(company.type || "operativa");
  const [cif, setCif] = useState(company.cif || "");
  const [parentId, setParentId] = useState(company.parentId || null);
  const [participation, setParticipation] = useState(company.participation ?? 100);
  const possibleParents = companies.filter(c => c.id !== company.id && c.type === "holding");
  const canSave = !!name.trim();
  const handleSave = () => {
    if (!canSave) return;
    onSave({ name: name.trim(), type, cif: cif.trim(), parentId, participation: Number(participation) });
  };
  return (
    <div onClick={(e) => e.target === e.currentTarget && onClose()} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)", zIndex: 3000, display: "flex", alignItems: "center", justifyContent: "center" }}>
      <div style={{ background: "#fff", borderRadius: 14, width: 460, maxWidth: "94vw", borderTop: "4px solid #8E44AD", overflow: "hidden" }}>
        <div style={{ padding: "14px 18px", borderBottom: "0.5px solid #E5E7EB", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ fontSize: 14, fontWeight: 700 }}>{isNew ? "Añadir empresa" : "Editar empresa"}</div>
          <button onClick={onClose} style={{ background: "none", border: "none", fontSize: 18, cursor: "pointer", color: "#6B7280" }}>×</button>
        </div>
        <div style={{ padding: 18, display: "flex", flexDirection: "column", gap: 12 }}>
          <Field label="Nombre">
            <input value={name} onChange={e => setName(e.target.value)} placeholder="Ej: Alma Dimo Holding S.L." style={fieldStyle} />
          </Field>
          <Field label="Tipo">
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              {Object.entries(COMPANY_TYPE_META).map(([k, m]) => {
                const active = type === k;
                return (
                  <button key={k} onClick={() => setType(k)} style={{ padding: "6px 12px", borderRadius: 8, border: `1.5px solid ${active ? m.border : "#E5E7EB"}`, background: active ? m.bg : "#fff", color: active ? m.color : "#6B7280", fontSize: 12, fontWeight: active ? 700 : 500, cursor: "pointer", fontFamily: "inherit" }}>{m.icon} {m.label}</button>
                );
              })}
            </div>
          </Field>
          <Field label="CIF / NIF">
            <input value={cif} onChange={e => setCif(e.target.value)} placeholder="B12345678" style={fieldStyle} />
          </Field>
          {type !== "holding" && possibleParents.length > 0 && (
            <Field label="Holding matriz">
              <select value={parentId || ""} onChange={e => setParentId(e.target.value || null)} style={fieldStyle}>
                <option value="">— Sin matriz —</option>
                {possibleParents.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </Field>
          )}
          {parentId && (
            <Field label="Participación (%)">
              <input type="number" value={participation} min={0} max={100} onChange={e => setParticipation(e.target.value)} style={fieldStyle} />
            </Field>
          )}
          <div style={{ display: "flex", gap: 8, justifyContent: "space-between", marginTop: 8 }}>
            {!isNew && (
              <button onClick={() => onDelete(company.id)} style={{ padding: "8px 14px", borderRadius: 8, background: "transparent", border: "1px solid #FCA5A5", color: "#B91C1C", fontSize: 12, fontWeight: 600, cursor: "pointer", fontFamily: "inherit" }}>Eliminar</button>
            )}
            <div style={{ display: "flex", gap: 8, marginLeft: "auto" }}>
              <button onClick={onClose} style={{ padding: "8px 14px", borderRadius: 8, background: "transparent", border: "1px solid #D1D5DB", fontSize: 12, fontWeight: 500, cursor: "pointer", fontFamily: "inherit" }}>Cancelar</button>
              <button onClick={handleSave} disabled={!canSave} style={{ padding: "8px 18px", borderRadius: 8, background: canSave ? "#8E44AD" : "#E5E7EB", color: canSave ? "#fff" : "#9CA3AF", border: "none", fontSize: 12, fontWeight: 600, cursor: canSave ? "pointer" : "default", fontFamily: "inherit" }}>{isNew ? "Crear" : "Guardar"}</button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
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
function formatEur(n) {
  if (typeof n !== "number") return "—";
  return new Intl.NumberFormat("es-ES", { style: "currency", currency: "EUR", maximumFractionDigits: 0 }).format(n);
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
