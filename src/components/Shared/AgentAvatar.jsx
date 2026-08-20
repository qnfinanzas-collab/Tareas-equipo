// AgentAvatar — monograma institucional para los 6 agentes Kluxor.
//
// Cambio de lenguaje (19/08/2026): antes cara SVG multicolor tipo mascota.
// Ahora monograma cuadrado negro con inicial serif dorada. Coherencia con
// la tarjeta del Umbral, el rombo del logo y la iconografía de línea del
// sidebar. Un monograma dice despacho; un emoji dice app de consumo.
//
// API estable — todos los callers siguen igual:
//   <AgentAvatar agent="hector" size={40} />
//   <AgentAvatar agent="mario"  size={32} />
//   <AgentAvatar agent="alvaro" size={22} />
//
// Agentes válidos: hector | mario | jorge | diego | alvaro | gonzalo.
// Iniciales: H · M · J · Á · G · D. (Sí, Álvaro con tilde — es la marca).
//
// La prop `size` controla el lado del cuadrado. La tipografía escala
// proporcionalmente (~55% del tamaño). Para consistencia visual, la caja
// se dibuja como cuadrado exacto — nunca redondeado.
import React from "react";

const AGENT_INITIAL = {
  hector:  "H",
  mario:   "M",
  jorge:   "J",
  diego:   "D",
  alvaro:  "Á",
  gonzalo: "G",
};

// Paleta institucional: negro profundo + oro heráldico.
//
// BORDER conserva el oro original (#C9A84C) porque a 1px sobre negro
// se ve fino y elegante — subirlo lo haría chillón.
// INK sube a un oro más luminoso (#E5C46B) para que la inicial serif
// tenga contraste real en tamaños grandes (72–80px del Welcome y del
// Summary). Antonio: "la H apenas se ve, sube el contraste del oro".
// El #C9A84C anterior sobre #0A0A0A daba ~4.4:1 (roza el mínimo WCAG
// AA); el #E5C46B sube a ~7.3:1. Sigue leyéndose como oro, pero se lee.
const BG      = "#0A0A0A";
const BORDER  = "#C9A84C";
const INK     = "#E5C46B";

// canonicalAgentKey(agent) — devuelve "hector"|"mario"|... si el objeto
// representa uno de los 6 agentes canónicos de Kluxor; null si es un
// agente custom del CEO. Útil para los pickers donde conviven canónicos
// (monograma) con custom (emoji propio del user).
//
// Tolera varias formas: {key}, {name}, {label}. Comprueba prefijo del
// nombre para admitir "Mario Legal" · "Jorge Finanzas" · etc.
export function canonicalAgentKey(agent) {
  if (!agent) return null;
  const key = String(agent.key || "").toLowerCase().trim();
  if (["hector","mario","jorge","alvaro","gonzalo","diego"].includes(key)) return key;
  const name = String(agent.name || agent.label || "").toLowerCase().trim();
  if (!name) return null;
  if (name.startsWith("héctor") || name.startsWith("hector"))  return "hector";
  if (name.startsWith("mario"))    return "mario";
  if (name.startsWith("jorge"))    return "jorge";
  if (name.startsWith("álvaro") || name.startsWith("alvaro"))  return "alvaro";
  if (name.startsWith("gonzalo"))  return "gonzalo";
  if (name.startsWith("diego"))    return "diego";
  return null;
}

export default function AgentAvatar({ agent, size = 32, style }) {
  const key = (agent || "").toLowerCase();
  const initial = AGENT_INITIAL[key] || "?";
  // Tipografía serif de marca. font-size ~55% del cuadrado da un peso
  // visual similar al monograma de la tarjeta del Umbral.
  const fontSize = Math.max(10, Math.round(size * 0.55));
  return (
    <div style={{
      width: size,
      height: size,
      flexShrink: 0,
      background: BG,
      border: `1px solid ${BORDER}`,
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      fontFamily: '"Cormorant Garamond", "Instrument Serif", Georgia, serif',
      // fontWeight 600 (subido desde 500) — refuerza la inicial serif
      // en el negro. Junto con INK más luminoso, resuelve el "apenas
      // se ve" del Welcome.
      fontWeight: 600,
      fontSize,
      lineHeight: 1,
      color: INK,
      letterSpacing: "0.01em",
      // Corrección óptica: el trazo serif se sienta ligeramente alto en
      // caja tipográfica. Bajamos 1px para centrar visualmente.
      paddingTop: 1,
      ...(style || {}),
    }}>{initial}</div>
  );
}
