// AsientoCard — render formal de asientos del libro diario PGC español.
// Se monta cuando Diego (u otro especialista) emite [ASIENTOS]…[/ASIENTOS]
// y el parser de src/lib/parseAsientos.js entrega la lista normalizada.
//
// Identidad Kluxor: paleta operativa, border-radius 0, números con
// alineación tabular (font-variant-numeric: tabular-nums). Verde
// sutil como acento (identidad Diego/contabilidad) + borde oro como
// pieza-de-entrega-de-valor (mismo patrón visual que DocumentCard).
//
// Validación post-LLM: cada asiento trae _cuadra del parser. Si alguno
// descuadra, banner ROJO visible dentro de ese asiento (no silencioso).
// Banner agregado al pie de la card resume el estado total. Los
// asientos descuadrados quedan EXCLUIDOS al pulsar "Crear todos los
// asientos" — coherente con addAccountingEntry que rechazaría el
// payload de todas formas.
//
// Patrón propositivo (idéntico a ActionProposal): el texto del botón
// y los banners siempre en futuro/imperativo: "Voy a crear…",
// "Confirme para crear", nunca en pasado.
import React from "react";

const EUR_FMT = new Intl.NumberFormat("es-ES", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtEur = (n) => EUR_FMT.format(Number(n) || 0) + " €";
const fmtEurOrDash = (n) => (Number(n) || 0) === 0 ? "—" : EUR_FMT.format(Number(n));

function fmtFecha(iso) {
  if (!iso) return "(sin fecha)";
  // Acepta "2026-01-15" y devuelve "15 ene 2026".
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso));
  if (!m) return iso;
  const date = new Date(`${m[1]}-${m[2]}-${m[3]}T12:00:00Z`);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleDateString("es-ES", { day: "2-digit", month: "short", year: "numeric" });
}

export default function AsientoCard({
  asientos = [],
  companyResolver = null,  // (companyId) => "Nombre Empresa" | null
  onCreateEntries = null,  // (cuadrados[]) => void; null = no se muestra acción
  onCancel = null,         // () => void; null = no se muestra cancelar
  disabled = false,        // bloquea acciones tras confirmar/cancelar
  executed = false,        // tras éxito, ocultar acciones, mostrar banner verde
}) {
  if (!Array.isArray(asientos) || asientos.length === 0) return null;

  const cuadrados = asientos.filter(a => a._cuadra);
  const descuadrados = asientos.length - cuadrados.length;
  const empresaLabel = companyResolver && asientos[0].companyId ? companyResolver(asientos[0].companyId) : null;

  const handleCreate = () => {
    if (!onCreateEntries || disabled || executed) return;
    if (cuadrados.length === 0) return;
    onCreateEntries(cuadrados);
  };

  return (
    <div style={{
      background: "#FAFAF7",
      border: "1.5px solid #C9A84C",
      padding: "16px 18px 14px",
      display: "flex",
      flexDirection: "column",
      gap: 14,
      boxShadow: "0 1px 4px rgba(201,168,76,0.18)",
      fontVariantNumeric: "tabular-nums",
    }}>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "baseline", flexWrap: "wrap", gap: 8 }}>
        <span style={{ fontSize: 18, lineHeight: 1, flexShrink: 0 }}>📒</span>
        <div style={{ flex: 1, minWidth: 200 }}>
          <div style={{ fontSize: 15, fontWeight: 700, color: "#1F1A0F", letterSpacing: "0.005em" }}>
            {executed ? "Libro diario creado" : "Libro diario propuesto"} · {asientos.length} asiento{asientos.length !== 1 ? "s" : ""}
            {empresaLabel ? ` · ${empresaLabel}` : ""}
          </div>
          <div style={{ fontSize: 11, color: "#8B6914", letterSpacing: "0.04em", marginTop: 2, fontStyle: "italic" }}>
            Formato PGC español · validado en cliente
          </div>
        </div>
      </div>

      {/* Asientos */}
      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        {asientos.map((a, idx) => (
          <AsientoBlock key={idx} numero={idx + 1} asiento={a} />
        ))}
      </div>

      {/* Banner agregado */}
      {!executed && (
        descuadrados === 0 ? (
          <div style={{
            background: "#ECFDF5",
            border: "0.5px solid #86EFAC",
            padding: "10px 14px",
            fontSize: 12.5,
            color: "#065F46",
            fontWeight: 600,
            letterSpacing: "0.01em",
          }}>
            ✓ Los {asientos.length} asiento{asientos.length !== 1 ? "s cuadran" : " cuadra"} (debe = haber).
          </div>
        ) : (
          <div style={{
            background: "#FEF2F2",
            border: "0.5px solid #FCA5A5",
            padding: "10px 14px",
            fontSize: 12.5,
            color: "#991B1B",
            fontWeight: 600,
            letterSpacing: "0.01em",
          }}>
            ⚠ {descuadrados} asiento{descuadrados !== 1 ? "s" : ""} descuadrado{descuadrados !== 1 ? "s" : ""}. Al confirmar solo se crearán los {cuadrados.length} que cuadran.
          </div>
        )
      )}

      {executed && (
        <div style={{
          background: "#ECFDF5",
          border: "0.5px solid #86EFAC",
          padding: "10px 14px",
          fontSize: 12.5,
          color: "#065F46",
          fontWeight: 600,
        }}>
          ✓ Asientos creados y registrados en el libro diario.
        </div>
      )}

      {/* Acciones (propositivas, nunca en pasado) */}
      {!executed && (onCreateEntries || onCancel) && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 2 }}>
          {onCreateEntries && (
            <button
              onClick={handleCreate}
              disabled={disabled || cuadrados.length === 0}
              title={cuadrados.length === 0 ? "No hay asientos cuadrados para crear" : `Confirmar y crear ${cuadrados.length} asiento(s) en el libro diario`}
              style={{
                padding: "8px 16px",
                minHeight: 38,
                background: (disabled || cuadrados.length === 0) ? "#E5E0D5" : "#0E7C5A",
                color: (disabled || cuadrados.length === 0) ? "#9CA3AF" : "#FFFFFF",
                border: "none",
                fontSize: 13,
                fontWeight: 600,
                cursor: (disabled || cuadrados.length === 0) ? "not-allowed" : "pointer",
                fontFamily: "inherit",
                letterSpacing: "0.01em",
              }}
            >
              {cuadrados.length === asientos.length
                ? `➕ Crear ${cuadrados.length} asiento${cuadrados.length !== 1 ? "s" : ""}`
                : `➕ Crear ${cuadrados.length} asiento${cuadrados.length !== 1 ? "s" : ""} (omitir ${descuadrados} descuadrado${descuadrados !== 1 ? "s" : ""})`}
            </button>
          )}
          {onCancel && (
            <button
              onClick={onCancel}
              disabled={disabled}
              style={{
                padding: "8px 14px",
                minHeight: 38,
                background: "#fff",
                border: "0.5px solid #D1D5DB",
                color: "#4B5563",
                fontSize: 12.5,
                fontWeight: 600,
                cursor: disabled ? "not-allowed" : "pointer",
                fontFamily: "inherit",
              }}
            >
              Descartar
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// AsientoBlock — un asiento individual con cabecera + tabla + totales.
// Si descuadra: banner rojo arriba del asiento + total D/H en rojo.
function AsientoBlock({ numero, asiento }) {
  const cuadra = asiento._cuadra;
  return (
    <div style={{
      background: "#fff",
      border: cuadra ? "0.5px solid #E5E0D5" : "1px solid #FCA5A5",
      padding: "12px 14px",
    }}>
      {/* Cabecera del asiento */}
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 8, flexWrap: "wrap" }}>
        <span style={{ fontSize: 11, fontWeight: 700, color: "#8B6914", letterSpacing: "0.18em" }}>
          ASIENTO {numero}
        </span>
        <span style={{ fontSize: 11, color: "#6B6B6B" }}>
          · {fmtFecha(asiento.fecha)}
        </span>
      </div>
      <div style={{ fontSize: 13.5, fontWeight: 600, color: "#1F1A0F", marginBottom: 10, lineHeight: 1.35 }}>
        {asiento.concepto}
      </div>

      {/* Banner descuadrado */}
      {!cuadra && (
        <div style={{
          background: "#FEF2F2",
          border: "0.5px solid #FCA5A5",
          padding: "6px 10px",
          fontSize: 11.5,
          color: "#991B1B",
          fontWeight: 600,
          marginBottom: 10,
        }}>
          ⚠ Asiento descuadrado · debe {fmtEur(asiento._totalDebe)} ≠ haber {fmtEur(asiento._totalHaber)} (diferencia {fmtEur(asiento._diff)})
        </div>
      )}

      {/* Tabla del asiento */}
      <div style={{ width: "100%", overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5 }}>
          <thead>
            <tr style={{ background: "#FAFAF7" }}>
              <th style={th("left",  90)}>Cuenta</th>
              <th style={th("left",  null)}>Concepto</th>
              <th style={th("right", 100)}>Debe</th>
              <th style={th("right", 100)}>Haber</th>
            </tr>
          </thead>
          <tbody>
            {asiento.lineas.map((l, i) => (
              <tr key={i} style={{ borderBottom: "0.5px solid #F0EBE0" }}>
                <td style={td("left", { fontFamily: "ui-monospace, monospace", letterSpacing: "0.02em" })}>{l.cuenta}</td>
                <td style={td("left")}>{l.nombre || "—"}</td>
                <td style={td("right")}>{fmtEurOrDash(l.debe)}</td>
                <td style={td("right")}>{fmtEurOrDash(l.haber)}</td>
              </tr>
            ))}
            <tr style={{ background: "#FAFAF7", borderTop: "1px solid #C9A84C" }}>
              <td style={td("left", { fontWeight: 700, color: "#8B6914", letterSpacing: "0.08em", textTransform: "uppercase", fontSize: 10.5 })}></td>
              <td style={td("right", { fontWeight: 700, color: "#8B6914", letterSpacing: "0.08em", textTransform: "uppercase", fontSize: 10.5 })}>Total</td>
              <td style={td("right", { fontWeight: 700, color: cuadra ? "#1F1A0F" : "#991B1B" })}>{fmtEur(asiento._totalDebe)}</td>
              <td style={td("right", { fontWeight: 700, color: cuadra ? "#1F1A0F" : "#991B1B" })}>{fmtEur(asiento._totalHaber)}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}

const th = (align, width) => ({
  textAlign: align,
  padding: "6px 8px",
  fontSize: 10.5,
  fontWeight: 700,
  color: "#8B6914",
  letterSpacing: "0.12em",
  textTransform: "uppercase",
  borderBottom: "0.5px solid #E5E0D5",
  ...(width ? { width } : {}),
});

const td = (align, extra = {}) => ({
  textAlign: align,
  padding: "6px 8px",
  color: "#1F1A0F",
  verticalAlign: "top",
  ...extra,
});
