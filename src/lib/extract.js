// extract.js — extracción cliente de documentos tabulares (xlsx/xls/csv)
// y texto plano (txt/md/json/html) a una cadena pipe-separated lista para
// pasarse al LLM como `{kind:"text"}` attachment.
//
// Diseño:
//   - Dynamic import de "xlsx" para que la librería (~430 KB raw /
//     143 KB gzip) solo se descargue cuando hace falta. Cero impacto en
//     el boot de la app.
//   - Detección por EXTENSIÓN además de MIME (en Windows/Chrome el MIME
//     a veces es "" o "application/octet-stream" — la extensión es el
//     único hint fiable).
//   - Truncado visible: si una hoja excede maxRows o el total excede
//     maxChars, dejamos un aviso explícito en el propio texto
//     ("(mostradas N de M filas)" / "…(truncado)") — el LLM y el CEO
//     ven exactamente qué llegó.
//   - Fallback Latin-1 para CSV mal codificado (común en datos
//     contables españoles exportados desde sistemas legacy). Misma
//     lección que el mojibake del DocumentViewer: si vemos U+FFFD en
//     el resultado, reintentamos decode con iso-8859-1.
//
// API:
//   extractToText(blob, fileName, opts?) → Promise<string>
//   - blob: File o Blob (debe exponer arrayBuffer() y text()).
//   - fileName: string con extensión — guía la detección de formato.
//   - opts.maxChars (default 60000), maxSheets (5), maxRows (1000).
//
// Throws Error si el formato no es soportado por este helper. El caller
// decide qué hacer (mostrar mensaje al CEO, fallback, etc).

const DEFAULTS = { maxChars: 60000, maxSheets: 5, maxRows: 1000 };

function extOf(name) {
  const lower = String(name || "").toLowerCase();
  const dot = lower.lastIndexOf(".");
  return dot >= 0 ? lower.slice(dot) : "";
}

// Decodificación robusta de bytes a string: intenta UTF-8 estricto; si
// aparece el carácter de reemplazo U+FFFD reintenta con iso-8859-1
// (la codificación habitual de exports legacy en España). Idéntica
// lección del fix de mojibake del DocumentViewer pero aplicada en
// origen (decodificación cliente), no en consumo.
async function decodeRobust(blob) {
  let raw;
  try { raw = await blob.text(); } catch { raw = ""; }
  if (/\uFFFD/.test(raw)) {
    try {
      const buf = await blob.arrayBuffer();
      raw = new TextDecoder("iso-8859-1").decode(buf);
    } catch {}
  }
  return raw;
}

function stripCell(v) {
  return String(v ?? "").replace(/\s+/g, " ").trim();
}

async function extractSpreadsheet(blob, fileName, { maxSheets, maxRows, maxChars }) {
  const XLSX = await import("xlsx");
  const buf = await blob.arrayBuffer();
  const wb = XLSX.read(buf, { type: "array", cellDates: true });
  const sheetNames = wb.SheetNames || [];
  const parts = [];
  parts.push(`### Archivo: ${fileName || "(sin nombre)"} · hojas detectadas: ${sheetNames.length}`);
  if (sheetNames.length > maxSheets) {
    parts.push(`(mostradas las primeras ${maxSheets} hojas; restantes omitidas)`);
  }
  for (const name of sheetNames.slice(0, maxSheets)) {
    const ws = wb.Sheets[name];
    const arr = XLSX.utils.sheet_to_json(ws, { header: 1, defval: "", raw: true });
    const totalRows = arr.length;
    const rows = arr.slice(0, maxRows);
    parts.push("");
    parts.push(`### Hoja "${name}" (${totalRows} fila${totalRows !== 1 ? "s" : ""})`);
    if (totalRows > maxRows) {
      parts.push(`(mostradas ${maxRows} de ${totalRows} filas)`);
    }
    const body = rows.map(r => Array.isArray(r) ? r.map(stripCell).join(" | ") : stripCell(r)).join("\n");
    parts.push(body);
  }
  let out = parts.join("\n");
  if (out.length > maxChars) {
    out = out.slice(0, maxChars) + "\n…(truncado por exceder " + maxChars + " caracteres)";
  }
  return out;
}

async function extractCsv(blob, fileName, { maxChars, maxRows }) {
  const raw = await decodeRobust(blob);
  if (!raw) return `(${fileName || "csv"}: vacío)`;
  // Parseo CSV ligero. PapaParse haría un trabajo más limpio frente a
  // comillas anidadas y separadores no-coma, pero para el caso 95%
  // (export bancario/contable estándar) basta con split por líneas y
  // detección heurística del separador. Si en el futuro hay falsos
  // negativos, sustituir por dynamic import("papaparse").
  const lines = raw.split(/\r?\n/);
  const sample = lines.slice(0, 20).join("\n");
  const sep = (sample.match(/;/g)?.length || 0) > (sample.match(/,/g)?.length || 0) ? ";" : ",";
  const allRows = lines.filter(l => l.length > 0);
  const totalRows = allRows.length;
  const rows = allRows.slice(0, maxRows);
  const parts = [];
  parts.push(`### Archivo: ${fileName || "(sin nombre)"} · CSV · ${totalRows} fila${totalRows !== 1 ? "s" : ""}`);
  if (totalRows > maxRows) {
    parts.push(`(mostradas ${maxRows} de ${totalRows} filas)`);
  }
  parts.push("");
  // Quitamos comillas envolventes simples. Sin escape avanzado — caso 95%.
  const body = rows.map(line => {
    const cells = line.split(sep).map(c => stripCell(c.replace(/^"|"$/g, "")));
    return cells.join(" | ");
  }).join("\n");
  parts.push(body);
  let out = parts.join("\n");
  if (out.length > maxChars) {
    out = out.slice(0, maxChars) + "\n…(truncado por exceder " + maxChars + " caracteres)";
  }
  return out;
}

async function extractPlainText(blob, fileName, { maxChars }) {
  const raw = await decodeRobust(blob);
  const head = `### Archivo: ${fileName || "(sin nombre)"} · texto plano\n\n`;
  let body = raw || "";
  const cap = Math.max(0, maxChars - head.length);
  if (body.length > cap) body = body.slice(0, cap) + "\n…(truncado por exceder " + maxChars + " caracteres)";
  return head + body;
}

export async function extractToText(blob, fileName, opts = {}) {
  const cfg = { ...DEFAULTS, ...opts };
  const ext = extOf(fileName);
  if (ext === ".xlsx" || ext === ".xls") {
    return extractSpreadsheet(blob, fileName, cfg);
  }
  if (ext === ".csv") {
    return extractCsv(blob, fileName, cfg);
  }
  if (ext === ".txt" || ext === ".md" || ext === ".json" || ext === ".html" || ext === ".htm") {
    return extractPlainText(blob, fileName, cfg);
  }
  throw new Error(`extract.js: extensión no soportada (${ext || "sin extensión"}) · ${fileName}`);
}
