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
const NAME_BY_KEY = { mario: "Mario", jorge: "Jorge", alvaro: "Álvaro", gonzalo: "Gonzalo", diego: "Diego" };
const EMOJI_BY_KEY = { mario: "⚖️", jorge: "📊", alvaro: "🏠", gonzalo: "🏛️", diego: "💰" };

// Parser del marker [DERIVAR:agente:razón]. Diseño v2 (tolerante):
//   - Escaneo global del texto: el marker puede estar en cualquier línea.
//   - Si hay varios, gana el ÚLTIMO (más cercano al cierre).
//   - Todos los markers se quitan del texto visible (no solo el último).
//   - Distinguimos tres casos para logging:
//       "ok"               → matcheó y se aplicó
//       "marker-malformed" → el texto contiene "[DERIVAR" pero ningún
//                            match válido se encontró (typo en el nombre
//                            del agente, falta el segundo separador, etc).
//       "marker-absent"    → no hay rastro del prefijo, el modelo decidió
//                            no derivar.
// Devuelve { cleanText, derivation: {toKey, reason} | null, debug }.
const DERIVE_RE_GLOBAL = /\[DERIVAR:(mario|jorge|alvaro):([^\]\n]+)\]/gi;
function parseDerivation(text) {
  if (!text) return { cleanText: text, derivation: null, debug: "no-text" };
  const str = String(text);
  const matches = [...str.matchAll(DERIVE_RE_GLOBAL)];
  if (matches.length === 0) {
    const debug = /\[DERIVAR/i.test(str) ? "marker-malformed" : "marker-absent";
    return { cleanText: str, derivation: null, debug };
  }
  const last = matches[matches.length - 1];
  const cleanText = str
    .replace(DERIVE_RE_GLOBAL, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return {
    cleanText,
    derivation: { toKey: last[1].toLowerCase(), reason: (last[2] || "").trim() },
    debug: "ok",
  };
}

// Definición de los 5 especialistas. `mode` decide el comportamiento de la
// card: "chat" embebe el chat en esta vista; "navigate" salta a otra vista.
const COUNCIL = [
  { key: "mario",   emoji: "⚖️", name: "Mario",   role: "Abogado mercantil",                    accent: "#7C3AED", bg: "#F3EEFF", border: "#D8B4FE", mode: "chat" },
  { key: "jorge",   emoji: "📊", name: "Jorge",   role: "Analista de inversión",                accent: "#0E7C5A", bg: "#ECFDF5", border: "#86EFAC", mode: "chat" },
  { key: "alvaro",  emoji: "🏠", name: "Álvaro",  role: "Inmobiliario y fiscalidad",            accent: "#92400E", bg: "#FEF3C7", border: "#FCD34D", mode: "chat" },
  { key: "gonzalo", emoji: "🏛️", name: "Gonzalo", role: "Holdings y gobernanza",                accent: "#6B21A8", bg: "#F5EEFA", border: "#D8B4FE", mode: "navigate", target: "gobernanza" },
  { key: "diego",   emoji: "💰", name: "Diego",   role: "Analista financiero",                  accent: "#B91C1C", bg: "#FEF2F2", border: "#FCA5A5", mode: "navigate", target: "finance" },
];

export default function ConsejoView({ currentMember, permissions, onCallMario, onCallJorge, onCallAlvaro, onNavigate, pendingDerivation, onSetPendingDerivation, onBridgeToHector }) {
  // Filtramos por canUseAgent. Si el miembro no tiene permiso sobre un
  // agente, su card no aparece — admin global pasa libre.
  const visible = COUNCIL.filter(c => canUseAgent(currentMember, c.key, permissions));
  // Solo uno activo a la vez. Cierra al volver a clicar la misma card.
  const [activeKey, setActiveKey] = useState(null);

  const callerFor = (key) => key === "mario" ? onCallMario : key === "jorge" ? onCallJorge : key === "alvaro" ? onCallAlvaro : null;

  // canDerive — el chip de derivación solo se pinta si el CEO tiene permiso
  // sobre el destino. Gate redundante con la regla del system prompt para
  // que el marker emitido a destinos sin permiso quede silencioso en UI.
  const canDerive = (toKey) => canUseAgent(currentMember, toKey, permissions);

  // Disparador del chip: marca activeKey en el destino + setea la
  // derivación pendiente para que el CouncilChat destino la consuma al
  // montar / al recibir prop.
  const handleDerive = (payload) => {
    if (!canDerive(payload.toKey)) return;
    setActiveKey(payload.toKey);
    onSetPendingDerivation?.(payload);
  };

  // Auto-abrir la card destino cuando el state global trae una derivación
  // — útil si la derivación viniera de fuera (p.ej., navegación cruzada
  // entre secciones en fase 2). Hoy ya lo hace handleDerive, pero defensivo.
  useEffect(() => {
    if (pendingDerivation && visible.some(c => c.key === pendingDerivation.toKey && c.mode === "chat")) {
      setActiveKey(pendingDerivation.toKey);
    }
  }, [pendingDerivation]); // eslint-disable-line react-hooks/exhaustive-deps

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
          pendingDerivation={pendingDerivation && pendingDerivation.toKey === c.key ? pendingDerivation : null}
          onConsumePendingDerivation={() => onSetPendingDerivation?.(null)}
          onDerive={handleDerive}
          canDerive={canDerive}
          onBridgeToHector={onBridgeToHector}
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
function CouncilChat({ spec, currentMember, onCall, pendingDerivation, onConsumePendingDerivation, onDerive, canDerive, onBridgeToHector }) {
  const userId = currentMember?.id ?? "anon";
  const storageKey = `kluxor.consejo.${spec.key}.chat.${userId}`;
  const [history, setHistory] = useState(() => {
    try { return JSON.parse(localStorage.getItem(storageKey) || "[]"); } catch { return []; }
  });
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const scrollRef = useRef(null);
  // derivationContext — card visible arriba del chat cuando la conversación
  // arranca por derivación desde otro especialista. Session-only (no se
  // persiste). chainDepth se usa para capar a 1 derivación encadenada: si
  // ya hay derivation context, los chips quedan ocultos en respuestas
  // posteriores de este chat.
  const [derivationContext, setDerivationContext] = useState(null);
  // showDerivationDetails — collapsible del bloque "Mostrar contexto recibido".
  const [showDerivationDetails, setShowDerivationDetails] = useState(false);
  // derivationInjected — flag para inyectar extraSystem SOLO en el primer
  // send tras recibir la derivación. Sonnet integra el contexto la primera
  // vez; repetirlo en cada turn infla el system prompt sin valor.
  const [derivationInjected, setDerivationInjected] = useState(false);

  // Consumo del pendingDerivation: al llegar la prop, copiamos a state
  // local y avisamos al padre para limpiar el global.
  useEffect(() => {
    if (pendingDerivation && pendingDerivation.toKey === spec.key) {
      setDerivationContext(pendingDerivation);
      setDerivationInjected(false);
      setShowDerivationDetails(false);
      onConsumePendingDerivation?.();
    }
  }, [pendingDerivation, spec.key]); // eslint-disable-line react-hooks/exhaustive-deps

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
      const callArgs = { messages };
      // Si estamos en chat derivado y aún no inyectamos el contexto, lo
      // mandamos como extraSystem en este primer turn. Tras el primer
      // turn, el contexto está en el history del LLM implícitamente y no
      // hace falta volver a inyectarlo.
      if (derivationContext && !derivationInjected) {
        const FROM_NAME = NAME_BY_KEY[derivationContext.fromKey] || derivationContext.fromKey;
        const truncated = String(derivationContext.originReply || "").slice(0, 2000);
        callArgs.extraSystem = `CONTEXTO DE DERIVACIÓN:
El CEO consultó originalmente a ${FROM_NAME}: "${derivationContext.originalQuery || ""}"
${FROM_NAME} respondió y deriva a ti por: "${derivationContext.reason || ""}".
Resumen de ${FROM_NAME} (referencia, NO repetir): "${truncated}".
Responde TÚ desde tu disciplina integrando lo que ${FROM_NAME} ya dijo. No repitas su análisis.`;
        callArgs.fromKey = derivationContext.fromKey;
      }
      const reply = await onCall(callArgs);
      const rawText = typeof reply === "string" ? reply : (reply?.text || "");
      // Parseo del marker [DERIVAR:] — limpia el texto visible y guarda
      // metadata en el mensaje para renderizar el chip al pie. Log de
      // diagnóstico: "ok" / "marker-absent" (el modelo decidió no derivar)
      // / "marker-malformed" (lo intentó pero no encaja con el regex).
      const { cleanText, derivation, debug } = parseDerivation(rawText);
      if (debug === "ok") {
        console.log(`🔀 [Consejo·${spec.key}] derivación parseada →`, derivation);
      } else if (debug === "marker-malformed") {
        console.warn(`🔀 [Consejo·${spec.key}] marker presente pero malformado · cola del texto:`, String(rawText).slice(-300));
      } else {
        console.log(`🔀 [Consejo·${spec.key}] sin derivación (marker-absent)`);
      }
      const finalReply = (cleanText || "").trim() || "(sin respuesta)";
      setHistory(h => [...h, { role: "assistant", content: finalReply, derivation, ts: Date.now() }].slice(-CHAT_MAX));
      if (derivationContext && !derivationInjected) setDerivationInjected(true);
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
      setDerivationContext(null);
      setDerivationInjected(false);
      try { localStorage.removeItem(storageKey); } catch {}
    }
  };

  // Click en el chip "→ Consultar a X". Reconstruye la pregunta original
  // del CEO buscando hacia atrás el último mensaje user previo a esta
  // respuesta del especialista.
  const handleDeriveChip = (msg) => {
    if (!onDerive || !msg.derivation) return;
    const idx = history.indexOf(msg);
    let originalQuery = "";
    for (let i = idx - 1; i >= 0; i--) {
      if (history[i].role === "user") { originalQuery = history[i].content; break; }
    }
    onDerive({
      fromKey: spec.key,
      toKey: msg.derivation.toKey,
      reason: msg.derivation.reason,
      originalQuery,
      originReply: msg.content,
      chainDepth: 1,
    });
  };

  // Chain cap = 1: si este chat está en estado derivado, sus chips quedan
  // ocultos. El CEO solo derivó UNA vez; segundas derivaciones quedan para
  // fases posteriores.
  const isDerived = !!derivationContext;

  // Puente a Héctor: el botón al pie de cada respuesta del especialista
  // empuja a Héctor el paquete {fromKey, originalQuery, originReply} para
  // que precargue el input con "Convierte este análisis en acciones…".
  // Héctor responde con su pipeline normal [ACTIONS] → ActionProposal.
  const handleBridgeClick = (msg) => {
    if (!onBridgeToHector) return;
    const idx = history.indexOf(msg);
    let originalQuery = "";
    for (let i = idx - 1; i >= 0; i--) {
      if (history[i].role === "user") { originalQuery = history[i].content; break; }
    }
    onBridgeToHector({
      fromKey: spec.key,
      originalQuery,
      originReply: msg.content,
    });
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

      {/* Card de derivación recibida — pinned arriba mientras dure la
          sesión. Trust: el CEO ve exactamente qué se ha pasado al destino. */}
      {derivationContext && (
        <div style={{ background: "#FFFBEB", borderBottom: "1px solid #FCD34D", padding: "12px 16px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
            <span style={{ fontSize: 15 }}>📥</span>
            <span style={{ fontSize: 13, fontWeight: 700, color: "#92400E" }}>
              Derivación recibida de {EMOJI_BY_KEY[derivationContext.fromKey]} {NAME_BY_KEY[derivationContext.fromKey] || derivationContext.fromKey}
            </span>
          </div>
          {derivationContext.reason && (
            <div style={{ fontSize: 12.5, color: "#78350F", marginBottom: 6, lineHeight: 1.4 }}>
              <strong>Razón:</strong> {derivationContext.reason}
            </div>
          )}
          <button
            onClick={() => setShowDerivationDetails(v => !v)}
            style={{ background: "transparent", border: "none", color: "#B45309", fontSize: 11, cursor: "pointer", padding: 0, fontFamily: "inherit", fontWeight: 600 }}
          >
            {showDerivationDetails ? "▾ Ocultar contexto recibido" : "▸ Mostrar contexto recibido"}
          </button>
          {showDerivationDetails && (
            <div style={{ marginTop: 8, fontSize: 12, color: "#451A03", background: "#FEF3C7", border: "0.5px solid #FCD34D", padding: "10px 12px", display: "flex", flexDirection: "column", gap: 8 }}>
              <div>
                <div style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.08em", color: "#92400E", marginBottom: 3 }}>Pregunta original del CEO</div>
                <div style={{ whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{derivationContext.originalQuery || "(sin pregunta original)"}</div>
              </div>
              <div>
                <div style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.08em", color: "#92400E", marginBottom: 3 }}>Respuesta de {NAME_BY_KEY[derivationContext.fromKey] || derivationContext.fromKey}</div>
                <div style={{ whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{derivationContext.originReply || "(sin respuesta)"}</div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Mensajes */}
      <div ref={scrollRef} style={{ flex: 1, overflowY: "auto", padding: "16px 16px 8px", display: "flex", flexDirection: "column", gap: 10, maxHeight: 540 }}>
        {history.length === 0 && (
          <div style={{ padding: "24px 16px", textAlign: "center", color: "#9CA3AF", fontSize: 13, fontStyle: "italic" }}>
            {derivationContext
              ? `Continúa la conversación con ${spec.name}. El contexto recibido ya está cargado.`
              : `Pregúntale a ${spec.name} lo que necesites. Asesoría directa, sin intermediarios.`}
          </div>
        )}
        {history.map((m, i) => {
          const isUser = m.role === "user";
          // Chip de derivación: solo en mensajes assistant con derivation
          // parseada, destino permitido por canDerive y NO estamos ya en
          // un chat derivado (chain cap = 1).
          const showDeriveChip = !isUser && m.derivation && !isDerived && canDerive?.(m.derivation.toKey);
          return (
            <div key={i} style={{ display: "flex", gap: 8, justifyContent: isUser ? "flex-end" : "flex-start", flexDirection: "column", alignItems: isUser ? "flex-end" : "flex-start" }}>
              <div style={{ display: "flex", gap: 8, alignItems: "flex-start", maxWidth: "82%" }}>
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
                }}>
                  {m.content}
                </div>
              </div>
              {/* Footer de acciones bajo la burbuja del especialista.
                  El botón "Accionar con Héctor" está SIEMPRE disponible
                  (sin gating, sin chain cap) — es la salida ejecutiva
                  desde cualquier respuesta del Consejo. El chip de
                  derivación queda gated por canDerive + chain cap. */}
              {!isUser && !m.error && (
                <div style={{ paddingLeft: 36, display: "flex", flexWrap: "wrap", gap: 6, marginTop: 4 }}>
                  {showDeriveChip && (
                    <button
                      onClick={() => handleDeriveChip(m)}
                      title={m.derivation.reason || ""}
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        gap: 6,
                        padding: "4px 10px",
                        background: "#fff",
                        border: `1px solid ${spec.accent}`,
                        color: spec.accent,
                        fontSize: 11.5,
                        fontWeight: 600,
                        cursor: "pointer",
                        fontFamily: "inherit",
                      }}
                      onMouseEnter={e => { e.currentTarget.style.background = spec.bg; }}
                      onMouseLeave={e => { e.currentTarget.style.background = "#fff"; }}
                    >
                      → Consultar a {EMOJI_BY_KEY[m.derivation.toKey]} {NAME_BY_KEY[m.derivation.toKey]}
                    </button>
                  )}
                  {onBridgeToHector && (
                    <button
                      onClick={() => handleBridgeClick(m)}
                      title="Pedir a Héctor que convierta este análisis en acciones"
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        gap: 6,
                        padding: "4px 10px",
                        background: "#fff",
                        border: "1px solid #C9A84C",
                        color: "#8B6914",
                        fontSize: 11.5,
                        fontWeight: 600,
                        cursor: "pointer",
                        fontFamily: "inherit",
                      }}
                      onMouseEnter={e => { e.currentTarget.style.background = "#FFFBEB"; }}
                      onMouseLeave={e => { e.currentTarget.style.background = "#fff"; }}
                    >
                      🧙 Accionar con Héctor
                    </button>
                  )}
                </div>
              )}
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
