// invoiceAI — extracción IA de datos de factura desde PDF o imagen.
// Sube el archivo a Supabase Storage (si está habilitado) para conservar
// el original y envía base64 al endpoint /api/agent que delega en
// Anthropic Claude (vision / PDF parsing nativo).
//
// La respuesta llega como JSON dentro del texto del modelo. Aquí lo
// parseamos defensivamente (acepta envoltorio ```json...``` o trozos de
// texto antes/después).
import { uploadDocument, blobToBase64, storageEnabled } from "./storage.js";
import { callAgentSafe } from "./agent.js";

// Formatos aceptados para análisis IA (PDF + imágenes comunes).
const SUPPORTED_AI = ["application/pdf", "image/png", "image/jpeg", "image/jpg", "image/webp"];
export function isAnalyzableInvoiceFile(file){
  if (!file) return false;
  const t = (file.type || "").toLowerCase();
  if (SUPPORTED_AI.includes(t)) return true;
  const name = (file.name || "").toLowerCase();
  return name.endsWith(".pdf") || name.endsWith(".png") || name.endsWith(".jpg") || name.endsWith(".jpeg") || name.endsWith(".webp");
}

// Extrae media_type robusto. file.type puede venir vacío en drag&drop de
// algunos navegadores; deducimos desde la extensión.
function detectMediaType(file){
  const t = (file.type || "").toLowerCase();
  if (t) return t;
  const name = (file.name || "").toLowerCase();
  if (name.endsWith(".pdf"))  return "application/pdf";
  if (name.endsWith(".png"))  return "image/png";
  if (name.endsWith(".jpg") || name.endsWith(".jpeg")) return "image/jpeg";
  if (name.endsWith(".webp")) return "image/webp";
  return "application/octet-stream";
}

// JSON parser tolerante. Busca el primer { ... } balanceado en el texto y
// permite envoltorio markdown ```json ... ```.
function extractJson(text){
  if (!text) return null;
  let s = String(text).trim();
  s = s.replace(/^```json\s*/i, "").replace(/^```\s*/, "").replace(/\s*```$/, "");
  // Buscar primer "{" y último "}" balanceados.
  const start = s.indexOf("{");
  const end   = s.lastIndexOf("}");
  if (start < 0 || end < 0 || end <= start) return null;
  const slice = s.slice(start, end + 1);
  try { return JSON.parse(slice); } catch {}
  // Reintento con limpieza agresiva: quita comentarios //... y comas finales
  try {
    const cleaned = slice
      .replace(/\/\/[^\n]*/g, "")
      .replace(/,(\s*[}\]])/g, "$1");
    return JSON.parse(cleaned);
  } catch {}
  return null;
}

const PROMPT_TEMPLATE = (type) => `Analiza esta factura ${type} y extrae los datos en JSON. Es para un sistema contable español (PGC).

Extrae:
- counterparty: { name, cif, address }   ← ${type === "emitida" ? "datos del CLIENTE (a quién se emite)" : "datos del PROVEEDOR (quién emite)"}
- number: número de factura
- date: fecha de emisión (YYYY-MM-DD)
- dueDate: fecha de vencimiento si aparece (YYYY-MM-DD) o null
- lines: [{ description, quantity, unitPrice, vatRate }] ← cada línea. vatRate sin %, solo número (ej: 21).
- irpfRate: % retención IRPF si hay (0, 7, 15 o 19), si no aparece → 0
- notes: observaciones relevantes (forma pago, etc) o cadena vacía

Reglas:
- Si la factura tiene una línea sola, ponla como array de 1 elemento.
- Si los importes vienen con IVA incluido, descompón a base + IVA.
- Si no puedes extraer un campo, ponlo a null o "" (no inventes).
- Responde SOLO el objeto JSON, sin texto antes ni después.`;

// Sube el archivo a storage (si disponible) para conservar el original
// asociado a la factura, e invoca al modelo. Devuelve:
//   { extracted: {...}, storagePath: string|null, raw: string, error?: string }
//
// `companyId` se usa como ownerKey en el path de storage:
// finance/{companyId}/invoices/{ts}-{name}
//
// `type` = "emitida" | "recibida"
export async function analyzeInvoiceFile(file, { type, companyId } = {}) {
  if (!file) throw new Error("Sin archivo");
  if (!isAnalyzableInvoiceFile(file)) throw new Error(`Formato no soportado para análisis IA: ${file.type || file.name}`);

  // Storage opcional: si falla seguimos con base64 directo.
  let storagePath = null;
  if (storageEnabled()) {
    try {
      const ownerKey = `finance/${companyId || "no-company"}/invoices`;
      const meta = await uploadDocument(file, ownerKey);
      storagePath = meta.storagePath;
    } catch (e) {
      console.warn("[invoiceAI] upload fallo (continuamos sin storage):", e.message);
    }
  }

  // Convertimos a base64 para el endpoint /api/agent.
  const data = await blobToBase64(file);
  const mediaType = detectMediaType(file);
  const isPdf = mediaType === "application/pdf";
  const attachments = [{
    kind: isPdf ? "pdf" : "image",
    media_type: mediaType,
    data,
  }];

  const system = PROMPT_TEMPLATE(type === "emitida" ? "emitida" : "recibida");
  const messages = [{ role: "user", content: "Extrae los datos de la factura adjunta y devuélvelos en JSON estricto." }];

  let raw = "";
  try {
    raw = await callAgentSafe({
      system,
      messages,
      attachments,
      max_tokens: 2048,
    });
  } catch (e) {
    return { extracted: null, storagePath, raw: "", error: e.message || "Error en /api/agent" };
  }

  const extracted = extractJson(raw);
  if (!extracted) {
    return { extracted: null, storagePath, raw, error: "No se pudo parsear el JSON de la respuesta" };
  }
  return { extracted, storagePath, raw };
}

// Normaliza el resultado del modelo a un payload aceptado por addInvoice.
// `extracted` es lo que devuelve la IA. `companyId` y `type` los pone el
// caller (heredan de la tab activa).
//
// Si faltan campos críticos (nombre contraparte, alguna línea) marca la
// factura como "incompleta" en notes y devuelve `partial: true` para que
// la UI muestre badge 🟡 de revisión.
export function normalizeExtractedInvoice(extracted, { type, companyId, sourcePath }) {
  if (!extracted || typeof extracted !== "object") {
    return { partial: true, payload: null, missing: ["respuesta vacía"] };
  }
  const missing = [];
  const cp = extracted.counterparty || {};
  const name = String(cp.name || "").trim();
  if (!name) missing.push("nombre contraparte");

  let lines = Array.isArray(extracted.lines) ? extracted.lines : [];
  // Sanitiza cada línea — descarta las completamente vacías.
  lines = lines.map(l => ({
    description: String(l?.description || "").trim(),
    quantity:  Number(l?.quantity)  || 0,
    unitPrice: Number(l?.unitPrice) || 0,
    vatRate:   Number(l?.vatRate)   || 0,
  })).filter(l => l.description || l.quantity || l.unitPrice);
  if (lines.length === 0) {
    // Si no hay líneas, intentamos derivar del total/base si vienen.
    const total = Number(extracted.total) || 0;
    const subtotal = Number(extracted.subtotal) || total;
    if (total > 0) {
      lines = [{ description: extracted.notes || "Factura importada", quantity: 1, unitPrice: subtotal || total, vatRate: 21 }];
    } else {
      missing.push("líneas");
      lines = [{ description: "(revisar) " + (extracted.notes || ""), quantity: 1, unitPrice: 0, vatRate: 21 }];
    }
  }
  const date = (extracted.date && /^\d{4}-\d{2}-\d{2}/.test(extracted.date)) ? extracted.date.slice(0,10) : null;
  if (!date) missing.push("fecha");
  const dueDate = (extracted.dueDate && /^\d{4}-\d{2}-\d{2}/.test(extracted.dueDate)) ? extracted.dueDate.slice(0,10) : null;
  const irpfRate = [0, 7, 15, 19].includes(Number(extracted.irpfRate)) ? Number(extracted.irpfRate) : 0;

  const baseNotes = String(extracted.notes || "").trim();
  const reviewMark = missing.length > 0 ? `[🟡 Revisar: faltan ${missing.join(", ")}] ` : "";
  const sourceMark = sourcePath ? `\nOrigen: ${sourcePath}` : "";
  const notes = (reviewMark + baseNotes + sourceMark).trim();

  return {
    partial: missing.length > 0,
    missing,
    payload: {
      type,
      companyId,
      number: String(extracted.number || "").trim() || null,
      date: date || new Date().toISOString().slice(0,10),
      dueDate,
      counterparty: {
        name: name || "(sin nombre — revisar)",
        cif: String(cp.cif || "").trim().toUpperCase(),
        address: String(cp.address || "").trim(),
      },
      lines,
      irpfRate,
      notes,
      status: "pendiente",
    },
  };
}

// Busca un movimiento bancario candidato a haber pagado/cobrado la factura.
// Para emitidas: busca ingresos; recibidas: gastos. Tolerancia ±2% importe,
// ±15 días. Devuelve el mejor (menor delta) o null.
export function findBankMatchForInvoice(invoiceTotal, invoiceDate, type, bankMovements) {
  if (!Array.isArray(bankMovements) || !invoiceTotal || !invoiceDate) return null;
  const target = Math.abs(Number(invoiceTotal)||0);
  const tol = Math.max(0.5, target * 0.02);
  const dayMs = 86400000;
  const refDate = new Date(invoiceDate);
  let best = null;
  for (const m of bankMovements) {
    if (m.reconciled) continue;
    const amt = Number(m.amount)||0;
    const isIncome = amt > 0;
    if (type === "emitida" && !isIncome) continue;
    if (type === "recibida" && isIncome) continue;
    const amountDelta = Math.abs(Math.abs(amt) - target);
    if (amountDelta > tol) continue;
    const d = new Date(m.date);
    if (isNaN(d.getTime())) continue;
    const dateDelta = Math.abs(Math.floor((d - refDate) / dayMs));
    if (dateDelta > 15) continue;
    if (!best || amountDelta < best.amountDelta || (amountDelta === best.amountDelta && dateDelta < best.dateDelta)) {
      best = { id: m.id, date: m.date, amount: amt, amountDelta, dateDelta, concept: m.concept };
    }
  }
  return best;
}
