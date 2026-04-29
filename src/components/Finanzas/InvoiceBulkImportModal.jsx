// InvoiceBulkImportModal — importación masiva de facturas desde Excel/CSV.
// Misma estética que ImportExtractoModal (movimientos bancarios) para
// mantener consistencia visual.
//
// Pasos: 1) parseo del archivo, 2) auto-detección de columnas + mapeo
// manual, 3) preview con dupes (mismo nº + mismo CIF) y selección por
// fila, 4) creación masiva via onAddInvoice (la numeración auto la
// resuelve el mutator si number queda vacío).
//
// El tipo (emitida/recibida) se hereda de la tab activa de Facturacion.
import React, { useEffect, useMemo, useRef, useState } from "react";

const COL_HEURISTICS = {
  number:    ["nº", "n°", "numero", "número", "nº factura", "número factura", "numero factura", "invoice", "factura"],
  date:      ["fecha", "fecha factura", "fecha emisión", "fecha emision", "f.factura", "f. factura", "issue date"],
  dueDate:   ["vencimiento", "fecha vencimiento", "venc.", "due date"],
  name:      ["cliente", "proveedor", "razón social", "razon social", "nombre", "company", "counterparty"],
  cif:       ["cif", "nif", "vat", "tax id", "identificación", "identificacion"],
  base:      ["base", "subtotal", "importe sin iva", "neto", "base imponible"],
  vatRate:   ["iva%", "tipo iva", "% iva", "iva (%)", "vat rate"],
  vatAmount: ["iva", "cuota iva", "iva total"],
  irpfRate:  ["irpf%", "% irpf", "retención", "retencion", "irpf"],
  total:     ["total", "importe total", "total factura"],
  notes:     ["notas", "observaciones", "concepto", "memo"],
};

function detectColumn(headers, kind){
  const heur = COL_HEURISTICS[kind] || [];
  const lowered = headers.map(h => String(h||"").toLowerCase().trim());
  for (const cand of heur) {
    const idx = lowered.findIndex(h => h.includes(cand));
    if (idx >= 0) return idx;
  }
  return -1;
}

function parseAmount(v){
  if (v == null || v === "") return null;
  if (typeof v === "number") return v;
  let s = String(v).trim().replace(/[€$£¥\s]/g, "");
  if (!s) return null;
  let neg = false;
  if (s.startsWith("(") && s.endsWith(")")) { neg = true; s = s.slice(1, -1); }
  const lc = s.lastIndexOf(","), ld = s.lastIndexOf(".");
  if (lc > -1 && ld > -1) {
    if (lc > ld) s = s.replace(/\./g, "").replace(",", ".");
    else         s = s.replace(/,/g, "");
  } else if (lc > -1) {
    s = s.replace(/\./g, "").replace(",", ".");
  }
  const n = Number(s);
  if (isNaN(n)) return null;
  return neg ? -Math.abs(n) : n;
}

function parseDate(input){
  if (!input) return null;
  if (input instanceof Date) return input.toISOString().slice(0,10);
  if (typeof input === "number") {
    const ms = (input - 25569) * 86400 * 1000;
    const d = new Date(ms);
    return isNaN(d.getTime()) ? null : d.toISOString().slice(0,10);
  }
  const s = String(input).trim();
  let m = s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
  if (m) return `${m[1]}-${String(m[2]).padStart(2,"0")}-${String(m[3]).padStart(2,"0")}`;
  m = s.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{2,4})/);
  if (m) {
    let [, a, b, y] = m;
    a = Number(a); b = Number(b);
    let day, month;
    if (a > 12 && b <= 12) { day = a; month = b; }
    else if (b > 12 && a <= 12) { day = b; month = a; }
    else { day = a; month = b; }
    if (y.length === 2) y = String(2000 + Number(y));
    return `${y}-${String(month).padStart(2,"0")}-${String(day).padStart(2,"0")}`;
  }
  return null;
}

const fmtEur = (n) => new Intl.NumberFormat("es-ES", { style: "currency", currency: "EUR", maximumFractionDigits: 2 }).format(Number(n)||0);

export default function InvoiceBulkImportModal({
  type,           // "emitida" | "recibida"
  companyId,
  initialFile,    // si la zona drag&drop ya entregó un archivo, lo procesamos al montar
  existingInvoices = [],
  onClose,
  onAddInvoice,
  onToast,
}) {
  const [step, setStep]           = useState(initialFile ? "loading" : "file");
  const [busy, setBusy]           = useState(false);
  const [headers, setHeaders]     = useState([]);
  const [rows, setRows]           = useState([]);
  const [colMap, setColMap]       = useState({ number:-1, date:-1, dueDate:-1, name:-1, cif:-1, base:-1, vatRate:-1, vatAmount:-1, irpfRate:-1, total:-1, notes:-1 });
  const [parseError, setParseError] = useState("");
  const [excluded, setExcluded]   = useState(new Set());
  const fileInputRef = useRef(null);

  useEffect(() => {
    if (initialFile) handleFile(initialFile);
  }, []);

  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const handleFile = async (file) => {
    setParseError("");
    setBusy(true);
    setStep("loading");
    try {
      const lower = (file.name || "").toLowerCase();
      let parsedHeaders, parsedRows;
      if (lower.endsWith(".csv")) {
        const Papa = (await import("papaparse")).default;
        let text = await file.text();
        if (/[\uFFFD]/.test(text)) {
          const buf = await file.arrayBuffer();
          text = new TextDecoder("iso-8859-1").decode(buf);
        }
        const out = Papa.parse(text, { skipEmptyLines: true });
        if (!out.data?.length) throw new Error("CSV vacío");
        let headerIdx = 0;
        for (let i = 0; i < Math.min(10, out.data.length); i++) {
          const filled = out.data[i].filter(c => String(c||"").trim()).length;
          if (filled >= 3) { headerIdx = i; break; }
        }
        parsedHeaders = (out.data[headerIdx] || []).map(c => String(c||"").trim());
        parsedRows = out.data.slice(headerIdx + 1).filter(r => r.some(c => c !== "" && c != null));
      } else if (lower.endsWith(".xlsx") || lower.endsWith(".xls")) {
        const XLSX = await import("xlsx");
        const wb = XLSX.read(await file.arrayBuffer(), { type: "array", cellDates: true });
        const sheetName = wb.SheetNames[0];
        if (!sheetName) throw new Error("Excel sin hojas");
        const ws = wb.Sheets[sheetName];
        const arr = XLSX.utils.sheet_to_json(ws, { header: 1, defval: "", raw: true });
        if (!arr.length) throw new Error("Hoja vacía");
        let headerIdx = 0;
        for (let i = 0; i < Math.min(10, arr.length); i++) {
          const filled = arr[i].filter(c => String(c||"").trim()).length;
          if (filled >= 3) { headerIdx = i; break; }
        }
        parsedHeaders = arr[headerIdx].map(c => String(c||"").trim());
        parsedRows = arr.slice(headerIdx + 1).filter(r => r.some(c => c !== "" && c != null));
      } else {
        throw new Error("Formato no soportado. Usa .xlsx, .xls o .csv");
      }
      setHeaders(parsedHeaders);
      setRows(parsedRows);
      setColMap({
        number:    detectColumn(parsedHeaders, "number"),
        date:      detectColumn(parsedHeaders, "date"),
        dueDate:   detectColumn(parsedHeaders, "dueDate"),
        name:      detectColumn(parsedHeaders, "name"),
        cif:       detectColumn(parsedHeaders, "cif"),
        base:      detectColumn(parsedHeaders, "base"),
        vatRate:   detectColumn(parsedHeaders, "vatRate"),
        vatAmount: detectColumn(parsedHeaders, "vatAmount"),
        irpfRate:  detectColumn(parsedHeaders, "irpfRate"),
        total:     detectColumn(parsedHeaders, "total"),
        notes:     detectColumn(parsedHeaders, "notes"),
      });
      setExcluded(new Set());
      setStep("preview");
    } catch (e) {
      console.warn("[invoice-bulk] parse fallo:", e);
      setParseError(e.message || "Error leyendo el archivo");
      setStep("file");
    } finally {
      setBusy(false);
    }
  };

  // Build de payloads desde rows + colMap. Cada fila se convierte en una
  // factura con una sola línea (la base imponible). Si la columna `base`
  // no existe, deducimos desde total - iva - irpf.
  const parsed = useMemo(() => {
    if (step !== "preview" || rows.length === 0) return [];
    return rows.map((r, idx) => {
      const get = (k) => colMap[k] >= 0 ? r[colMap[k]] : null;
      const number   = String(get("number")||"").trim();
      const date     = parseDate(get("date"));
      const dueDate  = parseDate(get("dueDate"));
      const name     = String(get("name")||"").trim();
      const cif      = String(get("cif")||"").trim().toUpperCase();
      const base     = parseAmount(get("base"));
      const vatRate  = parseAmount(get("vatRate"));
      const vatAmt   = parseAmount(get("vatAmount"));
      const irpfRate = parseAmount(get("irpfRate"));
      const total    = parseAmount(get("total"));
      const notes    = String(get("notes")||"").trim();
      // Determinar tipo IVA. Si tenemos solo base + IVA importe, calculamos el rate.
      let computedVat = vatRate;
      if (computedVat == null && base && base > 0 && vatAmt != null) {
        computedVat = Math.round((vatAmt / base) * 100);
      }
      // Determinar base si solo viene total. Asumimos vatRate fallback 21% si no hay nada.
      let computedBase = base;
      const finalVat = computedVat != null ? computedVat : 21;
      if (computedBase == null && total != null) {
        const vMul = 1 + finalVat/100;
        const irpfMul = (irpfRate||0)/100;
        // total = base + base*v - base*irpf = base * (1 + v - irpf)
        computedBase = total / (vMul - irpfMul);
      }
      return {
        rowIdx: idx,
        number, date, dueDate, name, cif, notes,
        base: computedBase,
        vatRate: finalVat,
        irpfRate: irpfRate != null ? irpfRate : 0,
        total: total != null ? total : (computedBase != null ? computedBase * (1 + finalVat/100) - (computedBase * (irpfRate||0)/100) : 0),
      };
    }).filter(p => p.name && p.date && p.base != null && p.base > 0);
  }, [step, rows, colMap]);

  // Detección de duplicados: mismo nº + mismo CIF en facturas existentes.
  const withDupes = useMemo(() => {
    const existingKeys = new Set();
    for (const inv of existingInvoices) {
      if (inv.type !== type) continue;
      const cif = (inv.counterparty?.cif||"").toUpperCase();
      const num = String(inv.number||"").trim();
      if (cif && num) existingKeys.add(`${cif}|${num}`);
    }
    return parsed.map(p => ({
      ...p,
      isDupe: !!(p.cif && p.number && existingKeys.has(`${p.cif}|${p.number}`)),
    }));
  }, [parsed, existingInvoices, type]);

  const stats = useMemo(() => {
    const list = withDupes.filter(p => !excluded.has(p.rowIdx));
    let totalSum = 0, vatSum = 0, dupes = 0;
    for (const p of list) {
      totalSum += Number(p.total)||0;
      vatSum   += (Number(p.base)||0) * (Number(p.vatRate)||0)/100;
      if (p.isDupe) dupes++;
    }
    return { count: list.length, total: totalSum, vat: vatSum, dupes };
  }, [withDupes, excluded]);

  const toggleExcluded = (idx) => setExcluded(s => {
    const n = new Set(s); n.has(idx) ? n.delete(idx) : n.add(idx); return n;
  });
  const toggleAll = () => {
    if (excluded.size === 0) setExcluded(new Set(withDupes.map(p => p.rowIdx)));
    else setExcluded(new Set());
  };

  const canImport = step === "preview" && stats.count > 0 && !!companyId && companyId !== "all";
  const canMap = headers.length > 0 && colMap.date >= 0 && colMap.name >= 0
    && (colMap.base >= 0 || colMap.total >= 0);

  const handleImport = () => {
    if (!canImport) return;
    let createdCount = 0;
    for (const p of withDupes) {
      if (excluded.has(p.rowIdx)) continue;
      onAddInvoice?.({
        type,
        companyId,
        number: p.number || null,
        date: p.date,
        dueDate: p.dueDate || null,
        counterparty: { name: p.name, cif: p.cif, address: "" },
        lines: [{
          description: p.notes || "Factura importada",
          quantity: 1,
          unitPrice: Number(p.base)||0,
          vatRate: Number(p.vatRate)||0,
        }],
        irpfRate: Number(p.irpfRate)||0,
        notes: p.notes || "",
        status: "pendiente",
      });
      createdCount++;
    }
    onToast?.(`✓ ${createdCount} factura${createdCount!==1?"s":""} ${type} importada${createdCount!==1?"s":""}`, "success");
    onClose();
  };

  const onPickFile = (e) => {
    const f = e.target.files?.[0];
    e.target.value = "";
    if (f) handleFile(f);
  };
  const onDropFile = (e) => {
    e.preventDefault();
    const f = e.dataTransfer.files?.[0];
    if (f) handleFile(f);
  };

  return (
    <div onClick={(e) => e.target === e.currentTarget && onClose()} style={overlayStyle}>
      <div style={{ ...modalStyle, borderTop: "4px solid #27AE60" }}>
        <div style={modalHeader}>
          <div style={{ fontSize: 14, fontWeight: 700 }}>📊 Importar facturas {type === "emitida" ? "emitidas" : "recibidas"} (Excel/CSV)</div>
          <button onClick={onClose} style={closeBtn}>×</button>
        </div>
        <div style={modalBody}>
          {step === "file" && (
            <div
              onDragOver={(e) => e.preventDefault()}
              onDrop={onDropFile}
              onClick={() => fileInputRef.current?.click()}
              style={{ border: "2px dashed #BDC3C7", borderRadius: 12, padding: "32px 22px", textAlign: "center", background: "#FAFAFA", cursor: "pointer" }}
            >
              <div style={{ fontSize: 32, marginBottom: 8 }}>📊</div>
              <div style={{ fontSize: 14, fontWeight: 600 }}>Arrastra el archivo o haz clic</div>
              <div style={{ fontSize: 11.5, color: "#7F8C8D", marginTop: 6 }}>Acepta .xlsx, .xls, .csv</div>
              <input ref={fileInputRef} type="file" accept=".xlsx,.xls,.csv" onChange={onPickFile} style={{ display: "none" }} />
            </div>
          )}

          {step === "loading" && (
            <div style={{ padding: 30, textAlign: "center", color: "#6B7280" }}>⏳ Procesando archivo…</div>
          )}

          {parseError && (
            <div style={{ padding: "10px 12px", background: "#FEE2E2", border: "1px solid #FCA5A5", borderRadius: 8, color: "#991B1B", fontSize: 12 }}>⚠ {parseError}</div>
          )}

          {step === "preview" && headers.length > 0 && (
            <div style={{ background: "#F9FAFB", border: "0.5px solid #E5E7EB", borderRadius: 8, padding: 12 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: "#6B7280", textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 8 }}>Asignación de columnas</div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 8 }}>
                <Mapper label="Nº factura"     value={colMap.number}    headers={headers} onChange={v => setColMap(c => ({...c, number: v}))} />
                <Mapper label="Fecha *"        value={colMap.date}      headers={headers} onChange={v => setColMap(c => ({...c, date: v}))} required />
                <Mapper label="Vencimiento"    value={colMap.dueDate}   headers={headers} onChange={v => setColMap(c => ({...c, dueDate: v}))} />
                <Mapper label={type==="emitida"?"Cliente *":"Proveedor *"} value={colMap.name} headers={headers} onChange={v => setColMap(c => ({...c, name: v}))} required />
                <Mapper label="CIF / NIF"      value={colMap.cif}       headers={headers} onChange={v => setColMap(c => ({...c, cif: v}))} />
                <Mapper label="Base imponible *(o Total)" value={colMap.base} headers={headers} onChange={v => setColMap(c => ({...c, base: v}))} required={colMap.total < 0} />
                <Mapper label="Tipo IVA (%)"   value={colMap.vatRate}   headers={headers} onChange={v => setColMap(c => ({...c, vatRate: v}))} />
                <Mapper label="IVA (importe)"  value={colMap.vatAmount} headers={headers} onChange={v => setColMap(c => ({...c, vatAmount: v}))} />
                <Mapper label="IRPF (%)"       value={colMap.irpfRate}  headers={headers} onChange={v => setColMap(c => ({...c, irpfRate: v}))} />
                <Mapper label="Total"          value={colMap.total}     headers={headers} onChange={v => setColMap(c => ({...c, total: v}))} />
                <Mapper label="Notas"          value={colMap.notes}     headers={headers} onChange={v => setColMap(c => ({...c, notes: v}))} />
              </div>
              {!canMap && (
                <div style={{ fontSize: 11, color: "#92400E", marginTop: 8 }}>
                  ⚠ Asigna como mínimo: fecha, {type==="emitida"?"cliente":"proveedor"} y base imponible (o total).
                </div>
              )}
            </div>
          )}

          {step === "preview" && canMap && (
            <>
              <div style={{ display: "flex", gap: 16, flexWrap: "wrap", padding: "10px 12px", background: "#F9FAFB", border: "0.5px solid #E5E7EB", borderRadius: 8, fontSize: 12 }}>
                <div><b style={{ color: "#111827" }}>{stats.count}</b> factura{stats.count!==1?"s":""}</div>
                <div style={{ color: "#0E7C5A" }}>Total: {fmtEur(stats.total)}</div>
                <div style={{ color: "#374151" }}>IVA: {fmtEur(stats.vat)}</div>
                {stats.dupes > 0 && <div style={{ color: "#92400E" }}>⚠ {stats.dupes} posible{stats.dupes!==1?"s":""} duplicado{stats.dupes!==1?"s":""}</div>}
              </div>
              <div style={{ background: "#fff", border: "1px solid #E5E7EB", borderRadius: 8, overflow: "hidden", maxHeight: 320, overflowY: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11.5 }}>
                  <thead style={{ position: "sticky", top: 0, background: "#FAFAFA", borderBottom: "0.5px solid #E5E7EB" }}>
                    <tr>
                      <th style={{ ...th, width: 36 }}><input type="checkbox" checked={excluded.size === 0} onChange={toggleAll} /></th>
                      <th style={th}>Nº</th>
                      <th style={th}>Fecha</th>
                      <th style={{ ...th, textAlign: "left" }}>{type === "emitida" ? "Cliente" : "Proveedor"}</th>
                      <th style={th}>CIF</th>
                      <th style={{ ...th, textAlign: "right" }}>Base</th>
                      <th style={{ ...th, textAlign: "right" }}>IVA</th>
                      <th style={{ ...th, textAlign: "right" }}>Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {withDupes.map(p => {
                      const isExcl = excluded.has(p.rowIdx);
                      return (
                        <tr key={p.rowIdx} style={{ borderTop: "0.5px solid #F3F4F6", opacity: isExcl ? 0.4 : 1, background: p.isDupe && !isExcl ? "#FEF3C7" : "transparent" }}>
                          <td style={{ ...td, padding: "6px 10px" }}>
                            <input type="checkbox" checked={!isExcl} onChange={() => toggleExcluded(p.rowIdx)} />
                          </td>
                          <td style={{ ...td, fontFamily: "ui-monospace,monospace" }}>{p.number || "—"}</td>
                          <td style={td}>{p.date}</td>
                          <td style={{ ...td, textAlign: "left" }}>{p.isDupe && !isExcl && <span title="Posible duplicado">⚠️ </span>}{p.name}</td>
                          <td style={{ ...td, fontFamily: "ui-monospace,monospace", color: "#9CA3AF" }}>{p.cif || "—"}</td>
                          <td style={{ ...td, textAlign: "right", fontFamily: "ui-monospace,monospace" }}>{fmtEur(p.base)}</td>
                          <td style={{ ...td, textAlign: "right", fontFamily: "ui-monospace,monospace", color: "#0E7C5A" }}>{p.vatRate}%</td>
                          <td style={{ ...td, textAlign: "right", fontFamily: "ui-monospace,monospace", fontWeight: 700 }}>{fmtEur(p.total)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                {withDupes.length === 0 && (
                  <div style={{ padding: "20px 12px", textAlign: "center", color: "#9CA3AF", fontSize: 12 }}>Ninguna fila parseable. Revisa el mapeo de columnas.</div>
                )}
              </div>
            </>
          )}

          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 4 }}>
            <button onClick={onClose} style={{ padding: "8px 14px", borderRadius: 8, background: "transparent", border: "1px solid #D1D5DB", fontSize: 12, fontWeight: 500, cursor: "pointer", fontFamily: "inherit" }}>Cancelar</button>
            {step === "preview" && (
              <button
                onClick={handleImport}
                disabled={!canImport}
                style={canImport
                  ? { padding: "8px 18px", borderRadius: 8, background: "#27AE60", color: "#fff", border: "none", fontSize: 12, fontWeight: 600, cursor: "pointer", fontFamily: "inherit" }
                  : { padding: "8px 18px", borderRadius: 8, background: "#E5E7EB", color: "#9CA3AF", border: "none", fontSize: 12, fontWeight: 600, cursor: "default", fontFamily: "inherit" }
                }
              >Importar {stats.count > 0 ? `${stats.count} factura${stats.count!==1?"s":""}` : ""}</button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function Mapper({ label, value, headers, onChange, required }) {
  return (
    <div>
      <div style={{ fontSize: 10, fontWeight: 600, color: required && value < 0 ? "#B91C1C" : "#6B7280", textTransform: "uppercase", letterSpacing: 0.4, marginBottom: 3 }}>{label}</div>
      <select value={value} onChange={e => onChange(Number(e.target.value))} style={{ ...inputStyle, fontSize: 12 }}>
        <option value={-1}>— Sin asignar —</option>
        {headers.map((h, i) => <option key={i} value={i}>{h || `(col ${i+1})`}</option>)}
      </select>
    </div>
  );
}

const inputStyle = { padding: "8px 10px", borderRadius: 8, border: "0.5px solid #D1D5DB", fontSize: 13, fontFamily: "inherit", outline: "none", boxSizing: "border-box", background: "#fff", width: "100%" };
const overlayStyle = { position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)", zIndex: 3000, display: "flex", alignItems: "center", justifyContent: "center", padding: 20 };
const modalStyle = { background: "#fff", borderRadius: 14, width: 760, maxWidth: "96vw", overflow: "hidden", maxHeight: "92vh", display: "flex", flexDirection: "column" };
const modalHeader = { padding: "14px 18px", borderBottom: "0.5px solid #E5E7EB", display: "flex", alignItems: "center", justifyContent: "space-between", flexShrink: 0 };
const modalBody = { padding: 18, display: "flex", flexDirection: "column", gap: 14, overflowY: "auto" };
const closeBtn = { background: "none", border: "none", fontSize: 20, cursor: "pointer", color: "#6B7280" };
const th = { padding: "8px 10px", textAlign: "center", fontSize: 10.5, fontWeight: 700, color: "#6B7280", textTransform: "uppercase", letterSpacing: 0.4 };
const td = { padding: "6px 10px", textAlign: "center", color: "#111827" };
