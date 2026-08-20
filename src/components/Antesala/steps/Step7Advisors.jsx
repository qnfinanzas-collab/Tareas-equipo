// Paso 7 — quién asesora hoy al CEO.
//
// Motivo (Antonio, 20/08/2026): dos razones convergen.
//   (a) Producto: Héctor necesita saberlo para actuar bien. Si el CEO
//       tiene abogado, Mario prepara con rigor y remite para validación;
//       si no tiene nadie, el Consejo es única cobertura y actúa distinto.
//   (b) Negocio: saber si el Consejo compite con profesionales ya
//       contratados o si cubre un hueco. Son dos conversaciones
//       comerciales distintas.
//
// Multi-select: una o varias opciones. "Ahora mismo, nadie" es
// exclusiva — marcarla desmarca las demás y viceversa.
//
// Destino en commit 3: data.ceoProfile.advisors como array de keys
// del enum abajo. Leído por buildCeoBlock con el helper del prompt
// "QUIÉN LE ASESORA HOY" (ver hilo con Antonio 20/08).
import React from "react";
import AntesalaStep, { COLORS } from "../AntesalaStep.jsx";

const OPTIONS = [
  { key: "legal",    label: "Tengo abogado" },
  { key: "fiscal",   label: "Tengo asesor fiscal" },
  { key: "gestoria", label: "Tengo gestoría" },
  { key: "internal", label: "Lo llevo internamente" },
  { key: "none",     label: "Ahora mismo, nadie" },
];

export default function Step7Advisors({ step, total, answers, setAnswer, onNext, onSkip }) {
  const selected = Array.isArray(answers.advisors) ? answers.advisors : [];
  const isSel = (key) => selected.includes(key);
  const toggle = (key) => {
    const already = isSel(key);
    // Regla de exclusividad de "none": marcarla vacía las demás; marcar
    // cualquier otra desmarca "none". Simple y sin sorpresas.
    if (key === "none") {
      setAnswer("advisors", already ? [] : ["none"]);
      return;
    }
    const withoutNone = selected.filter(k => k !== "none");
    const next = already
      ? withoutNone.filter(k => k !== key)
      : [...withoutNone, key];
    setAnswer("advisors", next);
  };

  const canContinue = selected.length > 0;

  return (
    <AntesalaStep
      step={step} total={total}
      question="¿Quién le asesora hoy en lo legal, lo fiscal y lo contable?"
      help="Marque todas las que apliquen. Héctor lo tendrá presente al decidir cuándo el Consejo prepara y remite a su profesional, y cuándo actúa como su única cobertura."
      canContinue={canContinue}
      onNext={onNext} onSkip={onSkip}
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {OPTIONS.map(opt => {
          const sel = isSel(opt.key);
          return (
            <button
              key={opt.key}
              type="button"
              onClick={() => toggle(opt.key)}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 12,
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
              {/* Marca cuadrada — visualiza estado sin usar checkbox nativo */}
              <span style={{
                width: 16,
                height: 16,
                border: `1px solid ${sel ? COLORS.PEARL : COLORS.HAIR}`,
                background: sel ? COLORS.PEARL : "transparent",
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                flexShrink: 0,
              }}>
                {sel ? (
                  <span style={{
                    width: 8,
                    height: 8,
                    background: COLORS.BLACK,
                  }} />
                ) : null}
              </span>
              <span>{opt.label}</span>
            </button>
          );
        })}
      </div>
    </AntesalaStep>
  );
}

// Exportado para que el orquestador (commit 3) reuse las etiquetas
// legibles al persistir y para que el Summary use el mismo mapa.
export const ADVISOR_OPTIONS = OPTIONS;
