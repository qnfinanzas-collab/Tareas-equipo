// formatting — renderizado enriquecido de respuestas de agentes IA.
//
// Kluxor manda al LLM la PLAIN_TEXT_RULE (agent.js:9) que prohíbe
// asteriscos, hashes y viñetas markdown. Decisión histórica del commit
// 47c41ea (23/04/2026): el TTS de Héctor leía literalmente "asterisco
// asterisco decisión asterisco asterisco" cuando el modelo emitía
// **decisión**. Esa regla se queda como está — sigue siendo correcta
// para audio.
//
// Este módulo hace el fix del OTRO lado: en vez de dejar que el texto
// plano llegue a la burbuja como un muro sin ritmo visual, lo enriquece
// tipográficamente en el render. El texto ORIGINAL que va al TTS o al
// clipboard no se toca — solo cambia cómo se pinta en pantalla.
//
// Función PURA: string → React fragment. Sin side effects, sin state.
//
// Heurísticas de detección (sin parsear markdown, sin XSS surface):
//   - Línea totalmente en MAYÚSCULAS (≥3 chars, con letras) → titular
//     (font-weight 600, color tinta tierra, margen superior generoso).
//   - Línea corta (<55 chars) terminada en ":" → sub-titular
//     (mismo tratamiento, margen algo menor).
//   - Línea vacía → separador de párrafo (aire visual real).
//   - Línea normal → párrafo con interlineado 1.7 y margen inferior.
//
// LinkifiedText: se acepta como componente opcional. Si se pasa junto
// con linkifyMap, cada línea NORMAL se envuelve para que los códigos
// reales del tenant (MAR, NEG-100, TST-042) sean clicables. Titulares
// y sub-titulares NO se linkifican (no tiene sentido semántico —
// suelen ser rótulos, no citas de entidades).
//
// Diseño y colores respetan la paleta operativa Kluxor:
//   #4E4A42 (tinta tierra para titulares) — mismo tono que Mario/Gonzalo.
//   Cero uso del oro #C9A84C aquí — el oro queda reservado para acentos
//   de sistema, no para texto de agentes.

import React from "react";

// Titular: solo letras mayúsculas (incluidas acentuadas ES), dígitos,
// espacios y puntuación conservadora. La línea debe contener al menos
// una letra — evita que "12/04/2026" o "· · ·" se traten como titulares.
const HEADLINE_RE = /^[A-ZÁÉÍÓÚÑ0-9\s:·\-\.,()¡!¿?/&]+$/;
const HAS_UPPER_LETTER_RE = /[A-ZÁÉÍÓÚÑ]/;
const HAS_LETTER_RE = /[a-záéíóúñA-ZÁÉÍÓÚÑ]/;

const SUBTITLE_MAX = 55;
const HEADLINE_MIN = 3;

function isHeadline(trimmed) {
  if (trimmed.length < HEADLINE_MIN) return false;
  if (!HEADLINE_RE.test(trimmed)) return false;
  if (!HAS_UPPER_LETTER_RE.test(trimmed)) return false;
  return true;
}

function isSubtitle(trimmed) {
  if (trimmed.length === 0 || trimmed.length > SUBTITLE_MAX) return false;
  if (!trimmed.endsWith(":")) return false;
  if (!HAS_LETTER_RE.test(trimmed)) return false;
  return true;
}

// Estilos únicos — compartidos entre las 5 superficies conversacionales.
const S = {
  headline: {
    fontWeight: 600,
    color: "#4E4A42",
    fontSize: 14,
    lineHeight: 1.4,
    marginTop: 14,
    marginBottom: 6,
    letterSpacing: "0.02em",
  },
  subtitle: {
    fontWeight: 600,
    color: "#4E4A42",
    fontSize: 14,
    lineHeight: 1.5,
    marginTop: 12,
    marginBottom: 4,
  },
  paragraph: {
    marginBottom: 6,
    lineHeight: 1.7,
  },
  spacer: {
    height: 8,
  },
};

/**
 * Convierte el texto plano de un agente en un fragmento React con
 * jerarquía tipográfica. Devuelve el texto tal cual si el input es
 * falsy o no es string (defensivo).
 *
 * @param {string} text - la prosa ya limpia (sin bloques [ACTIONS]/[TASKS_LIST]/etc.)
 * @param {object} [opts]
 * @param {React.ComponentType} [opts.LinkifiedText] - componente para envolver códigos
 * @param {any}                 [opts.linkifyMap]
 * @param {function}            [opts.onOpenTask]
 * @param {function}            [opts.onOpenNegotiation]
 * @param {function}            [opts.onOpenProject]
 * @returns {React.ReactNode}
 */
export function renderAgentText(text, opts = {}) {
  if (!text || typeof text !== "string") return text || null;
  const { LinkifiedText, linkifyMap, onOpenTask, onOpenNegotiation, onOpenProject } = opts;
  const canLinkify = typeof LinkifiedText === "function" && !!linkifyMap;

  const lines = text.split("\n");
  const out = [];
  let sawHeadingRecently = false;

  lines.forEach((line, i) => {
    const trimmed = line.trim();

    // Línea vacía → separador (solo si ya hay contenido y no acabamos
    // de emitir uno tras un titular).
    if (trimmed === "") {
      if (out.length > 0 && !sawHeadingRecently) {
        out.push(<div key={`sp-${i}`} style={S.spacer} />);
      }
      return;
    }

    // Titular (MAYÚSCULAS enteras).
    if (isHeadline(trimmed)) {
      const style = { ...S.headline };
      if (out.length === 0) style.marginTop = 0;
      out.push(<div key={`h-${i}`} style={style}>{line}</div>);
      sawHeadingRecently = true;
      return;
    }

    // Sub-titular (línea corta terminada en ":").
    if (isSubtitle(trimmed)) {
      const style = { ...S.subtitle };
      if (out.length === 0) style.marginTop = 0;
      out.push(<div key={`s-${i}`} style={style}>{line}</div>);
      sawHeadingRecently = true;
      return;
    }

    // Párrafo normal — colapsa el margen superior si viene tras un titular.
    const style = { ...S.paragraph };
    if (sawHeadingRecently) style.marginTop = 0;
    const content = canLinkify
      ? (
        <LinkifiedText
          text={line}
          linkifyMap={linkifyMap}
          onOpenTask={onOpenTask}
          onOpenNegotiation={onOpenNegotiation}
          onOpenProject={onOpenProject}
        />
      )
      : line;
    out.push(<div key={`p-${i}`} style={style}>{content}</div>);
    sawHeadingRecently = false;
  });

  return <React.Fragment>{out}</React.Fragment>;
}
