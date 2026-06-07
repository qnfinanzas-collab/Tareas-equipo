// parseAsientos.js — parser del marker [ASIENTOS]…[/ASIENTOS] que Diego
// emite cuando elabora asientos del libro diario PGC.
//
// Namespace propio, paralelo a [ACTIONS] / [DOCUMENT] / [DERIVAR].
// NO toca parseAgentActions ni el resto de markers — vive solo en
// el componente AsientoCard (display + acción de creación).
//
// Tolerancia (regla dura: NUNCA romper el chat):
//   - Sin marker → debug:"marker-absent", asientos:null.
//   - Marker abierto sin cerrar → "marker-malformed", asientos:null,
//     texto literal en cleanText (markers visibles para que el CEO los
//     vea, no se rompe el render).
//   - JSON inválido dentro del marker → "json-invalid", asientos:null.
//   - Schema parcialmente inválido (falta lineas, etc.) → se descarta
//     ese asiento individual pero el resto se preserva. debug:"ok" si
//     al menos uno es válido, "schema-empty" si todos descartados.
//
// Shape de cada asiento parseado:
//   { fecha, concepto, companyId?, lineas:[{cuenta,nombre,debe,haber}],
//     _totalDebe, _totalHaber, _diff, _cuadra }
// Los campos con guion bajo son métricas calculadas client-side para
// que AsientoCard pueda decidir el estado de cuadre sin recomputar.

const ASIENTOS_BLOCK_RE = /\[ASIENTOS\]\s*([\s\S]*?)\s*\[\/ASIENTOS\]/i;
const OPEN_RE  = /\[ASIENTOS\]/i;
const CLOSE_RE = /\[\/ASIENTOS\]/i;

function toNumber(v) {
  if (v == null || v === "") return 0;
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  // Acepta "1.500,00" (es-ES) y "1500.00" (en-US) y "1,500.00" (es ambiguo).
  // Heurística: si hay coma Y punto, el separador decimal es el último.
  let s = String(v).trim().replace(/\s/g, "");
  if (s.includes(",") && s.includes(".")) {
    const lastComma = s.lastIndexOf(",");
    const lastDot = s.lastIndexOf(".");
    if (lastComma > lastDot) {
      // formato es-ES: "1.500,00"
      s = s.replace(/\./g, "").replace(",", ".");
    } else {
      // formato en-US: "1,500.00"
      s = s.replace(/,/g, "");
    }
  } else if (s.includes(",")) {
    // solo coma → decimal es-ES
    s = s.replace(",", ".");
  }
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : 0;
}

function round2(n) { return Math.round(n * 100) / 100; }

function normalizeLinea(raw) {
  if (!raw || typeof raw !== "object") return null;
  const cuenta = String(raw.cuenta || raw.account || "").trim();
  const nombre = String(raw.nombre || raw.accountName || raw.concepto || "").trim();
  const debe   = round2(toNumber(raw.debe ?? raw.debit ?? 0));
  const haber  = round2(toNumber(raw.haber ?? raw.credit ?? 0));
  // Una línea debe tener cuenta y al menos un movimiento en debe O haber.
  if (!cuenta) return null;
  if (debe === 0 && haber === 0) return null;
  return { cuenta, nombre, debe, haber };
}

function normalizeAsiento(raw) {
  if (!raw || typeof raw !== "object") return null;
  const fecha    = String(raw.fecha || raw.date || "").trim();
  const concepto = String(raw.concepto || raw.description || raw.descripcion || "").trim();
  const companyId = raw.companyId != null ? String(raw.companyId).trim() : null;
  const lineasRaw = Array.isArray(raw.lineas) ? raw.lineas
                 : Array.isArray(raw.lines)  ? raw.lines
                 : [];
  const lineas = lineasRaw.map(normalizeLinea).filter(Boolean);
  if (lineas.length < 2) return null; // un asiento real necesita ≥2 líneas
  if (!fecha || !concepto) return null;
  // Cuadre: tolerancia 0.011 (idéntica a addAccountingEntry).
  const totalDebe  = round2(lineas.reduce((s, l) => s + l.debe,  0));
  const totalHaber = round2(lineas.reduce((s, l) => s + l.haber, 0));
  const diff = Math.abs(totalDebe - totalHaber);
  const _cuadra = diff <= 0.011;
  return {
    fecha,
    concepto,
    companyId,
    lineas,
    _totalDebe: totalDebe,
    _totalHaber: totalHaber,
    _diff: round2(diff),
    _cuadra,
  };
}

export function parseAsientos(rawText) {
  if (!rawText) return { asientos: null, cleanText: rawText || "", debug: "no-text" };
  const str = String(rawText);
  const hasOpen  = OPEN_RE.test(str);
  const hasClose = CLOSE_RE.test(str);
  if (!hasOpen && !hasClose) {
    return { asientos: null, cleanText: str, debug: "marker-absent" };
  }
  if (hasOpen && !hasClose) {
    // Marker abierto pero sin cerrar — probablemente el modelo se cortó.
    // No se parsea, log para auditoría, cleanText queda con marker visible.
    return { asientos: null, cleanText: str, debug: "marker-malformed" };
  }
  const m = str.match(ASIENTOS_BLOCK_RE);
  if (!m) return { asientos: null, cleanText: str, debug: "marker-malformed" };
  const body = (m[1] || "").trim();
  let payload;
  try {
    // Tolerancia mínima a JSON con trailing commas (común en Sonnet).
    const cleaned = body.replace(/,(\s*[}\]])/g, "$1");
    payload = JSON.parse(cleaned);
  } catch (e) {
    return {
      asientos: null,
      cleanText: str.replace(ASIENTOS_BLOCK_RE, "").trim(),
      debug: "json-invalid",
      _parseError: e.message,
    };
  }
  const list = Array.isArray(payload?.asientos) ? payload.asientos
            : Array.isArray(payload)          ? payload
            : [];
  const asientos = list.map(normalizeAsiento).filter(Boolean);
  const cleanText = str.replace(ASIENTOS_BLOCK_RE, "").replace(/\n{3,}/g, "\n\n").trim();
  if (asientos.length === 0) {
    return { asientos: null, cleanText, debug: "schema-empty" };
  }
  return { asientos, cleanText, debug: "ok" };
}
