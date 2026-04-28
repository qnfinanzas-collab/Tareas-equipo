// GobernanzaView — sección dedicada de gobernanza empresarial. Tres tabs:
//   1) Dashboard societario: estructura del grupo + KPIs + alertas
//   2) Calendario fiscal: obligaciones mes a mes con estado por color
//   3) Chat con Gonzalo: conversación 1:1 con el agente especialista
// La vista se monta cuando activeTab === "gobernanza" y solo es visible
// para admin global o miembros con permission view en "gobernanza".
import React, { useState, useRef, useEffect } from "react";
import { speak, stopSpeaking, listen } from "../../lib/voice.js";

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

// ── TAB 2: Calendario fiscal ──
// Plantilla anual de obligaciones fiscales/societarias españolas según skill
// de Gobernanza. Se siembra automáticamente al primer uso. El admin puede
// marcar como presentado, añadir notas, o crear obligaciones custom.
const MONTHS_ES = ["Ene","Feb","Mar","Abr","May","Jun","Jul","Ago","Sep","Oct","Nov","Dic"];
const MONTHS_FULL = ["Enero","Febrero","Marzo","Abril","Mayo","Junio","Julio","Agosto","Septiembre","Octubre","Noviembre","Diciembre"];

// Plantilla canónica de obligaciones fiscales/societarias estándar para una
// SL en España. Se aplica al año en curso si data.governance.obligations
// está vacío. Cada entrada tiene mes (0-11), día, modelo y descripción.
const FISCAL_TEMPLATE = [
  { month: 0, day: 30, model: "Mod 184", concept: "Declaración entidades en régimen atribución de rentas" },
  { month: 0, day: 30, model: "Mod 390", concept: "Resumen Anual IVA" },
  { month: 0, day: 30, model: "Mod 190", concept: "Resumen Anual Retenciones IRPF" },
  { month: 0, day: 30, model: "Mod 180", concept: "Resumen Anual Retenciones Alquileres" },
  { month: 0, day: 20, model: "Mod 111", concept: "IRPF Retenciones 4T" },
  { month: 0, day: 20, model: "Mod 115", concept: "Retenciones Alquileres 4T" },
  { month: 0, day: 30, model: "Mod 303", concept: "IVA Trimestral 4T" },
  { month: 1, day: 28, model: "Mod 347", concept: "Operaciones con Terceros >€3.005,06" },
  { month: 1, day: 28, model: "Mod 720", concept: "Bienes en el extranjero (>€50k)" },
  { month: 3, day: 20, model: "Mod 111", concept: "IRPF Retenciones 1T" },
  { month: 3, day: 20, model: "Mod 115", concept: "Retenciones Alquileres 1T" },
  { month: 3, day: 20, model: "Mod 303", concept: "IVA Trimestral 1T" },
  { month: 3, day: 20, model: "Mod 202", concept: "Pago fraccionado IS 1P" },
  { month: 5, day: 30, model: "Junta",    concept: "Junta General Ordinaria (6 meses post-cierre)" },
  { month: 6, day: 25, model: "Mod 200",  concept: "Impuesto Sociedades anual" },
  { month: 6, day: 20, model: "Mod 111",  concept: "IRPF Retenciones 2T" },
  { month: 6, day: 20, model: "Mod 115",  concept: "Retenciones Alquileres 2T" },
  { month: 6, day: 20, model: "Mod 303",  concept: "IVA Trimestral 2T" },
  { month: 6, day: 30, model: "Cuentas",  concept: "Depósito Cuentas Anuales (1 mes post-junta)" },
  { month: 9, day: 20, model: "Mod 111",  concept: "IRPF Retenciones 3T" },
  { month: 9, day: 20, model: "Mod 115",  concept: "Retenciones Alquileres 3T" },
  { month: 9, day: 20, model: "Mod 303",  concept: "IVA Trimestral 3T" },
  { month: 9, day: 20, model: "Mod 202",  concept: "Pago fraccionado IS 2P" },
  { month: 11, day: 20, model: "Mod 202", concept: "Pago fraccionado IS 3P" },
];

function buildFiscalYear(year){
  return FISCAL_TEMPLATE.map((t, idx) => ({
    id: `fy${year}_${idx}`,
    year,
    model: t.model,
    concept: t.concept,
    dueDate: new Date(year, t.month, t.day).toISOString().slice(0,10),
    status: "pending",
    filedAt: null,
    notes: "",
  }));
}

function GovCalendarTab({ governance, onUpdateGovernance }) {
  const [year, setYear] = useState(new Date().getFullYear());
  const [selMonth, setSelMonth] = useState(new Date().getMonth());
  const obligations = governance.obligations || [];
  const yearObs = obligations.filter(o => Number(o.year || (o.dueDate||"").slice(0,4)) === year);

  const seedYear = () => {
    const list = obligations.slice();
    const seeded = buildFiscalYear(year);
    onUpdateGovernance?.({ obligations: [...list, ...seeded] });
  };
  const updateObligation = (id, patch) => {
    const list = obligations.map(o => o.id === id ? { ...o, ...patch } : o);
    onUpdateGovernance?.({ obligations: list });
  };

  // Conteos por mes con estado dominante para colorear el header.
  const today = new Date();
  const stateOf = (o) => {
    if (o.status === "filed") return "filed";
    const due = new Date(o.dueDate);
    if (isNaN(due.getTime())) return "pending";
    const diffDays = Math.floor((due - today) / 86400000);
    if (diffDays < 0) return "overdue";
    if (diffDays <= 14) return "soon";
    return "pending";
  };
  const monthsAgg = MONTHS_ES.map((_, m) => {
    const items = yearObs.filter(o => new Date(o.dueDate).getMonth() === m);
    const states = items.map(stateOf);
    const dominant = states.includes("overdue") ? "overdue"
      : states.includes("soon") ? "soon"
      : items.length > 0 && states.every(s => s === "filed") ? "filed"
      : items.length > 0 ? "pending" : "empty";
    return { count: items.length, state: dominant };
  });
  const stateColor = {
    filed:   { bg: "#DCFCE7", border: "#86EFAC", icon: "✅" },
    soon:    { bg: "#FEF3C7", border: "#FCD34D", icon: "🟡" },
    overdue: { bg: "#FEE2E2", border: "#FCA5A5", icon: "🔴" },
    pending: { bg: "#F3F4F6", border: "#D1D5DB", icon: "⏳" },
    empty:   { bg: "#FAFAFA", border: "#E5E7EB", icon: "·" },
  };

  const monthItems = yearObs.filter(o => new Date(o.dueDate).getMonth() === selMonth)
    .slice().sort((a,b) => new Date(a.dueDate) - new Date(b.dueDate));

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {/* Header con año + acciones */}
      <div style={{ background: "#fff", border: "1px solid #E5E7EB", borderRadius: 12, padding: "14px 18px", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <button onClick={() => setYear(y => y - 1)} style={navBtn}>‹</button>
          <div style={{ fontSize: 18, fontWeight: 700, color: "#111827" }}>📅 Calendario Fiscal {year}</div>
          <button onClick={() => setYear(y => y + 1)} style={navBtn}>›</button>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          {yearObs.length === 0 && (
            <button onClick={seedYear} style={{ padding: "7px 14px", borderRadius: 8, background: "#8E44AD", color: "#fff", border: "none", fontSize: 12, fontWeight: 600, cursor: "pointer", fontFamily: "inherit" }}>+ Generar plantilla {year}</button>
          )}
        </div>
      </div>

      {/* Grid mensual */}
      <div style={{ background: "#fff", border: "1px solid #E5E7EB", borderRadius: 12, padding: 14 }}>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(12, 1fr)", gap: 6 }}>
          {MONTHS_ES.map((label, m) => {
            const agg = monthsAgg[m];
            const palette = stateColor[agg.state];
            const isSelected = selMonth === m;
            return (
              <button
                key={m}
                onClick={() => setSelMonth(m)}
                title={`${MONTHS_FULL[m]} ${year} · ${agg.count} obligación${agg.count !== 1 ? "es" : ""}`}
                style={{
                  background: palette.bg,
                  border: `1.5px solid ${isSelected ? "#8E44AD" : palette.border}`,
                  borderRadius: 8,
                  padding: "10px 6px",
                  cursor: "pointer",
                  fontFamily: "inherit",
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "center",
                  gap: 2,
                }}
              >
                <div style={{ fontSize: 11, fontWeight: 700, color: "#374151", textTransform: "uppercase", letterSpacing: 0.5 }}>{label}</div>
                <div style={{ fontSize: 13, fontWeight: 700, color: "#111827" }}>{agg.count}</div>
                <div style={{ fontSize: 10 }}>{palette.icon}</div>
              </button>
            );
          })}
        </div>
      </div>

      {/* Detalle mes seleccionado */}
      <div style={{ background: "#fff", border: "1px solid #E5E7EB", borderRadius: 12, padding: 18 }}>
        <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 10, color: "#111827" }}>
          {MONTHS_FULL[selMonth]} {year} · {monthItems.length} obligación{monthItems.length !== 1 ? "es" : ""}
        </div>
        {monthItems.length === 0 ? (
          <div style={{ padding: "20px 14px", textAlign: "center", color: "#9CA3AF", fontSize: 12, fontStyle: "italic" }}>Sin obligaciones registradas para este mes.</div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {monthItems.map(o => {
              const state = stateOf(o);
              const palette = stateColor[state];
              const due = new Date(o.dueDate);
              const dayLabel = isNaN(due.getTime()) ? "—" : `${due.getDate()} ${MONTHS_ES[due.getMonth()].toLowerCase()}`;
              const stateLabel = state === "filed" ? "Presentado"
                : state === "overdue" ? "Vencido"
                : state === "soon" ? "Próximo (≤14d)"
                : "Pendiente";
              return (
                <div key={o.id} style={{ background: palette.bg, border: `1px solid ${palette.border}`, borderRadius: 8, padding: "10px 14px", display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
                  <div style={{ minWidth: 70, fontSize: 11, fontWeight: 700, color: "#6B7280", textTransform: "uppercase", letterSpacing: 0.5 }}>{dayLabel}</div>
                  <div style={{ display: "flex", alignItems: "baseline", gap: 8, flex: 1, minWidth: 0 }}>
                    <span style={{ fontSize: 12, fontWeight: 700, color: "#1F2937" }}>{o.model}</span>
                    <span style={{ fontSize: 12.5, color: "#374151", overflow: "hidden", textOverflow: "ellipsis" }}>{o.concept}</span>
                  </div>
                  <span style={{ fontSize: 10.5, fontWeight: 600, padding: "2px 8px", borderRadius: 10, background: "#fff", border: `1px solid ${palette.border}`, color: "#374151" }}>{palette.icon} {stateLabel}</span>
                  {state !== "filed" && (
                    <button onClick={() => updateObligation(o.id, { status: "filed", filedAt: new Date().toISOString() })} style={{ padding: "4px 10px", borderRadius: 6, background: "#8E44AD", color: "#fff", border: "none", fontSize: 11, fontWeight: 600, cursor: "pointer", fontFamily: "inherit" }}>Marcar presentado</button>
                  )}
                  {state === "filed" && (
                    <button onClick={() => updateObligation(o.id, { status: "pending", filedAt: null })} style={{ padding: "4px 10px", borderRadius: 6, background: "transparent", border: "1px solid #D1D5DB", fontSize: 11, color: "#6B7280", cursor: "pointer", fontFamily: "inherit" }}>Reabrir</button>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

const navBtn = { padding: "4px 10px", borderRadius: 8, border: "0.5px solid #D1D5DB", background: "#fff", fontSize: 14, cursor: "pointer", fontFamily: "inherit", color: "#374151" };

// ── TAB 3: Chat con Gonzalo ──
// Conversación 1:1 con el agente especialista. Mismo stack que el chat de
// Héctor: Web Speech API para TTS y SpeechRecognition. Persistencia local
// por userId vía localStorage para que la conversación sobreviva recargas.
const GONZALO_VOICE = { gender: "male", rate: 1.0, pitch: 0.92 };
const CHAT_MAX = 50;

function GovChatTab({ currentMember, onCallAgent }) {
  const userId = currentMember?.id ?? "anon";
  const storageKey = `soulbaric.gonzalo.chat.${userId}`;
  const [history, setHistory] = useState(() => {
    try { return JSON.parse(localStorage.getItem(storageKey) || "[]"); } catch { return []; }
  });
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [listening, setListening] = useState(false);
  const [muted, setMuted] = useState(() => {
    try { return localStorage.getItem("gonzalo_muted") === "1"; } catch { return false; }
  });
  const stopListenRef = useRef(null);
  const scrollRef = useRef(null);

  useEffect(() => {
    try { localStorage.setItem(storageKey, JSON.stringify(history.slice(-CHAT_MAX))); } catch {}
  }, [history, storageKey]);

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [history, loading]);

  const toggleMute = () => {
    setMuted(m => {
      const next = !m;
      try { localStorage.setItem("gonzalo_muted", next ? "1" : "0"); } catch {}
      if (next) stopSpeaking();
      return next;
    });
  };

  const speakIfUnmuted = (text) => {
    if (typeof window === "undefined" || !window.speechSynthesis) return;
    if (muted || !text) return;
    try { speak(text, GONZALO_VOICE); } catch (e) { console.warn("[gonzalo] speak fallo:", e?.message); }
  };

  const send = async (overrideText) => {
    const txt = (overrideText ?? input).trim();
    if (!txt || loading) return;
    stopSpeaking();
    const next = [...history, { role: "user", content: txt, ts: Date.now() }].slice(-CHAT_MAX);
    setHistory(next);
    setInput("");
    setLoading(true);
    try {
      const messages = next.map(m => ({ role: m.role === "user" ? "user" : "assistant", content: m.content }));
      const reply = await onCallAgent({ messages });
      const finalReply = (reply || "").trim() || "(sin respuesta)";
      const updated = [...next, { role: "assistant", content: finalReply, ts: Date.now() }].slice(-CHAT_MAX);
      setHistory(updated);
      speakIfUnmuted(finalReply);
    } catch (e) {
      const errMsg = `⚠ Error consultando a Gonzalo: ${e.message || e}`;
      setHistory(h => [...h, { role: "assistant", content: errMsg, ts: Date.now(), error: true }].slice(-CHAT_MAX));
    } finally {
      setLoading(false);
    }
  };

  const startListen = () => {
    if (listening) {
      try { stopListenRef.current?.(); } catch {}
      setListening(false);
      return;
    }
    setListening(true);
    try {
      const stop = listen({
        lang: "es-ES",
        onResult: (text) => {
          setListening(false);
          if (text && text.trim()) send(text.trim());
        },
        onError: () => setListening(false),
        onEnd: () => setListening(false),
      });
      stopListenRef.current = stop;
    } catch {
      setListening(false);
    }
  };

  const onKey = (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } };

  const clear = () => {
    if (!history.length) return;
    if (window.confirm("¿Borrar el historial de conversación con Gonzalo?")) {
      setHistory([]);
      try { localStorage.removeItem(storageKey); } catch {}
    }
  };

  return (
    <div style={{ background: "#fff", border: "1px solid #E5E7EB", borderRadius: 12, overflow: "hidden", display: "flex", flexDirection: "column", minHeight: 520 }}>
      {/* Header del chat */}
      <div style={{ padding: "12px 16px", borderBottom: "0.5px solid #E5E7EB", display: "flex", alignItems: "center", gap: 10, background: "linear-gradient(90deg,#F5EEFA,#FFFFFF)" }}>
        <div style={{ width: 36, height: 36, borderRadius: "50%", background: "#8E44AD", color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 18 }}>🏛️</div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: "#111827" }}>Gonzalo Gobernanza</div>
          <div style={{ fontSize: 11, color: "#6B21A8" }}>Estructura societaria, holdings, calendario fiscal, internacionalización</div>
        </div>
        <button onClick={toggleMute} title={muted ? "Activar voz" : "Silenciar voz"} style={{ background: "transparent", border: "1px solid #E5E7EB", borderRadius: 8, width: 32, height: 32, fontSize: 14, cursor: "pointer", color: muted ? "#9CA3AF" : "#8E44AD" }}>{muted ? "🔇" : "🔊"}</button>
        <button onClick={clear} title="Borrar conversación" style={{ background: "transparent", border: "1px solid #E5E7EB", borderRadius: 8, width: 32, height: 32, fontSize: 14, cursor: "pointer", color: "#6B7280" }}>🗑</button>
      </div>

      {/* Mensajes */}
      <div ref={scrollRef} style={{ flex: 1, overflowY: "auto", padding: "16px 16px 8px", display: "flex", flexDirection: "column", gap: 10 }}>
        {history.length === 0 && (
          <div style={{ padding: "24px 16px", textAlign: "center", color: "#9CA3AF", fontSize: 13, fontStyle: "italic" }}>
            Pregúntale a Gonzalo sobre estructura societaria, holdings, consolidación fiscal, calendario de obligaciones, internacionalización o planificación sucesoria.
          </div>
        )}
        {history.map((m, i) => {
          const isUser = m.role === "user";
          return (
            <div key={i} style={{ display: "flex", gap: 8, justifyContent: isUser ? "flex-end" : "flex-start" }}>
              {!isUser && <div style={{ width: 28, height: 28, borderRadius: "50%", background: m.error ? "#FCA5A5" : "#8E44AD", color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 13, flexShrink: 0 }}>🏛️</div>}
              <div style={{
                maxWidth: "78%",
                background: isUser ? "#7F77DD" : (m.error ? "#FEE2E2" : "#F5EEFA"),
                color: isUser ? "#fff" : (m.error ? "#991B1B" : "#1F2937"),
                border: m.error ? "1px solid #FCA5A5" : "0.5px solid #E5E7EB",
                borderRadius: 12,
                padding: "10px 14px",
                fontSize: 13.5,
                lineHeight: 1.5,
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
              }}>{m.content}</div>
            </div>
          );
        })}
        {loading && (
          <div style={{ display: "flex", gap: 8 }}>
            <div style={{ width: 28, height: 28, borderRadius: "50%", background: "#8E44AD", color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 13 }}>🏛️</div>
            <div style={{ background: "#F5EEFA", border: "0.5px solid #E5E7EB", borderRadius: 12, padding: "10px 14px", fontSize: 12.5, color: "#6B21A8", fontStyle: "italic" }}>🏛️ Gonzalo está respondiendo…</div>
          </div>
        )}
      </div>

      {/* Input */}
      <div style={{ padding: 12, borderTop: "0.5px solid #E5E7EB", display: "flex", gap: 8, alignItems: "flex-end" }}>
        <textarea
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={onKey}
          placeholder="Pregúntale sobre holdings, consolidación fiscal, calendario, internacionalización…"
          rows={1}
          style={{ flex: 1, padding: "10px 12px", borderRadius: 10, border: "0.5px solid #D1D5DB", fontSize: 13, fontFamily: "inherit", outline: "none", resize: "none", lineHeight: 1.4, maxHeight: 120 }}
        />
        <button onClick={startListen} title={listening ? "Detener" : "Hablar"} style={{ width: 38, height: 38, borderRadius: 10, background: listening ? "#E24B4A" : "#fff", color: listening ? "#fff" : "#8E44AD", border: `1px solid ${listening ? "#E24B4A" : "#D8B4FE"}`, cursor: "pointer", fontSize: 16, fontFamily: "inherit" }}>{listening ? "⏹" : "🎤"}</button>
        <button onClick={() => send()} disabled={!input.trim() || loading} style={{ padding: "9px 16px", borderRadius: 10, background: input.trim() && !loading ? "#8E44AD" : "#E5E7EB", color: input.trim() && !loading ? "#fff" : "#9CA3AF", border: "none", fontSize: 13, fontWeight: 600, cursor: input.trim() && !loading ? "pointer" : "not-allowed", fontFamily: "inherit" }}>{loading ? "…" : "Enviar"}</button>
      </div>
    </div>
  );
}
