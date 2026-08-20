// Paso 4 — tres frentes abiertos del CEO.
// Simplificado 20/08/2026: la confirmación inline de "voy a crear
// estos tres proyectos" se movió a AntesalaSummary — la pantalla de
// devolución final donde Héctor devuelve todo lo entendido antes de
// entrar en Kluxor. Aquí volvemos a tres campos limpios sin fase de
// confirmación. Los proyectos se crean en el momento en que el CEO
// pulsa "Entrar en Kluxor" en el Summary, no antes.
//
// Destino en commit 4: data.projects + data.boards vía ejecutor de
// create_project (el mismo que usa Héctor), disparado desde
// onComplete del AntesalaFlow — no desde este paso.
import React, { useEffect, useRef } from "react";
import AntesalaStep, { INPUT_STYLE, COLORS } from "../AntesalaStep.jsx";

export default function Step4Fronts({ step, total, answers, setAnswer, onNext, onSkip }) {
  const fronts = Array.isArray(answers.fronts) && answers.fronts.length === 3
    ? answers.fronts
    : ["", "", ""];
  const setFront = (idx, val) => {
    const next = [...fronts];
    next[idx] = val;
    setAnswer("fronts", next);
  };
  const ref = useRef(null);
  useEffect(() => { try { ref.current?.focus(); } catch {} }, []);

  const filled = fronts.map(f => (f || "").trim()).filter(Boolean);
  const canContinue = filled.length === 3;

  return (
    <AntesalaStep
      step={step} total={total}
      question="¿Cuáles son sus tres frentes abiertos ahora mismo?"
      help="Los tres temas que le ocupan la cabeza esta semana. Con ellos armaremos sus tres primeros proyectos en Kluxor."
      canContinue={canContinue}
      onNext={onNext} onSkip={onSkip}
    >
      {[0, 1, 2].map(i => (
        <div key={i} style={{ marginBottom: i < 2 ? 12 : 0 }}>
          <input
            ref={i === 0 ? ref : null}
            type="text"
            value={fronts[i] || ""}
            onChange={e => setFront(i, e.target.value)}
            placeholder={`Frente ${i + 1}`}
            autoComplete="off"
            style={INPUT_STYLE}
            onFocus={e => e.currentTarget.style.borderColor = COLORS.GOLD}
            onBlur={e => e.currentTarget.style.borderColor = COLORS.HAIR}
          />
        </div>
      ))}
    </AntesalaStep>
  );
}
