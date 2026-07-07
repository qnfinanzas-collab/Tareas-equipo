// MisLugaresView — sección visual de los lugares guardados del CEO en
// data.places. Commit 2/3: añade add/edit/delete vía PlaceModal.
// Commit 3 traerá ⌘K + botón "Guardar parada como sitio" en RutaCard.
//
// Add/edit funcionan en paralelo al flujo conversacional save_place de
// Héctor:
//   - Añadir manual usa addPlaceToTenant (mismo que el conversacional —
//     dispara dedup blando si el CEO añade un nombre+tipo ya existente:
//     mergea en lugar de duplicar). Es coherente: añadir "Bar Pepe / comer"
//     a mano cuando ya hay "Bar Pepe / comer" conversacional no debería
//     crear dos.
//   - Editar usa updatePlaceInTenant (NUEVO, NO dispara dedup — actualiza
//     por id exacto). Cambiar el nombre de un lugar existente NO debe
//     mezclarlo con otro.
//   - Borrar usa deletePlaceFromTenant (NUEVO, idempotente por id).
//
// Confirmación de borrado: inline en la card o en el modal, sin
// window.confirm — coherencia con el resto de la app.

import React, { useMemo, useState, useEffect } from "react";
import { renderNoteWithPhones } from "./Shared/RutaCard.jsx";
import { filterMyPlaces } from "../lib/places.js";

// Paleta coherente con TaskListCard (lista de elementos informativa).
// Oro Kluxor como acento (no decoración).
const BORDER = "#3B5573";
const TINT_HEAD = "rgba(59,85,115,0.04)";
const TINT_CARD = "#FFFFFF";
const GOLD = "#C9A84C";
const GOLD_SOFT = "rgba(201,168,76,0.18)";
const META = "#6B7280";
const META_SOFT = "#9CA3AF";
const HEAD = "#1F2937";
const DANGER = "#A32D2D";
const DANGER_BG = "#FEF2F2";

// Iconos cerrados al set válido del schema save_place. Sin emojis
// decorativos extra.
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

// Formato fecha legible "12 jun" o "12 jun 2025" si el año no es actual.
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

// PlaceCard — vista de un lugar. Acciones (Editar/Borrar) condicionales
// a que el padre pase los callbacks. Borrado con confirmación inline:
// pulsa Borrar → la card se transforma a "¿Borrar este lugar?" sin
// ocultarse, segundo click confirma.
function PlaceCard({ place, onEdit, onDelete, pendingDelete, onAskDelete, onCancelDelete }) {
  const tipo = TIPOS_ORDEN.includes(place.type) ? place.type : "otro";
  const icon = TIPO_ICON[tipo];
  const tipoLabel = TIPO_LABEL[tipo];
  const rating = (typeof place.rating === "number" && place.rating >= 0 && place.rating <= 5) ? place.rating : null;
  const visitCount = Number.isFinite(place.visitCount) ? place.visitCount : 0;
  const createdLabel = fmtFecha(place.createdAt);
  const lastVisitLabel = place.lastVisitedAt && place.lastVisitedAt !== place.createdAt
    ? fmtFecha(place.lastVisitedAt) : "";

  const metaPieces = [];
  if (visitCount > 1) metaPieces.push(`${visitCount} visitas`);
  else if (visitCount === 1) metaPieces.push("1 visita");
  if (createdLabel) metaPieces.push(`creado ${createdLabel}`);
  if (lastVisitLabel) metaPieces.push(`última ${lastVisitLabel}`);

  // Modo confirmación inline de borrado
  if (pendingDelete) {
    return (
      <div style={{
        background: DANGER_BG,
        border: `1px solid ${DANGER}`,
        borderLeft: `3px solid ${DANGER}`,
        borderRadius: 0,
        padding: 18,
        display: "flex",
        flexDirection: "column",
        gap: 12,
        minHeight: 110,
        justifyContent: "center",
      }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: DANGER, lineHeight: 1.4 }}>
          ¿Borrar «{place.name}»?
        </div>
        <div style={{ fontSize: 11, color: META, lineHeight: 1.5 }}>
          Se eliminará del repositorio personal. Esta acción no se puede deshacer.
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button
            type="button"
            onClick={() => onDelete(place.id)}
            style={{
              fontFamily: "inherit", fontSize: 11.5, fontWeight: 600,
              color: "#FFFFFF", background: DANGER,
              border: `1px solid ${DANGER}`, borderRadius: 0,
              padding: "7px 14px", cursor: "pointer",
              letterSpacing: "0.04em", textTransform: "uppercase",
            }}
          >Sí, borrar</button>
          <button
            type="button"
            onClick={onCancelDelete}
            style={{
              fontFamily: "inherit", fontSize: 11.5, fontWeight: 500,
              color: META, background: "transparent",
              border: `0.5px solid ${BORDER}`, borderRadius: 0,
              padding: "7px 14px", cursor: "pointer",
            }}
          >Cancelar</button>
        </div>
      </div>
    );
  }

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
      position: "relative",
    }}>
      {/* Cabecera: icono + nombre + tipo badge + acciones */}
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

      {/* Nota */}
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

      {/* Pie: metadata operativa + acciones */}
      <div style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        marginTop: 2,
        gap: 8,
      }}>
        <div style={{
          fontSize: 10,
          color: META_SOFT,
          textTransform: "lowercase",
          flex: 1,
          minWidth: 0,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}>{metaPieces.length > 0 ? metaPieces.join(" · ") : ""}</div>
        {(onEdit || onAskDelete) && (
          <div style={{ display: "flex", gap: 4, flexShrink: 0 }}>
            {onEdit && (
              <button
                type="button"
                onClick={() => onEdit(place)}
                title="Editar lugar"
                style={{
                  fontFamily: "inherit", fontSize: 10, fontWeight: 500,
                  color: META, background: "transparent",
                  border: `0.5px solid ${BORDER}`, borderRadius: 0,
                  padding: "3px 8px", cursor: "pointer",
                  letterSpacing: "0.04em", textTransform: "uppercase",
                }}
              >Editar</button>
            )}
            {onAskDelete && (
              <button
                type="button"
                onClick={() => onAskDelete(place.id)}
                title="Borrar lugar"
                style={{
                  fontFamily: "inherit", fontSize: 10, fontWeight: 500,
                  color: DANGER, background: "transparent",
                  border: `0.5px solid ${DANGER}55`, borderRadius: 0,
                  padding: "3px 8px", cursor: "pointer",
                  letterSpacing: "0.04em", textTransform: "uppercase",
                }}
              >Borrar</button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// PlaceModal — form de add/edit. Validación inline (name obligatorio).
// Modo CREATE: pre-rellena si recibe `place` como seed (Commit 3: botón
// "+" desde una parada de RutaCard abre este modal con name/type/notes
// pre-rellenados). Modo EDIT: pre-rellena del place recibido.
// Botones: Cancelar / Guardar (+ Borrar en modo EDIT, con confirmación
// inline reemplazando los botones).
// Export: usado dentro de MisLugaresView (CRUD propio) Y desde App.jsx
// como overlay global cuando una parada de RutaCard dispara guardar.
export function PlaceModal({ mode, place, onSubmit, onDelete, onClose }) {
  const isEdit = mode === "edit";
  // Acepta `place` también en modo create — funciona como seed inicial
  // sin convertir la operación en update (no hay id, no toca lastVisitedAt).
  const initial = place || null;

  const [name, setName]       = useState(initial?.name || "");
  const [type, setType]       = useState(initial?.type && TIPOS_ORDEN.includes(initial.type) ? initial.type : "otro");
  const [address, setAddress] = useState(initial?.address || "");
  const [notes, setNotes]     = useState(initial?.notes || "");
  const [ratingStr, setRatingStr] = useState(
    typeof initial?.rating === "number" ? String(initial.rating) : ""
  );
  // Tags como CSV editable. Al guardar: split por coma, trim, filter no vacíos.
  const [tagsStr, setTagsStr] = useState(
    Array.isArray(initial?.tags) ? initial.tags.join(", ") : ""
  );
  const [errorName, setErrorName] = useState("");
  const [askDelete, setAskDelete] = useState(false);

  // Cerrar con Escape — patrón del resto de la app.
  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const submit = (e) => {
    if (e && e.preventDefault) e.preventDefault();
    const cleanName = name.trim();
    if (!cleanName) {
      setErrorName("El nombre es obligatorio.");
      return;
    }
    setErrorName("");
    // Rating: vacío → null. Si número, clamp 0..5 (el mutator también
    // clampa como red secundaria).
    let rating = null;
    if (ratingStr !== "" && ratingStr !== null && ratingStr !== undefined) {
      const r = Number(ratingStr);
      if (Number.isFinite(r)) rating = Math.max(0, Math.min(5, r));
    }
    const tags = tagsStr.split(",").map(t => t.trim()).filter(Boolean);
    const payload = {
      name: cleanName,
      type,
      address: address.trim(),
      notes: notes.trim(),
      rating,
      tags,
    };
    onSubmit(payload, initial?.id);
  };

  return (
    <div
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(15,15,15,0.55)",
        zIndex: 5500,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 20,
      }}
    >
      <div style={{
        background: "#FFFFFF",
        border: `1px solid ${BORDER}`,
        borderRadius: 0,
        width: 480,
        maxWidth: "100%",
        maxHeight: "90vh",
        overflowY: "auto",
        boxShadow: "0 20px 60px rgba(0,0,0,0.25)",
      }}>
        {/* Cabecera del modal */}
        <div style={{
          padding: "16px 20px",
          borderBottom: `1px solid ${BORDER}`,
          background: TINT_HEAD,
        }}>
          <div style={{ fontSize: 11, fontWeight: 600, color: GOLD, textTransform: "uppercase", letterSpacing: "0.1em" }}>
            Mis Lugares
          </div>
          <div style={{ fontSize: 17, fontWeight: 600, color: HEAD, marginTop: 4 }}>
            {isEdit ? "Editar lugar" : "Añadir lugar"}
          </div>
        </div>

        {/* Form */}
        <form onSubmit={submit} style={{ padding: 20, display: "flex", flexDirection: "column", gap: 14 }}>
          {/* Nombre */}
          <div>
            <label style={lblStyle}>Nombre <span style={{ color: DANGER }}>*</span></label>
            <input
              type="text"
              value={name}
              onChange={(e) => { setName(e.target.value); if (errorName) setErrorName(""); }}
              placeholder="Ej. Venta El Romeral"
              autoFocus
              style={inputStyle(errorName ? DANGER : BORDER)}
            />
            {errorName && (
              <div style={{ fontSize: 11, color: DANGER, marginTop: 4 }}>{errorName}</div>
            )}
          </div>

          {/* Tipo */}
          <div>
            <label style={lblStyle}>Tipo</label>
            <select
              value={type}
              onChange={(e) => setType(e.target.value)}
              style={inputStyle(BORDER)}
            >
              {TIPOS_ORDEN.map(t => (
                <option key={t} value={t}>{TIPO_ICON[t]}  {TIPO_LABEL[t]}</option>
              ))}
            </select>
          </div>

          {/* Dirección */}
          <div>
            <label style={lblStyle}>Dirección</label>
            <input
              type="text"
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              placeholder="Calle, ciudad, indicación útil"
              style={inputStyle(BORDER)}
            />
          </div>

          {/* Rating */}
          <div>
            <label style={lblStyle}>Valoración (0-5, opcional)</label>
            <input
              type="number"
              min="0"
              max="5"
              step="1"
              value={ratingStr}
              onChange={(e) => setRatingStr(e.target.value)}
              placeholder="Sin valorar"
              style={{ ...inputStyle(BORDER), width: 120 }}
            />
            <div style={{ fontSize: 10.5, color: META_SOFT, marginTop: 3 }}>
              Vacío = sin valorar. 5 = excelente.
            </div>
          </div>

          {/* Notas */}
          <div>
            <label style={lblStyle}>Notas</label>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Cualquier detalle útil: cuándo fue, con quién, qué pidió, teléfono de reserva..."
              rows={4}
              style={{ ...inputStyle(BORDER), resize: "vertical", fontFamily: "inherit" }}
            />
            <div style={{ fontSize: 10.5, color: META_SOFT, marginTop: 3 }}>
              Los teléfonos en las notas se convierten en enlaces pulsables al ver el lugar.
            </div>
          </div>

          {/* Tags */}
          <div>
            <label style={lblStyle}>Etiquetas (separadas por coma)</label>
            <input
              type="text"
              value={tagsStr}
              onChange={(e) => setTagsStr(e.target.value)}
              placeholder="andaluz, coche, parada habitual"
              style={inputStyle(BORDER)}
            />
          </div>

          {/* Metadata pie (solo en modo edit) */}
          {isEdit && (
            <div style={{
              fontSize: 10.5,
              color: META_SOFT,
              padding: "8px 10px",
              background: TINT_HEAD,
              border: `0.5px solid ${BORDER}`,
              borderLeft: `2px solid ${BORDER}`,
              lineHeight: 1.6,
            }}>
              {initial?.createdAt && <div>Creado el {fmtFecha(initial.createdAt)}</div>}
              {Number.isFinite(initial?.visitCount) && initial.visitCount > 0 && (
                <div>{initial.visitCount} {initial.visitCount === 1 ? "visita" : "visitas"} registradas</div>
              )}
              {initial?.lastVisitedAt && initial.lastVisitedAt !== initial.createdAt && (
                <div>Última visita {fmtFecha(initial.lastVisitedAt)}</div>
              )}
              <div style={{ marginTop: 4, fontStyle: "italic", fontSize: 10 }}>
                Estos datos no se editan a mano — se actualizan cuando guarda el lugar hablando con Héctor.
              </div>
            </div>
          )}

          {/* Botones */}
          {askDelete ? (
            <div style={{
              padding: "12px 14px",
              background: DANGER_BG,
              border: `1px solid ${DANGER}`,
              borderLeft: `3px solid ${DANGER}`,
            }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: DANGER, marginBottom: 4 }}>
                ¿Seguro que quiere borrar «{initial?.name}»?
              </div>
              <div style={{ fontSize: 11, color: META, lineHeight: 1.5, marginBottom: 10 }}>
                Se eliminará del repositorio personal. Esta acción no se puede deshacer.
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                <button
                  type="button"
                  onClick={() => { onDelete(initial.id); }}
                  style={{
                    fontFamily: "inherit", fontSize: 11.5, fontWeight: 600,
                    color: "#FFFFFF", background: DANGER,
                    border: `1px solid ${DANGER}`, borderRadius: 0,
                    padding: "7px 14px", cursor: "pointer",
                    letterSpacing: "0.04em", textTransform: "uppercase",
                  }}
                >Sí, borrar</button>
                <button
                  type="button"
                  onClick={() => setAskDelete(false)}
                  style={{
                    fontFamily: "inherit", fontSize: 11.5, fontWeight: 500,
                    color: META, background: "transparent",
                    border: `0.5px solid ${BORDER}`, borderRadius: 0,
                    padding: "7px 14px", cursor: "pointer",
                  }}
                >Cancelar</button>
              </div>
            </div>
          ) : (
            <div style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              gap: 10,
              marginTop: 6,
            }}>
              {isEdit ? (
                <button
                  type="button"
                  onClick={() => setAskDelete(true)}
                  style={{
                    fontFamily: "inherit", fontSize: 11, fontWeight: 500,
                    color: DANGER, background: "transparent",
                    border: `0.5px solid ${DANGER}55`, borderRadius: 0,
                    padding: "7px 14px", cursor: "pointer",
                    letterSpacing: "0.04em", textTransform: "uppercase",
                  }}
                >Borrar lugar</button>
              ) : <div/>}
              <div style={{ display: "flex", gap: 8 }}>
                <button
                  type="button"
                  onClick={onClose}
                  style={{
                    fontFamily: "inherit", fontSize: 12, fontWeight: 500,
                    color: META, background: "transparent",
                    border: `0.5px solid ${BORDER}`, borderRadius: 0,
                    padding: "8px 16px", cursor: "pointer",
                  }}
                >Cancelar</button>
                <button
                  type="submit"
                  style={{
                    fontFamily: "inherit", fontSize: 12, fontWeight: 600,
                    color: "#0A0A0A", background: GOLD,
                    border: `1px solid ${GOLD}`, borderRadius: 0,
                    padding: "8px 18px", cursor: "pointer",
                    letterSpacing: "0.04em", textTransform: "uppercase",
                  }}
                >{isEdit ? "Guardar cambios" : "Añadir"}</button>
              </div>
            </div>
          )}
        </form>
      </div>
    </div>
  );
}

const lblStyle = {
  display: "block",
  fontSize: 11,
  fontWeight: 600,
  color: HEAD,
  marginBottom: 5,
  textTransform: "uppercase",
  letterSpacing: "0.06em",
};

function inputStyle(borderColor) {
  return {
    width: "100%",
    padding: "9px 12px",
    fontSize: 13,
    color: HEAD,
    background: "#FFFFFF",
    border: `1px solid ${borderColor}`,
    borderRadius: 0,
    fontFamily: "inherit",
    outline: "none",
    boxSizing: "border-box",
  };
}

export default function MisLugaresView({ data, activeMember, onAdd, onUpdate, onDelete }) {
  const [filtroTipo, setFiltroTipo] = useState("todos");
  const [modalState, setModalState] = useState(null);  // null | "create" | place-object (edit)
  const [pendingDeleteId, setPendingDeleteId] = useState(null);
  // Aislamiento por member (07/07/2026): filtramos SIEMPRE por
  // activeMember — cada usuario ve solo los suyos, nunca los de otros
  // users del mismo tenant. Defensa en profundidad; App.jsx además
  // envuelve los mutators con activeMember.
  const places = useMemo(
    () => filterMyPlaces(data?.places || [], activeMember),
    [data, activeMember]
  );

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

  const lugaresOrdenados = useMemo(() => {
    return [...lugaresFiltrados].sort((a, b) => {
      const da = a?.lastVisitedAt || a?.createdAt || "";
      const db = b?.lastVisitedAt || b?.createdAt || "";
      return db.localeCompare(da);
    });
  }, [lugaresFiltrados]);

  // Handlers
  const handleSubmit = (payload, id) => {
    if (modalState === "create") {
      onAdd && onAdd(payload);
    } else if (id) {
      onUpdate && onUpdate(id, payload);
    }
    setModalState(null);
  };
  const handleDeleteFromModal = (id) => {
    onDelete && onDelete(id);
    setModalState(null);
    setPendingDeleteId(null);
  };
  const handleDeleteFromCard = (id) => {
    onDelete && onDelete(id);
    setPendingDeleteId(null);
  };

  return (
    <div style={{ padding: "24px 28px", maxWidth: 1100, margin: "0 auto" }}>
      {/* Cabecera de sección con acción Añadir */}
      <div style={{
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "space-between",
        gap: 16,
        marginBottom: 22,
      }}>
        <div style={{ flex: 1, minWidth: 0 }}>
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
              ? "Aún no tiene lugares guardados. Añada uno aquí o dígale a Héctor «guarda este sitio…»."
              : `${places.length} ${places.length === 1 ? "lugar guardado" : "lugares guardados"}. Héctor los usa como paradas preferentes al planear sus rutas.`}
          </p>
        </div>
        {onAdd && (
          <button
            type="button"
            onClick={() => setModalState("create")}
            style={{
              fontFamily: "inherit", fontSize: 12, fontWeight: 600,
              color: "#0A0A0A", background: GOLD,
              border: `1px solid ${GOLD}`, borderRadius: 0,
              padding: "10px 18px", cursor: "pointer",
              letterSpacing: "0.04em", textTransform: "uppercase",
              flexShrink: 0,
              whiteSpace: "nowrap",
            }}
          >+ Añadir lugar</button>
        )}
      </div>

      {/* Filtros */}
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

      {/* Estado vacío total */}
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
          Use «+ Añadir lugar» o hable con Héctor: <em>«guarda Venta El Romeral en Córdoba, comimos genial»</em>.
        </div>
      )}

      {/* Estado vacío por filtro */}
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

      {/* Grid */}
      {lugaresOrdenados.length > 0 && (
        <div style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))",
          gap: 12,
        }}>
          {lugaresOrdenados.map(p => (
            <PlaceCard
              key={p.id}
              place={p}
              onEdit={onUpdate ? (pl => setModalState(pl)) : null}
              onAskDelete={onDelete ? (setPendingDeleteId) : null}
              pendingDelete={pendingDeleteId === p.id}
              onDelete={handleDeleteFromCard}
              onCancelDelete={() => setPendingDeleteId(null)}
            />
          ))}
        </div>
      )}

      {/* Modal */}
      {modalState && (
        <PlaceModal
          mode={modalState === "create" ? "create" : "edit"}
          place={modalState === "create" ? null : modalState}
          onSubmit={handleSubmit}
          onDelete={handleDeleteFromModal}
          onClose={() => setModalState(null)}
        />
      )}
    </div>
  );
}
