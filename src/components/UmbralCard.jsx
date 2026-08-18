// UmbralCard — F1.2 El Umbral. Tarjeta de convocatoria.
//
// Es material de marca EXTERNA (lo que verá el invitado). Modo NEGRO
// operativo Kluxor: fondo #0A0A0A, oro #C9A84C, perla #F5F0E8.
//
// Composición SVG puro para poder:
//   - Renderizar en pantalla como <img> con data URL.
//   - Exportar a PNG vía canvas.drawImage + toDataURL.
//   - Exportar a PDF vía jspdf (ya en package.json) usando el PNG.
//
// El QR se genera con `qrcode` (npm) con lazy-loading (dynamic import)
// para que no lastre el bundle inicial de la app — solo se descarga
// cuando el owner entra a El Umbral y convoca a alguien.

import React, { useEffect, useMemo, useState } from "react";

const W = 800;
const H = 1200;
const COLOR_BG      = "#0A0A0A";
const COLOR_GOLD    = "#C9A84C";
const COLOR_PEARL   = "#F5F0E8";
const COLOR_MUTED   = "#8A867F";

// Formatea la fecha caducidad al estilo "1 de septiembre de 2026".
function fmtCaducidad(iso) {
  try {
    const d = new Date(iso);
    return d.toLocaleDateString("es-ES", { day: "numeric", month: "long", year: "numeric" });
  } catch { return iso || ""; }
}

// Escapa texto para que sea seguro dentro de SVG (< > & ").
function xmlEscape(s) {
  return String(s || "").replace(/[<>&"']/g, ch => ({
    "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;",
  }[ch]));
}

// Compone el SVG completo con el QR ya renderizado dentro.
// qrSvgInner es el <path>/<rect>... del QR (SVG string sin envoltura),
// que insertamos escalado y centrado en su cuadro.
function buildSvg({ inviteeName, ownerName, expiresAt, qrSvgInner }) {
  const safeInvitee = xmlEscape(inviteeName || "(nombre)");
  const safeOwner   = xmlEscape(ownerName   || "(convocante)");
  const safeDate    = xmlEscape(fmtCaducidad(expiresAt));

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
    <!-- Fondo negro -->
    <rect width="${W}" height="${H}" fill="${COLOR_BG}"/>

    <!-- Doble filete oro enmarcando (patrón portada PDF propuesta) -->
    <rect x="34"  y="34"  width="${W - 68}"  height="${H - 68}"  fill="none" stroke="${COLOR_GOLD}" stroke-width="1.5"/>
    <rect x="46"  y="46"  width="${W - 92}"  height="${H - 92}"  fill="none" stroke="${COLOR_GOLD}" stroke-width="0.5"/>

    <!-- Monograma H en cuadrado con borde oro -->
    <g transform="translate(${W/2 - 45},130)">
      <rect x="0" y="0" width="90" height="90" fill="none" stroke="${COLOR_GOLD}" stroke-width="1.5"/>
      <text x="45" y="66" text-anchor="middle"
            font-family="'Instrument Serif', Georgia, serif"
            font-size="58" font-style="italic" fill="${COLOR_GOLD}">H</text>
    </g>

    <!-- Wordmark K L U X O R -->
    <text x="${W/2}" y="290" text-anchor="middle"
          font-family="'Instrument Serif', Georgia, serif"
          font-size="44" letter-spacing="18" fill="${COLOR_PEARL}">KLUXOR</text>

    <!-- Eyebrow GABINETE EJECUTIVO -->
    <text x="${W/2}" y="330" text-anchor="middle"
          font-family="'Inter', system-ui, sans-serif"
          font-size="10" letter-spacing="8" font-weight="600"
          fill="${COLOR_GOLD}">GABINETE EJECUTIVO</text>

    <!-- Filete oro corto separador -->
    <line x1="${W/2 - 40}" y1="365" x2="${W/2 + 40}" y2="365"
          stroke="${COLOR_GOLD}" stroke-width="0.75"/>

    <!-- "<Nombre> ha sido convocado." grande en perla -->
    <text x="${W/2}" y="470" text-anchor="middle"
          font-family="'Instrument Serif', Georgia, serif"
          font-size="42" font-style="italic" fill="${COLOR_PEARL}">${safeInvitee}</text>
    <text x="${W/2}" y="520" text-anchor="middle"
          font-family="'Instrument Serif', Georgia, serif"
          font-size="30" fill="${COLOR_PEARL}">ha sido convocado.</text>

    <!-- "A propuesta de <owner>" -->
    <text x="${W/2}" y="590" text-anchor="middle"
          font-family="'Inter', system-ui, sans-serif"
          font-size="14" letter-spacing="2" fill="${COLOR_MUTED}">A PROPUESTA DE</text>
    <text x="${W/2}" y="620" text-anchor="middle"
          font-family="'Instrument Serif', Georgia, serif"
          font-size="22" fill="${COLOR_PEARL}">${safeOwner}</text>

    <!-- QR code (cuadro blanco de 260x260 centrado horizontal) -->
    <g transform="translate(${W/2 - 130},720)">
      <rect x="-10" y="-10" width="280" height="280" fill="#FFFFFF"/>
      <svg x="0" y="0" width="260" height="260" viewBox="0 0 260 260">
        ${qrSvgInner}
      </svg>
    </g>

    <!-- Caducidad -->
    <text x="${W/2}" y="1060" text-anchor="middle"
          font-family="'Inter', system-ui, sans-serif"
          font-size="11" letter-spacing="3" font-weight="500"
          fill="${COLOR_GOLD}">RESERVADO HASTA EL</text>
    <text x="${W/2}" y="1090" text-anchor="middle"
          font-family="'Instrument Serif', Georgia, serif"
          font-size="20" fill="${COLOR_PEARL}">${safeDate}</text>

    <!-- Footer discreto -->
    <text x="${W/2}" y="1140" text-anchor="middle"
          font-family="'Inter', system-ui, sans-serif"
          font-size="10" letter-spacing="4" fill="${COLOR_MUTED}">KLUXOR — SILENT LUXURY CIRCLE</text>
  </svg>`;
}

// Convierte SVG string a data URL (para <img src>).
function svgToDataUrl(svg) {
  const b64 = typeof window !== "undefined"
    ? window.btoa(unescape(encodeURIComponent(svg)))
    : Buffer.from(svg).toString("base64");
  return `data:image/svg+xml;base64,${b64}`;
}

// Convierte SVG string a PNG data URL via canvas. Usa la resolución
// nativa del viewBox (800x1200) para nitidez en descargas.
function svgToPngDataUrl(svg) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = W;
      canvas.height = H;
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = COLOR_BG;
      ctx.fillRect(0, 0, W, H);
      ctx.drawImage(img, 0, 0, W, H);
      resolve(canvas.toDataURL("image/png"));
    };
    img.onerror = () => reject(new Error("No se pudo renderizar la tarjeta"));
    img.src = svgToDataUrl(svg);
  });
}

// Extrae solo el contenido interior del SVG generado por qrcode
// (sin la envoltura <svg ...>) para poder incrustarlo en la card.
function extractQrInner(fullSvg) {
  const m = fullSvg.match(/<svg[^>]*>([\s\S]*?)<\/svg>/i);
  return m ? m[1] : fullSvg;
}

export default function UmbralCard({ inviteeName, ownerName, url, expiresAt, onReady }) {
  const [qrSvgInner, setQrSvgInner] = useState(null);
  const [qrError,    setQrError]    = useState(null);

  // Lazy-load de qrcode: solo se descarga cuando este componente monta.
  // Cero impacto en el bundle inicial de la app.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { default: QRCode } = await import("qrcode");
        const fullSvg = await QRCode.toString(url || "", {
          type: "svg",
          errorCorrectionLevel: "M",
          margin: 0,
          color: { dark: "#000000", light: "#00000000" },
        });
        if (!cancelled) setQrSvgInner(extractQrInner(fullSvg));
      } catch (e) {
        if (!cancelled) setQrError(e?.message || "Error generando QR");
      }
    })();
    return () => { cancelled = true; };
  }, [url]);

  const svg = useMemo(() => {
    if (!qrSvgInner) return null;
    return buildSvg({ inviteeName, ownerName, expiresAt, qrSvgInner });
  }, [inviteeName, ownerName, expiresAt, qrSvgInner]);

  // Cuando el SVG está listo, avisamos al padre para que sepa que se
  // puede descargar. onReady recibe { downloadPng, downloadPdf }.
  useEffect(() => {
    if (!svg || typeof onReady !== "function") return;
    onReady({
      downloadPng: async () => {
        const png = await svgToPngDataUrl(svg);
        triggerDownload(png, filename(inviteeName, "png"));
      },
      downloadPdf: async () => {
        const png = await svgToPngDataUrl(svg);
        const { default: jsPDF } = await import("jspdf");
        // A4 portrait (210x297 mm). Tarjeta centrada horizontal,
        // margen superior 30mm. La tarjeta 800x1200 escala a ~150x225mm.
        const pdf = new jsPDF({ unit: "mm", format: "a4", orientation: "portrait" });
        const cardWmm = 150;
        const cardHmm = 225;
        const xmm = (210 - cardWmm) / 2;
        const ymm = 30;
        pdf.addImage(png, "PNG", xmm, ymm, cardWmm, cardHmm);
        pdf.save(filename(inviteeName, "pdf"));
      },
    });
  }, [svg, inviteeName, onReady]);

  if (qrError) {
    return <div style={S.error}>Error generando la tarjeta: {qrError}</div>;
  }
  if (!svg) {
    return <div style={S.placeholder}>Preparando tarjeta…</div>;
  }
  return (
    <img
      src={svgToDataUrl(svg)}
      alt={`Convocatoria de ${inviteeName || "invitado"}`}
      style={S.preview}
    />
  );
}

function filename(name, ext) {
  const slug = String(name || "convocatoria")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "convocatoria";
  return `kluxor-umbral-${slug}.${ext}`;
}

function triggerDownload(dataUrl, name) {
  const a = document.createElement("a");
  a.href = dataUrl;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

// Genera el mensaje plano para copiar (WhatsApp/correo). Reutilizado
// desde UmbralView.jsx — exportado para evitar duplicación.
export function buildInviteMessage({ inviteeName, ownerName, url, expiresAt }) {
  const nombre = (inviteeName || "").trim() || "amigo";
  const fecha  = fmtCaducidad(expiresAt);
  const owner  = (ownerName || "").trim() || "el convocante";
  return `Estimado ${nombre},

Le convoco a Kluxor.

No es una herramienta de productividad. Es un Jefe de Gabinete que ordena su día y un Consejo de especialistas —legal, financiero, inmobiliario, societario y contable— al servicio de quien dirige.

Su acceso queda reservado hasta el ${fecha}:
${url}

${owner}`;
}

const S = {
  preview: {
    display: "block",
    width: "100%",
    maxWidth: 400,
    height: "auto",
    margin: "0 auto",
    boxShadow: "0 12px 40px rgba(0,0,0,0.35)",
  },
  placeholder: {
    padding: 40,
    textAlign: "center",
    fontSize: 13,
    color: "#6B6B6B",
    background: "#FAFAF7",
    border: "1px solid #E5E0D5",
  },
  error: {
    padding: 20,
    fontSize: 13,
    color: "#8A2020",
    background: "#FBEFEF",
    border: "1px solid rgba(138,32,32,.2)",
  },
};
