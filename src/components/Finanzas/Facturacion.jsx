// Facturacion — pestaña de gestión de facturas emitidas/recibidas.
// Placeholder mientras se implementa la UI completa en commits siguientes.
// El selector de empresa de FinanceView ya filtra por companyId.
import React from "react";

export default function Facturacion({ data, selectedCompanyId }) {
  const companies = data.governance?.companies || [];
  const company = selectedCompanyId === "all" ? null : companies.find(c => c.id === selectedCompanyId);
  return (
    <div style={{ background: "#fff", border: "1px solid #E5E7EB", borderRadius: 12, padding: "40px 24px", textAlign: "center" }}>
      <div style={{ fontSize: 36, marginBottom: 12 }}>🧾</div>
      <div style={{ fontSize: 16, fontWeight: 700, color: "#111827", marginBottom: 6 }}>Facturación {company ? `· ${company.name}` : "consolidada"}</div>
      <div style={{ fontSize: 12, color: "#7F8C8D", maxWidth: 420, margin: "0 auto", lineHeight: 1.5 }}>
        Próximamente: emisión de facturas con numeración automática, control de IVA y retenciones IRPF, listado de facturas recibidas, reconciliación con movimientos bancarios y exportación para presentar modelos 303 / 347.
      </div>
    </div>
  );
}
