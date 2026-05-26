// MiDiaView — agenda diaria por horas del usuario activo. Vive aparte de
// MyTasksView (lista filtrada) y de la Sala de Mando (foco operativo).
// Tres tabs: Hoy, Mañana, Esta semana. Tareas con dueTime se distribuyen
// en franjas horarias 08:00–22:00; las que tienen dueDate del día pero
// sin dueTime van al bloque "Sin hora asignada".
//
// Independencia: no toca TaskModal global, no muta shared state fuera de
// los callbacks que recibe por props. duration_minutes se persiste vía
// onUpdateTask (jsonb, sin migración).
import React, { useMemo, useState } from "react";

const C = {
  bg: "#FAFAF7",
  surface: "#FFFFFF",
  border: "#E5E0D5",
  borderSoft: "#F0EDE5",
  textPrimary: "#1A1A1A",
  textSecondary: "#6B6B6B",
  textTertiary: "#9B9B9B",
  gold: "#C9A84C",
  goldLight: "#E8DFC4",
  goldText: "#7A5C0F",
  red: "#A32D2D",
  redBg: "#FDF5F5",
};

const HOURS_AGENDA = (() => { const a = []; for (let h = 8; h <= 22; h++) a.push(h); return a; })();

const PRI_COLORS = {
  alta:  { bg: "#FDF5F5", text: "#7A1F1F", border: "#7A1F1F40" },
  media: { bg: "#FFF8E6", text: "#854F0B", border: "#85510B40" },
  baja:  { bg: "#F0F7F4", text: "#0E7C5A", border: "#0E7C5A40" },
};

const DUR_OPTIONS = [15, 30, 45, 60, 90, 120];

function toISO(d) {
  const tz = d.getTimezoneOffset() * 60000;
  return new Date(d.getTime() - tz).toISOString().slice(0, 10);
}
function todayISO()    { return toISO(new Date()); }
function tomorrowISO() { const d = new Date(); d.setDate(d.getDate() + 1); return toISO(d); }
function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }

function endTime(start, durMin) {
  if (!start) return "";
  const [h, m] = start.split(":").map(Number);
  const total = h * 60 + m + (durMin || 60);
  const eh = Math.floor(total / 60) % 24;
  const em = total % 60;
  return `${String(eh).padStart(2, "0")}:${String(em).padStart(2, "0")}`;
}

const WEEKDAYS = ["Domingo", "Lunes", "Martes", "Miércoles", "Jueves", "Viernes", "Sábado"];
const MONTHS = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];
function weekdayLabel(d) { return WEEKDAYS[d.getDay()]; }
function dayMonthLabel(d) { return `${d.getDate()} ${MONTHS[d.getMonth()]}`; }

function btnStyle(color, primary = false) {
  return {
    padding: "4px 10px",
    fontSize: 11,
    background: primary ? (color || C.gold) : "transparent",
    color: primary ? "#fff" : (color || C.textSecondary),
    border: primary ? "none" : `0.5px solid ${color || C.border}`,
    cursor: "pointer",
    fontFamily: "inherit",
    borderRadius: 0,
    fontWeight: 500,
    letterSpacing: "0.02em",
  };
}

const fieldLabelStyle = {
  display: "flex",
  flexDirection: "column",
  gap: 4,
  fontSize: 10,
  fontWeight: 600,
  color: C.textSecondary,
  letterSpacing: "0.05em",
  textTransform: "uppercase",
};

const fieldInputStyle = {
  background: "#fff",
  border: `0.5px solid ${C.border}`,
  borderRadius: 0,
  padding: "6px 8px",
  fontSize: 12,
  color: C.textPrimary,
  fontFamily: "inherit",
  outline: "none",
};

// Opciones de estado disponibles en el editor inline. El mapping a colId
// real se hace por nombre dentro del board del proyecto de cada tarea.
// Si el proyecto no tiene una columna con ese nombre exacto, el cambio
// se ignora silenciosamente — el resto de campos (fecha/hora/duración)
// se actualizan igual.
const STATUS_OPTIONS = ["Por hacer", "En progreso", "Hecho"];

export default function MiDiaView({
  data,
  activeMember,
  onOpenTask,
  onCompleteTask,
  onArchiveTask,
  onDeleteTask,
  onUpdateTask,
  onMoveTask,
}) {
  const [tab, setTab] = useState("hoy");
  const [pendingDeleteId, setPendingDeleteId] = useState(null);
  const [pendingArchiveId, setPendingArchiveId] = useState(null);
  const [editingId, setEditingId] = useState(null);
  const [editDraft, setEditDraft] = useState(null);

  const openEdit = (t) => {
    setEditingId(t.id);
    setEditDraft({
      dueDate: t.dueDate || "",
      dueTime: t.dueTime || "",
      duration_minutes: Number(t.duration_minutes) || 60,
      colName: t.colName || "Por hacer",
    });
    setPendingDeleteId(null);
    setPendingArchiveId(null);
  };
  const closeEdit = () => { setEditingId(null); setEditDraft(null); };
  const saveEdit = (t) => {
    if (!editDraft) { closeEdit(); return; }
    const fieldUpdates = {};
    if (editDraft.dueDate !== (t.dueDate || ""))                              fieldUpdates.dueDate = editDraft.dueDate;
    if (editDraft.dueTime !== (t.dueTime || ""))                              fieldUpdates.dueTime = editDraft.dueTime;
    if (Number(editDraft.duration_minutes) !== (Number(t.duration_minutes) || 60)) {
      fieldUpdates.duration_minutes = Number(editDraft.duration_minutes);
    }
    if (Object.keys(fieldUpdates).length > 0) onUpdateTask?.(t.id, fieldUpdates);
    if (editDraft.colName && editDraft.colName !== t.colName && onMoveTask) {
      const projCols = data?.boards?.[t.projId] || [];
      const target = projCols.find(c => c?.name === editDraft.colName);
      if (target && target.id !== t.colId) {
        onMoveTask(t.id, t.colId, target.id);
      } else if (!target) {
        console.warn(`[MiDiaView] proyecto ${t.projCode || t.projId} no tiene columna "${editDraft.colName}", estado no movido`);
      }
    }
    closeEdit();
  };

  // Aplanar tareas vivas asignadas al usuario activo.
  const myTasks = useMemo(() => {
    const out = [];
    Object.entries(data?.boards || {}).forEach(([pid, cols]) => {
      const proj = (data?.projects || []).find(p => p && p.id === Number(pid));
      if (!proj || proj.archived) return;
      (cols || []).forEach(col => {
        if (!col || col.name === "Hecho") return;
        (col.tasks || []).forEach(t => {
          if (!t || t.archived) return;
          if (!t.assignees?.includes(activeMember)) return;
          out.push({
            ...t,
            colId: col.id,
            colName: col.name,
            projId: Number(pid),
            projName: proj.name || "",
            projCode: proj.code || "",
            projEmoji: proj.emoji || "📋",
            projColor: proj.color || C.gold,
          });
        });
      });
    });
    return out;
  }, [data, activeMember]);

  const filtered = useMemo(() => {
    const today = todayISO();
    const tomorrow = tomorrowISO();
    return myTasks.filter(t => {
      if (!t.dueDate) return false;
      if (tab === "hoy") return t.dueDate === today;
      if (tab === "manana") return t.dueDate === tomorrow;
      if (tab === "semana") {
        const start = new Date(); start.setHours(0, 0, 0, 0);
        const end = addDays(new Date(), 6); end.setHours(23, 59, 59, 999);
        const d = new Date(t.dueDate);
        return d >= start && d <= end;
      }
      return false;
    });
  }, [myTasks, tab]);

  const TaskCard = ({ t, hideTime = false }) => {
    const dur = Number(t.duration_minutes) || 60;
    const endT = hideTime ? "" : endTime(t.dueTime, dur);
    const pri = PRI_COLORS[t.priority] || PRI_COLORS.media;
    const isPendingDel = pendingDeleteId === t.id;
    const isPendingArch = pendingArchiveId === t.id;
    const isEditing = editingId === t.id;

    // Opciones de estado para el select: las 3 estándar + la actual si
    // el proyecto tiene una columna fuera de ese set (ej. "Revision").
    const statusOptions = STATUS_OPTIONS.includes(t.colName || "")
      ? STATUS_OPTIONS
      : [...new Set([t.colName || "Por hacer", ...STATUS_OPTIONS])];

    return (
      <div style={{
        background: C.surface,
        border: `1px solid ${C.border}`,
        borderLeft: `3px solid ${t.projColor || C.gold}`,
        borderRadius: 8,
        padding: "10px 12px",
        display: "flex",
        flexDirection: "column",
        gap: 6,
      }}>
        <div style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", marginBottom: 3 }}>
              {t.ref && (
                <span style={{
                  fontSize: 10, fontWeight: 600, padding: "1px 6px",
                  background: C.goldLight, color: C.goldText,
                  fontFamily: "ui-monospace,SFMono-Regular,Menlo,Consolas,monospace",
                  letterSpacing: "0.04em",
                }}>{t.ref}</span>
              )}
              <span style={{ fontSize: 11, color: C.textSecondary }}>
                {t.projEmoji} {t.projName}{t.colName ? ` · ${t.colName}` : ""}
              </span>
            </div>
            <div style={{
              fontSize: 13, fontWeight: 500, color: C.textPrimary,
              lineHeight: 1.35, wordBreak: "break-word",
            }}>{t.title}</div>
            {!hideTime && (
              <div style={{
                fontSize: 11, color: C.textSecondary, marginTop: 4,
                fontVariantNumeric: "tabular-nums",
              }}>
                {t.dueTime} – {endT} <span style={{ color: C.textTertiary }}>· {dur}m</span>
              </div>
            )}
          </div>
          <span style={{
            fontSize: 9, fontWeight: 700, padding: "2px 7px",
            background: pri.bg, color: pri.text, border: `0.5px solid ${pri.border}`,
            letterSpacing: "0.04em", textTransform: "uppercase", flexShrink: 0,
          }}>{t.priority || "media"}</span>
        </div>

        {isEditing ? (
          <div style={{
            background: C.borderSoft, padding: 10, marginTop: 4,
            borderTop: `0.5px solid ${C.border}`,
            display: "flex", flexDirection: "column", gap: 10,
          }}>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
              <label style={fieldLabelStyle}>
                <span>Fecha</span>
                <input
                  type="date"
                  value={editDraft?.dueDate || ""}
                  onChange={e => setEditDraft(d => ({ ...d, dueDate: e.target.value }))}
                  style={fieldInputStyle}
                />
              </label>
              <label style={fieldLabelStyle}>
                <span>Hora inicio</span>
                <input
                  type="time"
                  value={editDraft?.dueTime || ""}
                  onChange={e => setEditDraft(d => ({ ...d, dueTime: e.target.value }))}
                  style={fieldInputStyle}
                />
              </label>
              <label style={fieldLabelStyle}>
                <span>Duración</span>
                <select
                  value={editDraft?.duration_minutes || 60}
                  onChange={e => setEditDraft(d => ({ ...d, duration_minutes: Number(e.target.value) }))}
                  style={fieldInputStyle}
                >
                  {DUR_OPTIONS.map(m => <option key={m} value={m}>{m} min</option>)}
                </select>
              </label>
              <label style={fieldLabelStyle}>
                <span>Estado</span>
                <select
                  value={editDraft?.colName || "Por hacer"}
                  onChange={e => setEditDraft(d => ({ ...d, colName: e.target.value }))}
                  style={fieldInputStyle}
                >
                  {statusOptions.map(s => <option key={s} value={s}>{s}</option>)}
                </select>
              </label>
            </div>
            <div style={{ display: "flex", gap: 6, justifyContent: "space-between", alignItems: "center", flexWrap: "wrap" }}>
              {onOpenTask
                ? <button onClick={() => { closeEdit(); onOpenTask(t.id); }} style={btnStyle()}>↗ Ver tarea completa</button>
                : <span/>}
              <div style={{ display: "flex", gap: 6 }}>
                <button onClick={closeEdit}            style={btnStyle()}>Cancelar</button>
                <button onClick={() => saveEdit(t)}    style={btnStyle(C.gold, true)}>Guardar</button>
              </div>
            </div>
          </div>
        ) : isPendingDel ? (
          <div style={{
            display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap",
            background: C.redBg, padding: 8, borderTop: `0.5px solid ${C.red}`,
          }}>
            <span style={{ fontSize: 11, color: C.red, flex: 1, minWidth: 0 }}>
              ¿Eliminar esta tarea? Esta acción no se puede deshacer.
            </span>
            <button
              onClick={() => { onDeleteTask?.(t.id); setPendingDeleteId(null); }}
              style={btnStyle(C.red, true)}
            >Eliminar</button>
            <button onClick={() => setPendingDeleteId(null)} style={btnStyle()}>Cancelar</button>
          </div>
        ) : isPendingArch ? (
          <div style={{
            display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap",
            background: C.borderSoft, padding: 8, borderTop: `0.5px solid ${C.border}`,
          }}>
            <span style={{ fontSize: 11, color: C.textSecondary, flex: 1, minWidth: 0 }}>
              ¿Archivar esta tarea? Podrás restaurarla desde Mis Tareas.
            </span>
            <button
              onClick={() => { onArchiveTask?.(t.id); setPendingArchiveId(null); }}
              style={btnStyle(C.gold, true)}
            >Archivar</button>
            <button onClick={() => setPendingArchiveId(null)} style={btnStyle()}>Cancelar</button>
          </div>
        ) : (
          <div style={{
            display: "flex", gap: 6, flexWrap: "wrap",
            paddingTop: 6, borderTop: `0.5px solid ${C.borderSoft}`,
          }}>
            {onUpdateTask   && <button onClick={() => openEdit(t)}                                    style={btnStyle()}>✏ Editar</button>}
            {onCompleteTask && <button onClick={() => onCompleteTask(t.id, t.projId, t.colId)}        style={btnStyle("#0E7C5A")}>✓ Hecho</button>}
            {onArchiveTask  && <button onClick={() => setPendingArchiveId(t.id)}                      style={btnStyle()}>🗂 Archivar</button>}
            {onDeleteTask   && <button onClick={() => setPendingDeleteId(t.id)}                       style={btnStyle(C.red)}>🗑 Eliminar</button>}
          </div>
        )}
      </div>
    );
  };

  const renderAgendaDay = (dayLabel) => {
    const withTime = filtered
      .filter(t => /^\d{2}:\d{2}$/.test(t.dueTime || ""))
      .sort((a, b) => a.dueTime.localeCompare(b.dueTime));
    const withoutTime = filtered.filter(t => !/^\d{2}:\d{2}$/.test(t.dueTime || ""));

    const byHour = {};
    HOURS_AGENDA.forEach(h => { byHour[h] = []; });
    withTime.forEach(t => {
      const h = parseInt(t.dueTime.split(":")[0], 10);
      const bucket = h < 8 ? 8 : h > 22 ? 22 : h;
      byHour[bucket].push(t);
    });

    if (withTime.length === 0 && withoutTime.length === 0) {
      return (
        <div style={{ padding: "60px 20px", textAlign: "center", color: C.textTertiary, fontSize: 13 }}>
          Sin tareas asignadas para {dayLabel}.
        </div>
      );
    }

    return (
      <>
        <div>
          {HOURS_AGENDA.map(h => (
            <div key={h} style={{
              display: "flex", alignItems: "flex-start",
              borderTop: `0.5px solid ${C.border}`,
              padding: "8px 0", minHeight: 48,
            }}>
              <div style={{
                width: 56, paddingTop: 4, fontSize: 11,
                color: C.textSecondary, fontVariantNumeric: "tabular-nums",
              }}>{String(h).padStart(2, "0")}:00</div>
              <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 6 }}>
                {byHour[h].length === 0
                  ? <div style={{ height: 32 }} />
                  : byHour[h].map(t => <TaskCard key={t.id} t={t} />)}
              </div>
            </div>
          ))}
        </div>
        {withoutTime.length > 0 && (
          <div style={{ marginTop: 28 }}>
            <div style={{
              fontSize: 11, fontWeight: 600, color: C.textTertiary,
              letterSpacing: "0.08em", textTransform: "uppercase",
              padding: "8px 0", borderBottom: `0.5px solid ${C.border}`,
              marginBottom: 12,
            }}>
              Sin hora asignada · {withoutTime.length}
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {withoutTime.map(t => <TaskCard key={t.id} t={t} hideTime />)}
            </div>
          </div>
        )}
      </>
    );
  };

  const renderWeek = () => {
    const days = [];
    for (let i = 0; i < 7; i++) {
      const d = addDays(new Date(), i);
      const iso = toISO(d);
      const dayTasks = filtered
        .filter(t => t.dueDate === iso)
        .sort((a, b) => (a.dueTime || "99:99").localeCompare(b.dueTime || "99:99"));
      days.push({ d, iso, tasks: dayTasks });
    }
    const anyTasks = days.some(x => x.tasks.length > 0);
    if (!anyTasks) {
      return (
        <div style={{ padding: "60px 20px", textAlign: "center", color: C.textTertiary, fontSize: 13 }}>
          Sin tareas asignadas en los próximos 7 días.
        </div>
      );
    }
    return days.map(({ d, iso, tasks }) => tasks.length > 0 && (
      <div key={iso} style={{ marginBottom: 22 }}>
        <div style={{
          fontSize: 11, fontWeight: 600, color: C.textSecondary,
          letterSpacing: "0.08em", textTransform: "uppercase",
          padding: "8px 0", borderBottom: `1px solid ${C.border}`,
          marginBottom: 10,
        }}>
          {weekdayLabel(d)} · {dayMonthLabel(d)}
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {tasks.map(t => <TaskCard key={t.id} t={t} hideTime={!t.dueTime} />)}
        </div>
      </div>
    ));
  };

  return (
    <div style={{
      padding: "20px 24px", background: C.bg, minHeight: "100%",
      fontFamily: "'Segoe UI', system-ui, -apple-system, sans-serif",
    }}>
      <div style={{ maxWidth: 880, margin: "0 auto" }}>
        <h1 style={{ fontSize: 22, fontWeight: 600, color: C.textPrimary, margin: "0 0 4px" }}>Mi Día</h1>
        <p style={{ fontSize: 13, color: C.textSecondary, margin: "0 0 18px" }}>
          Agenda de tus tareas asignadas, organizada por horas.
        </p>

        <div style={{ display: "flex", gap: 0, marginBottom: 20, borderBottom: `1px solid ${C.border}` }}>
          {[
            { id: "hoy",    label: "Hoy" },
            { id: "manana", label: "Mañana" },
            { id: "semana", label: "Esta semana" },
          ].map(opt => (
            <button
              key={opt.id}
              onClick={() => setTab(opt.id)}
              style={{
                padding: "10px 18px",
                background: "transparent",
                border: "none",
                borderBottom: `2px solid ${tab === opt.id ? C.gold : "transparent"}`,
                color: tab === opt.id ? C.textPrimary : C.textSecondary,
                fontSize: 13,
                fontWeight: tab === opt.id ? 600 : 400,
                cursor: "pointer",
                fontFamily: "inherit",
                borderRadius: 0,
              }}
            >{opt.label}</button>
          ))}
        </div>

        {tab === "hoy"    && renderAgendaDay("hoy")}
        {tab === "manana" && renderAgendaDay("mañana")}
        {tab === "semana" && renderWeek()}
      </div>
    </div>
  );
}
