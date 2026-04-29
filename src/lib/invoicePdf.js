// invoicePdf — genera un PDF profesional de factura emitida a partir de
// los datos de `invoice` y la empresa emisora `company` (lee de
// data.governance.companies). Usa jsPDF con fuente Helvetica (sin emojis,
// la default solo soporta WinAnsiEncoding).
//
// Diseño: cabecera con datos emisor (izq) y bloque "FACTURA" + nº/fecha
// (der), bloque receptor, tabla de líneas, totales a la derecha. A4
// portrait. Importes en formato es-ES.
import jsPDF from "jspdf";

// Sanea texto para Helvetica (sin emojis ni caracteres fuera de Latin-1).
// Imitamos el helper que vive en App.jsx para el resto de PDFs.
function sanitize(text){
  return String(text || "")
    .replace(/[\u{1F000}-\u{1FFFF}]/gu, "")
    .replace(/[\u2600-\u27BF]/g, "")
    .replace(/[\u200D\uFE0F\u20E3]/g, "")
    .replace(/[\u{1F1E6}-\u{1F1FF}]/gu, "");
}

const fmtEur = (n) => new Intl.NumberFormat("es-ES", { style: "currency", currency: "EUR", maximumFractionDigits: 2 }).format(Number(n)||0);
const fmtDate = (s) => {
  if (!s) return "—";
  const d = new Date(s);
  if (isNaN(d.getTime())) return s;
  return d.toLocaleDateString("es-ES", { day: "2-digit", month: "2-digit", year: "numeric" });
};

// Paleta sobria — verde corporativo del módulo Finanzas.
const C = {
  green: [39, 174, 96],
  dark:  [31, 41, 55],
  gray:  [107, 114, 128],
  light: [230, 232, 237],
};

export function generateInvoicePdf(invoice, company) {
  const doc = new jsPDF({ unit: "mm", format: "a4", orientation: "portrait" });
  const pageW = doc.internal.pageSize.getWidth();   // 210
  const pageH = doc.internal.pageSize.getHeight();  // 297
  const margin = 18;
  let y = margin;

  // Banda superior de color
  doc.setFillColor(...C.green);
  doc.rect(0, 0, pageW, 6, "F");
  y += 4;

  // Bloque emisor (izquierda)
  doc.setFont("helvetica", "bold");
  doc.setFontSize(13);
  doc.setTextColor(...C.dark);
  doc.text(sanitize(company?.name || "(sin empresa)"), margin, y);
  y += 5;
  doc.setFont("helvetica", "normal");
  doc.setFontSize(9);
  doc.setTextColor(...C.gray);
  if (company?.cif)     { doc.text(`CIF: ${sanitize(company.cif)}`, margin, y); y += 4; }
  if (company?.address) { doc.text(sanitize(company.address), margin, y); y += 4; }
  if (company?.email || company?.phone) {
    const line = [company.email, company.phone].filter(Boolean).join(" · ");
    doc.text(sanitize(line), margin, y);
    y += 4;
  }

  // Bloque "FACTURA" (derecha) — alineado al margen derecho
  const rightX = pageW - margin;
  let yR = margin + 4;
  doc.setFont("helvetica", "bold");
  doc.setFontSize(20);
  doc.setTextColor(...C.green);
  doc.text("FACTURA", rightX, yR, { align: "right" });
  yR += 8;
  doc.setFontSize(10);
  doc.setTextColor(...C.dark);
  doc.text(`Nº ${sanitize(invoice.number || "(sin número)")}`, rightX, yR, { align: "right" });
  yR += 5;
  doc.setFont("helvetica", "normal");
  doc.setFontSize(9);
  doc.setTextColor(...C.gray);
  doc.text(`Fecha: ${fmtDate(invoice.date)}`, rightX, yR, { align: "right" });
  yR += 4;
  if (invoice.dueDate) {
    doc.text(`Vencimiento: ${fmtDate(invoice.dueDate)}`, rightX, yR, { align: "right" });
    yR += 4;
  }

  // Línea separadora antes del bloque receptor
  y = Math.max(y, yR) + 4;
  doc.setDrawColor(...C.light);
  doc.setLineWidth(0.4);
  doc.line(margin, y, pageW - margin, y);
  y += 6;

  // Bloque receptor (cliente)
  doc.setFont("helvetica", "bold");
  doc.setFontSize(9);
  doc.setTextColor(...C.gray);
  doc.text("FACTURAR A", margin, y);
  y += 5;
  doc.setFont("helvetica", "bold");
  doc.setFontSize(11);
  doc.setTextColor(...C.dark);
  doc.text(sanitize(invoice.counterparty?.name || "(sin nombre)"), margin, y);
  y += 5;
  doc.setFont("helvetica", "normal");
  doc.setFontSize(9);
  doc.setTextColor(...C.gray);
  if (invoice.counterparty?.cif)     { doc.text(`CIF/NIF: ${sanitize(invoice.counterparty.cif)}`, margin, y); y += 4; }
  if (invoice.counterparty?.address) { doc.text(sanitize(invoice.counterparty.address), margin, y); y += 4; }
  y += 4;

  // Tabla de líneas
  const cols = [
    { key: "description", label: "Descripción", x: margin,        w: 95, align: "left"  },
    { key: "quantity",    label: "Cant.",       x: margin + 95,   w: 18, align: "right" },
    { key: "unitPrice",   label: "Precio",      x: margin + 113,  w: 25, align: "right" },
    { key: "vatRate",     label: "IVA",         x: margin + 138,  w: 14, align: "right" },
    { key: "lineTotal",   label: "Subtotal",    x: margin + 152,  w: 22, align: "right" },
  ];
  // Header tabla
  doc.setFillColor(...C.green);
  doc.rect(margin, y, pageW - margin*2, 7, "F");
  doc.setTextColor(255, 255, 255);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(9);
  for (const col of cols) {
    const tx = col.align === "right" ? col.x + col.w - 2 : col.x + 2;
    doc.text(col.label, tx, y + 5, { align: col.align });
  }
  y += 7;

  // Líneas
  doc.setFont("helvetica", "normal");
  doc.setTextColor(...C.dark);
  doc.setFontSize(9);
  let subtotal = 0;
  const vatByRate = new Map();
  for (const line of (invoice.lines || [])) {
    const qty = Number(line.quantity) || 0;
    const price = Number(line.unitPrice) || 0;
    const rate = Number(line.vatRate) || 0;
    const base = qty * price;
    subtotal += base;
    const cur = vatByRate.get(rate) || { base: 0, vat: 0 };
    cur.base += base;
    cur.vat  += base * rate / 100;
    vatByRate.set(rate, cur);

    // Si quedamos sin espacio, salto de página (raro en facturas).
    if (y > pageH - 60) {
      doc.addPage();
      y = margin;
    }

    // Descripción puede ser multilínea — wrap.
    const desc = sanitize(line.description || "");
    const wrapped = doc.splitTextToSize(desc, cols[0].w - 2);
    const lineH = Math.max(wrapped.length, 1) * 4 + 2;
    // Fila zebra
    doc.setFillColor(250, 250, 250);
    doc.rect(margin, y, pageW - margin*2, lineH, "F");
    let dy = y + 4;
    for (const w of wrapped) { doc.text(w, cols[0].x + 2, dy); dy += 4; }
    doc.text(String(qty), cols[1].x + cols[1].w - 2, y + 4, { align: "right" });
    doc.text(fmtEur(price),  cols[2].x + cols[2].w - 2, y + 4, { align: "right" });
    doc.text(`${rate}%`,     cols[3].x + cols[3].w - 2, y + 4, { align: "right" });
    doc.text(fmtEur(base),   cols[4].x + cols[4].w - 2, y + 4, { align: "right" });
    y += lineH;
  }

  y += 4;
  doc.setDrawColor(...C.light);
  doc.line(margin, y, pageW - margin, y);
  y += 4;

  // Totales (alineados a la derecha)
  const totalsX = pageW - margin - 60;
  const totalsValueX = pageW - margin;
  const writeTotalRow = (label, value, opts = {}) => {
    doc.setFont("helvetica", opts.bold ? "bold" : "normal");
    doc.setFontSize(opts.bold ? 11 : 9);
    doc.setTextColor(...(opts.bold ? C.dark : C.gray));
    doc.text(label, totalsX, y);
    doc.setTextColor(...C.dark);
    doc.text(value, totalsValueX, y, { align: "right" });
    y += opts.bold ? 7 : 5;
  };
  writeTotalRow("Subtotal", fmtEur(subtotal));
  let vatTotal = 0;
  const vatRatesSorted = Array.from(vatByRate.entries()).filter(([, v]) => v.base > 0).sort((a, b) => a[0] - b[0]);
  for (const [rate, v] of vatRatesSorted) {
    vatTotal += v.vat;
    if (vatRatesSorted.length > 1) writeTotalRow(`IVA ${rate}% (sobre ${fmtEur(v.base)})`, fmtEur(v.vat));
  }
  if (vatRatesSorted.length <= 1) writeTotalRow("IVA", fmtEur(vatTotal));
  const irpfRate = Number(invoice.irpfRate) || 0;
  const irpfAmount = subtotal * irpfRate / 100;
  if (irpfRate > 0) {
    writeTotalRow(`Retención IRPF (-${irpfRate}%)`, `-${fmtEur(irpfAmount)}`);
  }
  // Línea separadora antes del total
  doc.setDrawColor(...C.dark);
  doc.setLineWidth(0.5);
  doc.line(totalsX, y - 1, totalsValueX, y - 1);
  y += 2;
  const totalCalc = subtotal + vatTotal - irpfAmount;
  writeTotalRow("TOTAL", fmtEur(totalCalc), { bold: true });

  // Notas
  if (invoice.notes) {
    y += 6;
    doc.setFont("helvetica", "bold");
    doc.setFontSize(9);
    doc.setTextColor(...C.gray);
    doc.text("OBSERVACIONES", margin, y);
    y += 4;
    doc.setFont("helvetica", "normal");
    doc.setTextColor(...C.dark);
    const wrapped = doc.splitTextToSize(sanitize(invoice.notes), pageW - margin*2);
    for (const w of wrapped) {
      if (y > pageH - 25) { doc.addPage(); y = margin; }
      doc.text(w, margin, y);
      y += 4;
    }
  }

  // Footer fijo
  doc.setFontSize(8);
  doc.setTextColor(...C.gray);
  doc.text(
    sanitize(`${company?.name || ""} · Documento generado por TaskFlow Finanzas · ${new Date().toLocaleDateString("es-ES")}`),
    pageW / 2, pageH - 8, { align: "center" }
  );

  return doc;
}

// Descarga directa: build + save con nombre coherente.
export function downloadInvoicePdf(invoice, company) {
  const doc = generateInvoicePdf(invoice, company);
  const stamp = (invoice.number || invoice.id || "factura").replace(/[\/\s]+/g, "-");
  const cName = (company?.name || "empresa").replace(/\s+/g, "_");
  doc.save(`Factura_${cName}_${stamp}.pdf`);
}
