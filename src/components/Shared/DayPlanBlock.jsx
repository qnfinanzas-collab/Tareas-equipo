// DayPlanBlock — bloque unificado del día (Organizador del Día, Fase 2).
//
// Compone visualmente:
//   1. RutaCard (la ruta parseada, reutilizada tal cual).
//   2. Bloque compacto de TAREAS que vencen ese día (dueDate === dayDate),
//      ordenadas por dueTime.
//   3. Banner discreto informativo de negociaciones activas — placeholder
//      hasta Fase 2b que introduce el schema n.nextAction.
//   4. Botón "Descartar ruta" opcional con confirmación inline (solo
//      cuando showDelete=true, típicamente en Mi Día; no en el chat).
//
// Se usa en dos lugares:
//   - HectorDirectView: dentro del renderRuta del ChatBubble. Aquí llega
//     data completo y userId=null (memberId null → todas las tareas del día).
//   - MiDiaView: reemplazando el RutaCard suelto. memberId=activeMember
//     (solo tareas asignadas al usuario activo).
//
// Retrocompat: si no hay tareas del día ni neg activas, solo se renderiza
// la RutaCard — layout idéntico al de Fase 1.
import React, { useMemo, useState } from "react";
import RutaCard from "./RutaCard.jsx";
import { getTasksForDate, countActiveNegotiations, extractPlanDate } from "../../lib/dayPlans.js";

// Paleta local coherente con RutaCard (borde gris azulado) y MiDiaView
// (fondos cálidos crema). Border-radius 0 en todo.
const C = {
  border:      "#3B5573",
  tint:        "rgba(59,85,115,0.04)",
  tintCard:    "#FFFFFF",
  gold:        "#C9A84C",
  goldSoft:    "rgba(201,168,76,0.14)",
  goldText:    "#7A5C0F",
  head:        "#1F2937",
  meta:        "#4B5563",
  metaSoft:    "#9CA3AF",
  danger:      "#A32D2D",
  dangerBg:    "#FDF5F5",
};

const PRI_STYLE = {
  alta:  { bg: "#FDF5F5", text: "#7A1F1F", border: "#7A1F1F40", label: "Alta"  },
  media: { bg: "#FFF8E6", text: "#854F0B", border: "#85510B40", label: "Media" },
  baja:  { bg: "#F0F7F4", text: "#0E7C5A", border: "#0E7C5A40", label: "Baja"  },
};

function TaskRow({ task }) {
  const pri = PRI_STYLE[task.priority] || PRI_STYLE.media;
  const hasHora = /^\d{2}:\d{2}$/.test(task.dueTime || "");
  return (
    <div style={{
      display: "flex",
      alignItems: "flex-start",
      gap: 10,
      padding: "6px 0",
      borderTop: `0.5px dashed #E5E0D5`,
    }}>
      <div style={{
        width: 48,
        fontSize: 11,
        color: hasHora ? C.head : C.metaSoft,
        fontVariantNumeric: "tabular-nums",
        fontWeight: hasHora ? 600 : 400,
        flexShrink: 0,
        paddingTop: 2,
      }}>{hasHora ? task.dueTime : "—"}</div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{
          display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap",
        }}>
          {task.ref && (
            <span style={{
              fontSize: 9.5, fontWeight: 700, color: C.goldText,
              background: C.goldSoft, border: `0.5px solid ${C.gold}55`,
              padding: "1px 5px", letterSpacing: "0.04em",
              fontVariantNumeric: "tabular-nums",
            }}>{task.ref}</span>
          )}
          <span style={{
            fontSize: 12, color: C.head, wordBreak: "break-word",
            fontWeight: 500,
          }}>{task.title}</span>
        </div>
        {task.projName && (
          <div style={{
            fontSize: 10, color: C.metaSoft, marginTop: 2,
          }}>{task.projEmoji} {task.projName}{task.colName ? ` · ${task.colName}` : ""}</div>
        )}
      </div>
      <div style={{
        display: "flex", gap: 4, alignItems: "center", flexShrink: 0,
        paddingTop: 2,
      }}>
        <span style={{
          fontSize: 9.5, fontWeight: 600,
          color: pri.text, background: pri.bg,
          border: `0.5px solid ${pri.border}`,
          padding: "1px 5px", letterSpacing: "0.04em",
          textTransform: "uppercase",
        }}>{pri.label}</span>
        {Number.isFinite(task.duration_minutes) && task.duration_minutes > 0 && (
          <span style={{
            fontSize: 9.5, color: C.meta,
            fontVariantNumeric: "tabular-nums",
          }}>{task.duration_minutes} min</span>
        )}
      </div>
    </div>
  );
}

export default function DayPlanBlock({
  ruta,
  dayDate,               // "YYYY-MM-DD" opcional; si no se pasa, se calcula desde ruta.salida
  data,
  memberId = null,       // null = todas las tareas del día (chat); id = filtra por asignee (Mi Día)
  onSavePlace = null,    // se pasa a RutaCard (chat sí, Mi Día no)
  showDelete = false,
  onDelete,              // callback si showDelete
}) {
  const [askDelete, setAskDelete] = useState(false);

  // Fecha del día: preferimos la prop; si no viene, la extraemos de la
  // ruta. Si tampoco existe, no habrá cruce con tareas — el bloque solo
  // renderiza RutaCard como antes.
  const effectiveDate = dayDate || extractPlanDate(ruta);

  const tasks = useMemo(() => {
    if (!effectiveDate || !data) return [];
    return getTasksForDate(data.boards || {}, data.projects || [], effectiveDate, { memberId });
  }, [effectiveDate, data, memberId]);

  const activeNegCount = useMemo(() => {
    if (!data) return 0;
    return countActiveNegotiations(data.negotiations || []);
  }, [data]);

  const showTasks = tasks.length > 0;
  const showNegBanner = activeNegCount > 0;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <RutaCard ruta={ruta} onSavePlace={onSavePlace} />

      {showTasks && (
        <div style={{
          background: C.tint,
          border: `1px solid ${C.border}`,
          borderRadius: 0,
          padding: "10px 14px",
        }}>
          <div style={{
            fontSize: 10.5, fontWeight: 700, color: C.head,
            textTransform: "uppercase", letterSpacing: "0.08em",
            marginBottom: 6,
            display: "flex", alignItems: "center", gap: 6,
          }}>
            <span>📌 Tareas de este día</span>
            <span style={{
              fontSize: 10, fontWeight: 600,
              color: C.metaSoft,
              fontVariantNumeric: "tabular-nums",
            }}>· {tasks.length}</span>
          </div>
          {tasks.map(t => <TaskRow key={`${t.projId}-${t.id}`} task={t} />)}
        </div>
      )}

      {showNegBanner && (
        <div style={{
          fontSize: 10.5, color: C.metaSoft,
          padding: "6px 12px",
          background: C.tint,
          border: `0.5px dashed ${C.border}`,
          borderRadius: 0,
          fontStyle: "italic",
          lineHeight: 1.4,
        }}>
          🤝 {activeNegCount} negociación{activeNegCount !== 1 ? "es" : ""} activa{activeNegCount !== 1 ? "s" : ""} — próximas acciones pendientes de configurar (Fase 2b).
        </div>
      )}

      {showDelete && onDelete && (
        askDelete ? (
          <div style={{
            display: "flex", alignItems: "center", gap: 8,
            padding: "8px 12px",
            background: C.dangerBg, border: `0.5px solid ${C.danger}`,
            fontSize: 11.5,
          }}>
            <span style={{ flex: 1, color: C.danger, fontWeight: 500 }}>¿Descartar esta ruta del día?</span>
            <button
              type="button"
              onClick={() => { onDelete(); setAskDelete(false); }}
              style={{
                fontFamily: "inherit", fontSize: 10.5, fontWeight: 600,
                color: "#FFFFFF", background: C.danger, border: `1px solid ${C.danger}`,
                borderRadius: 0, padding: "5px 12px", cursor: "pointer",
                letterSpacing: "0.04em", textTransform: "uppercase",
              }}
            >Sí, descartar</button>
            <button
              type="button"
              onClick={() => setAskDelete(false)}
              style={{
                fontFamily: "inherit", fontSize: 10.5, fontWeight: 500,
                color: C.meta, background: "transparent",
                border: `0.5px solid ${C.border}`, borderRadius: 0,
                padding: "5px 12px", cursor: "pointer",
              }}
            >Cancelar</button>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setAskDelete(true)}
            title="Descartar esta ruta del día"
            style={{
              alignSelf: "flex-start",
              fontFamily: "inherit", fontSize: 10, fontWeight: 500,
              color: C.metaSoft, background: "transparent",
              border: `0.5px solid ${C.border}`, borderRadius: 0,
              padding: "3px 10px", cursor: "pointer",
              letterSpacing: "0.04em", textTransform: "uppercase",
            }}
          >Descartar ruta</button>
        )
      )}
    </div>
  );
}
