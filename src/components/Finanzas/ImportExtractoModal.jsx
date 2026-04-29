// ImportExtractoModal — wizard de importación de extractos bancarios
// (Excel xlsx/xls y CSV). Cuatro pasos:
//   1. Seleccionar cuenta destino.
//   2. Subir/arrastrar archivo (parser dinámico — xlsx y papaparse se
//      cargan vía dynamic import para no inflar el bundle inicial).
//   3. Detección automática de columnas (fecha, concepto, importe, saldo)
//      con fallback a mapping manual.
//   4. Preview con dupe detection + auto-categorización por keywords +
//      checkboxes individuales para excluir filas.
//
// Persistencia: cada importación recibe un importBatchId (uuid) para
// poder deshacerse en bloque desde la UI de Bancos.
import React, { useEffect, useMemo, useRef, useState } from "react";

const COL_HEURISTICS = {
  date:    ["fecha", "date", "f.valor", "fecha valor", "value date", "fecha operación", "fecha operacion", "f.operacion", "f.operación"],
  concept: ["concepto", "descripción", "descripcion", "description", "detalle", "referencia", "subject", "counterparty name", "memo", "operación", "operacion"],
  amount:  ["importe", "amount", "cantidad", "monto", "total amount"],
  balance: ["saldo", "balance"],
};

// Auto-categorización por keywords en el concepto. Devuelve el id de
// movementCategory o null si nada matchea — el usuario o Diego categorizan
// luego. La lista es deliberadamente conservadora (precision > recall).
const CATEGORY_RULES = [
  { id: "personal",        re: /\b(nomina|nómina|seguridad social|sepa.*ssoc|tgss|seg.*social)\b/i },
  { id: "alquiler",        re: /\b(alquiler|arrendamiento|renta vivienda|renta local)\b/i },
  { id: "suministros",     re: /\b(luz|electricidad|endesa|iberdrola|naturgy|repsol gas|aqualia|canal isabel|gas natural|orange|movistar|vodafone|jazztel|fibra)\b/i },
  { id: "seguros",         re: /\b(seguro|mapfre|axa|allianz|mutua|generali|sanitas|adeslas|línea directa|linea directa)\b/i },
  { id: "impuestos",       re: /\b(hacienda|aeat|modelo 30[36]|modelo 11[15]|modelo 200|modelo 202|modelo 347|modelo 390|iva trimestral|irpf|ibi)\b/i },
  { id: "comisiones_banco",re: /\b(comisi[óo]n|mantenimiento cuenta|cuota mantenim|cuota tarjeta|cargo bancario)\b/i },
  { id: "asesoria",        re: /\b(asesor[íi]a|gestor[íi]a|abogado|notario|registro mercantil)\b/i },
  { id: "marketing",       re: /\b(google ads|meta ads|facebook ads|linkedin|publicidad|marketing)\b/i },
];

// Parser de fechas tolerante: prueba YYYY-MM-DD, DD/MM/YYYY, DD-MM-YYYY,
// MM/DD/YYYY (solo si día > 12 → asume DD/MM). Devuelve string ISO YYYY-MM-DD
// o null si no se puede.
function parseDate(input){
  if (!input) return null;
  if (input instanceof Date) return isoDate(input);
  if (typeof input === "number") {
    // Excel guarda fechas como números seriales desde 1899-12-30.
    const ms = (input - 25569) * 86400 * 1000;
    const d = new Date(ms);
    return isNaN(d.getTime()) ? null : isoDate(d);
  }
  const s = String(input).trim();
  if (!s) return null;
  // ISO YYYY-MM-DD o YYYY/MM/DD
  let m = s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
  if (m) return `${m[1]}-${pad2(m[2])}-${pad2(m[3])}`;
  // DD/MM/YYYY o DD-MM-YYYY (con disambiguación si día > 12 → ya sabemos)
  m = s.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{2,4})/);
  if (m) {
    let [, a, b, y] = m;
    a = Number(a); b = Number(b);
    let day, month;
    if (a > 12 && b <= 12)      { day = a; month = b; }   // DD/MM/YYYY (sin ambigüedad)
    else if (b > 12 && a <= 12) { day = b; month = a; }   // MM/DD/YYYY (sin ambigüedad)
    else                         { day = a; month = b; }   // ambos ≤12 → asumimos DD/MM (España)
    if (y.length === 2) y = String(2000 + Number(y));
    return `${y}-${pad2(month)}-${pad2(day)}`;
  }
  return null;
}
function isoDate(d){ return `${d.getFullYear()}-${pad2(d.getMonth()+1)}-${pad2(d.getDate())}`; }
function pad2(n){ return String(n).padStart(2,"0"); }

// Parser de importes tolerante: limpia €, espacios, decide si "," o "."
// es decimal. Soporta "-1.234,56", "1234.56", "(1234.56)" (negativo).
function parseAmount(input){
  if (input == null || input === "") return null;
  if (typeof input === "number") return input;
  let s = String(input).trim().replace(/[€$£¥\s]/g, "");
  if (!s) return null;
  // Paréntesis = negativo (formato contable)
  let negative = false;
  if (s.startsWith("(") && s.endsWith(")")) { negative = true; s = s.slice(1, -1); }
  // Si tiene "," y "." → el último es el decimal
  const lastComma = s.lastIndexOf(",");
  const lastDot   = s.lastIndexOf(".");
  if (lastComma > -1 && lastDot > -1) {
    if (lastComma > lastDot) {
      // 1.234,56 → coma decimal
      s = s.replace(/\./g, "").replace(",", ".");
    } else {
      // 1,234.56 → punto decimal
      s = s.replace(/,/g, "");
    }
  } else if (lastComma > -1) {
    // Solo coma → asumimos decimal europeo
    s = s.replace(/\./g, "").replace(",", ".");
  }
  // s = ahora con punto decimal (o entero)
  const n = Number(s);
  if (isNaN(n)) return null;
  return negative ? -Math.abs(n) : n;
}

function categorizeByKeywords(concept){
  if (!concept) return null;
  for (const rule of CATEGORY_RULES) {
    if (rule.re.test(concept)) return rule.id;
  }
  return null;
}

function detectColumn(headers, kind){
  const heuristics = COL_HEURISTICS[kind] || [];
  const lowered = headers.map(h => String(h||"").toLowerCase().trim());
  for (const candidate of heuristics) {
    const idx = lowered.findIndex(h => h.includes(candidate));
    if (idx >= 0) return idx;
  }
  return -1;
}

// Genera el importBatchId que agrupa todos los movimientos de una import.
function genBatchId(){
  if (typeof crypto !== "undefined" && crypto.randomUUID) return `imp_${crypto.randomUUID().slice(0,12)}`;
  return `imp_${Date.now()}_${Math.random().toString(36).slice(2,8)}`;
}

export default function ImportExtractoModal({ accounts, existingMovements, defaultAccountId, onClose, onImport }) {
  const [accountId, setAccountId] = useState(defaultAccountId || accounts[0]?.id || "");
  const [step, setStep] = useState("file"); // file | preview
  const [busy, setBusy] = useState(false);
  const [parseError, setParseError] = useState("");
  const [headers, setHeaders] = useState([]);
  const [rows, setRows] = useState([]);             // parsed raw rows (array of arrays)
  const [colMap, setColMap] = useState({ date: -1, concept: -1, amount: -1, balance: -1 });
  const [importedFrom, setImportedFrom] = useState("manual");
  const [excluded, setExcluded] = useState(new Set());
  const [isDragOver, setIsDragOver] = useState(false);
  const fileInputRef = useRef(null);

  // ESC cierra
  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const handleFile = async (file) => {
    setParseError("");
    setBusy(true);
    try {
      const lower = (file.name || "").toLowerCase();
      let parsedHeaders, parsedRows, source;
      if (lower.endsWith(".csv")) {
        ({ headers: parsedHeaders, rows: parsedRows } = await parseCsvFile(file));
        source = "csv";
      } else if (lower.endsWith(".xlsx") || lower.endsWith(".xls")) {
        ({ headers: parsedHeaders, rows: parsedRows } = await parseExcelFile(file));
        source = "excel";
      } else {
        throw new Error("Formato no soportado. Usa .xlsx, .xls o .csv");
      }
      setHeaders(parsedHeaders);
      setRows(parsedRows);
      setColMap({
        date:    detectColumn(parsedHeaders, "date"),
        concept: detectColumn(parsedHeaders, "concept"),
        amount:  detectColumn(parsedHeaders, "amount"),
        balance: detectColumn(parsedHeaders, "balance"),
      });
      setImportedFrom(source);
      setExcluded(new Set());
      setStep("preview");
    } catch (e) {
      console.warn("[import] parse fallo:", e);
      setParseError(e.message || "Error leyendo el archivo");
    } finally {
      setBusy(false);
    }
  };

  const onPick = () => fileInputRef.current?.click();
  const onPickChange = (e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) handleFile(f); };
  const onDrop = (e) => { e.preventDefault(); setIsDragOver(false); const f = e.dataTransfer.files?.[0]; if (f) handleFile(f); };

  // Movimientos parseados (después de aplicar colMap). Se recalculan al
  // cambiar la asignación de columnas.
  const parsedMovements = useMemo(() => {
    if (step !== "preview" || rows.length === 0) return [];
    return rows.map((r, idx) => {
      const dateRaw   = colMap.date    >= 0 ? r[colMap.date]    : null;
      const conceptRaw= colMap.concept >= 0 ? r[colMap.concept] : "";
      const amountRaw = colMap.amount  >= 0 ? r[colMap.amount]  : null;
      const balanceRaw= colMap.balance >= 0 ? r[colMap.balance] : null;
      const date    = parseDate(dateRaw);
      const amount  = parseAmount(amountRaw);
      const balance = parseAmount(balanceRaw);
      const concept = String(conceptRaw||"").trim();
      const category = categorizeByKeywords(concept);
      return { rowIdx: idx, date, concept, amount, balance, category };
    }).filter(m => m.date && typeof m.amount === "number" && !isNaN(m.amount));
  }, [step, rows, colMap]);

  // Detección de duplicados contra existingMovements (mismo día, importe
  // y concepto). Marcamos con flag, no se excluyen automáticamente — el
  // usuario decide si los importa.
  const movementsWithDupes = useMemo(() => {
    const existingKeys = new Set();
    for (const m of (existingMovements||[])) {
      const k = `${m.date}|${(Number(m.amount)||0).toFixed(2)}|${(m.concept||"").trim().toLowerCase()}`;
      existingKeys.add(k);
    }
    return parsedMovements.map(m => {
      const k = `${m.date}|${(m.amount||0).toFixed(2)}|${(m.concept||"").trim().toLowerCase()}`;
      return { ...m, isDupe: existingKeys.has(k) };
    });
  }, [parsedMovements, existingMovements]);

  const stats = useMemo(() => {
    const list = movementsWithDupes.filter(m => !excluded.has(m.rowIdx));
    let income = 0, expense = 0, dupes = 0, withCat = 0;
    for (const m of list) {
      if (m.amount >= 0) income += m.amount; else expense += Math.abs(m.amount);
      if (m.isDupe) dupes++;
      if (m.category) withCat++;
    }
    return { count: list.length, income, expense, dupes, withCat };
  }, [movementsWithDupes, excluded]);

  const toggleExcluded = (idx) => setExcluded(s => {
    const n = new Set(s); n.has(idx) ? n.delete(idx) : n.add(idx); return n;
  });
  const toggleAll = () => {
    if (excluded.size === 0) {
      // todo seleccionado → quitar todos
      setExcluded(new Set(movementsWithDupes.map(m => m.rowIdx)));
    } else {
      setExcluded(new Set());
    }
  };

  const handleImport = () => {
    const batchId = genBatchId();
    const list = movementsWithDupes
      .filter(m => !excluded.has(m.rowIdx))
      .map(m => ({
        accountId,
        date: m.date,
        valueDate: m.date,
        concept: m.concept,
        amount: m.amount,
        balance: typeof m.balance === "number" ? m.balance : null,
        category: m.category || null,
        reconciled: false,
        notes: "",
        importedFrom,
        importBatchId: batchId,
      }));
    onImport(list, batchId);
    onClose();
  };

  const canImport = !!accountId && step === "preview" && stats.count > 0;
  const canMap = headers.length > 0 && colMap.date >= 0 && colMap.concept >= 0 && colMap.amount >= 0;

  return (
    <div onClick={(e) => e.target === e.currentTarget && onClose()} style={overlayStyle}>
      <div style={{ ...modalStyle, borderTop: "4px solid #27AE60" }}>
        <div style={modalHeader}>
          <div style={{ fontSize: 14, fontWeight: 700 }}>📤 Importar extracto bancario</div>
          <button onClick={onClose} style={closeBtn}>×</button>
        </div>
        <div style={modalBody}>
          {/* Paso 1: Cuenta destino */}
          <Field label="Cuenta destino">
            <select value={accountId} onChange={e => setAccountId(e.target.value)} style={inputStyle}>
              <option value="">— Selecciona cuenta —</option>
              {accounts.map(a => <option key={a.id} value={a.id}>🏦 {a.bankName}{a.alias?` · ${a.alias}`:""}</option>)}
            </select>
          </Field>

          {/* Paso 2: Subir archivo (visible si no hay datos parseados) */}
          {step === "file" && (
            <div
              onDragOver={(e) => { e.preventDefault(); setIsDragOver(true); }}
              onDragLeave={() => setIsDragOver(false)}
              onDrop={onDrop}
              onClick={!busy ? onPick : undefined}
              style={{
                border: `2px dashed ${isDragOver ? "#27AE60" : "#BDC3C7"}`,
                borderRadius: 12,
                padding: "32px 22px",
                textAlign: "center",
                background: isDragOver ? "#F0FDF4" : "#FAFAFA",
                cursor: busy ? "wait" : "pointer",
                transition: "all .2s",
                opacity: !accountId ? 0.5 : 1,
                pointerEvents: !accountId ? "none" : "auto",
              }}
            >
              <div style={{ fontSize: 32, marginBottom: 8 }}>📤</div>
              <div style={{ fontSize: 14, fontWeight: 600, color: "#111827" }}>
                {busy ? "Procesando…" : "Arrastra el extracto aquí o haz clic"}
              </div>
              <div style={{ fontSize: 11.5, color: "#7F8C8D", marginTop: 6 }}>
                Acepta .xlsx, .xls, .csv. Detecta columnas automáticamente.
              </div>
              <input ref={fileInputRef} type="file" accept=".xlsx,.xls,.csv" onChange={onPickChange} style={{ display: "none" }} />
            </div>
          )}

          {parseError && (
            <div style={{ padding: "10px 12px", background: "#FEE2E2", border: "1px solid #FCA5A5", borderRadius: 8, color: "#991B1B", fontSize: 12 }}>⚠ {parseError}</div>
          )}

          {/* Paso 3: Mapeo de columnas si la detección falló */}
          {step === "preview" && headers.length > 0 && (
            <div style={{ background: "#F9FAFB", border: "0.5px solid #E5E7EB", borderRadius: 8, padding: 12 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: "#6B7280", textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 8 }}>Asignación de columnas</div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(2,1fr)", gap: 8 }}>
                <ColumnMapper label="Fecha *"     value={colMap.date}    headers={headers} onChange={v => setColMap(c=>({...c, date: v}))} required />
                <ColumnMapper label="Concepto *"  value={colMap.concept} headers={headers} onChange={v => setColMap(c=>({...c, concept: v}))} required />
                <ColumnMapper label="Importe *"   value={colMap.amount}  headers={headers} onChange={v => setColMap(c=>({...c, amount: v}))} required />
                <ColumnMapper label="Saldo"       value={colMap.balance} headers={headers} onChange={v => setColMap(c=>({...c, balance: v}))} />
              </div>
              {!canMap && (
                <div style={{ fontSize: 11, color: "#92400E", marginTop: 8 }}>⚠ Asigna las columnas obligatorias (fecha, concepto, importe) para continuar.</div>
              )}
            </div>
          )}

          {/* Paso 4: Preview de movimientos */}
          {step === "preview" && canMap && (
            <>
              <div style={{ display: "flex", gap: 16, flexWrap: "wrap", padding: "10px 12px", background: "#F9FAFB", border: "0.5px solid #E5E7EB", borderRadius: 8, fontSize: 12 }}>
                <div><b style={{ color: "#111827" }}>{stats.count}</b> movimiento{stats.count!==1?"s":""}</div>
                <div style={{ color: "#0E7C5A" }}>↗ {fmtEur(stats.income)}</div>
                <div style={{ color: "#B91C1C" }}>↙ {fmtEur(stats.expense)}</div>
                {stats.withCat > 0 && <div style={{ color: "#374151" }}>🏷 {stats.withCat} auto-categorizados</div>}
                {stats.dupes > 0 && <div style={{ color: "#92400E" }}>⚠ {stats.dupes} posible{stats.dupes!==1?"s":""} duplicado{stats.dupes!==1?"s":""}</div>}
              </div>
              <div style={{ background: "#fff", border: "1px solid #E5E7EB", borderRadius: 8, overflow: "hidden", maxHeight: 320, overflowY: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11.5 }}>
                  <thead style={{ position: "sticky", top: 0, background: "#FAFAFA", borderBottom: "0.5px solid #E5E7EB" }}>
                    <tr>
                      <th style={{ ...th, width: 36 }}>
                        <input type="checkbox" checked={excluded.size === 0} onChange={toggleAll} />
                      </th>
                      <th style={th}>Fecha</th>
                      <th style={{ ...th, textAlign: "left" }}>Concepto</th>
                      <th style={{ ...th, textAlign: "right" }}>Importe</th>
                      <th style={th}>Categoría</th>
                    </tr>
                  </thead>
                  <tbody>
                    {movementsWithDupes.map(m => {
                      const isExcluded = excluded.has(m.rowIdx);
                      const isIncome = m.amount >= 0;
                      return (
                        <tr key={m.rowIdx} style={{ borderTop: "0.5px solid #F3F4F6", opacity: isExcluded ? 0.4 : 1, background: m.isDupe && !isExcluded ? "#FEF3C7" : "transparent" }}>
                          <td style={{ ...td, padding: "6px 10px" }}>
                            <input type="checkbox" checked={!isExcluded} onChange={() => toggleExcluded(m.rowIdx)} />
                          </td>
                          <td style={{ ...td, fontFamily: "ui-monospace,monospace" }}>{m.date}</td>
                          <td style={{ ...td, textAlign: "left" }}>
                            {m.isDupe && !isExcluded && <span title="Posible duplicado" style={{ marginRight: 4 }}>⚠️</span>}
                            {m.concept || "(sin concepto)"}
                          </td>
                          <td style={{ ...td, textAlign: "right", fontFamily: "ui-monospace,monospace", color: isIncome ? "#0E7C5A" : "#B91C1C", fontWeight: 600 }}>
                            {isIncome?"+":""}{fmtEur(m.amount)}
                          </td>
                          <td style={td}>{m.category ? <span style={{ fontSize: 10, padding: "1px 6px", borderRadius: 8, background: "#F3F4F6", color: "#374151" }}>{m.category}</span> : <span style={{ color: "#9CA3AF" }}>—</span>}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                {movementsWithDupes.length === 0 && (
                  <div style={{ padding: "20px 12px", textAlign: "center", color: "#9CA3AF", fontSize: 12 }}>Ninguna fila parseable. Revisa el mapeo de columnas.</div>
                )}
              </div>
            </>
          )}

          <div style={{ display: "flex", gap: 8, justifyContent: "space-between", marginTop: 4 }}>
            {step === "preview" && (
              <button onClick={() => { setStep("file"); setRows([]); setHeaders([]); setColMap({date:-1,concept:-1,amount:-1,balance:-1}); setExcluded(new Set()); setParseError(""); }} style={{ padding: "8px 14px", borderRadius: 8, background: "transparent", border: "1px solid #D1D5DB", fontSize: 12, fontWeight: 500, cursor: "pointer", fontFamily: "inherit" }}>← Cambiar archivo</button>
            )}
            <div style={{ display: "flex", gap: 8, marginLeft: "auto" }}>
              <button onClick={onClose} style={{ padding: "8px 14px", borderRadius: 8, background: "transparent", border: "1px solid #D1D5DB", fontSize: 12, fontWeight: 500, cursor: "pointer", fontFamily: "inherit" }}>Cancelar</button>
              {step === "preview" && (
                <button
                  onClick={handleImport}
                  disabled={!canImport}
                  style={canImport ? primaryBtn("#27AE60") : disabledBtn}
                >Importar {stats.count > 0 ? `${stats.count} movimiento${stats.count!==1?"s":""}` : ""}</button>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function ColumnMapper({ label, value, headers, onChange, required }) {
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

// ── Parsers (dynamic imports para no inflar el bundle inicial) ──

async function parseExcelFile(file){
  const XLSX = await import("xlsx");
  const buffer = await file.arrayBuffer();
  const wb = XLSX.read(buffer, { type: "array", cellDates: true });
  const sheetName = wb.SheetNames[0];
  if (!sheetName) throw new Error("Excel sin hojas");
  const ws = wb.Sheets[sheetName];
  const arr = XLSX.utils.sheet_to_json(ws, { header: 1, defval: "", raw: true });
  if (!arr.length) throw new Error("Hoja vacía");
  // Buscar la primera fila que parece header (≥3 columnas no vacías).
  let headerIdx = 0;
  for (let i = 0; i < Math.min(10, arr.length); i++) {
    const filled = arr[i].filter(c => String(c||"").trim()).length;
    if (filled >= 3) { headerIdx = i; break; }
  }
  const headers = arr[headerIdx].map(c => String(c||"").trim());
  const rows = arr.slice(headerIdx + 1).filter(r => r.some(c => c !== "" && c != null));
  return { headers, rows };
}

async function parseCsvFile(file){
  const Papa = (await import("papaparse")).default;
  // Intento UTF-8 primero, fallback a ISO-8859-1 si hay caracteres raros.
  let text = await file.text();
  if (/[\uFFFD]/.test(text)) {
    // Re-leer como ISO-8859-1
    const buffer = await file.arrayBuffer();
    const decoder = new TextDecoder("iso-8859-1");
    text = decoder.decode(buffer);
  }
  const result = Papa.parse(text, { skipEmptyLines: true });
  if (!result.data?.length) throw new Error("CSV vacío");
  // Detectar la primera fila con ≥3 columnas no vacías como header.
  let headerIdx = 0;
  for (let i = 0; i < Math.min(10, result.data.length); i++) {
    const filled = result.data[i].filter(c => String(c||"").trim()).length;
    if (filled >= 3) { headerIdx = i; break; }
  }
  const headers = (result.data[headerIdx] || []).map(c => String(c||"").trim());
  const rows = result.data.slice(headerIdx + 1).filter(r => r.some(c => c !== "" && c != null));
  return { headers, rows };
}

const fmtEur = (n) => typeof n === "number"
  ? new Intl.NumberFormat("es-ES", { style: "currency", currency: "EUR", maximumFractionDigits: 2 }).format(n)
  : "—";

const inputStyle = { padding: "8px 10px", borderRadius: 8, border: "0.5px solid #D1D5DB", fontSize: 13, fontFamily: "inherit", outline: "none", boxSizing: "border-box", background: "#fff", width: "100%" };
const overlayStyle = { position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)", zIndex: 3000, display: "flex", alignItems: "center", justifyContent: "center", padding: 20 };
const modalStyle = { background: "#fff", borderRadius: 14, width: 720, maxWidth: "94vw", overflow: "hidden", maxHeight: "92vh", display: "flex", flexDirection: "column" };
const modalHeader = { padding: "14px 18px", borderBottom: "0.5px solid #E5E7EB", display: "flex", alignItems: "center", justifyContent: "space-between", flexShrink: 0 };
const modalBody = { padding: 18, display: "flex", flexDirection: "column", gap: 14, overflowY: "auto" };
const closeBtn = { background: "none", border: "none", fontSize: 20, cursor: "pointer", color: "#6B7280" };
const disabledBtn = { padding: "8px 18px", borderRadius: 8, background: "#E5E7EB", color: "#9CA3AF", border: "none", fontSize: 12, fontWeight: 600, cursor: "default", fontFamily: "inherit" };
const primaryBtn = (color) => ({ padding: "8px 18px", borderRadius: 8, background: color, color: "#fff", border: "none", fontSize: 12, fontWeight: 600, cursor: "pointer", fontFamily: "inherit" });
const th = { padding: "8px 10px", textAlign: "center", fontSize: 10.5, fontWeight: 700, color: "#6B7280", textTransform: "uppercase", letterSpacing: 0.4 };
const td = { padding: "6px 10px", textAlign: "center", color: "#111827" };
function Field({ label, children }) {
  return (
    <div>
      <div style={{ fontSize: 10, fontWeight: 600, color: "#6B7280", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 4 }}>{label}</div>
      {children}
    </div>
  );
}
