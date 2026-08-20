// Paso 5 — qué le roba más tiempo cada semana.
// Destino en commit 3: data.ceoMemory.keyFacts[] con
// {type:"keyFact", content:"Le roba tiempo: X", source:"antesala"}.
// Héctor lo lee vía memBlockFormatted en el system prompt.
import React, { useEffect, useRef } from "react";
import AntesalaStep, { TEXTAREA_STYLE, COLORS } from "../AntesalaStep.jsx";

export default function Step5TimeSink({ step, total, answers, setAnswer, onNext, onSkip }) {
  const ref = useRef(null);
  useEffect(() => { try { ref.current?.focus(); } catch {} }, []);
  const value = answers.timeSink || "";
  const canContinue = value.trim().length >= 5;
  return (
    <AntesalaStep
      step={step} total={total}
      question="¿Qué le roba más tiempo cada semana?"
      help="Reuniones que se alargan, aprobaciones pendientes, tareas repetitivas, temas del equipo. Todo lo que le drena las horas de la semana."
      canContinue={canContinue}
      onNext={onNext} onSkip={onSkip}
    >
      <textarea
        ref={ref}
        value={value}
        onChange={e => setAnswer("timeSink", e.target.value)}
        placeholder="El foro semanal con el equipo comercial, los correos de proveedores…"
        rows={4}
        style={TEXTAREA_STYLE}
        onFocus={e => e.currentTarget.style.borderColor = COLORS.GOLD}
        onBlur={e => e.currentTarget.style.borderColor = COLORS.HAIR}
      />
    </AntesalaStep>
  );
}
