// ConsejoView — "El Consejo". Hub de especialistas con chat directo.
//
// Por qué existe: Mario, Jorge y Álvaro hoy solo son alcanzables vía
// [INVOCAR:] desde Héctor. Para el CEO (y para cualquier invitado que evalúe
// la plataforma) son invisibles. Este hub los pone a un click — cada uno con
// su chat 1:1 propio, clonado del patrón validado de GovChatTab.
//
// Asimetría deliberada con Gobernanza/Finanzas:
//   - Gonzalo y Diego YA tienen su sección dedicada con su chat.
//     Aquí sus cards no abren chat, NAVEGAN a sus secciones para no
//     duplicar conversaciones.
//   - Mario / Jorge / Álvaro reciben aquí su primer chat directo.
//
// Importante: los chats de Mario/Jorge/Álvaro son ASESORÍA PURA.
// No parsean [ACTIONS] ni [INVOCAR:]. Esto es a propósito — el riesgo de
// que un especialista propusiera crear entidades sin que Héctor coordine
// es operativamente alto (y los specialists no están pensados para eso).
import React, { useState, useRef, useEffect } from "react";
import { canUseAgent } from "../lib/auth.js";

const CHAT_MAX = 50;

// Definición de los 5 especialistas. `mode` decide el comportamiento de la
// card: "chat" embebe el chat en esta vista; "navigate" salta a otra vista.
const COUNCIL = [
  { key: "mario",   emoji: "⚖️", name: "Mario",   role: "Abogado mercantil",                    accent: "#7C3AED", bg: "#F3EEFF", border: "#D8B4FE", mode: "chat" },
  { key: "jorge",   emoji: "📊", name: "Jorge",   role: "Analista de inversión",                accent: "#0E7C5A", bg: "#ECFDF5", border: "#86EFAC", mode: "chat" },
  { key: "alvaro",  emoji: "🏠", name: "Álvaro",  role: "Inmobiliario y fiscalidad",            accent: "#92400E", bg: "#FEF3C7", border: "#FCD34D", mode: "chat" },
  { key: "gonzalo", emoji: "🏛️", name: "Gonzalo", role: "Holdings y gobernanza",                accent: "#6B21A8", bg: "#F5EEFA", border: "#D8B4FE", mode: "navigate", target: "gobernanza" },
  { key: "diego",   emoji: "💰", name: "Diego",   role: "Analista financiero",                  accent: "#B91C1C", bg: "#FEF2F2", border: "#FCA5A5", mode: "navigate", target: "finance" },
];

export default function ConsejoView({ currentMember, permissions, onCallMario, onCallJorge, onCallAlvaro, onNavigate }) {
  // Filtramos por canUseAgent. Si el miembro no tiene permiso sobre un
  // agente, su card no aparece — admin global pasa libre.
  const visible = COUNCIL.filter(c => canUseAgent(currentMember, c.key, permissions));
  // Solo uno activo a la vez. Cierra al volver a clicar la misma card.
  const [activeKey, setActiveKey] = useState(null);

  const callerFor = (key) => key === "mario" ? onCallMario : key === "jorge" ? onCallJorge : key === "alvaro" ? onCallAlvaro : null;

  return (
    <div style={{ maxWidth: 1100, margin: "0 auto", padding: "32px 20px" }}>
      <div style={{ marginBottom: 28 }}>
        <div style={{ fontSize: 28, fontWeight: 700, color: "#111827", marginBottom: 6, lineHeight: 1.2 }}>💼 El Consejo</div>
        <div style={{ fontSize: 14, color: "#6B7280" }}>Sus especialistas, en directo. Pregunta a quien necesites.</div>
      </div>

      {visible.length === 0 && (
        <div style={{ background: "#fff", border: "1px solid #E5E7EB", padding: "24px 22px", color: "#6B7280", fontSize: 14 }}>
          No tienes acceso a ningún especialista. Pide a tu administrador que te dé permisos para usar el Consejo.
        </div>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 14, marginBottom: 24 }}>
        {visible.map(c => {
          const isActive = activeKey === c.key && c.mode === "chat";
          return (
            <div
              key={c.key}
              onClick={() => {
                if (c.mode === "navigate") { onNavigate?.(c.target); return; }
                setActiveKey(prev => prev === c.key ? null : c.key);
              }}
              style={{
                background: isActive ? c.bg : "#fff",
                border: `1px solid ${isActive ? c.border : "#E5E7EB"}`,
                padding: "16px 18px",
                cursor: "pointer",
                transition: "border-color .15s ease, box-shadow .15s ease, background .15s ease",
                display: "flex",
                flexDirection: "column",
                gap: 6,
              }}
              onMouseEnter={e => { if (!isActive) { e.currentTarget.style.borderColor = c.border; e.currentTarget.style.boxShadow = `0 2px 12px ${c.accent}22`; } }}
              onMouseLeave={e => { if (!isActive) { e.currentTarget.style.borderColor = "#E5E7EB"; e.currentTarget.style.boxShadow = "none"; } }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <span style={{ fontSize: 22, lineHeight: 1, flexShrink: 0 }}>{c.emoji}</span>
                <h3 style={{ fontSize: 15, fontWeight: 600, color: "#111827", margin: 0 }}>{c.name}</h3>
                {c.mode === "navigate" && (
                  <span style={{ marginLeft: "auto", fontSize: 11, color: c.accent, fontWeight: 600 }}>↗</span>
                )}
              </div>
              <p style={{ fontSize: 13, color: "#6B7280", margin: 0, lineHeight: 1.45 }}>{c.role}</p>
              {c.mode === "navigate" && (
                <p style={{ fontSize: 11, color: c.accent, margin: 0, marginTop: 4, fontWeight: 500 }}>Ir a su sección dedicada</p>
              )}
              {c.mode === "chat" && isActive && (
                <p style={{ fontSize: 11, color: c.accent, margin: 0, marginTop: 4, fontWeight: 500 }}>Chat abierto debajo ↓</p>
              )}
            </div>
          );
        })}
      </div>

      {/* Chat activo. Solo se renderiza para mode:"chat". Tres possible:
          Mario, Jorge, Álvaro — cada uno con su persistencia propia. */}
      {visible.filter(c => c.mode === "chat" && c.key === activeKey).map(c => (
        <CouncilChat
          key={c.key}
          spec={c}
          currentMember={currentMember}
          onCall={callerFor(c.key)}
        />
      ))}
    </div>
  );
}

// CouncilChat — clon ligero de GovChatTab para Mario/Jorge/Álvaro.
// Diferencias deliberadas con GovChatTab:
//   - SIN parseAgentActions (asesoría pura — no propone crear entidades).
//   - SIN citations rendering (los specialists no usan web_search aquí).
//   - SIN TTS / voz (mantenemos el alcance mínimo del piloto).
//   - SIN proposal/banner banners.
// Persistencia localStorage por (specKey, userId) para que cada miembro
// tenga su propia conversación con cada especialista.
function CouncilChat({ spec, currentMember, onCall }) {
  const userId = currentMember?.id ?? "anon";
  const storageKey = `kluxor.consejo.${spec.key}.chat.${userId}`;
  const [history, setHistory] = useState(() => {
    try { return JSON.parse(localStorage.getItem(storageKey) || "[]"); } catch { return []; }
  });
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const scrollRef = useRef(null);

  useEffect(() => {
    try { localStorage.setItem(storageKey, JSON.stringify(history.slice(-CHAT_MAX))); } catch {}
  }, [history, storageKey]);

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [history, loading]);

  const send = async (overrideText) => {
    const txt = (overrideText ?? input).trim();
    if (!txt || loading || !onCall) return;
    const next = [...history, { role: "user", content: txt, ts: Date.now() }].slice(-CHAT_MAX);
    setHistory(next);
    setInput("");
    setLoading(true);
    try {
      const messages = next.map(m => ({ role: m.role === "user" ? "user" : "assistant", content: m.content }));
      const reply = await onCall({ messages });
      const text = typeof reply === "string" ? reply : (reply?.text || "");
      const finalReply = (text || "").trim() || "(sin respuesta)";
      setHistory(h => [...h, { role: "assistant", content: finalReply, ts: Date.now() }].slice(-CHAT_MAX));
    } catch (e) {
      setHistory(h => [...h, { role: "assistant", content: `⚠ Error consultando a ${spec.name}: ${e.message || e}`, ts: Date.now(), error: true }].slice(-CHAT_MAX));
    } finally {
      setLoading(false);
    }
  };

  const onKey = (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } };

  const clear = () => {
    if (!history.length) return;
    if (window.confirm(`¿Borrar el historial de conversación con ${spec.name}?`)) {
      setHistory([]);
      try { localStorage.removeItem(storageKey); } catch {}
    }
  };

  return (
    <div style={{ background: "#fff", border: "1px solid #E5E7EB", overflow: "hidden", display: "flex", flexDirection: "column", minHeight: 480 }}>
      {/* Header */}
      <div style={{ padding: "12px 16px", borderBottom: "0.5px solid #E5E7EB", display: "flex", alignItems: "center", gap: 10, background: `linear-gradient(90deg, ${spec.bg}, #FFFFFF)` }}>
        <div style={{ width: 36, height: 36, borderRadius: "50%", background: spec.accent, color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 18 }}>{spec.emoji}</div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: "#111827" }}>{spec.name}</div>
          <div style={{ fontSize: 11, color: spec.accent }}>{spec.role}</div>
        </div>
        <button onClick={clear} title="Borrar conversación" style={{ background: "transparent", border: "1px solid #E5E7EB", width: 32, height: 32, fontSize: 14, cursor: "pointer", color: "#6B7280", fontFamily: "inherit" }}>🗑</button>
      </div>

      {/* Mensajes */}
      <div ref={scrollRef} style={{ flex: 1, overflowY: "auto", padding: "16px 16px 8px", display: "flex", flexDirection: "column", gap: 10, maxHeight: 540 }}>
        {history.length === 0 && (
          <div style={{ padding: "24px 16px", textAlign: "center", color: "#9CA3AF", fontSize: 13, fontStyle: "italic" }}>
            Pregúntale a {spec.name} lo que necesites. Asesoría directa, sin intermediarios.
          </div>
        )}
        {history.map((m, i) => {
          const isUser = m.role === "user";
          return (
            <div key={i} style={{ display: "flex", gap: 8, justifyContent: isUser ? "flex-end" : "flex-start" }}>
              {!isUser && <div style={{ width: 28, height: 28, borderRadius: "50%", background: m.error ? "#FCA5A5" : spec.accent, color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 13, flexShrink: 0 }}>{spec.emoji}</div>}
              <div style={{
                background: isUser ? "#7F77DD" : (m.error ? "#FEE2E2" : spec.bg),
                color: isUser ? "#fff" : (m.error ? "#991B1B" : "#1F2937"),
                border: m.error ? "1px solid #FCA5A5" : "0.5px solid #E5E7EB",
                padding: "10px 14px",
                fontSize: 13.5,
                lineHeight: 1.5,
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
                maxWidth: "82%",
              }}>
                {m.content}
              </div>
            </div>
          );
        })}
        {loading && (
          <div style={{ display: "flex", gap: 8 }}>
            <div style={{ width: 28, height: 28, borderRadius: "50%", background: spec.accent, color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 13 }}>{spec.emoji}</div>
            <div style={{ background: spec.bg, border: "0.5px solid #E5E7EB", padding: "10px 14px", fontSize: 12.5, color: spec.accent, fontStyle: "italic" }}>
              {spec.name} está pensando…
            </div>
          </div>
        )}
      </div>

      {/* Input */}
      <div style={{ padding: 12, borderTop: "0.5px solid #E5E7EB", display: "flex", gap: 8, alignItems: "flex-end" }}>
        <textarea
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={onKey}
          placeholder={`Pregúntale a ${spec.name}…`}
          rows={1}
          style={{ flex: 1, padding: "10px 12px", border: "0.5px solid #D1D5DB", fontSize: 13, fontFamily: "inherit", outline: "none", resize: "none", lineHeight: 1.4, maxHeight: 120 }}
        />
        <button
          onClick={() => send()}
          disabled={!input.trim() || loading}
          style={{ padding: "9px 16px", background: input.trim() && !loading ? spec.accent : "#E5E7EB", color: input.trim() && !loading ? "#fff" : "#9CA3AF", border: "none", fontSize: 13, fontWeight: 600, cursor: input.trim() && !loading ? "pointer" : "not-allowed", fontFamily: "inherit" }}
        >
          {loading ? "…" : "Enviar"}
        </button>
      </div>
    </div>
  );
}
