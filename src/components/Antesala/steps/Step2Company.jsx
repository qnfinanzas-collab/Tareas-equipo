// Paso 2 — empresa y actividad.
// Destino en commit 3: data.ceoProfile.company + .sector + .description
// (los tres leídos por buildCeoBlock).
import React, { useEffect, useRef } from "react";
import AntesalaStep, { INPUT_STYLE, TEXTAREA_STYLE, COLORS } from "../AntesalaStep.jsx";

export default function Step2Company({ step, total, answers, setAnswer, onNext, onSkip }) {
  const ref = useRef(null);
  useEffect(() => { try { ref.current?.focus(); } catch {} }, []);
  const company = answers.company || "";
  const description = answers.description || "";
  const canContinue = company.trim().length >= 2 && description.trim().length >= 5;
  return (
    <AntesalaStep
      step={step} total={total}
      question="¿A qué se dedica su empresa?"
      help="El nombre de la empresa y, en una frase, qué hace o vende. Héctor y el Consejo lo usarán como contexto en cada consulta."
      canContinue={canContinue}
      onNext={onNext} onSkip={onSkip}
    >
      <input
        ref={ref}
        type="text"
        value={company}
        onChange={e => setAnswer("company", e.target.value)}
        placeholder="Nombre de la empresa"
        autoComplete="off"
        style={INPUT_STYLE}
        onFocus={e => e.currentTarget.style.borderColor = COLORS.GOLD}
        onBlur={e => e.currentTarget.style.borderColor = COLORS.HAIR}
      />
      <div style={{ height: 12 }} />
      <textarea
        value={description}
        onChange={e => setAnswer("description", e.target.value)}
        placeholder="Qué hace su empresa"
        rows={3}
        style={TEXTAREA_STYLE}
        onFocus={e => e.currentTarget.style.borderColor = COLORS.GOLD}
        onBlur={e => e.currentTarget.style.borderColor = COLORS.HAIR}
      />
    </AntesalaStep>
  );
}
