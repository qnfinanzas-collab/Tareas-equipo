// AntesalaFlow — orquestador visual de los 6 pasos de la Antesala
// (flujo Héctor↔CEO tras el signup, 20/08/2026).
//
// ALCANCE DE ESTE COMMIT (2/5): solo estado local + navegación entre
// pasos + callbacks al padre. Cero persistencia todavía — se pasa el
// objeto answers íntegro a onSkip/onComplete y el padre (commit 3)
// decidirá dónde escribir cada respuesta (ceoProfile / ceoMemory /
// avail / places / projects).
//
// Recibe:
//   initialStep     → paso desde el que arrancar (retomado tras skip).
//   initialAnswers  → respuestas ya guardadas (retomado).
//   onSkip(answers, step)   → CEO pulsó "Prefiero hacerlo después".
//   onComplete(answers)     → CEO terminó los 6 pasos.
//
// La detección "primera vez" y el chip de retomar viven fuera — este
// componente solo se renderiza cuando el padre decide.
import React, { useState } from "react";
import AntesalaWelcome from "./AntesalaWelcome.jsx";
import AntesalaSummary from "./AntesalaSummary.jsx";
import Step1Name from "./steps/Step1Name.jsx";
import Step2Company from "./steps/Step2Company.jsx";
import Step3Team from "./steps/Step3Team.jsx";
import Step4Fronts from "./steps/Step4Fronts.jsx";
import Step5TimeSink from "./steps/Step5TimeSink.jsx";
import Step6ScheduleCity from "./steps/Step6ScheduleCity.jsx";
import Step7Advisors from "./steps/Step7Advisors.jsx";

const STEPS = [Step1Name, Step2Company, Step3Team, Step4Fronts, Step5TimeSink, Step6ScheduleCity, Step7Advisors];
const TOTAL = STEPS.length;

export default function AntesalaFlow({
  initialStep = 1,
  initialAnswers = {},
  onSkip,
  onComplete,
  onProgress, // opcional: dispara al avanzar cada paso, permite persistir
              // progreso incremental para retomar tras cierre inesperado.
}) {
  // Clamp del initialStep al rango válido — defensivo para retomas con
  // progress corrupto o fuera de rango.
  const startAt = Math.min(TOTAL, Math.max(1, Number(initialStep) || 1));
  // Detección de "primera vez" vs "retomando": si no hay respuestas
  // previas Y arranca en paso 1 → muestra bienvenida. Si retoma (skip
  // en paso 3, vuelve luego) o si ya tiene respuestas → salta directo
  // al step correspondiente sin volver a mostrar la bienvenida.
  const hasPrevAnswers = initialAnswers && typeof initialAnswers === "object" && Object.keys(initialAnswers).length > 0;
  const isResuming = startAt > 1 || hasPrevAnswers;
  const [phase, setPhase] = useState(isResuming ? "steps" : "welcome");
  const [step, setStep] = useState(startAt);
  const [answers, setAnswers] = useState(hasPrevAnswers ? initialAnswers : {});
  // Flag "vuelve al summary tras editar un solo paso" — activado desde
  // AntesalaSummary cuando el CEO pulsa "Corregir algo" y elige una
  // sección. El siguiente onNext salta directo al summary en vez de
  // continuar la secuencia lineal.
  const [returningToSummary, setReturningToSummary] = useState(false);

  const setAnswer = (key, value) => {
    setAnswers(prev => ({ ...prev, [key]: value }));
  };

  const goNext = () => {
    // Persistir progreso incremental (status="progressing"):
    //   - Si returningToSummary → completedStep = step (el que se
    //     acaba de corregir).
    //   - Si step ≥ TOTAL → completedStep = TOTAL (se entra en Summary
    //     con las 7 respondidas).
    //   - Caso normal → completedStep = step (el que se acaba de responder).
    const completedStep = step;
    onProgress?.(answers, completedStep);

    if (returningToSummary) {
      setReturningToSummary(false);
      setPhase("summary");
      return;
    }
    if (step >= TOTAL) {
      // Tras el último paso, en vez de disparar onComplete pasamos a
      // la pantalla de devolución. onComplete solo se dispara cuando
      // el CEO pulsa "Entrar en Kluxor" en el Summary — ahí es donde
      // se materializan los proyectos y se marca antesalaCompletedAt.
      setPhase("summary");
    } else {
      setStep(step + 1);
    }
  };

  const skip = () => {
    onSkip?.(answers, step);
  };

  const jumpToStep = (targetStep) => {
    const clamped = Math.min(TOTAL, Math.max(1, Number(targetStep) || 1));
    setStep(clamped);
    setPhase("steps");
    setReturningToSummary(true);
  };

  if (phase === "welcome") {
    return <AntesalaWelcome onStart={() => setPhase("steps")} />;
  }

  if (phase === "summary") {
    return (
      <AntesalaSummary
        answers={answers}
        onEnter={() => onComplete?.(answers)}
        onCorrect={jumpToStep}
      />
    );
  }

  const StepComp = STEPS[step - 1];
  return (
    <StepComp
      step={step}
      total={TOTAL}
      answers={answers}
      setAnswer={setAnswer}
      onNext={goNext}
      onSkip={skip}
    />
  );
}

export { TOTAL as ANTESALA_TOTAL };
