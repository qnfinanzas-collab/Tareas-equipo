// RutaCard — render de un bloque [RUTA] emitido por Héctor.
//
// Familia visual: paridad con TaskListCard (borde gris azulado, tinte
// suave) pero acento oro para el botón de acción primaria. Border-radius
// 0 en todo (regla Kluxor). Sin dependencias externas — el deep link
// a Google Maps abre la app nativa del CEO en móvil.
//
// Estructura:
//   ┌──────────────────────────────────────────────────────┐
//   │ Marbella → Madrid                                    │
//   │ 590 km · 5h 45min · peajes ~32€                      │
//   │ salida 27/06 08:00 · llegada estimada 13:45          │
//   ├──────────────────────────────────────────────────────┤
//   │ ▶  Marbella                       08:00 ·   0 km     │
//   │ ☕ Área Antequera                  09:15 · 120 km     │
//   │    Café · 15min · gasolina                           │
//   │ 🍽 Venta El Romeral, Córdoba       11:30 · 280 km     │
//   │    Salida 320 · andaluza · 1h                        │
//   │ 🏁 Madrid · Hotel X                13:45 · 590 km     │
//   ├──────────────────────────────────────────────────────┤
//   │              [ Abrir en Google Maps ]                │
//   └──────────────────────────────────────────────────────┘

const BORDER = "#3B5573";
const TINT   = "rgba(59,85,115,0.06)";
const GOLD   = "#C9A84C";
const GOLD_HOVER = "#B89438";

const TIPO_ICON = {
  inicio:    "▶",
  cafe:      "☕",
  comida:    "🍽",
  gasolina:  "⛽",
  descanso:  "⏸",
  destino:   "🏁",
  punto:     "•",
};

// Mapeo parada.tipo (schema [RUTA]) → place.type (schema save_place).
// El botón "+" usa esto para construir la seed del PlaceModal. Caso
// inicio se trata aparte (no muestra botón — guardar el punto de
// salida no aporta valor al CEO).
const PARADA_TO_PLACE_TYPE = {
  destino:  "visitar",
  cafe:     "cafe",
  comida:   "comer",
  gasolina: "gasolina",
  descanso: "otro",
  punto:    "otro",
};

function formatSalida(iso) {
  if (!iso) return "";
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?/);
  if (!m) return iso;
  const [, , mm, dd, hh, mi] = m;
  const dia = String(parseInt(dd, 10));
  const mes = ["ene","feb","mar","abr","may","jun","jul","ago","sep","oct","nov","dic"][parseInt(mm,10)-1] || mm;
  return hh && mi ? `${dia} ${mes} ${hh}:${mi}` : `${dia} ${mes}`;
}

// Detección de teléfonos españoles en texto libre de notas. Cuando la nota
// de una parada (ej. "Reservar al 937 130 289") contiene un número, lo
// envuelve en <a href="tel:..."> para que el CEO pulse y llame desde el
// móvil. El resto del texto queda intacto.
//
// Patrón cubierto:
//   · Móviles  6XX XXX XXX, 7XX XXX XXX
//   · Fijos    8XX/9XX XXX XXX
//   · Prefijo  +34 o (+34) o 34 opcional
//   · Separadores opcionales entre bloques: espacio, punto, guion
//
// Normalización tel:href: limpia separadores y prefija +34 si no había
// código país. Conserva el formato visible original (lo que el CEO leyó).
const PHONE_RE = /((?:\+?34[\s.\-]?)?[6789]\d{2}[\s.\-]?\d{3}[\s.\-]?\d{3})/g;

export function renderNoteWithPhones(text) {
  if (!text || typeof text !== "string") return text;
  // split con captura → intercala texto-sin-match y match. Items en
  // posición impar son los teléfonos detectados.
  const parts = text.split(PHONE_RE);
  if (parts.length === 1) return text;  // sin matches
  return parts.map((part, i) => {
    if (i % 2 === 0) return part;
    const digits = part.replace(/[\s.\-()]/g, "");
    const tel = digits.startsWith("+")
      ? digits
      : (digits.length === 11 && digits.startsWith("34"))
        ? "+" + digits
        : "+34" + digits;
    return (
      <a
        key={`tel-${i}`}
        href={`tel:${tel}`}
        style={{
          color: "inherit",
          fontWeight: 600,
          textDecoration: "underline",
          textDecorationStyle: "dotted",
          textUnderlineOffset: "2px",
        }}
        onClick={(e) => e.stopPropagation()}
      >{part}</a>
    );
  });
}

// buildGoogleMapsUrl vive en src/lib/mapsUrl.js para poder testearlo en
// smoke Node (RutaCard tiene JSX, no importable en Node sin transformer).
// El histórico del formato path (f344176) + fix "Torre Eiffel" (prioriza
// p.direccion, descarta labels y activity markers) están documentados allí.
import { buildGoogleMapsUrl } from "../../lib/mapsUrl.js";

export default function RutaCard({ ruta, onSavePlace }) {
  if (!ruta || !Array.isArray(ruta.paradas) || ruta.paradas.length < 2) return null;
  const canSavePlace = typeof onSavePlace === "function";

  const mapsUrl = buildGoogleMapsUrl(ruta);
  const salidaTxt = formatSalida(ruta.salida);

  // Meta-línea inferior con distancia · ETA · peajes — solo lo que esté.
  const metas = [];
  if (ruta.distanciaTotal)  metas.push(ruta.distanciaTotal);
  if (ruta.etaTotal)        metas.push(ruta.etaTotal);
  if (ruta.peajesEstimados) metas.push(`peajes ${ruta.peajesEstimados}`);

  return (
    <div style={{
      marginTop: 10,
      background: TINT,
      border: `1px solid ${BORDER}`,
      borderRadius: 0,
      padding: 14,
    }}>
      {/* Cabecera */}
      <div style={{ marginBottom: 12 }}>
        <div style={{
          fontSize: 13.5,
          fontWeight: 700,
          color: "#1A1A1A",
          marginBottom: 4,
          wordBreak: "break-word",
        }}>
          {ruta.origen || "?"} <span style={{ color: BORDER, margin: "0 4px" }}>→</span> {ruta.destino || "?"}
        </div>
        {metas.length > 0 && (
          <div style={{
            fontSize: 11.5,
            color: "#4B5563",
            fontVariantNumeric: "tabular-nums",
          }}>
            {metas.join(" · ")}
          </div>
        )}
        {salidaTxt && (
          <div style={{
            fontSize: 11,
            color: "#6B6B6B",
            marginTop: 2,
          }}>
            salida {salidaTxt}
          </div>
        )}
      </div>

      {/* Lista de paradas */}
      <div style={{ display: "flex", flexDirection: "column", marginBottom: 12 }}>
        {ruta.paradas.map((p, i) => {
          const icon = TIPO_ICON[p.tipo] || TIPO_ICON.punto;
          // Paradas marcadas como fromCeoPlace destacan visualmente:
          // estrella ⭐ junto al icono y nota personal con estilo enfatizado.
          const isFromCeo = p.fromCeoPlace === true;
          return (
            <div
              key={i}
              style={{
                display: "flex",
                alignItems: "flex-start",
                gap: 10,
                padding: "8px 0",
                borderBottom: i < ruta.paradas.length - 1 ? "0.5px dashed #E5E0D5" : "none",
              }}
            >
              <span style={{
                fontSize: 14,
                minWidth: 22,
                textAlign: "center",
                lineHeight: 1.2,
              }}>{icon}</span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{
                  fontSize: 12.5,
                  fontWeight: 600,
                  color: "#1A1A1A",
                  wordBreak: "break-word",
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                }}>
                  {isFromCeo && (
                    <span
                      title="De Mis Sitios — lugar ya validado por experiencia personal del CEO."
                      style={{ fontSize: 13, color: GOLD, flexShrink: 0 }}
                    >⭐</span>
                  )}
                  <span>{p.lugar}</span>
                </div>
                {p.direccion && p.tipo !== "inicio" && (
                  <div style={{
                    fontSize: 10.5,
                    color: "#6B7280",
                    marginTop: 1,
                    lineHeight: 1.35,
                    wordBreak: "break-word",
                    fontVariantNumeric: "tabular-nums",
                  }}>{p.direccion}</div>
                )}
                {p.nota && (
                  <div style={{
                    fontSize: 11,
                    color: isFromCeo ? "#7A5C0F" : "#6B6B6B",
                    marginTop: 2,
                    lineHeight: 1.4,
                    fontStyle: isFromCeo ? "italic" : "normal",
                    background: isFromCeo ? "#FBF7EB" : "transparent",
                    padding: isFromCeo ? "3px 6px" : 0,
                    border: isFromCeo ? `0.5px solid ${GOLD}33` : "none",
                  }}>{renderNoteWithPhones(p.nota)}</div>
                )}
              </div>
              <div style={{
                fontSize: 11,
                color: "#4B5563",
                fontVariantNumeric: "tabular-nums",
                textAlign: "right",
                minWidth: 90,
                flexShrink: 0,
                display: "flex",
                flexDirection: "column",
                alignItems: "flex-end",
                gap: 4,
              }}>
                {p.hora && <div>{p.hora}</div>}
                {p.km != null && <div style={{ color: "#9CA3AF", fontSize: 10.5 }}>{p.km} km</div>}
                {canSavePlace && p.tipo !== "inicio" && p.lugar && (
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      onSavePlace({
                        name: p.lugar,
                        type: PARADA_TO_PLACE_TYPE[p.tipo] || "otro",
                        notes: p.nota || "",
                        address: p.direccion || "",
                      });
                    }}
                    title="Guardar esta parada en Mis Lugares"
                    style={{
                      fontFamily: "inherit",
                      fontSize: 9.5,
                      fontWeight: 600,
                      color: GOLD,
                      background: "transparent",
                      border: `0.5px solid ${GOLD}`,
                      borderRadius: 0,
                      padding: "2px 6px",
                      cursor: "pointer",
                      letterSpacing: "0.04em",
                      textTransform: "uppercase",
                      lineHeight: 1.3,
                      marginTop: 2,
                    }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.background = GOLD;
                      e.currentTarget.style.color = "#FFFFFF";
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.background = "transparent";
                      e.currentTarget.style.color = GOLD;
                    }}
                  >+ guardar</button>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* Botón */}
      <a
        href={mapsUrl}
        target="_blank"
        rel="noopener noreferrer"
        style={{
          display: "block",
          width: "100%",
          padding: "10px 14px",
          background: GOLD,
          color: "#FFFFFF",
          textAlign: "center",
          textDecoration: "none",
          fontSize: 12.5,
          fontWeight: 700,
          letterSpacing: "0.04em",
          border: `1px solid ${GOLD}`,
          borderRadius: 0,
          transition: "background .15s ease",
        }}
        onMouseEnter={e => { e.currentTarget.style.background = GOLD_HOVER; }}
        onMouseLeave={e => { e.currentTarget.style.background = GOLD; }}
      >
        Abrir en Google Maps ↗
      </a>
    </div>
  );
}
