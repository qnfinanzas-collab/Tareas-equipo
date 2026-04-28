// DocumentacionTab — gestión de documentación societaria por empresa.
// Mostrar/subir/compartir archivos agrupados por categoría. Por ahora
// shell — el contenido (filtros, upload, share) llega en commits siguientes.
import React, { useState } from "react";

export default function DocumentacionTab({ governance, currentMember, onUpdateGovernance }) {
  const companies = governance?.companies || [];
  const [companyId, setCompanyId] = useState(companies[0]?.id || "");

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
  const documents = (governance?.documents || []).filter(d => d.companyId === company.id);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {/* Header con selector de empresa */}
      <div style={{ background: "#fff", border: "1px solid #E5E7EB", borderRadius: 12, padding: "14px 18px", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: "#111827", marginBottom: 4 }}>📋 Documentación societaria</div>
          <div style={{ fontSize: 11, color: "#6B7280" }}>Archivos legales, fiscales y de gobierno por empresa</div>
        </div>
        <select value={companyId} onChange={e => setCompanyId(e.target.value)} style={{ padding: "8px 12px", borderRadius: 8, border: "0.5px solid #D1D5DB", fontSize: 13, fontFamily: "inherit", background: "#fff", minWidth: 220 }}>
          {companies.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
      </div>

      {/* Body */}
      <div style={{ background: "#fff", border: "1px solid #E5E7EB", borderRadius: 12, padding: 20, fontSize: 12, color: "#9CA3AF" }}>
        Empresa seleccionada: <b style={{ color: "#111827" }}>{company.name}</b> · {documents.length} documento{documents.length !== 1 ? "s" : ""} registrado{documents.length !== 1 ? "s" : ""}.
        <div style={{ marginTop: 6, fontStyle: "italic" }}>Lista de documentos disponible en el siguiente commit.</div>
      </div>
    </div>
  );
}
