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
import AgentAvatar from "./AgentAvatar.jsx";

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

function formatExecutedAt(ts) {
  if (!ts) return "";
  const d = new Date(ts);
  if (isNaN(d.getTime())) return "";
  return d.toLocaleString("es-ES", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

// Resumen compacto del conjunto de acciones ejecutadas para el banner
// verde. Cuenta proyectos, tareas, negociaciones y "otras" (movs,
// bancarios, asientos, facturas — el CEO ve "3 acciones más" sin
// abrir cada tipo). Función pura — sin side effects.
function summarizeExecuted(actions) {
  if (!Array.isArray(actions) || actions.length === 0) return "";
  let projects = 0, tasks = 0, negs = 0, others = 0;
  for (const a of actions) {
    if (!a) continue;
    if (a.type === "create_project") {
      projects++;
      tasks += Array.isArray(a.tasks) ? a.tasks.length : 0;
    } else if (a.type === "create_tasks") {
      tasks += Array.isArray(a.tasks) ? a.tasks.length : 0;
    } else if (a.type === "create_negotiation") {
      negs++;
    } else {
      others++;
    }
  }
  const parts = [];
  if (projects) parts.push(`${projects} proyecto${projects !== 1 ? "s" : ""}`);
  if (tasks)    parts.push(`${tasks} tarea${tasks !== 1 ? "s" : ""}`);
  if (negs)     parts.push(`${negs} negociaci${negs !== 1 ? "ones" : "ón"}`);
  if (others)   parts.push(`${others} otra acci${others !== 1 ? "ones" : "ón"}`);
  return parts.join(" · ");
}

// Banner verde que reemplaza la card ActionProposal después de que el
// CEO confirma "Crear todo". Persistente — sobrevive a refresh, cambio
// de tab, y sync cross-device, porque vive en el mensaje serializable.
// Visualmente distinto al banner amarillo de fakeSuccess (verde vs
// ámbar, ✅ vs ⚠).
export function ProposalExecutedBanner({ executedAt, executedActions, paddingLeft = 42 }) {
  const dateStr = formatExecutedAt(executedAt);
  const summary = summarizeExecuted(executedActions);
  return (
    <div style={{
      alignSelf: "stretch",
      marginLeft: paddingLeft,
      marginTop: 4,
      padding: "10px 14px",
      background: "#F0FDF4",
      border: "1.5px solid #86EFAC",
      borderRadius: 8,
      fontSize: 13,
      color: "#065F46",
      lineHeight: 1.5,
    }}>
      ✅ Acciones ejecutadas{dateStr ? ` el ${dateStr}` : ""}
      {summary && <span style={{ color: "#047857" }}> · {summary}</span>}
    </div>
  );
}

export default function ChatBubble({
  message,
  userInitials,
  onRunAgentActions,
  onDiscardProposal,
  onConfirmProposal,
  showTimestamp = false,
  // Render-prop opcional para insertar TaskListCard cuando el mensaje
  // trae message.tasksList. HectorDirect lo pasa con su TaskListCard
  // local; HectorPanel no lo pasa (no genera tasksList en su pipeline).
  renderTaskList,
  // Render-prop opcional para insertar RutaCard cuando el mensaje trae
  // message.ruta. Misma idea que renderTaskList. HectorDirect lo pasa,
  // los demás no — sin él la card no aparece (degradación silenciosa).
  renderRuta,
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
          <AgentAvatar agent="hector" size={32} />
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
            onConfirm={async (selected) => {
              // runAgentActions devuelve {results}. Solo marcamos la
              // propuesta como ejecutada si HUBO al menos un éxito
              // real. Antes (commit revertido) se marcaba siempre,
              // incluso cuando el ejecutor abortaba con error visible
              // — Héctor en el siguiente turno asumía que la tarea
              // estaba creada cuando no lo estaba (alucinación grave).
              const out = await onRunAgentActions(selected);
              const ok = Array.isArray(out?.results)
                && out.results.some(r => r && r.type && r.type !== "error");
              if (ok) {
                onConfirmProposal?.(selected);
              } else {
                onDiscardProposal?.();
              }
            }}
            onCancel={onDiscardProposal}
          />
        </div>
      )}
      {!isUser && message.proposalExecuted && (
        <ProposalExecutedBanner
          executedAt={message.executedAt}
          executedActions={message.executedActions}
        />
      )}
      {!isUser && message.tasksList && typeof renderTaskList === "function" && (
        <div style={{ alignSelf: "stretch", paddingLeft: 42 }}>
          {renderTaskList(message.tasksList)}
        </div>
      )}
      {!isUser && message.ruta && typeof renderRuta === "function" && (
        <div style={{ alignSelf: "stretch", paddingLeft: 42 }}>
          {renderRuta(message.ruta)}
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
      {/* Footer de fuentes consultadas (web_search). Se renderiza cuando
          message.citations tiene contenido — Héctor (HectorDirectView) y
          en el futuro cualquier otro caller que use tools y guarde citas.
          Patrón visual paralelo al de GobernanzaView (Normativa Viva). */}
      {!isUser && Array.isArray(message.citations) && message.citations.length > 0 && (
        <div style={{
          alignSelf: "stretch",
          marginLeft: 42,
          marginTop: 6,
          padding: "8px 10px",
          background: "#F0FDF4",
          border: "0.5px solid #BBF7D0",
          borderRadius: 8,
        }}>
          <div style={{ fontSize: 10, fontWeight: 700, color: "#15803D", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 5 }}>
            🔍 {message.citations.length} {message.citations.length === 1 ? "fuente consultada" : "fuentes consultadas"}
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
            {message.citations.map((c, ci) => (
              <a
                key={`cit-${ci}`}
                href={c.url}
                target="_blank"
                rel="noopener noreferrer"
                title={c.cited_text || c.url}
                style={{
                  fontSize: 11,
                  color: "#166534",
                  textDecoration: "none",
                  padding: "2px 6px",
                  border: "0.5px solid #86EFAC",
                  background: "#F7FEE7",
                  wordBreak: "break-all",
                }}
                onMouseEnter={(e) => { e.currentTarget.style.textDecoration = "underline"; }}
                onMouseLeave={(e) => { e.currentTarget.style.textDecoration = "none"; }}
              >
                {c.title || c.url}
              </a>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
