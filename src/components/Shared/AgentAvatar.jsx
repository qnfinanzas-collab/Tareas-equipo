// AgentAvatar — avatar circular flat moderno para los 6 agentes Kluxor.
//
// Los SVG viven INLINE en este archivo (no en /public/avatars/) para
// eliminar la dependencia de Vercel sirviendo archivos estáticos. Antes
// el catch-all rewrite del SPA pisaba /avatars/*.svg en algunos
// despliegues; ahora los SVG forman parte del bundle JS y no dependen
// de la red ni de la configuración del host.
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

// SVGs flat modernos. Cada uno es un string entero que se inyecta con
// dangerouslySetInnerHTML — más rápido y estable que <img src> porque
// no hace petición de red ni depende de Vercel rewrites.
const AGENT_SVGS = {
  hector: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 90 90" width="100%" height="100%">
<circle cx="45" cy="45" r="45" fill="#FDF5E0"/>
<path d="M15,85 Q15,68 30,64 L45,70 L60,64 Q75,68 75,85" fill="#1A1A1A"/>
<rect x="38" y="60" width="14" height="12" fill="#D4A980"/>
<path d="M30,64 Q35,58 45,57 Q55,58 60,64" fill="#2A2A2A"/>
<ellipse cx="45" cy="46" rx="20" ry="22" fill="#D4A980"/>
<ellipse cx="45" cy="27" rx="21" ry="12" fill="#1A1A1A"/>
<circle cx="30" cy="32" r="8" fill="#1A1A1A"/>
<circle cx="60" cy="32" r="8" fill="#1A1A1A"/>
<circle cx="24" cy="40" r="6" fill="#1A1A1A"/>
<circle cx="66" cy="40" r="6" fill="#1A1A1A"/>
<circle cx="38" cy="47" r="3.5" fill="#FAFAF7"/>
<circle cx="38" cy="47" r="2" fill="#1A1A1A"/>
<circle cx="52" cy="47" r="3.5" fill="#FAFAF7"/>
<circle cx="52" cy="47" r="2" fill="#1A1A1A"/>
<rect x="33" y="41" width="10" height="2.5" rx="1.5" fill="#1A1A1A"/>
<rect x="47" y="41" width="10" height="2.5" rx="1.5" fill="#1A1A1A"/>
<ellipse cx="45" cy="53" rx="3" ry="2" fill="#C49A70"/>
<path d="M37,59 Q45,65 53,59" stroke="#C49A70" stroke-width="1.5" fill="none" stroke-linecap="round"/>
<circle cx="80" cy="12" r="10" fill="#C9A84C"/>
<text x="80" y="16" text-anchor="middle" font-size="10" font-weight="700" fill="#0A0A0A" font-family="system-ui">H</text>
</svg>`,
  mario: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 90 90" width="100%" height="100%">
<circle cx="45" cy="45" r="45" fill="#EEF2FC"/>
<path d="M15,85 Q15,68 30,64 L45,70 L60,64 Q75,68 75,85" fill="#1A3060"/>
<rect x="38" y="60" width="14" height="12" fill="#D4A980"/>
<path d="M38,62 Q45,66 52,62" fill="#1A3060"/>
<ellipse cx="45" cy="46" rx="19" ry="22" fill="#D4A980"/>
<path d="M26,42 Q26,26 45,23 Q64,26 64,42" fill="#2A1A0A"/>
<ellipse cx="45" cy="26" rx="19" ry="7" fill="#2A1A0A"/>
<rect x="32" y="44" width="13" height="9" rx="2" fill="none" stroke="#2A5AAA" stroke-width="1.8"/>
<rect x="49" y="44" width="13" height="9" rx="2" fill="none" stroke="#2A5AAA" stroke-width="1.8"/>
<line x1="45" y1="48" x2="49" y2="48" stroke="#2A5AAA" stroke-width="1.5"/>
<line x1="26" y1="48" x2="32" y2="48" stroke="#2A5AAA" stroke-width="1.2"/>
<line x1="62" y1="48" x2="68" y2="48" stroke="#2A5AAA" stroke-width="1.2"/>
<circle cx="38" cy="48" r="2" fill="#1A1A1A"/>
<circle cx="55" cy="48" r="2" fill="#1A1A1A"/>
<rect x="33" y="41" width="9" height="2" rx="1" fill="#2A1A0A"/>
<rect x="50" y="41" width="9" height="2" rx="1" fill="#2A1A0A"/>
<path d="M45,52 Q43,57 45,59 Q47,57 45,52" stroke="#C49A70" stroke-width="0.8" fill="none"/>
<path d="M38,64 Q45,66 52,64" stroke="#C49A70" stroke-width="1.2" fill="none" stroke-linecap="round"/>
<circle cx="80" cy="12" r="10" fill="#2A5AAA"/>
<text x="80" y="16" text-anchor="middle" font-size="10" font-weight="700" fill="#FAFAF7" font-family="system-ui">M</text>
</svg>`,
  diego: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 90 90" width="100%" height="100%">
<circle cx="45" cy="45" r="45" fill="#EAF5EE"/>
<path d="M15,85 Q15,68 30,64 L45,70 L60,64 Q75,68 75,85" fill="#1A3A20"/>
<rect x="38" y="60" width="14" height="12" fill="#C49A70"/>
<ellipse cx="45" cy="46" rx="22" ry="23" fill="#C49A70"/>
<path d="M23,43 Q24,26 45,23 Q66,26 67,43" fill="#2A1A0A"/>
<path d="M25,52 Q25,70 45,73 Q65,70 65,52" fill="#3A2A1A" opacity="0.5"/>
<ellipse cx="45" cy="70" rx="16" ry="5" fill="#3A2A1A" opacity="0.6"/>
<ellipse cx="37" cy="46" rx="4" ry="3.5" fill="#FAFAF7"/>
<circle cx="37" cy="46" r="2.2" fill="#1A1A1A"/>
<ellipse cx="53" cy="46" rx="4" ry="3.5" fill="#FAFAF7"/>
<circle cx="53" cy="46" r="2.2" fill="#1A1A1A"/>
<rect x="32" y="40" width="11" height="2.5" rx="1.5" fill="#2A1A0A"/>
<rect x="47" y="40" width="11" height="2.5" rx="1.5" fill="#2A1A0A"/>
<ellipse cx="45" cy="53" rx="4" ry="2.5" fill="#AA7A50"/>
<path d="M37,60 Q45,65 53,60" stroke="#AA7A50" stroke-width="1.5" fill="none" stroke-linecap="round"/>
<circle cx="80" cy="12" r="10" fill="#1A7A4A"/>
<text x="80" y="16" text-anchor="middle" font-size="10" font-weight="700" fill="#FAFAF7" font-family="system-ui">D</text>
</svg>`,
  gonzalo: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 90 90" width="100%" height="100%">
<circle cx="45" cy="45" r="45" fill="#FBF3E5"/>
<path d="M15,85 Q15,68 30,64 L45,70 L60,64 Q75,68 75,85" fill="#2A2A2A"/>
<rect x="38" y="60" width="14" height="12" fill="#D4A980"/>
<polygon points="45,68 38,78 32,78 30,70 38,64" fill="#3A3A3A"/>
<polygon points="45,68 52,78 58,78 60,70 52,64" fill="#3A3A3A"/>
<rect x="39" y="68" width="12" height="10" fill="#FAFAF7"/>
<ellipse cx="45" cy="46" rx="20" ry="22" fill="#D4A980"/>
<path d="M25,44 Q26,26 45,23 Q64,26 65,44" fill="#8A8A8A"/>
<ellipse cx="45" cy="26" rx="20" ry="7" fill="#8A8A8A"/>
<ellipse cx="37" cy="47" rx="4" ry="3" fill="#FAFAF7"/>
<circle cx="37" cy="47" r="2" fill="#3A2A1A"/>
<ellipse cx="53" cy="47" rx="4" ry="3" fill="#FAFAF7"/>
<circle cx="53" cy="47" r="2" fill="#3A2A1A"/>
<rect x="32" y="41" width="10" height="2" rx="1" fill="#8A8A8A"/>
<rect x="47" y="41" width="10" height="2" rx="1" fill="#8A8A8A"/>
<path d="M45,52 Q43,57 45,59 Q47,57 45,52" stroke="#C49A70" stroke-width="0.8" fill="none"/>
<path d="M37,62 Q45,67 53,62" stroke="#C49A70" stroke-width="1.5" fill="none" stroke-linecap="round"/>
<circle cx="80" cy="12" r="10" fill="#A07830"/>
<text x="80" y="16" text-anchor="middle" font-size="10" font-weight="700" fill="#FAFAF7" font-family="system-ui">G</text>
</svg>`,
  jorge: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 90 90" width="100%" height="100%">
<circle cx="45" cy="45" r="45" fill="#FAF0EA"/>
<path d="M15,85 Q15,68 30,64 L45,70 L60,64 Q75,68 75,85" fill="#AA5A2A"/>
<rect x="38" y="60" width="14" height="12" fill="#C49A70"/>
<path d="M28,74 Q45,72 62,74 Q62,82 45,82 Q28,82 28,74" fill="#8A4A20"/>
<ellipse cx="45" cy="46" rx="21" ry="23" fill="#C49A70"/>
<path d="M24,42 Q24,26 45,22 Q66,26 66,42" fill="#1A1A1A"/>
<ellipse cx="45" cy="25" rx="21" ry="8" fill="#1A1A1A"/>
<ellipse cx="37" cy="47" rx="4.5" ry="3" fill="#FAFAF7"/>
<circle cx="37" cy="47" r="2.2" fill="#1A1A1A"/>
<ellipse cx="53" cy="47" rx="4.5" ry="3" fill="#FAFAF7"/>
<circle cx="53" cy="47" r="2.2" fill="#1A1A1A"/>
<path d="M32,41 Q37,39 42,41" stroke="#1A1A1A" stroke-width="2" fill="none" stroke-linecap="round"/>
<path d="M48,41 Q53,39 58,41" stroke="#1A1A1A" stroke-width="2" fill="none" stroke-linecap="round"/>
<ellipse cx="45" cy="53" rx="3.5" ry="2" fill="#AA7A50"/>
<path d="M37,60 Q45,65 53,60" stroke="#AA7A50" stroke-width="1.5" fill="none" stroke-linecap="round"/>
<circle cx="80" cy="12" r="10" fill="#AA5A2A"/>
<text x="80" y="16" text-anchor="middle" font-size="10" font-weight="700" fill="#FAFAF7" font-family="system-ui">J</text>
</svg>`,
  alvaro: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 90 90" width="100%" height="100%">
<circle cx="45" cy="45" r="45" fill="#F3EEF9"/>
<path d="M15,85 Q15,68 30,64 L45,70 L60,64 Q75,68 75,85" fill="#3A1A6A"/>
<rect x="38" y="60" width="14" height="12" fill="#D4A980"/>
<polygon points="45,68 38,78 33,78 32,70 38,64" fill="#4A2A7A"/>
<polygon points="45,68 52,78 57,78 58,70 52,64" fill="#4A2A7A"/>
<rect x="40" y="68" width="10" height="10" fill="#FAFAF7"/>
<ellipse cx="45" cy="46" rx="20" ry="22" fill="#D4A980"/>
<path d="M25,46 Q24,26 45,22 Q66,26 65,46" fill="#2A1A0A"/>
<ellipse cx="45" cy="25" rx="20" ry="8" fill="#2A1A0A"/>
<ellipse cx="26" cy="44" rx="5" ry="8" fill="#2A1A0A"/>
<ellipse cx="64" cy="44" rx="5" ry="8" fill="#2A1A0A"/>
<ellipse cx="37" cy="47" rx="4" ry="3" fill="#FAFAF7"/>
<circle cx="37" cy="47" r="2" fill="#1A1A1A"/>
<ellipse cx="53" cy="47" rx="4" ry="3" fill="#FAFAF7"/>
<circle cx="53" cy="47" r="2" fill="#1A1A1A"/>
<rect x="32" y="41" width="10" height="2" rx="1" fill="#2A1A0A"/>
<rect x="47" y="41" width="10" height="2" rx="1" fill="#2A1A0A"/>
<path d="M45,52 Q43,57 45,59 Q47,57 45,52" stroke="#C49A70" stroke-width="0.8" fill="none"/>
<path d="M38,63 Q45,67 52,63" stroke="#C49A70" stroke-width="1.2" fill="none" stroke-linecap="round"/>
<circle cx="80" cy="12" r="10" fill="#6A3AAA"/>
<text x="80" y="16" text-anchor="middle" font-size="10" font-weight="700" fill="#FAFAF7" font-family="system-ui">Á</text>
</svg>`,
};

export default function AgentAvatar({ agent, size = 32, style }) {
  const [failed, setFailed] = useState(false);
  const key = (agent || "").toLowerCase();
  const emoji = AGENT_EMOJI[key] || "🤖";
  const svgContent = AGENT_SVGS[key];
  const baseStyle = {
    width: size,
    height: size,
    flexShrink: 0,
    display: "block",
    ...(style || {}),
  };
  if (svgContent && !failed) {
    return (
      <div
        style={{
          ...baseStyle,
          borderRadius: "50%",
          overflow: "hidden",
        }}
        dangerouslySetInnerHTML={{ __html: svgContent }}
      />
    );
  }
  // Fallback: círculo perla con el emoji centrado.
  return (
    <div style={{
      ...baseStyle,
      borderRadius: "50%",
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
