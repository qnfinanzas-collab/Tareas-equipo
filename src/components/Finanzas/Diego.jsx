// Diego — pestaña de chat con el agente de finanzas operativas.
// Distinto de Jorge Finanzas (que vive en Deal Room para modelos de
// inversión y waterfalls). Diego se centra en operativa diaria:
// conciliación, cash flow, IVA, gastos sin justificar, alertas de
// liquidez. Placeholder mientras se implementa el agente y su chat.
import React from "react";

export default function Diego({ data, member, selectedCompanyId }) {
  const companies = data.governance?.companies || [];
  const company = selectedCompanyId === "all" ? null : companies.find(c => c.id === selectedCompanyId);
  return (
    <div style={{ background: "#fff", border: "1px solid #E5E7EB", borderRadius: 12, padding: "40px 24px", textAlign: "center" }}>
      <div style={{ fontSize: 36, marginBottom: 12 }}>💬</div>
      <div style={{ fontSize: 16, fontWeight: 700, color: "#111827", marginBottom: 6 }}>Diego — tu asistente de finanzas operativas</div>
      <div style={{ fontSize: 12, color: "#7F8C8D", maxWidth: 460, margin: "0 auto", lineHeight: 1.5 }}>
        Próximamente: chat con Diego para revisar la tesorería del día, conciliar movimientos bancarios, alertar de gastos sin clasificar, validar cumplimiento de IVA trimestral y subir documentos para análisis. {company ? `Filtrando por ${company.name}.` : "Vista consolidada de todas las empresas."}
      </div>
    </div>
  );
}
