// MisLugaresView — sección de SOLO LECTURA de los lugares guardados del
// CEO en data.places. Commit 1/3 de la sección visual: ver lo que ya hay.
// Add/edit/delete vienen en Commit 2; ⌘K y botón en RutaCard en Commit 3.
//
// Por qué SECCIÓN propia (no Workspaces): un workspace agrupa enlaces+
// contactos+credenciales de un CLIENTE; Mis Lugares es repositorio
// personal del CEO de sitios físicos (donde durmió, comió, visitó). Se
// pueden seguir guardando hablando con Héctor (save_place) como hasta
// hoy; esta vista solo los lista.
//
// Gating: arriba en el sidebar/Home (requiresOwner:true), aquí no
// volvemos a comprobar — confiamos en el caller.

import React, { useMemo, useState } from "react";
import { renderNoteWithPhones } from "./Shared/RutaCard.jsx";

// Paleta coherente con TaskListCard (lista de tareas como referencia
// visual de "vista informativa de elementos"). Oro Kluxor como acento
// (no decoración).
const BORDER = "#3B5573";
const TINT_HEAD = "rgba(59,85,115,0.04)";
const TINT_CARD = "#FFFFFF";
const GOLD = "#C9A84C";
const GOLD_SOFT = "rgba(201,168,76,0.18)";
const META = "#6B7280";
const META_SOFT = "#9CA3AF";
const HEAD = "#1F2937";

// Iconos cerrados al set válido del schema save_place. Sin emojis
// decorativos extra. "otro" tiene un punto neutro, no un icono concreto
// para no engañar.
const TIPO_ICON = {
  dormir:   "🛏",
  comer:    "🍽",
  visitar:  "📍",
  cafe:     "☕",
  gasolina: "⛽",
  otro:     "•",
};
const TIPO_LABEL = {
  dormir:   "Dormir",
  comer:    "Comer",
  visitar:  "Visitar",
  cafe:     "Café",
  gasolina: "Gasolina",
  otro:     "Otros",
};
const TIPOS_ORDEN = ["dormir","comer","visitar","cafe","gasolina","otro"];

// Formato fecha legible "12 jun" o "12 jun 2025" si el año no es el actual.
function fmtFecha(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  const meses = ["ene","feb","mar","abr","may","jun","jul","ago","sep","oct","nov","dic"];
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return sameYear
    ? `${d.getDate()} ${meses[d.getMonth()]}`
    : `${d.getDate()} ${meses[d.getMonth()]} ${d.getFullYear()}`;
}

function PlaceCard({ place }) {
  const tipo = TIPOS_ORDEN.includes(place.type) ? place.type : "otro";
  const icon = TIPO_ICON[tipo];
  const tipoLabel = TIPO_LABEL[tipo];
  const rating = (typeof place.rating === "number" && place.rating >= 0 && place.rating <= 5) ? place.rating : null;
  const visitCount = Number.isFinite(place.visitCount) ? place.visitCount : 0;
  const createdLabel = fmtFecha(place.createdAt);
  const lastVisitLabel = place.lastVisitedAt && place.lastVisitedAt !== place.createdAt
    ? fmtFecha(place.lastVisitedAt) : "";

  // Pie con metadata. Solo se muestran piezas con valor real (no rellenos
  // con "0 visitas" o "creado hace nada" que añadan ruido).
  const metaPieces = [];
  if (visitCount > 1) metaPieces.push(`${visitCount} visitas`);
  else if (visitCount === 1) metaPieces.push("1 visita");
  if (createdLabel) metaPieces.push(`creado ${createdLabel}`);
  if (lastVisitLabel) metaPieces.push(`última ${lastVisitLabel}`);

  return (
    <div style={{
      background: TINT_CARD,
      border: `1px solid ${BORDER}`,
      borderLeft: `3px solid ${GOLD}`,
      borderRadius: 0,
      padding: 14,
      display: "flex",
      flexDirection: "column",
      gap: 8,
    }}>
      {/* Cabecera: icono + nombre + tipo badge */}
      <div style={{ display: "flex", alignItems: "flex-start", gap: 10 }}>
        <span style={{
          fontSize: 18,
          lineHeight: 1.1,
          flexShrink: 0,
          width: 24,
          textAlign: "center",
        }}>{icon}</span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{
            fontSize: 14,
            fontWeight: 600,
            color: HEAD,
            wordBreak: "break-word",
            lineHeight: 1.3,
          }}>{place.name || "(sin nombre)"}</div>
          <div style={{
            fontSize: 10,
            fontWeight: 600,
            color: GOLD,
            textTransform: "uppercase",
            letterSpacing: "0.08em",
            marginTop: 2,
          }}>{tipoLabel}</div>
        </div>
        {rating !== null && (
          <div style={{
            fontSize: 11,
            color: GOLD,
            fontWeight: 600,
            fontVariantNumeric: "tabular-nums",
            flexShrink: 0,
            padding: "1px 6px",
            border: `0.5px solid ${GOLD_SOFT}`,
            background: GOLD_SOFT,
          }}>{rating}/5</div>
        )}
      </div>

      {/* Dirección */}
      {place.address && (
        <div style={{
          fontSize: 12,
          color: META,
          lineHeight: 1.4,
          wordBreak: "break-word",
        }}>{place.address}</div>
      )}

      {/* Nota — el helper detecta teléfonos y los hace clicables */}
      {place.notes && (
        <div style={{
          fontSize: 12,
          color: HEAD,
          lineHeight: 1.5,
          fontStyle: "italic",
          background: TINT_HEAD,
          padding: "6px 8px",
          borderLeft: `2px solid ${BORDER}`,
          wordBreak: "break-word",
        }}>{renderNoteWithPhones(place.notes)}</div>
      )}

      {/* Tags */}
      {Array.isArray(place.tags) && place.tags.length > 0 && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
          {place.tags.map((t, i) => (
            <span key={i} style={{
              fontSize: 10,
              color: META,
              padding: "1px 6px",
              border: `0.5px dashed ${BORDER}`,
              background: TINT_HEAD,
            }}>{t}</span>
          ))}
        </div>
      )}

      {/* Pie: metadata operativa */}
      {metaPieces.length > 0 && (
        <div style={{
          fontSize: 10,
          color: META_SOFT,
          marginTop: 2,
          textTransform: "lowercase",
        }}>{metaPieces.join(" · ")}</div>
      )}
    </div>
  );
}

export default function MisLugaresView({ data }) {
  const [filtroTipo, setFiltroTipo] = useState("todos");
  const places = useMemo(() => Array.isArray(data?.places) ? data.places : [], [data]);

  // Cuenta por tipo para los chips de filtro. Solo se muestran chips de
  // tipos que tienen al menos 1 lugar — evitar chips vacíos.
  const conteoPorTipo = useMemo(() => {
    const c = {};
    for (const p of places) {
      const t = TIPOS_ORDEN.includes(p?.type) ? p.type : "otro";
      c[t] = (c[t] || 0) + 1;
    }
    return c;
  }, [places]);

  const tiposVisibles = TIPOS_ORDEN.filter(t => (conteoPorTipo[t] || 0) > 0);

  const lugaresFiltrados = useMemo(() => {
    if (filtroTipo === "todos") return places;
    return places.filter(p => (p?.type || "otro") === filtroTipo);
  }, [places, filtroTipo]);

  // Ordenación: lastVisitedAt descendente (los más recientemente visitados
  // arriba). Sin lastVisitedAt cae a createdAt.
  const lugaresOrdenados = useMemo(() => {
    return [...lugaresFiltrados].sort((a, b) => {
      const da = a?.lastVisitedAt || a?.createdAt || "";
      const db = b?.lastVisitedAt || b?.createdAt || "";
      return db.localeCompare(da);
    });
  }, [lugaresFiltrados]);

  return (
    <div style={{ padding: "24px 28px", maxWidth: 1100, margin: "0 auto" }}>
      {/* Cabecera de sección */}
      <div style={{ marginBottom: 22 }}>
        <h1 style={{
          fontSize: 22,
          fontWeight: 600,
          color: HEAD,
          margin: 0,
          letterSpacing: "-0.01em",
        }}>📍 Mis Lugares</h1>
        <p style={{
          fontSize: 12.5,
          color: META,
          margin: "6px 0 0",
          lineHeight: 1.5,
        }}>
          {places.length === 0
            ? "Aún no tiene lugares guardados. Dígale a Héctor «guarda este sitio…» y aparecerán aquí."
            : `${places.length} ${places.length === 1 ? "lugar guardado" : "lugares guardados"}. Héctor los usa como paradas preferentes al planear sus rutas.`}
        </p>
      </div>

      {/* Filtros por tipo. Solo se muestran si hay >1 tipo distinto. */}
      {tiposVisibles.length > 1 && (
        <div style={{
          display: "flex",
          flexWrap: "wrap",
          gap: 6,
          marginBottom: 18,
          paddingBottom: 14,
          borderBottom: `0.5px solid ${BORDER}`,
        }}>
          {[{ key: "todos", label: "Todos", count: places.length }, ...tiposVisibles.map(t => ({ key: t, label: TIPO_LABEL[t], count: conteoPorTipo[t] }))].map(chip => {
            const activo = filtroTipo === chip.key;
            return (
              <button
                key={chip.key}
                type="button"
                onClick={() => setFiltroTipo(chip.key)}
                style={{
                  fontFamily: "inherit",
                  fontSize: 11.5,
                  fontWeight: activo ? 600 : 500,
                  color: activo ? "#FFFFFF" : HEAD,
                  background: activo ? BORDER : "transparent",
                  border: `0.5px solid ${BORDER}`,
                  borderRadius: 0,
                  padding: "6px 12px",
                  cursor: "pointer",
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 6,
                  transition: "background .15s, color .15s",
                }}
              >
                <span>{chip.label}</span>
                <span style={{
                  fontSize: 10,
                  color: activo ? "#FFFFFF" : META_SOFT,
                  fontWeight: 500,
                  opacity: activo ? 0.85 : 1,
                }}>{chip.count}</span>
              </button>
            );
          })}
        </div>
      )}

      {/* Estado vacío (sin lugares en total) */}
      {places.length === 0 && (
        <div style={{
          padding: "40px 24px",
          textAlign: "center",
          border: `1px dashed ${BORDER}`,
          background: TINT_HEAD,
          color: META,
          fontSize: 13,
          lineHeight: 1.6,
        }}>
          <div style={{ fontSize: 32, marginBottom: 12, opacity: 0.4 }}>📍</div>
          Aún no hay lugares guardados.<br/>
          Hable con Héctor: <em>«Héctor, guarda Venta El Romeral en Córdoba, comimos genial»</em>.
        </div>
      )}

      {/* Estado vacío de filtro (hay lugares pero no de este tipo) */}
      {places.length > 0 && lugaresOrdenados.length === 0 && (
        <div style={{
          padding: "30px 24px",
          textAlign: "center",
          border: `0.5px dashed ${BORDER}`,
          color: META,
          fontSize: 12.5,
        }}>
          Sin lugares del tipo «{TIPO_LABEL[filtroTipo] || filtroTipo}». Pruebe otro filtro.
        </div>
      )}

      {/* Grid de cards */}
      {lugaresOrdenados.length > 0 && (
        <div style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))",
          gap: 12,
        }}>
          {lugaresOrdenados.map(p => <PlaceCard key={p.id} place={p} />)}
        </div>
      )}
    </div>
  );
}
