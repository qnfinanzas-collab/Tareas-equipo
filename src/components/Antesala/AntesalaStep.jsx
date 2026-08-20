// AntesalaStep — envoltura visual compartida por los 6 pasos de la
// Antesala (flujo Héctor↔CEO post-signup, 20/08/2026).
//
// Lenguaje de MARCA EXTERNA (no la app operativa):
// - Border-radius 0 en todo, filetes rectos.
// - Fondo #FAFAF7, tarjeta #FFFFFF, texto #1A1A1A, gris #6B6B6B.
// - Acento oro #C9A84C, botón negro #0A0A0A + texto perla #F5F0E8.
// - Serif Cormorant Garamond para la pregunta.
// - Cero emojis. Trato de usted.
// - Profundidad por contraste de fondo, no por líneas divisorias.
//
// Móvil primero: inputs 56px alto (los define cada Step), botón 48px,
// padding lateral 24px móvil / 40px desktop.
//
// Recibe:
//   step, total      → cabecera "X de N".
//   question         → pregunta grande en serif — se escribe con typewriter.
//   help             → texto opcional en gris debajo.
//   children         → el input/area del paso (cada Step lo aporta).
//   canContinue      → habilita/deshabilita el botón principal.
//   ctaLabel         → texto del botón (default "Continuar").
//   onNext, onSkip   → callbacks del orquestador.
//
// Animación (20/08/2026): la pregunta se escribe con useTypewriter.
// El input/help/botón permanecen ocultos hasta que la pregunta termina
// de escribirse. Tap/click en cualquier zona vacía completa el texto.
// Sin cursor parpadeante. Motivo (Antonio): si aparecen de golpe es un
// formulario. Si se escriben, es una conversación.
import React from "react";
import { useTypewriter } from "./useTypewriter.js";

const BG      = "#FAFAF7";
const CARD    = "#FFFFFF";
const INK     = "#1A1A1A";
const GRAY    = "#6B6B6B";
const GOLD    = "#C9A84C";
const BLACK   = "#0A0A0A";
const PEARL   = "#F5F0E8";
const HAIR    = "#E5E0D5";

const SERIF   = '"Cormorant Garamond", "Instrument Serif", Georgia, serif';
const SANS    = '"Inter", system-ui, -apple-system, sans-serif';

export default function AntesalaStep({
  step, total,
  question, help,
  children,
  canContinue = true,
  ctaLabel = "Continuar",
  onNext, onSkip,
}) {
  const { shown, done, skip: skipTyping } = useTypewriter(question);
  // Click en zona vacía del fondo completa el texto si aún se escribe.
  // Los inputs y botones tienen stopPropagation implícito (son children
  // del onClick del wrapper). Solo dispara cuando el objetivo es el
  // propio fondo — no interfiere con el uso normal del input.
  const onBgClick = (e) => {
    if (!done && e.target === e.currentTarget) skipTyping();
  };
  return (
    <div
      onClick={onBgClick}
      style={{
        position: "fixed",
        inset: 0,
        background: BG,
        overflowY: "auto",
        WebkitOverflowScrolling: "touch",
        fontFamily: SANS,
        color: INK,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        padding: "min(6vh, 48px) 24px 40px",
      }}>
      {/* Cabecera con marca discreta y progreso */}
      <div style={{
        width: "100%",
        maxWidth: 560,
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        marginBottom: 28,
      }}>
        <div style={{
          fontFamily: SERIF,
          fontSize: 14,
          fontWeight: 500,
          color: GOLD,
          letterSpacing: "0.24em",
        }}>KLUXOR</div>
        <div style={{
          fontSize: 12,
          color: GRAY,
          fontVariantNumeric: "tabular-nums",
          letterSpacing: "0.02em",
        }}>{step} de {total}</div>
      </div>

      {/* Tarjeta central. Sin sombra — profundidad por contraste de
          fondo (#FAFAF7) vs tarjeta (#FFFFFF), no por sombras. */}
      <div
        onClick={onBgClick}
        style={{
          width: "100%",
          maxWidth: 560,
          background: CARD,
          padding: "40px 32px",
        }}>
        <h1 style={{
          fontFamily: SERIF,
          fontSize: "clamp(24px, 5vw, 32px)",
          fontWeight: 500,
          lineHeight: 1.25,
          color: INK,
          margin: 0,
          letterSpacing: "-0.005em",
          minHeight: "1.25em",
        }}>{shown}</h1>

        {/* Help + input + botón: aparecen SOLO cuando termina de
            escribirse la pregunta. Sin ellos la Antesala es
            conversación; con ellos ya es formulario. */}
        {done && help ? (
          <p style={{
            marginTop: 12,
            marginBottom: 0,
            fontSize: 14,
            lineHeight: 1.55,
            color: GRAY,
            opacity: 0,
            animation: "kluxorFadeIn 220ms ease-out forwards",
          }}>{help}</p>
        ) : null}

        {done ? (
          <div style={{
            marginTop: 28,
            opacity: 0,
            animation: "kluxorFadeIn 260ms 60ms ease-out forwards",
          }}>{children}</div>
        ) : null}

        {done ? (
          <button
            type="button"
            onClick={canContinue ? onNext : undefined}
            disabled={!canContinue}
            style={{
              marginTop: 28,
              width: "100%",
              height: 48,
              background: BLACK,
              color: PEARL,
              border: "none",
              fontFamily: "inherit",
              fontSize: 14,
              fontWeight: 600,
              letterSpacing: "0.04em",
              cursor: canContinue ? "pointer" : "default",
              opacity: 0,
              animation: "kluxorFadeIn 260ms 120ms ease-out forwards",
              transition: "opacity 0.15s ease",
            }}
          >{ctaLabel}</button>
        ) : null}
      </div>

      {/* Skip discreto — solo tras terminar de escribir. Sin caja, sin
          borde, gris pequeño. */}
      {done ? (
        <div style={{
          marginTop: 20,
          width: "100%",
          maxWidth: 560,
          display: "flex",
          justifyContent: "center",
          opacity: 0,
          animation: "kluxorFadeIn 220ms 200ms ease-out forwards",
        }}>
          <button
            type="button"
            onClick={onSkip}
            style={{
              background: "transparent",
              border: "none",
              padding: "8px 12px",
              fontFamily: "inherit",
              fontSize: 12,
              color: GRAY,
              cursor: "pointer",
              letterSpacing: "0.01em",
            }}
          >Prefiero hacerlo después</button>
        </div>
      ) : null}

      {/* Keyframes globales del fade — inyectados una sola vez. */}
      <style>{`@keyframes kluxorFadeIn{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:translateY(0)}}`}</style>
    </div>
  );
}

// Estilos compartidos que los Steps importan para sus inputs.
// Input 56px alto (móvil primero, requisito de Antonio). Filete recto,
// focus en oro. Sin ring azul del navegador.
export const INPUT_STYLE = {
  width: "100%",
  height: 56,
  padding: "0 16px",
  fontFamily: SANS,
  fontSize: 16,
  lineHeight: 1.3,
  color: INK,
  background: CARD,
  border: `1px solid ${HAIR}`,
  outline: "none",
  boxSizing: "border-box",
  borderRadius: 0,
  WebkitAppearance: "none",
};

export const TEXTAREA_STYLE = {
  width: "100%",
  minHeight: 120,
  padding: "14px 16px",
  fontFamily: SANS,
  fontSize: 16,
  lineHeight: 1.5,
  color: INK,
  background: CARD,
  border: `1px solid ${HAIR}`,
  outline: "none",
  boxSizing: "border-box",
  borderRadius: 0,
  resize: "vertical",
};

export const COLORS = { BG, CARD, INK, GRAY, GOLD, BLACK, PEARL, HAIR, SERIF, SANS };
