// DocumentacionTab — gestión de documentación societaria por empresa.
// Lista agrupada por categoría con estado visual (✅❌🟡⚪) y filtros.
// La subida de archivos, gestión de versiones y compartir llegan en
// commits siguientes — este commit cierra la UI base de visualización.
import React, { useMemo, useState } from "react";
import { CATEGORY_LABELS, CATEGORY_ORDER, computeDocStats } from "./documentTemplates.js";

const STATUS_META = {
  attached:       { icon: "✅", label: "Adjuntado",   color: "#0E7C5A", bg: "#F0FDF4", border: "#86EFAC" },
  pending:        { icon: "❌", label: "Falta",       color: "#B91C1C", bg: "#FEF2F2", border: "#FCA5A5" },
  overdue:        { icon: "🔴", label: "Vencido",     color: "#991B1B", bg: "#FEE2E2", border: "#F87171" },
  not_applicable: { icon: "⚪", label: "No aplica",   color: "#6B7280", bg: "#F9FAFB", border: "#E5E7EB" },
  draft:          { icon: "📝", label: "Borrador",    color: "#92400E", bg: "#FFFBEB", border: "#FCD34D" },
  expiring:       { icon: "🟡", label: "Próximo a vencer", color: "#92400E", bg: "#FEF3C7", border: "#FCD34D" },
};

const FILTERS = [
  { key: "all",       label: "Todos" },
  { key: "attached",  label: "✅ OK" },
  { key: "pending",   label: "❌ Faltan" },
  { key: "expiring",  label: "🟡 Próximos" },
  { key: "not_applicable", label: "⚪ No aplica" },
];

// Devuelve el "estado efectivo" para visualización: si hay archivo y
// expiresAt está dentro de 90 días → expiring; si no, devuelve status.
function effectiveStatus(doc) {
  if (doc.status !== "attached") return doc.status;
  if (!doc.expiresAt) return "attached";
  const days = Math.floor((new Date(doc.expiresAt) - new Date()) / 86400000);
  if (days < 0) return "overdue";
  if (days <= 90) return "expiring";
  return "attached";
}

export default function DocumentacionTab({ governance, currentMember, onUpdateGovernance }) {
  const companies = governance?.companies || [];
  const [companyId, setCompanyId] = useState(companies[0]?.id || "");
  const [filter, setFilter] = useState("all");

  if (companies.length === 0) {
    return (
      <div style={{ background: "#fff", border: "1px solid #E5E7EB", borderRadius: 12, padding: "40px 20px", textAlign: "center" }}>
        <div style={{ fontSize: 36, marginBottom: 12 }}>📋</div>
        <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 6, color: "#111827" }}>Aún no hay empresas registradas</div>
        <div style={{ fontSize: 12, color: "#7F8C8D", maxWidth: 380, margin: "0 auto" }}>
          Para gestionar documentación societaria, primero registra una empresa en el tab Dashboard. Al crearla, generaremos automáticamente la lista de documentos necesarios según su tipo.
        </div>
      </div>
    );
  }

  const company = companies.find(c => c.id === companyId) || companies[0];
  const allDocs = governance?.documents || [];
  const companyDocs = useMemo(() => allDocs.filter(d => d.companyId === company.id), [allDocs, company.id]);
  const stats = useMemo(() => computeDocStats(companyDocs), [companyDocs]);

  // Aplica filtro al listado. "expiring" mira el estado efectivo.
  const filtered = useMemo(() => {
    if (filter === "all") return companyDocs;
    return companyDocs.filter(d => effectiveStatus(d) === filter);
  }, [companyDocs, filter]);

  // Agrupa por categoría respetando CATEGORY_ORDER. Las cuentas anuales y
  // fiscal se sub-agrupan por subcategory (año / trimestre).
  const grouped = useMemo(() => {
    const out = {};
    for (const d of filtered) {
      const cat = d.category || "otros";
      if (!out[cat]) out[cat] = {};
      const sub = d.subcategory || "_";
      if (!out[cat][sub]) out[cat][sub] = [];
      out[cat][sub].push(d);
    }
    return out;
  }, [filtered]);

  const updateDoc = (id, patch) => {
    const next = allDocs.map(d => d.id === id ? { ...d, ...patch } : d);
    onUpdateGovernance?.({ documents: next });
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {/* Header con selector de empresa + resumen */}
      <div style={{ background: "#fff", border: "1px solid #E5E7EB", borderRadius: 12, padding: "14px 18px" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap", marginBottom: 12 }}>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 14, fontWeight: 700, color: "#111827", marginBottom: 4 }}>📋 Documentación societaria</div>
            <div style={{ fontSize: 11, color: "#6B7280" }}>Archivos legales, fiscales y de gobierno por empresa</div>
          </div>
          <select value={companyId} onChange={e => setCompanyId(e.target.value)} style={{ padding: "8px 12px", borderRadius: 8, border: "0.5px solid #D1D5DB", fontSize: 13, fontFamily: "inherit", background: "#fff", minWidth: 220 }}>
            {companies.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </div>
        {/* Resumen stats */}
        <div style={{ display: "flex", gap: 14, flexWrap: "wrap", alignItems: "center", paddingTop: 10, borderTop: "0.5px solid #F3F4F6" }}>
          <StatPill icon="✅" label={`${stats.attached}/${stats.total}`} sub="adjuntados" color="#0E7C5A" />
          {stats.pending > 0 && <StatPill icon="❌" label={String(stats.pending)} sub="faltan" color="#B91C1C" />}
          {stats.overdue > 0 && <StatPill icon="🔴" label={String(stats.overdue)} sub="vencidos" color="#991B1B" />}
          {stats.expiringSoon > 0 && <StatPill icon="🟡" label={String(stats.expiringSoon)} sub="próximos" color="#92400E" />}
        </div>
      </div>

      {/* Filtros */}
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        {FILTERS.map(f => {
          const active = filter === f.key;
          return (
            <button key={f.key} onClick={() => setFilter(f.key)} style={{
              padding: "6px 14px", borderRadius: 16,
              border: `1px solid ${active ? "#8E44AD" : "#E5E7EB"}`,
              background: active ? "#8E44AD" : "#fff",
              color: active ? "#fff" : "#6B7280",
              fontSize: 12, fontWeight: 600, cursor: "pointer", fontFamily: "inherit",
            }}>{f.label}</button>
          );
        })}
      </div>

      {/* Lista agrupada por categoría */}
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        {filtered.length === 0 ? (
          <div style={{ background: "#fff", border: "1px dashed #E5E7EB", borderRadius: 12, padding: "32px 16px", textAlign: "center", color: "#9CA3AF", fontSize: 12 }}>
            Ningún documento coincide con este filtro.
          </div>
        ) : (
          CATEGORY_ORDER.filter(cat => grouped[cat]).map(cat => (
            <CategorySection key={cat} category={cat} subgroups={grouped[cat]} onUpdate={updateDoc} />
          ))
        )}
      </div>
    </div>
  );
}

function StatPill({ icon, label, sub, color }) {
  return (
    <div style={{ display: "inline-flex", alignItems: "baseline", gap: 6 }}>
      <span style={{ fontSize: 14 }}>{icon}</span>
      <span style={{ fontSize: 14, fontWeight: 700, color }}>{label}</span>
      <span style={{ fontSize: 11, color: "#6B7280" }}>{sub}</span>
    </div>
  );
}

function CategorySection({ category, subgroups, onUpdate }) {
  const label = CATEGORY_LABELS[category] || `📂 ${category}`;
  const subKeys = Object.keys(subgroups).sort((a, b) => b.localeCompare(a)); // recientes primero
  return (
    <div style={{ background: "#fff", border: "1px solid #E5E7EB", borderRadius: 12, overflow: "hidden" }}>
      <div style={{ padding: "10px 16px", background: "#FAFAFA", borderBottom: "0.5px solid #E5E7EB", fontSize: 12, fontWeight: 700, color: "#374151", letterSpacing: 0.3 }}>{label}</div>
      <div style={{ padding: "8px 0" }}>
        {subKeys.map(sub => (
          <div key={sub}>
            {sub !== "_" && (
              <div style={{ padding: "6px 16px", fontSize: 11, fontWeight: 700, color: "#6B7280", textTransform: "uppercase", letterSpacing: 0.4 }}>{sub}</div>
            )}
            {subgroups[sub].map(doc => <DocumentRow key={doc.id} doc={doc} onUpdate={onUpdate} />)}
          </div>
        ))}
      </div>
    </div>
  );
}

function DocumentRow({ doc, onUpdate }) {
  const eff = effectiveStatus(doc);
  const meta = STATUS_META[eff] || STATUS_META.pending;
  const toggleApplicability = () => {
    if (doc.status === "not_applicable") onUpdate(doc.id, { status: "pending" });
    else if (doc.status === "pending")    onUpdate(doc.id, { status: "not_applicable" });
  };
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 16px", borderTop: "0.5px solid #F3F4F6" }}>
      <span style={{ fontSize: 18, lineHeight: 1, flexShrink: 0 }}>{meta.icon}</span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: doc.status === "not_applicable" ? "#9CA3AF" : "#111827" }}>
          {doc.name}
          {doc.required && doc.status !== "not_applicable" && <span style={{ color: "#E24B4A", marginLeft: 4 }}>*</span>}
        </div>
        {doc.description && (
          <div style={{ fontSize: 11, color: "#6B7280", marginTop: 2, lineHeight: 1.4 }}>{doc.description}</div>
        )}
        {doc.fileName && (
          <div style={{ fontSize: 11, color: "#0E7C5A", marginTop: 4, fontFamily: "ui-monospace,monospace" }}>📎 {doc.fileName}</div>
        )}
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
        <span style={{ fontSize: 10.5, fontWeight: 600, padding: "2px 8px", borderRadius: 10, background: meta.bg, border: `1px solid ${meta.border}`, color: meta.color, whiteSpace: "nowrap" }}>{meta.label}</span>
        {(doc.status === "not_applicable" || doc.status === "pending") && (
          <button onClick={toggleApplicability} title={doc.status === "not_applicable" ? "Activar este documento" : "Marcar como no aplica"} style={{ fontSize: 11, padding: "3px 8px", borderRadius: 6, background: "transparent", border: "1px solid #D1D5DB", color: "#6B7280", cursor: "pointer", fontFamily: "inherit" }}>{doc.status === "not_applicable" ? "+ Activar" : "No aplica"}</button>
        )}
      </div>
    </div>
  );
}
