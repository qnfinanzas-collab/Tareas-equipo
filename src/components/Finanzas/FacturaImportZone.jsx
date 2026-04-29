// FacturaImportZone — zona drag&drop arriba de la lista de facturas.
// Acepta PDFs / imágenes (análisis IA individual) y Excel/CSV (delega al
// modal de importación masiva). El tipo de factura emitida/recibida lo
// hereda de la tab activa de Facturacion.
//
// Cola paralela: máximo 3 análisis IA simultáneos para no saturar la API
// ni la cuota Anthropic. Por debajo (en el componente padre Facturacion)
// vive el modal de importación masiva, este solo enruta.
import React, { useRef, useState } from "react";
import { analyzeInvoiceFile, normalizeExtractedInvoice, isAnalyzableInvoiceFile, findBankMatchForInvoice } from "../../lib/invoiceAI.js";

const PARALLEL_AI = 3;
const ACCEPT_AI    = ".pdf,.png,.jpg,.jpeg,.webp";
const ACCEPT_BULK  = ".xlsx,.xls,.csv";
const ACCEPT_ANY   = `${ACCEPT_AI},${ACCEPT_BULK}`;

function isBulkFile(file){
  const n = (file.name || "").toLowerCase();
  return n.endsWith(".xlsx") || n.endsWith(".xls") || n.endsWith(".csv");
}

const fmtEur = (n) => new Intl.NumberFormat("es-ES", { style: "currency", currency: "EUR", maximumFractionDigits: 2 }).format(Number(n)||0);

export default function FacturaImportZone({
  type,                   // "emitida" | "recibida"
  companyId,              // companyId activo del selector de empresa
  bankMovements = [],     // para sugerir vinculación tras crear
  onAddInvoice,           // (payload) → factura creada (mutator)
  onOpenBulkModal,        // (file) → abre el modal de import masivo
  onToast,                // (msg, level) → toasts globales
}) {
  // queue contiene archivos en proceso. Cada entrada:
  //   { id, name, status: "queued"|"running"|"done"|"error", message, partial }
  const [queue, setQueue] = useState([]);
  const [drag, setDrag]   = useState(false);
  const inputRef = useRef(null);

  const enqueueFiles = (files) => {
    if (!files || files.length === 0) return;
    if (!companyId || companyId === "all") {
      onToast?.("Selecciona una empresa concreta antes de importar facturas.", "warn");
      return;
    }
    // Separa en bulk (Excel/CSV) y AI (PDF/img).
    const bulkFiles = [], aiFiles = [], rejected = [];
    for (const f of files) {
      if (isBulkFile(f)) bulkFiles.push(f);
      else if (isAnalyzableInvoiceFile(f)) aiFiles.push(f);
      else rejected.push(f);
    }
    if (rejected.length > 0) {
      onToast?.(`Formato no soportado: ${rejected.map(r => r.name).join(", ")}`, "warn");
    }
    // Bulk: pasamos el primer archivo al modal masivo. Si hay varios bulk,
    // procesamos solo el primero (el modal carga uno cada vez).
    if (bulkFiles.length > 0 && onOpenBulkModal) {
      onOpenBulkModal(bulkFiles[0]);
      if (bulkFiles.length > 1) onToast?.(`Solo se procesa el primer archivo Excel/CSV (${bulkFiles.length} en total). Repite la operación con los demás.`, "info");
    }
    // AI: empezamos la cola.
    if (aiFiles.length > 0) startAiQueue(aiFiles);
  };

  const startAiQueue = (aiFiles) => {
    const items = aiFiles.map(f => ({
      id: `ai_${Date.now()}_${Math.random().toString(36).slice(2,6)}`,
      file: f,
      name: f.name,
      status: "queued",
      message: "",
    }));
    setQueue(prev => [...prev, ...items]);
    // Worker pool: arranca min(PARALLEL_AI, items.length) workers.
    let i = 0;
    const next = async () => {
      if (i >= items.length) return;
      const myIdx = i++;
      const item = items[myIdx];
      setQueue(prev => prev.map(q => q.id === item.id ? { ...q, status: "running" } : q));
      try {
        const { extracted, storagePath, error } = await analyzeInvoiceFile(item.file, { type, companyId });
        if (!extracted) throw new Error(error || "Sin respuesta del modelo");
        const norm = normalizeExtractedInvoice(extracted, { type, companyId, sourcePath: storagePath });
        if (!norm.payload) throw new Error("Datos insuficientes para crear la factura");
        // Calcular total proyectado para sugerencia de matching.
        const projTotal = (norm.payload.lines || []).reduce((s, l) => s + (Number(l.quantity)||0) * (Number(l.unitPrice)||0) * (1 + (Number(l.vatRate)||0)/100), 0)
          - (norm.payload.lines || []).reduce((s, l) => s + (Number(l.quantity)||0) * (Number(l.unitPrice)||0), 0) * (Number(norm.payload.irpfRate)||0)/100;
        const match = findBankMatchForInvoice(projTotal, norm.payload.date, type, bankMovements);
        // Si encontramos match con confianza, lo sugerimos en el payload.
        // No vinculamos automáticamente — el CEO confirma en el modal de
        // edición tras revisar la factura.
        onAddInvoice?.(norm.payload);
        const cpyName = norm.payload.counterparty?.name || "(sin nombre)";
        let toastMsg = `✅ Factura ${type} de ${cpyName} creada${norm.partial ? " (revisar 🟡)" : ""} · ${fmtEur(projTotal)}`;
        if (match) toastMsg += ` · Posible pago el ${match.date} (${fmtEur(match.amount)})`;
        onToast?.(toastMsg, norm.partial ? "warn" : "success");
        setQueue(prev => prev.map(q => q.id === item.id ? { ...q, status: "done", partial: norm.partial, message: cpyName } : q));
      } catch (e) {
        console.warn("[invoice-import] fallo en", item.name, e);
        setQueue(prev => prev.map(q => q.id === item.id ? { ...q, status: "error", message: e.message || "error" } : q));
        onToast?.(`⚠ ${item.name}: ${e.message || "error analizando"}`, "warn");
      }
      next();
    };
    for (let k = 0; k < Math.min(PARALLEL_AI, items.length); k++) next();
  };

  const onDrop = (e) => {
    e.preventDefault();
    setDrag(false);
    const files = Array.from(e.dataTransfer.files || []);
    enqueueFiles(files);
  };
  const onPick = (e) => {
    const files = Array.from(e.target.files || []);
    e.target.value = "";
    enqueueFiles(files);
  };
  const clearDone = () => setQueue(q => q.filter(x => x.status === "queued" || x.status === "running"));

  const running = queue.filter(q => q.status === "running" || q.status === "queued").length;
  const done = queue.filter(q => q.status === "done").length;
  const errored = queue.filter(q => q.status === "error").length;
  const total = queue.length;
  const progress = total > 0 ? Math.round(((done + errored) / total) * 100) : 0;
  const disabled = !companyId || companyId === "all";

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <div
        onDragOver={(e) => { e.preventDefault(); if (!disabled) setDrag(true); }}
        onDragLeave={() => setDrag(false)}
        onDrop={onDrop}
        onClick={!disabled ? () => inputRef.current?.click() : undefined}
        style={{
          border: `2px dashed ${disabled ? "#E5E7EB" : drag ? "#27AE60" : "#BDC3C7"}`,
          borderRadius: 12,
          padding: "18px 16px",
          textAlign: "center",
          background: disabled ? "#FAFAFA" : drag ? "#F0FDF4" : "#fff",
          cursor: disabled ? "not-allowed" : "pointer",
          transition: "all .15s",
          opacity: disabled ? 0.65 : 1,
        }}
      >
        <div style={{ fontSize: 22, marginBottom: 4 }}>📎</div>
        <div style={{ fontSize: 13, fontWeight: 700, color: "#111827" }}>
          {disabled
            ? "Selecciona una empresa concreta para importar facturas"
            : `Arrastra facturas ${type === "emitida" ? "emitidas" : "recibidas"} aquí o haz clic`}
        </div>
        <div style={{ fontSize: 11, color: "#7F8C8D", marginTop: 4 }}>
          PDF / imagen → análisis IA · Excel/CSV → importación masiva
        </div>
        <input ref={inputRef} type="file" multiple accept={ACCEPT_ANY} onChange={onPick} style={{ display: "none" }} />
      </div>

      {/* Progreso de cola IA */}
      {queue.length > 0 && (
        <div style={{ background: "#fff", border: "1px solid #E5E7EB", borderRadius: 10, padding: "10px 14px" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: "#374151" }}>
              {running > 0 ? `Procesando ${done + errored + 1}/${total} factura${total!==1?"s":""}…` : `Completado ${done}/${total}${errored>0?` · ${errored} con error`:""}`}
            </div>
            {(done + errored === total) && (
              <button onClick={clearDone} style={{ padding: "4px 10px", borderRadius: 6, background: "transparent", border: "0.5px solid #D1D5DB", fontSize: 11, color: "#6B7280", cursor: "pointer", fontFamily: "inherit" }}>Limpiar</button>
            )}
          </div>
          <div style={{ background: "#F3F4F6", height: 6, borderRadius: 999, overflow: "hidden", marginBottom: 8 }}>
            <div style={{ background: "#27AE60", height: "100%", width: `${progress}%`, transition: "width .25s" }} />
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 3, maxHeight: 120, overflowY: "auto" }}>
            {queue.map(q => (
              <div key={q.id} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 11.5, color: q.status === "error" ? "#B91C1C" : q.status === "done" ? "#0E7C5A" : "#6B7280" }}>
                <span style={{ width: 16 }}>
                  {q.status === "queued"  && "⏳"}
                  {q.status === "running" && "🔍"}
                  {q.status === "done"    && (q.partial ? "🟡" : "✅")}
                  {q.status === "error"   && "❌"}
                </span>
                <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{q.name}</span>
                {q.message && <span style={{ fontSize: 10.5, color: "#9CA3AF", whiteSpace: "nowrap" }}>{q.message}</span>}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
