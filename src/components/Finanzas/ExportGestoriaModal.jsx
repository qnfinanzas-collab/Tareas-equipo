// ExportGestoriaModal — exportación de datos financieros para presentar
// a la gestoría. Soporta CSV (con BOM UTF-8 para Excel) y XLSX multi-hoja
// vía SheetJS dynamic import. Permite filtrar por período (mes/trimestre/
// año/personalizado) y empresa, y elegir qué contenidos incluir:
//   ☑ Movimientos bancarios categorizados
//   ☑ Facturas emitidas
//   ☑ Facturas recibidas
//   ☑ Resumen IVA trimestral (base Modelo 303)
//
// El XLSX se genera en cliente — no se sube nada al servidor.
import React, { useEffect, useMemo, useState } from "react";

const fmtEur = (n) => Number(n||0).toFixed(2);
const todayISO = () => new Date().toISOString().slice(0,10);
const startOfMonth = (d) => { const x = new Date(d); x.setDate(1); return x.toISOString().slice(0,10); };
const endOfMonth = (d) => { const x = new Date(d); x.setMonth(x.getMonth()+1, 0); return x.toISOString().slice(0,10); };
const startOfQuarter = (d) => { const x = new Date(d); const q = Math.floor(x.getMonth()/3); x.setMonth(q*3, 1); return x.toISOString().slice(0,10); };
const endOfQuarter = (d) => { const x = new Date(d); const q = Math.floor(x.getMonth()/3); x.setMonth(q*3+3, 0); return x.toISOString().slice(0,10); };
const startOfYear = (d) => { const x = new Date(d); x.setMonth(0, 1); return x.toISOString().slice(0,10); };
const endOfYear = (d) => { const x = new Date(d); x.setMonth(11, 31); return x.toISOString().slice(0,10); };

export default function ExportGestoriaModal({ data, selectedCompanyId, onClose }) {
  const companies = data.governance?.companies || [];
  const allMovements = data.bankMovements || [];
  const allInvoices  = data.invoices || [];
  const allAccounts  = data.bankAccounts || [];
  const categories   = data.movementCategories || [];

  const [period, setPeriod] = useState("month"); // month | quarter | year | custom
  const [from, setFrom] = useState(startOfMonth(new Date()));
  const [to, setTo]     = useState(endOfMonth(new Date()));
  const [companyFilter, setCompanyFilter] = useState(selectedCompanyId || "all");
  const [format, setFormat] = useState("csv"); // csv | xlsx
  const [includeMovs,  setIncludeMovs]  = useState(true);
  const [includeEmit,  setIncludeEmit]  = useState(true);
  const [includeRecib, setIncludeRecib] = useState(true);
  const [includeVat,   setIncludeVat]   = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  // Sincroniza from/to cuando cambia el preset.
  useEffect(() => {
    const today = new Date();
    if (period === "month")   { setFrom(startOfMonth(today)); setTo(endOfMonth(today)); }
    if (period === "quarter") { setFrom(startOfQuarter(today)); setTo(endOfQuarter(today)); }
    if (period === "year")    { setFrom(startOfYear(today)); setTo(endOfYear(today)); }
    // custom: no tocamos, deja que el usuario edite from/to
  }, [period]);

  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Filtrado base: empresa + rango fechas. Movimientos sin companyId
  // (legacy) se incluyen siempre — son del CEO y tendrá que asignarlos
  // luego, pero para una exportación es mejor incluirlos.
  const filteredMovs = useMemo(() => {
    return allMovements.filter(m => {
      if (companyFilter !== "all" && m.companyId && m.companyId !== companyFilter) return false;
      if (m.date < from || m.date > to) return false;
      return true;
    });
  }, [allMovements, companyFilter, from, to]);

  const filteredInvs = useMemo(() => {
    return allInvoices.filter(i => {
      if (companyFilter !== "all" && i.companyId && i.companyId !== companyFilter) return false;
      if (i.date < from || i.date > to) return false;
      return true;
    });
  }, [allInvoices, companyFilter, from, to]);

  const stats = useMemo(() => ({
    movs: filteredMovs.length,
    emit: filteredInvs.filter(i => i.type === "emitida").length,
    recib: filteredInvs.filter(i => i.type === "recibida").length,
  }), [filteredMovs, filteredInvs]);

  const companyName = companyFilter === "all" ? "Todas-las-empresas"
    : (companies.find(c => c.id === companyFilter)?.name || "empresa").replace(/\s+/g, "_");

  const buildMovsRows = () => {
    return filteredMovs.map(m => {
      const cat = categories.find(c => c.id === m.category);
      const acc = allAccounts.find(a => a.id === m.accountId);
      const inv = m.id ? allInvoices.find(i => i.bankMovementId === m.id) : null;
      const amt = Number(m.amount)||0;
      return {
        Fecha: m.date || "",
        Concepto: m.concept || "",
        Cuenta: acc ? `${acc.bankName}${acc.alias?` · ${acc.alias}`:""}` : "",
        Debe:  amt < 0 ? Math.abs(amt).toFixed(2) : "",
        Haber: amt > 0 ? amt.toFixed(2) : "",
        Categoría: cat?.name || "",
        "Cuenta PGC": cat?.pgc || "",
        Conciliado: m.reconciled ? "Sí" : "No",
        "Factura vinculada": inv?.number || "",
        Notas: m.notes || "",
      };
    });
  };

  const buildInvoiceRows = (kind) => {
    return filteredInvs.filter(i => i.type === kind).map(i => ({
      "Nº": i.number || "",
      Fecha: i.date || "",
      Vencimiento: i.dueDate || "",
      [kind === "emitida" ? "Cliente" : "Proveedor"]: i.counterparty?.name || "",
      CIF: i.counterparty?.cif || "",
      Subtotal: fmtEur(i.subtotal),
      "IVA": fmtEur(i.vatAmount),
      "Tipos IVA": Array.from(new Set((i.lines||[]).map(l => `${l.vatRate}%`))).join(" + "),
      "IRPF": fmtEur(i.irpfAmount),
      Total: fmtEur(i.total),
      Estado: i.status || "",
      "Pagada el": i.paidDate || "",
      "Movimiento bancario": i.bankMovementId ? "Sí" : "No",
      Notas: i.notes || "",
    }));
  };

  const buildVatRows = () => {
    const acc = new Map();
    for (const inv of filteredInvs) {
      const d = new Date(inv.date);
      if (isNaN(d.getTime())) continue;
      const q = Math.floor(d.getMonth()/3) + 1;
      const key = `${d.getFullYear()}-${q}T`;
      const cur = acc.get(key) || { rep: 0, sop: 0, year: d.getFullYear(), q };
      if (inv.type === "emitida") cur.rep += Number(inv.vatAmount)||0;
      else                         cur.sop += Number(inv.vatAmount)||0;
      acc.set(key, cur);
    }
    return Array.from(acc.entries())
      .sort(([a],[b]) => a.localeCompare(b))
      .map(([key, v]) => ({
        Trimestre: `${v.q}T-${v.year}`,
        "IVA repercutido": fmtEur(v.rep),
        "IVA soportado": fmtEur(v.sop),
        "Saldo (Mod. 303)": fmtEur(v.rep - v.sop),
        Resultado: v.rep - v.sop > 0.005 ? "A ingresar"
                 : v.rep - v.sop < -0.005 ? "A devolver"
                 : "Neutro",
      }));
  };

  // CSV helpers (BOM UTF-8 + RFC 4180 escaping). Excel reconoce el BOM y
  // abre el archivo con la codificación correcta sin pedir importar.
  const toCsv = (rows) => {
    if (!rows || rows.length === 0) return "\uFEFF";
    const headers = Object.keys(rows[0]);
    const esc = (v) => {
      const s = v == null ? "" : String(v);
      if (s.includes(";") || s.includes("\"") || s.includes("\n") || s.includes(",")) return `"${s.replace(/"/g, '""')}"`;
      return s;
    };
    const lines = [headers.join(";")];
    for (const r of rows) lines.push(headers.map(h => esc(r[h])).join(";"));
    return "\uFEFF" + lines.join("\n");
  };

  const downloadFile = (filename, blob) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
  };

  const handleExport = async () => {
    setErr("");
    setBusy(true);
    try {
      const parts = [];
      if (includeMovs)  parts.push({ name: "Movimientos",       rows: buildMovsRows() });
      if (includeEmit)  parts.push({ name: "Facturas-emitidas", rows: buildInvoiceRows("emitida") });
      if (includeRecib) parts.push({ name: "Facturas-recibidas",rows: buildInvoiceRows("recibida") });
      if (includeVat)   parts.push({ name: "Resumen-IVA",       rows: buildVatRows() });

      if (parts.length === 0) throw new Error("Selecciona al menos un contenido a exportar.");
      if (parts.every(p => p.rows.length === 0)) throw new Error("No hay datos en el período seleccionado.");

      const stamp = `${from}_${to}`;
      const baseName = `gestoria_${companyName}_${stamp}`;

      if (format === "csv") {
        // Un CSV por cada bloque con datos. Si solo hay uno, salida directa;
        // si hay varios, los bajamos uno detrás de otro (zip sería ideal pero
        // requeriría otra dep — un download por bloque es suficiente).
        const withData = parts.filter(p => p.rows.length > 0);
        for (const part of withData) {
          const csv = toCsv(part.rows);
          const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
          downloadFile(`${baseName}_${part.name}.csv`, blob);
        }
      } else {
        // XLSX multi-hoja con SheetJS.
        const XLSX = await import("xlsx");
        const wb = XLSX.utils.book_new();
        for (const part of parts) {
          const rows = part.rows.length > 0 ? part.rows : [{ "(sin datos en el período)": "" }];
          const ws = XLSX.utils.json_to_sheet(rows);
          XLSX.utils.book_append_sheet(wb, ws, part.name.slice(0, 31)); // Excel limita a 31 chars
        }
        const buffer = XLSX.write(wb, { bookType: "xlsx", type: "array" });
        const blob = new Blob([buffer], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
        downloadFile(`${baseName}.xlsx`, blob);
      }
      onClose();
    } catch (e) {
      console.warn("[export] fallo:", e);
      setErr(e.message || "Error generando el archivo");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div onClick={(e) => e.target === e.currentTarget && onClose()} style={overlayStyle}>
      <div style={{ ...modalStyle, borderTop: "4px solid #27AE60" }}>
        <div style={modalHeader}>
          <div style={{ fontSize: 14, fontWeight: 700 }}>📥 Exportar para gestoría</div>
          <button onClick={onClose} style={closeBtn}>×</button>
        </div>
        <div style={modalBody}>
          {/* Período */}
          <div>
            <Label>Período</Label>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              {[
                { k: "month",   label: "Mes actual" },
                { k: "quarter", label: "Trimestre actual" },
                { k: "year",    label: "Año actual" },
                { k: "custom",  label: "Personalizado" },
              ].map(o => (
                <button key={o.k} onClick={() => setPeriod(o.k)} style={chipBtn(period === o.k)}>{o.label}</button>
              ))}
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginTop: 10 }}>
              <Field label="Desde">
                <input type="date" value={from} onChange={e => { setFrom(e.target.value); setPeriod("custom"); }} style={inputStyle} />
              </Field>
              <Field label="Hasta">
                <input type="date" value={to} onChange={e => { setTo(e.target.value); setPeriod("custom"); }} style={inputStyle} />
              </Field>
            </div>
          </div>

          {/* Empresa */}
          <Field label="Empresa">
            <select value={companyFilter} onChange={e => setCompanyFilter(e.target.value)} style={inputStyle}>
              <option value="all">📊 Todas las empresas</option>
              {companies.map(c => <option key={c.id} value={c.id}>{c.type === "holding" ? "🏛️" : c.type === "patrimonial" ? "🏠" : "⚙️"} {c.name}{c.cif?` · ${c.cif}`:""}</option>)}
            </select>
          </Field>

          {/* Formato */}
          <div>
            <Label>Formato</Label>
            <div style={{ display: "flex", gap: 6 }}>
              {[
                { k: "csv",  label: "📄 CSV (UTF-8 con BOM)" },
                { k: "xlsx", label: "📊 Excel (.xlsx multi-hoja)" },
              ].map(o => (
                <button key={o.k} onClick={() => setFormat(o.k)} style={chipBtn(format === o.k, "#27AE60")}>{o.label}</button>
              ))}
            </div>
          </div>

          {/* Contenido */}
          <div>
            <Label>Contenido a incluir</Label>
            <div style={{ display: "flex", flexDirection: "column", gap: 6, padding: "8px 12px", background: "#FAFAFA", border: "0.5px solid #E5E7EB", borderRadius: 8 }}>
              <Checkbox checked={includeMovs}  onChange={setIncludeMovs}  label={`Movimientos bancarios categorizados (${stats.movs})`} />
              <Checkbox checked={includeEmit}  onChange={setIncludeEmit}  label={`Facturas emitidas (${stats.emit})`} />
              <Checkbox checked={includeRecib} onChange={setIncludeRecib} label={`Facturas recibidas (${stats.recib})`} />
              <Checkbox checked={includeVat}   onChange={setIncludeVat}   label={`Resumen IVA trimestral (base Modelo 303)`} />
            </div>
          </div>

          {err && (
            <div style={{ padding: "8px 12px", background: "#FEE2E2", border: "1px solid #FCA5A5", borderRadius: 8, fontSize: 12, color: "#991B1B" }}>⚠ {err}</div>
          )}

          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 4 }}>
            <button onClick={onClose} style={{ padding: "8px 14px", borderRadius: 8, background: "transparent", border: "1px solid #D1D5DB", fontSize: 12, fontWeight: 500, cursor: "pointer", fontFamily: "inherit" }}>Cancelar</button>
            <button
              onClick={handleExport}
              disabled={busy}
              style={busy
                ? { padding: "8px 18px", borderRadius: 8, background: "#E5E7EB", color: "#9CA3AF", border: "none", fontSize: 12, fontWeight: 600, cursor: "default", fontFamily: "inherit" }
                : { padding: "8px 18px", borderRadius: 8, background: "#27AE60", color: "#fff", border: "none", fontSize: 12, fontWeight: 600, cursor: "pointer", fontFamily: "inherit" }
              }
            >{busy ? "Generando…" : `Descargar ${format.toUpperCase()}`}</button>
          </div>
        </div>
      </div>
    </div>
  );
}

function Field({ label, children }) {
  return (
    <div>
      <div style={{ fontSize: 10, fontWeight: 600, color: "#6B7280", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 4 }}>{label}</div>
      {children}
    </div>
  );
}
function Label({ children }) {
  return <div style={{ fontSize: 10, fontWeight: 600, color: "#6B7280", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 6 }}>{children}</div>;
}
function Checkbox({ checked, onChange, label }) {
  return (
    <label style={{ display: "inline-flex", alignItems: "center", gap: 8, fontSize: 13, cursor: "pointer", color: "#1F2937" }}>
      <input type="checkbox" checked={checked} onChange={e => onChange(e.target.checked)} style={{ accentColor: "#27AE60" }} />
      {label}
    </label>
  );
}

const chipBtn = (active, color="#1E40AF") => ({
  padding: "6px 12px",
  borderRadius: 999,
  border: `1px solid ${active ? color : "#E5E7EB"}`,
  background: active ? `${color}15` : "#fff",
  color: active ? color : "#6B7280",
  fontSize: 12,
  fontWeight: 600,
  cursor: "pointer",
  fontFamily: "inherit",
});
const inputStyle = { padding: "8px 10px", borderRadius: 8, border: "0.5px solid #D1D5DB", fontSize: 13, fontFamily: "inherit", outline: "none", boxSizing: "border-box", background: "#fff", width: "100%" };
const overlayStyle = { position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)", zIndex: 3000, display: "flex", alignItems: "center", justifyContent: "center", padding: 20 };
const modalStyle = { background: "#fff", borderRadius: 14, width: 540, maxWidth: "94vw", overflow: "hidden", maxHeight: "92vh", display: "flex", flexDirection: "column" };
const modalHeader = { padding: "14px 18px", borderBottom: "0.5px solid #E5E7EB", display: "flex", alignItems: "center", justifyContent: "space-between", flexShrink: 0 };
const modalBody = { padding: 18, display: "flex", flexDirection: "column", gap: 14, overflowY: "auto" };
const closeBtn = { background: "none", border: "none", fontSize: 20, cursor: "pointer", color: "#6B7280" };
