// DocumentViewer — visor full-screen para documentos inline (markdown,
// text/plain). Reemplaza el blob-in-new-tab del DocumentUploader cuando
// el doc es inline, evitando el mojibake UTF-8↔Latin-1 que producía el
// Blob sin charset declarado: "Díaz" → "DÃ­az". Aquí el texto viaja
// dentro de un string JS renderizado por React directamente, sin paso
// por el decoder del navegador.
//
// Render:
//   - Markdown ligero (títulos, énfasis, listas) parseado en cliente
//     con un parser mínimo (sin dependencia nueva).
//   - Tipografía: system serif (Georgia / Times / Garamond) para títulos
//     y negritas de cláusula; sans del sistema para cuerpo. Buen
//     contraste, márgenes generosos, ancho lectura ≤ 720px.
//   - Identidad Kluxor: #FAFAF7 papel, border-radius 0, oro acento.
//
// Acciones:
//   - ⬇ Descargar PDF (jsPDF, Times). Páginas A4, márgenes 22mm.
//   - ⬇ Descargar .md (Blob text/plain;charset=utf-8 → anchor download).
//   - × Cerrar.
import React from "react";
import jsPDF from "jspdf";

// ── Parser mínimo de Markdown ────────────────────────────────────────────────
// Estructura en bloques (h1/h2/h3 | p | ul | ol). Inline solo bold/italic.
// Para documentos legales que produce el Consejo basta — sin enlaces, sin
// tablas, sin código. Si en el futuro hace falta más, escalamos.
function parseBlocks(text) {
  const lines = String(text || "").split(/\r?\n/);
  const blocks = [];
  let buf = [];
  let listKind = null;
  let listItems = [];
  const flushPara = () => { if (buf.length) blocks.push({ kind: "p", lines: buf }); buf = []; };
  const flushList = () => { if (listItems.length) blocks.push({ kind: listKind, items: listItems }); listItems = []; listKind = null; };
  for (const raw of lines) {
    const line = raw;
    const h = /^(#{1,3})\s+(.+?)\s*$/.exec(line);
    if (h) {
      flushPara(); flushList();
      blocks.push({ kind: `h${h[1].length}`, text: h[2] });
      continue;
    }
    if (/^[-*]\s+/.test(line)) {
      flushPara();
      if (listKind !== "ul") { flushList(); listKind = "ul"; }
      listItems.push(line.replace(/^[-*]\s+/, ""));
      continue;
    }
    if (/^\d+\.\s+/.test(line)) {
      flushPara();
      if (listKind !== "ol") { flushList(); listKind = "ol"; }
      listItems.push(line.replace(/^\d+\.\s+/, ""));
      continue;
    }
    if (line.trim() === "") { flushPara(); flushList(); continue; }
    flushList();
    buf.push(line);
  }
  flushPara(); flushList();
  return blocks;
}

// Inline parser: **bold** y *italic* únicamente. Devuelve nodos React.
// Implementación tokenizadora para evitar regex anidadas que producen
// matches incorrectos en frases largas.
function renderInline(text, baseKey = "i") {
  const out = [];
  let i = 0;
  const str = String(text || "");
  let bufPlain = "";
  const flushPlain = () => { if (bufPlain) { out.push(bufPlain); bufPlain = ""; } };
  while (i < str.length) {
    if (str[i] === "*" && str[i+1] === "*") {
      const end = str.indexOf("**", i + 2);
      if (end > i + 2) {
        flushPlain();
        out.push(<strong key={`${baseKey}b${out.length}`}>{str.slice(i+2, end)}</strong>);
        i = end + 2; continue;
      }
    }
    if (str[i] === "*") {
      const end = str.indexOf("*", i + 1);
      if (end > i + 1 && str[i+1] !== "*") {
        flushPlain();
        out.push(<em key={`${baseKey}i${out.length}`}>{str.slice(i+1, end)}</em>);
        i = end + 1; continue;
      }
    }
    bufPlain += str[i];
    i++;
  }
  flushPlain();
  return out;
}

const SERIF = 'Georgia, "Times New Roman", "Hoefler Text", Garamond, serif';
const SANS = 'system-ui, -apple-system, "Segoe UI", sans-serif';

function MarkdownBody({ text }) {
  const blocks = React.useMemo(() => parseBlocks(text), [text]);
  return (
    <div style={{ fontFamily: SANS, fontSize: 14.5, lineHeight: 1.7, color: "#2C2A24" }}>
      {blocks.map((b, idx) => {
        if (b.kind === "h1") return <h1 key={idx} style={{ fontFamily: SERIF, fontSize: 28, fontWeight: 600, color: "#1F1A0F", margin: "28px 0 14px", lineHeight: 1.2 }}>{renderInline(b.text, `h1-${idx}`)}</h1>;
        if (b.kind === "h2") return <h2 key={idx} style={{ fontFamily: SERIF, fontSize: 22, fontWeight: 600, color: "#1F1A0F", margin: "26px 0 12px", lineHeight: 1.25 }}>{renderInline(b.text, `h2-${idx}`)}</h2>;
        if (b.kind === "h3") return <h3 key={idx} style={{ fontFamily: SERIF, fontSize: 18, fontWeight: 600, color: "#1F1A0F", margin: "22px 0 10px", lineHeight: 1.3 }}>{renderInline(b.text, `h3-${idx}`)}</h3>;
        if (b.kind === "ul") return (
          <ul key={idx} style={{ paddingLeft: 26, margin: "12px 0" }}>
            {b.items.map((it, ii) => <li key={ii} style={{ marginBottom: 6 }}>{renderInline(it, `ul-${idx}-${ii}`)}</li>)}
          </ul>
        );
        if (b.kind === "ol") return (
          <ol key={idx} style={{ paddingLeft: 26, margin: "12px 0" }}>
            {b.items.map((it, ii) => <li key={ii} style={{ marginBottom: 6 }}>{renderInline(it, `ol-${idx}-${ii}`)}</li>)}
          </ol>
        );
        return (
          <p key={idx} style={{ margin: "0 0 14px", whiteSpace: "pre-wrap" }}>
            {b.lines.map((ln, li) => (
              <React.Fragment key={li}>
                {renderInline(ln, `p-${idx}-${li}`)}
                {li < b.lines.length - 1 && <br />}
              </React.Fragment>
            ))}
          </p>
        );
      })}
    </div>
  );
}

// Sanitizado mínimo para jsPDF: la fuente Helvetica/Times solo soportan
// WinAnsi (Latin-1). Las tildes españolas Sí están en el rango, pero los
// emojis y símbolos extendidos pueden romper splitTextToSize. Aplicamos
// el mismo cleanup que el resto de exports a PDF de la app.
function pdfSanitize(t) {
  return String(t || "")
    .replace(/[\u{1F000}-\u{1FFFF}]/gu, "")
    .replace(/[\u2600-\u27BF]/g, "")
    .replace(/[\u200D\uFE0F\u20E3]/g, "")
    .replace(/[\u{1F1E6}-\u{1F1FF}]/gu, "");
}

// Genera el PDF de un documento markdown. A4 portrait, márgenes 22mm,
// Times (serif clásico) por defecto, negritas en títulos. Página numerada
// al pie. Si ocupa varias páginas, salto automático.
// Exportado para que DocumentCard del Consejo pueda reutilizarlo sin
// duplicar lógica (commit 2 de Opción B).
export function downloadAsPdf(doc) {
  const pdf = new jsPDF({ unit: "mm", format: "a4", orientation: "portrait" });
  const PAGE_W = 210, PAGE_H = 297;
  const M = 22;
  const CONTENT_W = PAGE_W - M * 2;
  let y = M;

  // Cabecera (nombre + meta)
  pdf.setFont("times", "bold");
  pdf.setFontSize(16);
  const headerLines = pdf.splitTextToSize(pdfSanitize(doc.name || "Documento"), CONTENT_W);
  for (const line of headerLines) {
    if (y > PAGE_H - M) { pdf.addPage(); y = M; }
    pdf.text(line, M, y);
    y += 7;
  }
  const dateStr = doc.uploadedAt ? new Date(doc.uploadedAt).toLocaleDateString("es-ES", { day: "2-digit", month: "long", year: "numeric" }) : "";
  if (dateStr) {
    pdf.setFont("times", "italic");
    pdf.setFontSize(10);
    pdf.setTextColor(120, 120, 120);
    pdf.text(dateStr, M, y);
    y += 7;
    pdf.setTextColor(0, 0, 0);
  }
  // Línea separadora.
  pdf.setDrawColor(201, 168, 76); // oro
  pdf.setLineWidth(0.3);
  pdf.line(M, y, M + CONTENT_W, y);
  y += 8;

  // Cuerpo.
  const blocks = parseBlocks(doc.text || "");
  const lineH = 5.2;
  const writeWrapped = (text, fontSize, fontStyle, color = [0, 0, 0], extraGap = 0) => {
    pdf.setFont("times", fontStyle);
    pdf.setFontSize(fontSize);
    pdf.setTextColor(...color);
    const safe = pdfSanitize(text);
    // Quita marcadores inline ** _ _ — jsPDF no entiende markdown.
    const flat = safe.replace(/\*\*/g, "").replace(/\*/g, "").replace(/__/g, "").replace(/_/g, "");
    let lines;
    try { lines = pdf.splitTextToSize(flat, CONTENT_W); }
    catch { lines = [flat]; }
    for (const line of lines) {
      if (y > PAGE_H - M - 8) { pdf.addPage(); y = M; }
      pdf.text(line, M, y);
      y += fontSize === 16 ? 7 : fontSize === 14 ? 6.2 : lineH;
    }
    y += extraGap;
  };

  for (const b of blocks) {
    if (b.kind === "h1") writeWrapped(b.text, 16, "bold", [31, 26, 15], 3);
    else if (b.kind === "h2") writeWrapped(b.text, 14, "bold", [31, 26, 15], 2);
    else if (b.kind === "h3") writeWrapped(b.text, 12, "bold", [31, 26, 15], 2);
    else if (b.kind === "ul") {
      for (const it of b.items) writeWrapped("•  " + it, 11, "normal");
      y += 2;
    }
    else if (b.kind === "ol") {
      b.items.forEach((it, i) => writeWrapped(`${i + 1}.  ${it}`, 11, "normal"));
      y += 2;
    }
    else if (b.kind === "p") {
      writeWrapped(b.lines.join(" "), 11, "normal", [44, 42, 36], 3);
    }
  }

  // Pie con paginación.
  const totalPages = pdf.internal.getNumberOfPages();
  for (let p = 1; p <= totalPages; p++) {
    pdf.setPage(p);
    pdf.setFont("times", "normal");
    pdf.setFontSize(8);
    pdf.setTextColor(150, 150, 150);
    pdf.text(`${p} / ${totalPages}`, PAGE_W - M, PAGE_H - 10, { align: "right" });
  }

  const safeName = String(doc.name || "documento").replace(/[^a-z0-9_\-]+/gi, "_").slice(0, 60);
  pdf.save(`${safeName}.pdf`);
}

// Descarga .md — Blob explícito con charset utf-8 para evitar el mismo
// mojibake del visor antiguo cuando el browser decodifica el archivo.
// Exportado para reutilización (commit 2 de Opción B).
export function downloadAsMd(doc) {
  const blob = new Blob([doc.text || ""], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const safeName = String(doc.name || "documento").replace(/[^a-z0-9_\-]+/gi, "_").slice(0, 60);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${safeName}.md`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

export default function DocumentViewer({ doc, onClose }) {
  if (!doc) return null;
  // Cierre con tecla Escape.
  React.useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onClose?.(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const dateStr = doc.uploadedAt
    ? new Date(doc.uploadedAt).toLocaleDateString("es-ES", { day: "2-digit", month: "long", year: "numeric" })
    : "";
  const originLabel = doc._origin?.specName ? `· redactado por ${doc._origin.specName}` : "";

  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed", inset: 0,
        background: "rgba(28, 24, 16, 0.55)",
        zIndex: 2100,
        display: "flex", alignItems: "center", justifyContent: "center",
        padding: 16,
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          background: "#FAFAF7",
          border: "1px solid #E5E0D5",
          width: "100%", maxWidth: 820,
          maxHeight: "92vh",
          display: "flex", flexDirection: "column",
          overflow: "hidden",
        }}
      >
        {/* Header */}
        <div style={{ padding: "14px 22px", borderBottom: "0.5px solid #E5E0D5", display: "flex", alignItems: "center", gap: 12, background: "#fff", flexShrink: 0, flexWrap: "wrap" }}>
          <div style={{ flex: 1, minWidth: 200 }}>
            <div style={{ fontFamily: SERIF, fontSize: 18, fontWeight: 600, color: "#1F1A0F", lineHeight: 1.2, marginBottom: 2 }}>{doc.name || "Documento"}</div>
            {(dateStr || originLabel) && (
              <div style={{ fontSize: 11, color: "#8B6914", fontStyle: "italic", letterSpacing: "0.02em" }}>
                {dateStr}{dateStr && originLabel ? " " : ""}{originLabel}
              </div>
            )}
          </div>
          <button
            onClick={() => downloadAsPdf(doc)}
            title="Descargar como PDF"
            style={{ padding: "8px 12px", minHeight: 40, background: "#fff", border: "1px solid #C9A84C", color: "#8B6914", fontSize: 12, fontWeight: 600, cursor: "pointer", fontFamily: "inherit", display: "inline-flex", alignItems: "center", gap: 6 }}
            onMouseEnter={e => { e.currentTarget.style.background = "#FFFBEB"; }}
            onMouseLeave={e => { e.currentTarget.style.background = "#fff"; }}
          >
            ⬇ PDF
          </button>
          <button
            onClick={() => downloadAsMd(doc)}
            title="Descargar como Markdown"
            style={{ padding: "8px 12px", minHeight: 40, background: "#fff", border: "1px solid #E5E0D5", color: "#3D2E12", fontSize: 12, fontWeight: 600, cursor: "pointer", fontFamily: "inherit", display: "inline-flex", alignItems: "center", gap: 6 }}
            onMouseEnter={e => { e.currentTarget.style.background = "#FAFAF7"; e.currentTarget.style.borderColor = "#C9A84C"; }}
            onMouseLeave={e => { e.currentTarget.style.background = "#fff"; e.currentTarget.style.borderColor = "#E5E0D5"; }}
          >
            ⬇ .md
          </button>
          <button
            onClick={onClose}
            title="Cerrar"
            style={{ width: 40, height: 40, background: "transparent", border: "none", fontSize: 22, cursor: "pointer", color: "#8B6914", padding: 0, fontFamily: "inherit", lineHeight: 1 }}
          >
            ×
          </button>
        </div>

        {/* Cuerpo: render Markdown con paleta operativa Kluxor. */}
        <div style={{ flex: 1, overflowY: "auto", padding: "32px 56px 40px", background: "#FAFAF7" }}>
          <div style={{ maxWidth: 680, margin: "0 auto" }}>
            <MarkdownBody text={doc.text || ""} />
          </div>
        </div>
      </div>
    </div>
  );
}
