// MiDiaView — agenda diaria por horas del usuario activo. Vive aparte de
// MyTasksView (lista filtrada) y de la Sala de Mando (foco operativo).
// Tres tabs: Hoy, Mañana, Esta semana. Tareas con dueTime se distribuyen
// en franjas horarias 08:00–22:00; las que tienen el ancla del día pero
// sin dueTime van al bloque "Sin hora asignada".
//
// EJE DE FECHA (decisión de producto, fix de junio 2026): el día en el
// que aparece cada tarea se determina por su FECHA DE INICIO (startDate)
// — cuándo se ataca la tarea — NO por dueDate (cuándo vence). Fallback
// para tareas históricas sin startDate: caemos a dueDate. El editor
// rápido de la tarjeta edita SOLO startDate; dueDate se preserva
// intacto y se modifica desde el detalle de la tarea, no desde aquí.
// Misma lógica de ancla para overdue: una tarea "atrasada en Mi Día"
// es una que ya debía atacarse y sigue sin estar Hecho.
//
// Independencia: no toca TaskModal global, no muta shared state fuera de
// los callbacks que recibe por props. duration_minutes se persiste vía
// onUpdateTask (jsonb, sin migración).
import React, { useMemo, useState } from "react";

// Ancla del día para Mi Día: startDate manda; dueDate solo cubre tareas
// históricas (creadas antes de que se introdujera el campo o desde
// vistas que no lo rellenaban). Una función única para que filtro,
// overdue y vista semana compartan la misma regla — la coherencia
// entre los tres era una restricción explícita del fix.
function taskAnchor(t) {
  return t?.startDate || t?.dueDate || "";
}

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

function dateNavBtnStyle(disabled) {
  return {
    padding: "5px 10px",
    background: "transparent",
    color: disabled ? C.textTertiary : C.textSecondary,
    border: `0.5px solid ${C.border}`,
    borderRadius: 0,
    fontSize: 12,
    cursor: disabled ? "not-allowed" : "pointer",
    fontFamily: "inherit",
    fontWeight: 500,
    minWidth: 36,
  };
}

// Formulario inline de creación. Vive dentro de una franja horaria del
// agenda — la hora inicio llega pre-rellenada por el caller. Valida
// solo título no vacío; el resto tiene defaults razonables (60m, alta,
// proyecto = primero disponible si "Personal / Sin proyecto"). Submit
// dispara onSubmit(); el caller llama a onCreateTask y cierra.
function CreateForm({ draft, setDraft, availableProjects, defaultProjectId, onSubmit, onCancel, onNavigateProjects }) {
  if (!draft) return null;
  // Para guardar requerimos: título no vacío Y projId explícito. El
  // dropdown ya no muestra "Personal / Sin proyecto" — si el usuario no
  // ha configurado su defecto, debe elegir uno. Esto cierra el bug
  // histórico de tareas que caían a data.projects[0] (Marbella Club).
  const canSubmit = (draft.title || "").trim().length > 0
                 && availableProjects.length > 0
                 && !!draft.projId;
  const defaultProj = defaultProjectId != null
    ? availableProjects.find(p => p.id === defaultProjectId)
    : null;
  return (
    <div style={{
      background: C.borderSoft, padding: 12, border: `0.5px solid ${C.border}`,
      borderLeft: `3px solid ${C.gold}`,
      display: "flex", flexDirection: "column", gap: 10,
    }}>
      <label style={fieldLabelStyle}>
        <span>Título</span>
        <input
          type="text"
          autoFocus
          value={draft.title}
          onChange={e => setDraft(d => ({ ...d, title: e.target.value }))}
          onKeyDown={e => { if (e.key === "Enter" && canSubmit) { e.preventDefault(); onSubmit(); } if (e.key === "Escape") onCancel(); }}
          placeholder="¿Qué hay que hacer?"
          style={{ ...fieldInputStyle, fontSize: 13 }}
        />
      </label>
      {/* Descripción: textarea plano multilínea. Se guarda en
          task.desc (campo canónico del schema — verificado en TaskModal,
          INITIAL_DATA y addTaskToProject). Enter dentro del textarea
          hace salto de línea por defecto, NO submit — coherente con la
          expectativa de un campo de texto largo. Escape no cancela aquí
          a propósito: si el CEO está escribiendo un párrafo, no quiero
          que la tecla Escape pierda su texto. Cancelar = botón. */}
      <label style={fieldLabelStyle}>
        <span>Descripción</span>
        <textarea
          rows={2}
          value={draft.desc || ""}
          onChange={e => setDraft(d => ({ ...d, desc: e.target.value }))}
          placeholder="Opcional · contexto, detalles, recordatorios"
          style={{ ...fieldInputStyle, fontSize: 13, resize: "vertical", lineHeight: 1.5, boxSizing: "border-box", width: "100%" }}
        />
      </label>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
        <label style={fieldLabelStyle}>
          <span>Hora inicio</span>
          <input
            type="time"
            value={draft.dueTime}
            onChange={e => setDraft(d => ({ ...d, dueTime: e.target.value }))}
            style={fieldInputStyle}
          />
        </label>
        <label style={fieldLabelStyle}>
          <span>Duración</span>
          <select
            value={draft.duration_minutes}
            onChange={e => setDraft(d => ({ ...d, duration_minutes: Number(e.target.value) }))}
            style={fieldInputStyle}
          >
            {DUR_OPTIONS.map(m => <option key={m} value={m}>{m} min</option>)}
          </select>
        </label>
        <label style={fieldLabelStyle}>
          <span>Prioridad</span>
          <select
            value={draft.priority}
            onChange={e => setDraft(d => ({ ...d, priority: e.target.value }))}
            style={fieldInputStyle}
          >
            <option value="alta">Alta</option>
            <option value="media">Media</option>
            <option value="baja">Baja</option>
          </select>
        </label>
        <label style={fieldLabelStyle}>
          <span>Proyecto</span>
          {/* Sin defecto: primera opción es un placeholder deshabilitado
              que obliga a elegir; sin elección, el botón Crear queda
              deshabilitado (canSubmit). Con defecto: dropdown se pre-elige
              con el proyecto-defecto y se ve con sufijo "· por defecto".
              Cero fallback silencioso. */}
          <select
            value={draft.projId}
            onChange={e => setDraft(d => ({ ...d, projId: e.target.value }))}
            style={fieldInputStyle}
          >
            {!draft.projId && <option value="" disabled>— Elige proyecto —</option>}
            {availableProjects.map(p => (
              <option key={p.id} value={p.id}>
                {p.emoji || "📋"} {p.name}{p.code ? ` [${p.code}]` : ""}
                {defaultProj && p.id === defaultProj.id ? " · por defecto" : ""}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div style={{ display: "flex", gap: 6, justifyContent: "space-between", alignItems: "center", flexWrap: "wrap" }}>
        {/* Hint sutil: si NO hay proyecto-defecto del usuario, sugerir
            configurar uno en Proyectos para que la próxima vez salga
            pre-elegido. Si hay defecto, no añadimos ruido. */}
        {!defaultProj && onNavigateProjects ? (
          <button
            onClick={() => onNavigateProjects()}
            style={{
              ...btnStyle(),
              fontSize: 10,
              padding: "3px 8px",
              color: C.textTertiary,
              border: "none",
              textDecoration: "underline",
              fontStyle: "italic",
            }}
          >Configurar mi proyecto por defecto</button>
        ) : <span/>}
        <div style={{ display: "flex", gap: 6 }}>
          <button onClick={onCancel} style={btnStyle()}>Cancelar</button>
          <button
            onClick={onSubmit}
            disabled={!canSubmit}
            style={{
              ...btnStyle(C.gold, true),
              opacity: canSubmit ? 1 : 0.5,
              cursor: canSubmit ? "pointer" : "not-allowed",
            }}
          >Crear</button>
        </div>
      </div>
    </div>
  );
}

// Opciones de estado disponibles en el editor inline. El mapping a colId
// real se hace por nombre dentro del board del proyecto de cada tarea.
// Si el proyecto no tiene una columna con ese nombre exacto, el cambio
// se ignora silenciosamente — el resto de campos (fecha/hora/duración)
// se actualizan igual.
const STATUS_OPTIONS = ["Por hacer", "En progreso", "Hecho"];

// findPersonalProject ELIMINADO. Antes resolvía "Personal / Sin proyecto"
// cayendo en último término a projects[0] — origen del bug histórico
// "tareas en Marbella Club". Sustituido por:
//   - dropdown que muestra el defaultProjectId del usuario pre-elegido,
//   - "Crear" deshabilitado si no hay proyecto explícito,
//   - link "Configurar mi proyecto por defecto" → navegación a Proyectos.

export default function MiDiaView({
  data,
  activeMember,
  defaultProjectId = null,
  onNavigateProjects,
  onOpenTask,
  onCompleteTask,
  onArchiveTask,
  onDeleteTask,
  onUpdateTask,
  onMoveTask,
  onCreateTask,
}) {
  const [tab, setTab] = useState("dia");
  const [selectedDate, setSelectedDate] = useState(() => todayISO());
  const [pendingDeleteId, setPendingDeleteId] = useState(null);
  const [pendingArchiveId, setPendingArchiveId] = useState(null);
  const [editingId, setEditingId] = useState(null);
  const [editDraft, setEditDraft] = useState(null);
  const [createHour, setCreateHour] = useState(null);
  const [createDraft, setCreateDraft] = useState(null);
  const [overdueCollapsed, setOverdueCollapsed] = useState(true);

  const availableProjects = useMemo(
    () => (data?.projects || []).filter(p => p && !p.archived),
    [data]
  );

  const openCreate = (h) => {
    setCreateHour(h);
    setCreateDraft({
      title: "",
      desc: "",
      dueTime: `${String(h).padStart(2, "0")}:00`,
      duration_minutes: 60,
      priority: "alta",
      // Pre-elegir el proyecto-defecto del USUARIO si existe y sigue
      // disponible (no archivado). Si no, dropdown vacío que obliga a
      // elegir explícitamente.
      projId: (defaultProjectId != null
              && availableProjects.some(p => p.id === defaultProjectId))
        ? String(defaultProjectId)
        : "",
    });
    setEditingId(null);
    setEditDraft(null);
    setPendingDeleteId(null);
    setPendingArchiveId(null);
  };
  const closeCreate = () => { setCreateHour(null); setCreateDraft(null); };
  const submitCreate = () => {
    if (!createDraft || !createDraft.title.trim() || !onCreateTask) { closeCreate(); return; }
    // Proyecto obligatorio. Sin elección explícita no se crea — el
    // botón "Crear" ya está disabled vía canSubmit en CreateForm, esto
    // es defensa adicional. Cero fallback silencioso a projects[0].
    const targetProjId = createDraft.projId ? Number(createDraft.projId) : null;
    if (!targetProjId) {
      console.warn("[MiDiaView] submitCreate sin projId — se aborta (sin fallback silencioso)");
      return;
    }
    const dayIso = tab === "dia" ? selectedDate : todayISO();
    // Nueva tarea nace con startDate Y dueDate alineados al día visible.
    // startDate es ahora la fuente para Mi Día (cuándo se ataca); dueDate
    // se mantiene para que el resto de vistas (Kanban, Eisenhower) sigan
    // teniendo fecha límite explícita. Si más adelante se introduce el
    // concepto tarea/evento, dueDate puede diverger libremente.
    onCreateTask(targetProjId, {
      title: createDraft.title.trim(),
      // Descripción: se persiste en task.desc (campo canónico, ver
      // App.jsx addTaskToProject que lee payload.desc). Trim para no
      // grabar espacios sueltos cuando el CEO escribe y borra.
      desc: (createDraft.desc || "").trim(),
      priority: createDraft.priority,
      startDate: dayIso,
      dueDate: dayIso,
      dueTime: createDraft.dueTime,
      duration_minutes: Number(createDraft.duration_minutes) || 60,
      assignees: [activeMember],
    });
    closeCreate();
  };

  // Navegación de fechas en modo "día". goToday vuelve a hoy; goPrev/
  // goNext desplazan en días naturales. Cambiar fecha desde el picker
  // fuerza tab="dia" automáticamente.
  const goPrevDay = () => setSelectedDate(toISO(addDays(new Date(selectedDate + "T00:00:00"), -1)));
  const goNextDay = () => setSelectedDate(toISO(addDays(new Date(selectedDate + "T00:00:00"),  1)));
  const goToday   = () => setSelectedDate(todayISO());
  const isToday   = selectedDate === todayISO();
  const selectedDateObj = new Date(selectedDate + "T00:00:00");
  const dateHeaderLabel = `${weekdayLabel(selectedDateObj)} ${dayMonthLabel(selectedDateObj)}`;

  // Reabrir tarea completada — vuelve a "Por hacer" (o primera columna
  // disponible si el proyecto no tiene esa exacta).
  const reopenTask = (t) => {
    if (!onMoveTask) return;
    const projCols = data?.boards?.[t.projId] || [];
    const target = projCols.find(c => c?.name === "Por hacer") || projCols[0];
    if (target && target.id !== t.colId) onMoveTask(t.id, t.colId, target.id);
  };

  const openEdit = (t) => {
    setEditingId(t.id);
    // El editor rápido de Mi Día edita SOLO la fecha de INICIO (cuándo
    // se ataca). dueDate se preserva intacto y se modifica desde el
    // detalle de la tarea. Pre-rellenamos con el ancla actual (startDate
    // o, si no existe, dueDate como fallback histórico) para que al
    // abrir el editor el CEO vea el día en el que la tarea está
    // colocada en la agenda.
    setEditDraft({
      startDate: t.startDate || t.dueDate || "",
      dueTime: t.dueTime || "",
      duration_minutes: Number(t.duration_minutes) || 60,
      colName: t.colName || "Por hacer",
    });
    setPendingDeleteId(null);
    setPendingArchiveId(null);
    setCreateHour(null);
    setCreateDraft(null);
  };
  const closeEdit = () => { setEditingId(null); setEditDraft(null); };

  // Lookup de la tarea original (sin metadata de proyecto que añade el
  // flatten). Necesario porque updateTaskAnywhere REEMPLAZA la tarea con
  // el objeto recibido (no merge) — pasarle solo el diff destrozaba
  // assignees/tags/comments/timeline/subtasks y crasheaba con forEach
  // sobre undefined en código downstream. Mismo patrón del bug del
  // color picker en Kanban.
  const findOriginalTask = (taskId) => {
    if (!data?.boards) return null;
    for (const pid in data.boards) {
      const cols = data.boards[pid];
      if (!Array.isArray(cols)) continue;
      for (const col of cols) {
        const found = col?.tasks?.find?.(x => x?.id === taskId);
        if (found) return found;
      }
    }
    return null;
  };

  const saveEdit = (t) => {
    if (!editDraft) { closeEdit(); return; }
    const fieldUpdates = {};
    // SOLO startDate, dueTime y duration_minutes. dueDate NO se toca
    // aquí — se conserva intacto para que cualquier vista que dependa
    // de la fecha límite (Kanban, Eisenhower, alertas) siga con su
    // valor original. Decisión de producto: el editor rápido mueve la
    // tarea de día en la agenda; vencer es otra cosa, otra UI.
    if (editDraft.startDate !== (t.startDate || ""))                          fieldUpdates.startDate = editDraft.startDate;
    if (editDraft.dueTime !== (t.dueTime || ""))                              fieldUpdates.dueTime = editDraft.dueTime;
    if (Number(editDraft.duration_minutes) !== (Number(t.duration_minutes) || 60)) {
      fieldUpdates.duration_minutes = Number(editDraft.duration_minutes);
    }
    if (Object.keys(fieldUpdates).length > 0) {
      const original = findOriginalTask(t.id);
      if (original) {
        onUpdateTask?.(t.id, { ...original, ...fieldUpdates });
      } else {
        console.warn(`[MiDiaView] no se encontró tarea original ${t.id} en data.boards, update omitido`);
      }
    }
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

  // Aplanar tareas asignadas al usuario activo. Incluye "Hecho" para que
  // las completadas aparezcan en su día con visual tachado/verde. Los
  // filtros downstream (overdue, agenda) excluyen Hecho cuando aplica.
  const myTasks = useMemo(() => {
    const out = [];
    Object.entries(data?.boards || {}).forEach(([pid, cols]) => {
      const proj = (data?.projects || []).find(p => p && p.id === Number(pid));
      if (!proj || proj.archived) return;
      (cols || []).forEach(col => {
        if (!col) return;
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
    return myTasks.filter(t => {
      const anchor = taskAnchor(t);
      if (!anchor) return false;
      if (tab === "dia") return anchor === selectedDate;
      if (tab === "semana") {
        const start = new Date(); start.setHours(0, 0, 0, 0);
        const end = addDays(new Date(), 6); end.setHours(23, 59, 59, 999);
        const d = new Date(anchor);
        return d >= start && d <= end;
      }
      return false;
    });
  }, [myTasks, tab, selectedDate]);

  // Días anteriores — tareas que ya debían atacarse (startDate < hoy)
  // y siguen sin estar en Hecho. Usa el mismo ancla que `filtered` —
  // así Mi Día y el contador de atrasadas hablan del mismo eje: cuándo
  // se trabaja la tarea, no cuándo vence. Excluye Hecho aquí porque
  // myTasks sí incluye esa columna (para mostrarlas en su día con
  // visual diferenciado).
  const overdueTasks = useMemo(() => {
    const today = todayISO();
    return myTasks
      .filter(t => {
        const anchor = taskAnchor(t);
        return anchor && anchor < today && t.colName !== "Hecho";
      })
      .sort((a, b) => {
        const dateCmp = taskAnchor(a).localeCompare(taskAnchor(b));
        if (dateCmp !== 0) return dateCmp;
        return (a.dueTime || "99:99").localeCompare(b.dueTime || "99:99");
      });
  }, [myTasks]);

  const TaskCard = ({ t, hideTime = false }) => {
    const dur = Number(t.duration_minutes) || 60;
    const endT = hideTime ? "" : endTime(t.dueTime, dur);
    const pri = PRI_COLORS[t.priority] || PRI_COLORS.media;
    const isPendingDel = pendingDeleteId === t.id;
    const isPendingArch = pendingArchiveId === t.id;
    const isEditing = editingId === t.id;
    const isDone = t.colName === "Hecho";

    // Opciones de estado para el select: las 3 estándar + la actual si
    // el proyecto tiene una columna fuera de ese set (ej. "Revision").
    const statusOptions = STATUS_OPTIONS.includes(t.colName || "")
      ? STATUS_OPTIONS
      : [...new Set([t.colName || "Por hacer", ...STATUS_OPTIONS])];

    return (
      <div style={{
        background: isDone ? "#F0FAF0" : C.surface,
        border: `1px solid ${C.border}`,
        borderLeft: `3px solid ${isDone ? "#4CAF50" : (t.projColor || C.gold)}`,
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
              fontSize: 13, fontWeight: 500,
              color: isDone ? C.textSecondary : C.textPrimary,
              textDecoration: isDone ? "line-through" : "none",
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
          {isDone ? (
            <span style={{
              fontSize: 9, fontWeight: 700, padding: "2px 7px",
              background: "#E8F5E9", color: "#2E7D32",
              border: "0.5px solid #4CAF5055",
              letterSpacing: "0.04em", textTransform: "uppercase", flexShrink: 0,
            }}>✓ Hecho</span>
          ) : (
            <span style={{
              fontSize: 9, fontWeight: 700, padding: "2px 7px",
              background: pri.bg, color: pri.text, border: `0.5px solid ${pri.border}`,
              letterSpacing: "0.04em", textTransform: "uppercase", flexShrink: 0,
            }}>{t.priority || "media"}</span>
          )}
        </div>

        {isEditing ? (
          <div style={{
            background: C.borderSoft, padding: 10, marginTop: 4,
            borderTop: `0.5px solid ${C.border}`,
            display: "flex", flexDirection: "column", gap: 10,
          }}>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
              <label style={fieldLabelStyle}>
                <span>Fecha de inicio</span>
                <input
                  type="date"
                  value={editDraft?.startDate || ""}
                  onChange={e => setEditDraft(d => ({ ...d, startDate: e.target.value }))}
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
        ) : isDone ? (
          <div style={{
            display: "flex", gap: 6, flexWrap: "wrap",
            paddingTop: 6, borderTop: `0.5px solid ${C.borderSoft}`,
          }}>
            {onMoveTask    && <button onClick={() => reopenTask(t)}                                   style={btnStyle("#2E7D32")}>↺ Reabrir</button>}
            {onDeleteTask  && <button onClick={() => setPendingDeleteId(t.id)}                        style={btnStyle(C.red)}>🗑 Eliminar</button>}
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

    const empty = withTime.length === 0 && withoutTime.length === 0;

    return (
      <>
        {empty && (
          <div style={{
            padding: "16px 20px", textAlign: "center", color: C.textTertiary,
            fontSize: 12, background: C.borderSoft, border: `0.5px solid ${C.border}`,
            marginBottom: 12,
          }}>
            Sin tareas asignadas para {dayLabel}. Pulsa cualquier franja horaria para añadir una.
          </div>
        )}
        <div>
          {HOURS_AGENDA.map(h => {
            const isCreateHere = createHour === h;
            const slotTasks = byHour[h];
            return (
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
                  {slotTasks.map(t => <TaskCard key={t.id} t={t} />)}
                  {isCreateHere
                    ? <CreateForm
                        draft={createDraft}
                        setDraft={setCreateDraft}
                        availableProjects={availableProjects}
                        defaultProjectId={defaultProjectId}
                        onSubmit={submitCreate}
                        onCancel={closeCreate}
                        onNavigateProjects={onNavigateProjects}
                      />
                    : (slotTasks.length === 0 && onCreateTask && (
                        <button
                          type="button"
                          onClick={() => openCreate(h)}
                          style={{
                            height: 32, background: "transparent",
                            border: `0.5px dashed ${C.border}`, borderRadius: 0,
                            color: C.textTertiary, fontSize: 11, cursor: "pointer",
                            fontFamily: "inherit", textAlign: "left",
                            padding: "0 10px",
                          }}
                          onMouseEnter={e => { e.currentTarget.style.background = C.borderSoft; e.currentTarget.style.color = C.textSecondary; }}
                          onMouseLeave={e => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.color = C.textTertiary; }}
                        >+ Añadir tarea a las {String(h).padStart(2, "0")}:00</button>
                      ))}
                </div>
              </div>
            );
          })}
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
        .filter(t => taskAnchor(t) === iso)
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
        <div style={{ display: "flex", alignItems: "center", gap: 12, justifyContent: "space-between", margin: "0 0 4px", flexWrap: "wrap" }}>
          <h1 style={{ fontSize: 22, fontWeight: 600, color: C.textPrimary, margin: 0 }}>
            Mi Día
            <span style={{ color: C.textSecondary, fontWeight: 400, fontSize: 16, marginLeft: 8 }}>
              — {tab === "semana" ? "Esta semana" : dateHeaderLabel}
            </span>
          </h1>
          {overdueTasks.length > 0 && (
            <button
              type="button"
              onClick={() => setOverdueCollapsed(c => !c)}
              title={overdueCollapsed ? "Mostrar tareas atrasadas" : "Ocultar tareas atrasadas"}
              style={{
                display: "inline-flex", alignItems: "center", gap: 6,
                padding: "5px 10px", background: "#FDF5F5",
                border: `0.5px solid ${C.red}55`, borderRadius: 0,
                color: C.red, fontSize: 12, fontWeight: 600, cursor: "pointer",
                fontFamily: "inherit", letterSpacing: "0.02em",
              }}
            >
              <span>⚠ {overdueTasks.length} atrasada{overdueTasks.length === 1 ? "" : "s"}</span>
              <span style={{ fontSize: 10, opacity: 0.7 }}>{overdueCollapsed ? "▾" : "▴"}</span>
            </button>
          )}
        </div>
        <p style={{ fontSize: 13, color: C.textSecondary, margin: "0 0 18px" }}>
          Agenda de tus tareas asignadas, organizada por horas.
        </p>

        {/* Navegación de fecha: ◀ Hoy ▶ + selector + tab Esta semana.
            En modo "dia" los controles están activos y el header refleja
            selectedDate; en modo "semana" los controles se desactivan y
            el header muestra "Esta semana". */}
        <div style={{ display: "flex", gap: 6, alignItems: "center", marginBottom: 20, flexWrap: "wrap", borderBottom: `1px solid ${C.border}`, paddingBottom: 14 }}>
          <button
            type="button"
            onClick={goPrevDay}
            disabled={tab === "semana"}
            title="Día anterior"
            style={dateNavBtnStyle(tab === "semana")}
          >◀</button>
          <button
            type="button"
            onClick={() => { setTab("dia"); goToday(); }}
            disabled={tab === "dia" && isToday}
            style={{
              ...dateNavBtnStyle(tab === "dia" && isToday),
              minWidth: 50,
              background: (tab === "dia" && isToday) ? C.borderSoft : "transparent",
              fontWeight: (tab === "dia" && isToday) ? 600 : 500,
            }}
          >Hoy</button>
          <button
            type="button"
            onClick={goNextDay}
            disabled={tab === "semana"}
            title="Día siguiente"
            style={dateNavBtnStyle(tab === "semana")}
          >▶</button>
          <label style={{
            display: "inline-flex", alignItems: "center", gap: 6,
            padding: "5px 8px",
            border: `0.5px solid ${C.border}`,
            background: tab === "dia" ? "#fff" : C.borderSoft,
            cursor: "pointer",
            fontSize: 12,
            color: C.textSecondary,
            fontFamily: "inherit",
          }}>
            <span style={{ fontSize: 13 }}>📅</span>
            <input
              type="date"
              value={selectedDate}
              onChange={e => { if (e.target.value) { setSelectedDate(e.target.value); setTab("dia"); } }}
              style={{
                border: "none", outline: "none", background: "transparent",
                fontFamily: "inherit", fontSize: 12, color: C.textPrimary,
                padding: 0, cursor: "pointer",
              }}
            />
          </label>
          <div style={{ flex: 1, minWidth: 10 }} />
          <button
            type="button"
            onClick={() => setTab("semana")}
            style={{
              padding: "6px 14px",
              background: tab === "semana" ? C.gold : "transparent",
              color: tab === "semana" ? "#fff" : C.textSecondary,
              border: `0.5px solid ${tab === "semana" ? C.gold : C.border}`,
              borderRadius: 0,
              fontSize: 12,
              fontWeight: tab === "semana" ? 600 : 500,
              cursor: "pointer",
              fontFamily: "inherit",
              letterSpacing: "0.02em",
            }}
          >Esta semana</button>
        </div>

        {/* Días anteriores — listado expandido. Por defecto colapsado;
            se despliega con el badge "⚠ N atrasadas" del header. Visible
            en cualquier tab porque las vencidas no dependen del día. */}
        {overdueTasks.length > 0 && !overdueCollapsed && (
          <div style={{
            marginBottom: 20,
            border: `1px solid ${C.border}`,
            background: C.surface,
            padding: 12,
            display: "flex", flexDirection: "column", gap: 8,
          }}>
            <div style={{
              fontSize: 11, fontWeight: 600, color: C.red,
              letterSpacing: "0.08em", textTransform: "uppercase",
              paddingBottom: 6, borderBottom: `0.5px solid ${C.border}`,
            }}>
              ⚠ Días anteriores · {overdueTasks.length} tarea{overdueTasks.length === 1 ? "" : "s"}
            </div>
            {overdueTasks.map(t => <TaskCard key={t.id} t={t} hideTime={!t.dueTime} />)}
          </div>
        )}

        {tab === "dia"    && renderAgendaDay(dateHeaderLabel.toLowerCase())}
        {tab === "semana" && renderWeek()}
      </div>
    </div>
  );
}
