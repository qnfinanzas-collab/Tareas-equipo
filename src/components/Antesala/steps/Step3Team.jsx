// Paso 3 — tamaño del equipo.
// Destino en commit 3: data.ceoProfile.teamSize (número).
// Presets rápidos + opción manual.
import React, { useEffect, useRef } from "react";
import AntesalaStep, { INPUT_STYLE, COLORS } from "../AntesalaStep.jsx";

const PRESETS = [
  { label: "Yo solo",  value: 1 },
  { label: "2 a 5",    value: 3 },
  { label: "6 a 15",   value: 10 },
  { label: "16 a 50",  value: 30 },
  { label: "Más de 50", value: 60 },
];

export default function Step3Team({ step, total, answers, setAnswer, onNext, onSkip }) {
  const ref = useRef(null);
  useEffect(() => { try { ref.current?.focus(); } catch {} }, []);
  const value = typeof answers.teamSize === "number" ? answers.teamSize : "";
  const canContinue = typeof value === "number" && value >= 0;
  return (
    <AntesalaStep
      step={step} total={total}
      question="¿Cuántas personas tiene en su equipo?"
      help="Cuente todas las personas que dependen de usted: propias, freelance recurrentes, socios operativos."
      canContinue={canContinue}
      onNext={onNext} onSkip={onSkip}
    >
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 16 }}>
        {PRESETS.map(p => {
          const sel = value === p.value;
          return (
            <button
              key={p.label}
              type="button"
              onClick={() => setAnswer("teamSize", p.value)}
              style={{
                padding: "10px 16px",
                background: sel ? COLORS.BLACK : "transparent",
                color:      sel ? COLORS.PEARL : COLORS.INK,
                border:     `1px solid ${sel ? COLORS.BLACK : COLORS.HAIR}`,
                fontFamily: "inherit",
                fontSize: 13,
                fontWeight: 500,
                cursor: "pointer",
                borderRadius: 0,
                letterSpacing: "0.01em",
              }}
            >{p.label}</button>
          );
        })}
      </div>
      <input
        ref={ref}
        type="number"
        min={0}
        max={9999}
        value={value}
        onChange={e => {
          const v = e.target.value;
          if (v === "") setAnswer("teamSize", "");
          else {
            const n = Math.max(0, Math.min(9999, parseInt(v, 10) || 0));
            setAnswer("teamSize", n);
          }
        }}
        placeholder="O escriba el número exacto"
        style={INPUT_STYLE}
        onFocus={e => e.currentTarget.style.borderColor = COLORS.GOLD}
        onBlur={e => e.currentTarget.style.borderColor = COLORS.HAIR}
      />
    </AntesalaStep>
  );
}
