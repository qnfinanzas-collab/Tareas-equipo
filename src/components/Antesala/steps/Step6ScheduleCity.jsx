// Paso 6 — horario habitual y ciudad.
// Destino en commit 3:
//   - Horario: member.avail (morningStart/End, afternoonStart/End,
//     hoursPerDay) para el member del CEO. Los planners ya lo usan.
//   - Ciudad: data.ceoProfile.city (leído por buildCeoBlock) +
//     data.places con placeType:"home" (planificador de rutas).
//
// Diseño: un preset de jornada (mañana / partido / continuo) + input
// ciudad. Mantiene "una pregunta por pantalla" (dos campos pero un
// solo tema: "cómo se organiza"). No añade paso.
import React, { useEffect, useRef } from "react";
import AntesalaStep, { INPUT_STYLE, COLORS } from "../AntesalaStep.jsx";

// help: cadena legible del horario. Se usa como chip.help en el paso 6
// y como base del resumen en AntesalaSummary. Guión largo (–) en vez
// de punto medio (·) para no confundir con el separador del propio
// summary (que sí usa "·" entre horario y ciudad).
const SCHEDULES = [
  { key: "morning",  label: "Mañana",   help: "09:00–14:00",                 morningStart:"09:00", morningEnd:"14:00", afternoonStart:"",      afternoonEnd:"",      hoursPerDay: 5 },
  { key: "split",    label: "Partido",  help: "09:00–14:00 y 16:00–19:00",   morningStart:"09:00", morningEnd:"14:00", afternoonStart:"16:00", afternoonEnd:"19:00", hoursPerDay: 8 },
  { key: "straight", label: "Continuo", help: "09:00–17:00",                 morningStart:"09:00", morningEnd:"17:00", afternoonStart:"",      afternoonEnd:"",      hoursPerDay: 8 },
];

export default function Step6ScheduleCity({ step, total, answers, setAnswer, onNext, onSkip }) {
  const ref = useRef(null);
  useEffect(() => { try { ref.current?.focus(); } catch {} }, []);
  const schedule = answers.scheduleKey || "";
  const city = answers.city || "";
  const canContinue = schedule && city.trim().length >= 2;
  return (
    <AntesalaStep
      step={step} total={total}
      question="¿Cuál es su horario habitual y su ciudad?"
      help="Su horario ancla la planificación diaria. Su ciudad, las rutas y desplazamientos."
      canContinue={canContinue}
      onNext={onNext} onSkip={onSkip}
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 20 }}>
        {SCHEDULES.map(s => {
          const sel = schedule === s.key;
          return (
            <button
              key={s.key}
              type="button"
              onClick={() => setAnswer("scheduleKey", s.key)}
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                padding: "14px 16px",
                background: sel ? COLORS.BLACK : "transparent",
                color:      sel ? COLORS.PEARL : COLORS.INK,
                border:     `1px solid ${sel ? COLORS.BLACK : COLORS.HAIR}`,
                fontFamily: "inherit",
                fontSize: 14,
                fontWeight: 500,
                cursor: "pointer",
                borderRadius: 0,
                textAlign: "left",
                letterSpacing: "0.01em",
              }}
            >
              <span>{s.label}</span>
              <span style={{
                fontSize: 12,
                color: sel ? COLORS.PEARL : COLORS.GRAY,
                opacity: sel ? 0.75 : 1,
                fontVariantNumeric: "tabular-nums",
              }}>{s.help}</span>
            </button>
          );
        })}
      </div>
      <input
        ref={ref}
        type="text"
        value={city}
        onChange={e => setAnswer("city", e.target.value)}
        placeholder="Su ciudad"
        autoComplete="address-level2"
        style={INPUT_STYLE}
        onFocus={e => e.currentTarget.style.borderColor = COLORS.GOLD}
        onBlur={e => e.currentTarget.style.borderColor = COLORS.HAIR}
      />
    </AntesalaStep>
  );
}

// Exportado para que el orquestador (commit 3) pueda mapear scheduleKey
// → avail al persistir. Vive aquí para que la definición sea única y no
// se desincronice entre step y persistencia.
export { SCHEDULES };
