// Paso 1 — nombre preferido del CEO.
// Destino en commit 3: data.ceoProfile.name (lo lee buildCeoBlock).
import React, { useEffect, useRef } from "react";
import AntesalaStep, { INPUT_STYLE, COLORS } from "../AntesalaStep.jsx";

export default function Step1Name({ step, total, answers, setAnswer, onNext, onSkip }) {
  const ref = useRef(null);
  useEffect(() => { try { ref.current?.focus(); } catch {} }, []);
  const value = answers.name || "";
  const canContinue = value.trim().length >= 2;
  const onKey = (e) => { if (e.key === "Enter" && canContinue) onNext(); };
  return (
    <AntesalaStep
      step={step} total={total}
      question="¿Cómo quiere que le llame?"
      help="Su nombre o el trato con el que prefiera trabajar. Héctor lo usará en cada respuesta."
      canContinue={canContinue}
      onNext={onNext} onSkip={onSkip}
    >
      <input
        ref={ref}
        type="text"
        value={value}
        onChange={e => setAnswer("name", e.target.value)}
        onKeyDown={onKey}
        placeholder="Antonio"
        autoComplete="off"
        style={INPUT_STYLE}
        onFocus={e => e.currentTarget.style.borderColor = COLORS.GOLD}
        onBlur={e => e.currentTarget.style.borderColor = COLORS.HAIR}
      />
    </AntesalaStep>
  );
}
