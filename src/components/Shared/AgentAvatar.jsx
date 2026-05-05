// AgentAvatar — avatar circular flat moderno para los 6 agentes Kluxor.
//
// Carga el SVG desde /public/avatars/{agent}.svg como <img>. Si la
// imagen falla (red caída, archivo movido, build sin assets), hacemos
// fallback al emoji original del agente sobre fondo gris perla — la UI
// nunca queda con el círculo vacío.
//
// Uso:
//   <AgentAvatar agent="hector" size={32} />
//   <AgentAvatar agent="mario"  size={48} />
//
// Agentes válidos: hector | mario | jorge | diego | alvaro | gonzalo.
import React, { useState } from "react";

const AGENT_EMOJI = {
  hector:  "🧙",
  mario:   "⚖️",
  jorge:   "📊",
  diego:   "💰",
  alvaro:  "🏠",
  gonzalo: "🏛️",
};

export default function AgentAvatar({ agent, size = 32, style }) {
  const [failed, setFailed] = useState(false);
  const key = (agent || "").toLowerCase();
  const emoji = AGENT_EMOJI[key] || "🤖";
  const baseStyle = {
    width: size,
    height: size,
    borderRadius: "50%",
    flexShrink: 0,
    display: "block",
    ...(style || {}),
  };
  if (failed || !AGENT_EMOJI[key]) {
    // Fallback: círculo perla con el emoji centrado.
    return (
      <div style={{
        ...baseStyle,
        background: "#F0EDE5",
        color: "#1A1A1A",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontSize: Math.round(size * 0.5),
        lineHeight: 1,
      }}>{emoji}</div>
    );
  }
  return (
    <img
      src={`/avatars/${key}.svg`}
      alt={key}
      width={size}
      height={size}
      style={baseStyle}
      onError={() => setFailed(true)}
    />
  );
}
