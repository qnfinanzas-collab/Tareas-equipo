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
import { SCHEDULES } from "../schedules.js";

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

// SCHEDULES se re-exporta desde schedules.js para no romper imports
// existentes (Summary lo importa desde este archivo por historia).
export { SCHEDULES };
