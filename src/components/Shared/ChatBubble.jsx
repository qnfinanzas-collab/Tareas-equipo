// ChatBubble — burbuja unificada del chat con Héctor.
//
// Diseño Kluxor "operational": fondos cálidos crema/perla, oro como
// acento, avatares circulares (CEO con iniciales sólidas, Héctor con
// borde oro). Usado por HectorDirectView y por HectorPanel (Sala de
// Mando) — antes vivía duplicado entre los dos.
//
// El componente NO renderiza:
//   - role === "system" (texto centrado de trazabilidad — específico
//     de HectorPanel, va inline allí).
//   - role === "hector_analysis" (burbuja de análisis con summary card
//     — específica de HectorPanel).
//   - role === "specialist" (invocaciones a Mario/Jorge/etc. — solo
//     HectorDirect, lo maneja con SpecialistBubble propio).
//   - role === "hector" + isFollowUp (burbuja amarilla con CTAs —
//     específica de HectorPanel).
//
// Solo cubre los dos casos comunes: role === "user" y role === "hector"
// (o "assistant") con texto normal. El resto de tipos los renderiza el
// caller inline.
import React from "react";
import ActionProposal from "./ActionProposal.jsx";

// Paleta operativa Kluxor — claro/legible para uso diario, oro como
// acento de marca y acción. La paleta dark negro/oro queda solo para
// los PDFs (comunicación externa). Rolls Royce: negro fuera, claro
// dentro de la herramienta.
export const CHAT_PALETTE = {
  borderTertiary: "#E5E0D5",
  bgPrimary:      "#FAFAF7",
  bgSecondary:    "#F0EDE5",
  textTertiary:   "#9B9B9B",
  textSecondary:  "#6B6B6B",
  textPrimary:    "#1A1A1A",
  brand:          "#C9A84C",
  brandLight:     "#E8DFC4",
  brandHover:     "#B89638",
  hectorEmojiBg:  "#F0EDE5",
  statusGreen:    "#4A8B5C",
  statusOrange:   "#B89638",
};

const C = CHAT_PALETTE;

export const ceoAvatarStyle = {
  width: 32,
  height: 32,
  borderRadius: "50%",
  background: C.brand,
  color: "#FFFFFF",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  fontSize: 13,
  fontWeight: 600,
  flexShrink: 0,
};

export const hectorAvatarSmall = {
  width: 32,
  height: 32,
  borderRadius: "50%",
  // Avatar pequeño dentro de las burbujas: ligeramente más blanco para
  // diferenciarse del fondo de la burbuja Héctor (que es #F0EDE5).
  background: "#FAFAF7",
  border: `1px solid ${C.brand}`,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  fontSize: 16,
  flexShrink: 0,
};

function formatTs(ts) {
  if (!ts) return "";
  const d = new Date(ts);
  if (isNaN(d.getTime())) return "";
  return d.toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit" });
}

export default function ChatBubble({
  message,
  userInitials,
  onRunAgentActions,
  onDiscardProposal,
  showTimestamp = false,
  // Render-prop opcional para insertar TaskListCard cuando el mensaje
  // trae message.tasksList. HectorDirect lo pasa con su TaskListCard
  // local; HectorPanel no lo pasa (no genera tasksList en su pipeline).
  renderTaskList,
}) {
  const isUser = message.role === "user";
  const text = message.text || "";
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6, alignItems: isUser ? "flex-end" : "flex-start" }}>
      <div style={{
        display: "flex",
        flexDirection: isUser ? "row-reverse" : "row",
        gap: 10,
        alignItems: "flex-start",
        maxWidth: "100%",
      }}>
        {isUser ? (
          <div style={ceoAvatarStyle}>{userInitials}</div>
        ) : (
          <div style={hectorAvatarSmall}>🧙</div>
        )}
        <div style={{
          background: isUser ? C.brandLight : (message.error ? "#FEF2F2" : C.bgSecondary),
          color: message.error ? "#991B1B" : C.textPrimary,
          borderRadius: isUser ? "16px 4px 16px 16px" : "4px 16px 16px 16px",
          padding: "10px 14px",
          maxWidth: "78%",
          fontSize: 14,
          lineHeight: 1.5,
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
          border: message.error ? "1px solid #FCA5A5" : "none",
        }}>
          {text}
        </div>
      </div>
      {showTimestamp && message.ts && (
        <div style={{ fontSize: 9.5, color: C.textTertiary, paddingLeft: isUser ? 0 : 42, paddingRight: isUser ? 42 : 0 }}>
          {formatTs(message.ts)}
        </div>
      )}
      {!isUser && message.proposal && onRunAgentActions && (
        <div style={{ alignSelf: "stretch", paddingLeft: 42 }}>
          <ActionProposal
            proposal={message.proposal}
            agentName="Héctor"
            agentEmoji="🧙"
            color={C.brand}
            onConfirm={async (selected) => { await onRunAgentActions(selected); }}
            onCancel={onDiscardProposal}
          />
        </div>
      )}
      {!isUser && message.tasksList && typeof renderTaskList === "function" && (
        <div style={{ alignSelf: "stretch", paddingLeft: 42 }}>
          {renderTaskList(message.tasksList)}
        </div>
      )}
      {!isUser && message.fakeSuccess && !message.proposal && (
        <div style={{
          alignSelf: "stretch",
          marginLeft: 42,
          marginTop: 4,
          padding: "8px 12px",
          background: "#FEF3C7",
          border: "1px solid #FCD34D",
          borderRadius: 8,
          fontSize: 12,
          color: "#92400E",
          lineHeight: 1.4,
        }}>
          ⚠ Héctor afirma éxito pero <b>no emitió ninguna acción real</b>. Nada se ha guardado. Reformula la orden o pídele explícitamente que ejecute.
        </div>
      )}
    </div>
  );
}
