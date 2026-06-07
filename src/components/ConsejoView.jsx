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
import DocumentViewer, { downloadAsPdf, downloadAsMd } from "./Shared/DocumentViewer.jsx";

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

// Parser de [DOCUMENT:tipo:nombre]…contenido…[/DOCUMENT].
// Namespace propio, paralelo a [DERIVAR:] — NO toca [ACTIONS] ni el
// pipeline de Héctor. Segmenta la respuesta en chunks ordenados: prosa
// suelta como {kind:"text"}; cada bloque cerrado como {kind:"document"}.
//
// Tolerancia (regla dura del CEO: NUNCA romper el chat):
//   - Si abre [DOCUMENT:…] y nunca cierra → no se parsea como documento,
//     el texto sale literal (markers visibles). Log warning.
//   - Si el cierre [/DOCUMENT] aparece sin apertura previa → ignorado,
//     queda en la prosa (caso edge).
//   - Anidación: regex no-greedy → toma el cierre MÁS CERCANO al inicio.
//     Documentos anidados quedan aplanados al primero (no soportado).
//   - tipo: solo lowercase + guion. nombre: cualquier char salvo "]" y "\n".
const DOCUMENT_RE = /\[DOCUMENT:([a-z][a-z_\-]{0,30}):([^\]\n]{1,120})\]\s*\n([\s\S]*?)\n?\[\/DOCUMENT\]/gi;
function parseDocuments(text) {
  if (!text) return { segments: [{ kind: "text", content: text || "" }], documents: [], debug: "no-text" };
  const str = String(text);
  const segments = [];
  const documents = [];
  let lastIndex = 0;
  const re = new RegExp(DOCUMENT_RE.source, "gi");
  let m;
  while ((m = re.exec(str)) !== null) {
    if (m.index > lastIndex) {
      const before = str.slice(lastIndex, m.index).trim();
      if (before) segments.push({ kind: "text", content: before });
    }
    const doc = {
      docType: m[1].toLowerCase(),
      name: m[2].trim(),
      content: m[3].trim(),
    };
    segments.push({ kind: "document", ...doc });
    documents.push(doc);
    lastIndex = m.index + m[0].length;
  }
  if (lastIndex < str.length) {
    const tail = str.slice(lastIndex).trim();
    if (tail) segments.push({ kind: "text", content: tail });
  }
  // Detección de apertura sin cierre (caso de truncado parcial que
  // sobrevivió a la continuación, o emisión malformada del modelo).
  // No rompemos el render — la prosa sale literal con el marker visible
  // para que el CEO lo vea — pero logueamos para auditoría.
  const opens = (str.match(/\[DOCUMENT:/gi) || []).length;
  const closes = (str.match(/\[\/DOCUMENT\]/gi) || []).length;
  let debug = documents.length > 0 ? "ok" : (opens > 0 ? "marker-unclosed" : "marker-absent");
  if (opens !== closes) debug = "marker-unclosed";
  // Si no encontramos ninguno y no hay markers en absoluto, devolvemos
  // el texto íntegro como un único segmento.
  if (segments.length === 0) segments.push({ kind: "text", content: str });
  return { segments, documents, debug, opens, closes };
}

// Helper para convertir un segment {kind:"document", ...} en el shape
// que esperan downloadAsPdf / downloadAsMd / DocumentViewer (igual que
// el "doc inline" del DocumentUploader). Centraliza el mapping para no
// duplicarlo en cada handler de la card.
function _docFromSegment(seg, spec) {
  return {
    id: "doc_chat_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    name: seg.name || `Documento de ${spec?.name || "especialista"}`,
    type: "text/markdown",
    size: (seg.content || "").length,
    storagePath: null,
    url: null,
    text: seg.content || "",
    kind: "inline",
    uploadedAt: new Date().toISOString(),
    analyzedBy: null,
    analyzedAt: null,
    report: null,
    _origin: { source: "consejo", specKey: spec?.key, specName: spec?.name, docType: seg.docType },
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

export default function ConsejoView({ currentMember, permissions, onCallMario, onCallJorge, onCallAlvaro, onNavigate, pendingDerivation, onSetPendingDerivation, onBridgeToHector, negTargets = [], taskTargets = [], onSaveCouncilDocument }) {
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
          negTargets={negTargets}
          taskTargets={taskTargets}
          onSaveCouncilDocument={onSaveCouncilDocument}
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
function CouncilChat({ spec, currentMember, onCall, pendingDerivation, onConsumePendingDerivation, onDerive, canDerive, onBridgeToHector, negTargets = [], taskTargets = [], onSaveCouncilDocument }) {
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

  // Apertura automática del especialista al recibir una derivación.
  // El destino habla PRIMERO como un profesional que recibe el expediente:
  // 3 pasos (acuse, propuesta concreta, pregunta de cierre).
  //
  // Diseño técnico:
  //   - Mensaje sintético "user" inyectado al history con _synthetic:true.
  //     Cumple la alternancia que exige Claude (primer turn debe ser user)
  //     y la UI lo filtra del render — el CEO nunca lo ve.
  //   - extraSystem único de apertura (no se repite en turnos posteriores).
  //   - derivationInjected pasa a true tras éxito → el siguiente send del
  //     CEO NO vuelve a inyectar contexto (lo tiene en history).
  //   - Si falla: removemos el sintético y dejamos el chat en estado
  //     pasivo. El siguiente send inyecta el extraSystem normal de
  //     derivación (comportamiento previo, no rompe nada).
  const fireDerivationOpener = async (ctx) => {
    if (!onCall) return;
    const syntheticContent = "[Sistema] Apertura automática de derivación. Procede según las instrucciones del system prompt.";
    setLoading(true);
    setHistory(h => [...h, { role: "user", content: syntheticContent, _synthetic: true, ts: Date.now() }].slice(-CHAT_MAX));
    try {
      const FROM_NAME = NAME_BY_KEY[ctx.fromKey] || ctx.fromKey;
      const truncated = String(ctx.originReply || "").slice(0, 2000);
      const extraSystem = `CONTEXTO DE DERIVACIÓN — APERTURA AUTOMÁTICA:
El CEO consultó originalmente a ${FROM_NAME}: "${ctx.originalQuery || ""}"
${FROM_NAME} respondió y te lo deriva por: "${ctx.reason || ""}".
Resumen de ${FROM_NAME} (referencia, NO repetir literal): "${truncated}".

INSTRUCCIONES PARA ESTE TURNO INICIAL (único):
Hablas TÚ primero. El CEO no ha escrito nada en este chat — recibes el expediente como un profesional. Comportamiento esperado en TRES pasos:
1) ACUSE de recibo en UNA línea (ej: "He revisado el análisis de ${FROM_NAME} sobre …").
2) PROPUESTA concreta desde tu disciplina (1-2 frases — qué harías y cómo).
3) PREGUNTA de cierre pidiendo CONFIRMACIÓN o el DATO que falta para avanzar.

No repitas el análisis de ${FROM_NAME}. No emitas [ACTIONS] ni [INVOCAR]. Solo habla.`;
      const messages = [{ role: "user", content: syntheticContent }];
      const reply = await onCall({ messages, extraSystem, fromKey: ctx.fromKey });
      const rawText = typeof reply === "string" ? reply : (reply?.text || "");
      const { cleanText, derivation, debug } = parseDerivation(rawText);
      console.log(`🔀 [Consejo·${spec.key}] apertura automática (${debug})`, derivation || "");
      const finalReply = (cleanText || "").trim() || "(sin respuesta)";
      setHistory(h => [...h, { role: "assistant", content: finalReply, derivation, ts: Date.now(), _derivationOpener: true }].slice(-CHAT_MAX));
      setDerivationInjected(true);
    } catch (e) {
      console.warn(`🔀 [Consejo·${spec.key}] apertura automática fallida — fallback a chat pasivo:`, e?.message);
      // Removemos el sintético: si la apertura falló, el siguiente send
      // del CEO debe quedar como primer mensaje real sin contaminación.
      setHistory(h => h.filter(m => !m._synthetic));
    } finally {
      setLoading(false);
    }
  };

  // Consumo del pendingDerivation: al llegar la prop, copiamos a state
  // local, limpiamos el state global y disparamos la apertura automática.
  useEffect(() => {
    if (pendingDerivation && pendingDerivation.toKey === spec.key) {
      const ctx = pendingDerivation;
      setDerivationContext(ctx);
      setDerivationInjected(false);
      setShowDerivationDetails(false);
      onConsumePendingDerivation?.();
      // Fire-and-forget: el manejo de errores vive dentro de la función.
      fireDerivationOpener(ctx);
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
      }
      // Parseo del marker [DOCUMENT:tipo:nombre] — segmenta la respuesta
      // en chunks ordenados (prosa + documentos). Si malformado, queda
      // como texto plano sin romper el chat.
      const docParse = parseDocuments(cleanText || "");
      if (docParse.debug === "ok") {
        console.log(`📄 [Consejo·${spec.key}] ${docParse.documents.length} documento(s) entregados:`, docParse.documents.map(d => `${d.docType}/${d.name}`));
      } else if (docParse.debug === "marker-unclosed") {
        console.warn(`📄 [Consejo·${spec.key}] [DOCUMENT] sin cierre · opens=${docParse.opens} closes=${docParse.closes} · render como texto plano`);
      }
      const finalReply = (cleanText || "").trim() || "(sin respuesta)";
      setHistory(h => [...h, {
        role: "assistant",
        content: finalReply,
        derivation,
        // segments y documents solo se guardan si parser encontró
        // documentos válidos; el render decide a partir de la presencia.
        segments: docParse.documents.length > 0 ? docParse.segments : null,
        documents: docParse.documents.length > 0 ? docParse.documents : null,
        ts: Date.now(),
      }].slice(-CHAT_MAX));
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
    // Buscamos el user message REAL — saltamos sintéticos (aperturas
    // automáticas de derivaciones anteriores) para no contaminar la
    // pregunta original que viaja al destino.
    for (let i = idx - 1; i >= 0; i--) {
      if (history[i].role === "user" && !history[i]._synthetic) {
        originalQuery = history[i].content;
        break;
      }
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
  // Guardar como documento — abre el modal con el mensaje del especialista
  // como contenido del documento. El modal pide nombre + destino y delega
  // en onSaveCouncilDocument que vive en App.jsx.
  const [saveDocFor, setSaveDocFor] = useState(null);
  // viewerDoc — cuando el CEO pulsa "👁 Ver" sobre una DocumentCard del
  // chat, montamos el visor profesional (mismo DocumentViewer que abre
  // los docs guardados en negociación/tarea). Cero duplicación.
  const [viewerDoc, setViewerDoc] = useState(null);
  const handleSaveDocClick = (msg) => {
    if (!onSaveCouncilDocument) return;
    setSaveDocFor(msg);
  };
  const handleSaveDocConfirm = ({ targetType, targetId, doc }) => {
    const ok = onSaveCouncilDocument?.({ targetType, targetId, doc });
    if (ok) setSaveDocFor(null);
  };

  const handleBridgeClick = (msg) => {
    if (!onBridgeToHector) return;
    const idx = history.indexOf(msg);
    let originalQuery = "";
    // Skip sintéticos al recuperar la pregunta original (igual que el
    // chip de derivación). Si no hay user real previo (caso apertura
    // automática sin que el CEO haya escrito aún), originalQuery = "".
    for (let i = idx - 1; i >= 0; i--) {
      if (history[i].role === "user" && !history[i]._synthetic) {
        originalQuery = history[i].content;
        break;
      }
    }
    // Si el mensaje incluye un documento parseado, lo pasamos íntegro
    // como originDocument (adiós recorte de 2000 chars en HectorDirect).
    // Tomamos el primer documento — la regla es máximo 1 por respuesta.
    // Fallback: re-parseo retroactivo sobre msg.content por si el mensaje
    // es histórico (anterior al deploy) y aún no tiene documents en jsonb.
    let firstDoc = Array.isArray(msg.documents) && msg.documents.length > 0 ? msg.documents[0] : null;
    if (!firstDoc && typeof msg.content === "string" && /\[DOCUMENT:/i.test(msg.content)) {
      const dp = parseDocuments(msg.content);
      if (dp.documents.length > 0) firstDoc = dp.documents[0];
    }
    onBridgeToHector({
      fromKey: spec.key,
      originalQuery,
      originReply: msg.content,
      originDocument: firstDoc ? {
        name: firstDoc.name,
        docType: firstDoc.docType,
        content: firstDoc.content,
      } : null,
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

      {/* Mensajes — filtramos sintéticos (apertura automática de
          derivaciones): existen en history para mantener la alternancia
          que exige Claude, pero el CEO no debe verlos. */}
      <div ref={scrollRef} style={{ flex: 1, overflowY: "auto", padding: "16px 16px 8px", display: "flex", flexDirection: "column", gap: 10, maxHeight: 540 }}>
        {history.filter(m => !m._synthetic).length === 0 && !loading && (
          <div style={{ padding: "24px 16px", textAlign: "center", color: "#9CA3AF", fontSize: 13, fontStyle: "italic" }}>
            {derivationContext
              ? `${spec.name} está revisando el expediente…`
              : `Pregúntale a ${spec.name} lo que necesites. Asesoría directa, sin intermediarios.`}
          </div>
        )}
        {history.filter(m => !m._synthetic).map((m, i) => {
          const isUser = m.role === "user";
          // Chip de derivación: solo en mensajes assistant con derivation
          // parseada, destino permitido por canDerive y NO estamos ya en
          // un chat derivado (chain cap = 1).
          const showDeriveChip = !isUser && m.derivation && !isDerived && canDerive?.(m.derivation.toKey);
          // Re-parseo retroactivo: mensajes assistant anteriores al deploy
          // pueden contener markers [DOCUMENT] sin segments computados.
          // Si el contenido sigue teniendo markers válidos, parseamos al
          // vuelo para que la card aparezca igualmente. NUNCA muta history.
          let segments = m.segments;
          let documents = m.documents;
          if (!isUser && (!Array.isArray(segments) || segments.length === 0) && typeof m.content === "string" && /\[DOCUMENT:[a-z][a-z_\-]{0,30}:[^\]\n]+\]/i.test(m.content)) {
            const dp = parseDocuments(m.content);
            if (dp.documents.length > 0) {
              segments = dp.segments;
              documents = dp.documents;
            }
          }
          const mWithSegs = (segments && documents) ? { ...m, segments, documents } : m;
          return (
            <div key={i} style={{ display: "flex", gap: 8, justifyContent: isUser ? "flex-end" : "flex-start", flexDirection: "column", alignItems: isUser ? "flex-end" : "flex-start" }}>
              {/* Render: segments (cuando hay documentos parseados) o
                  contenido plano. Los segments alternan burbujas de
                  prosa con DocumentCards visualmente distintas — la
                  prosa explica/acota, la card señala entrega de valor. */}
              {Array.isArray(mWithSegs.segments) && mWithSegs.segments.length > 0 ? (
                <div style={{ display: "flex", flexDirection: "column", gap: 8, maxWidth: "82%", width: "82%" }}>
                  {mWithSegs.segments.map((seg, si) => {
                    if (seg.kind === "document") {
                      return (
                        <DocumentCard
                          key={si}
                          spec={spec}
                          doc={seg}
                          onView={() => setViewerDoc(seg)}
                          onAttach={() => handleSaveDocClick({ content: seg.content, ts: m.ts || Date.now(), _docMeta: seg })}
                          onPdf={() => downloadAsPdf(_docFromSegment(seg, spec))}
                          onMd={() => downloadAsMd(_docFromSegment(seg, spec))}
                        />
                      );
                    }
                    return (
                      <div key={si} style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
                        {si === 0 && !isUser && <div style={{ width: 28, height: 28, borderRadius: "50%", background: m.error ? "#FCA5A5" : spec.accent, color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 13, flexShrink: 0 }}>{spec.emoji}</div>}
                        {si > 0 && !isUser && <div style={{ width: 28, flexShrink: 0 }}/>}
                        <div style={{
                          background: m.error ? "#FEE2E2" : spec.bg,
                          color: m.error ? "#991B1B" : "#1F2937",
                          border: m.error ? "1px solid #FCA5A5" : "0.5px solid #E5E7EB",
                          padding: "10px 14px",
                          fontSize: 13.5,
                          lineHeight: 1.5,
                          whiteSpace: "pre-wrap",
                          wordBreak: "break-word",
                          flex: 1,
                        }}>
                          {seg.content}
                        </div>
                      </div>
                    );
                  })}
                </div>
              ) : (
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
              )}
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
                  {onSaveCouncilDocument && (
                    <button
                      onClick={() => handleSaveDocClick(m)}
                      title="Guardar como documento en una negociación o tarea"
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        gap: 6,
                        padding: "4px 10px",
                        background: "#fff",
                        border: "1px solid #E5E0D5",
                        color: "#3D2E12",
                        fontSize: 11.5,
                        fontWeight: 600,
                        cursor: "pointer",
                        fontFamily: "inherit",
                      }}
                      onMouseEnter={e => { e.currentTarget.style.background = "#FAFAF7"; e.currentTarget.style.borderColor = "#C9A84C"; }}
                      onMouseLeave={e => { e.currentTarget.style.background = "#fff"; e.currentTarget.style.borderColor = "#E5E0D5"; }}
                    >
                      📎 Guardar como documento
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
      {/* Modal "Guardar como documento". Renderizado en overlay propio
          (fixed full-screen). Si saveDocFor es null, no se renderiza. */}
      {saveDocFor && (
        <SaveDocumentModal
          msg={saveDocFor}
          spec={spec}
          negTargets={negTargets}
          taskTargets={taskTargets}
          onSave={handleSaveDocConfirm}
          onCancel={() => setSaveDocFor(null)}
        />
      )}
      {/* Visor profesional para previsualizar el documento del chat
          ANTES de adjuntarlo. Mismo componente que el visor del
          DocumentUploader (consistencia visual + cero duplicación). */}
      {viewerDoc && (
        <DocumentViewer
          doc={_docFromSegment(viewerDoc, spec)}
          onClose={() => setViewerDoc(null)}
        />
      )}
    </div>
  );
}

// DocumentCard — render visualmente distinto a una burbuja: borde oro
// como "entrega de valor". Acciones para Ver, Adjuntar a destino,
// descargar PDF/MD. Tipografía serif en el título para anclar la
// percepción "documento" desde el primer vistazo. Identidad Kluxor:
// papel #FAFAF7, oro #C9A84C, border-radius 0.
function DocumentCard({ spec, doc, onView, onAttach, onPdf, onMd }) {
  const SERIF = 'Georgia, "Times New Roman", Garamond, serif';
  const chars = (doc.content || "").length;
  const lines = (doc.content || "").split(/\r?\n/).filter(l => l.trim()).length;
  return (
    <div style={{
      background: "#FAFAF7",
      border: "1.5px solid #C9A84C",
      padding: "14px 16px 12px",
      display: "flex",
      flexDirection: "column",
      gap: 10,
      boxShadow: "0 1px 4px rgba(201,168,76,0.18)",
    }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
        <span style={{ fontSize: 18, lineHeight: 1, flexShrink: 0 }}>📄</span>
        <div style={{ flex: 1, minWidth: 200 }}>
          <div style={{ fontFamily: SERIF, fontSize: 16, fontWeight: 600, color: "#1F1A0F", lineHeight: 1.25 }}>{doc.name || "Documento sin nombre"}</div>
          <div style={{ fontSize: 11, color: "#8B6914", letterSpacing: "0.04em", marginTop: 2, fontStyle: "italic" }}>
            {doc.docType ? doc.docType.toUpperCase() : "DOCUMENTO"} · {chars.toLocaleString("es-ES")} chars · {lines} líneas · redactado por {spec?.name || "especialista"}
          </div>
        </div>
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
        {onView && (
          <button
            onClick={onView}
            title="Ver el documento con formato"
            style={_cardBtn("#fff", "#C9A84C", "#8B6914")}
            onMouseEnter={e => { e.currentTarget.style.background = "#FFFBEB"; }}
            onMouseLeave={e => { e.currentTarget.style.background = "#fff"; }}
          >
            👁 Ver
          </button>
        )}
        {onAttach && (
          <button
            onClick={onAttach}
            title="Adjuntar a una negociación o tarea"
            style={_cardBtn("#fff", "#E5E0D5", "#3D2E12")}
            onMouseEnter={e => { e.currentTarget.style.background = "#FAFAF7"; e.currentTarget.style.borderColor = "#C9A84C"; }}
            onMouseLeave={e => { e.currentTarget.style.background = "#fff"; e.currentTarget.style.borderColor = "#E5E0D5"; }}
          >
            📎 Adjuntar a…
          </button>
        )}
        {onPdf && (
          <button onClick={onPdf} title="Descargar PDF" style={_cardBtn("#fff", "#E5E0D5", "#3D2E12")}
            onMouseEnter={e => { e.currentTarget.style.background = "#FAFAF7"; e.currentTarget.style.borderColor = "#C9A84C"; }}
            onMouseLeave={e => { e.currentTarget.style.background = "#fff"; e.currentTarget.style.borderColor = "#E5E0D5"; }}
          >⬇ PDF</button>
        )}
        {onMd && (
          <button onClick={onMd} title="Descargar Markdown" style={_cardBtn("#fff", "#E5E0D5", "#3D2E12")}
            onMouseEnter={e => { e.currentTarget.style.background = "#FAFAF7"; e.currentTarget.style.borderColor = "#C9A84C"; }}
            onMouseLeave={e => { e.currentTarget.style.background = "#fff"; e.currentTarget.style.borderColor = "#E5E0D5"; }}
          >⬇ .md</button>
        )}
      </div>
    </div>
  );
}
function _cardBtn(bg, border, color) {
  return {
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
    padding: "6px 12px",
    minHeight: 34,
    background: bg,
    border: `1px solid ${border}`,
    color,
    fontSize: 12,
    fontWeight: 600,
    cursor: "pointer",
    fontFamily: "inherit",
  };
}

// SaveDocumentModal — captura el texto íntegro de la burbuja del especialista
// y lo guarda como entry {kind:"inline"} en negotiation.documents[] o
// task.documents[] del destino seleccionado. Reutiliza el schema del
// DocumentUploader (mismo shape que addInlineText, sección DOCUMENT_INLINE
// validada en producción). La identidad visual sigue la paleta operativa
// Kluxor (#FAFAF7, oro acento, borde #E5E0D5, border-radius 0).
function SaveDocumentModal({ msg, spec, negTargets, taskTargets, onSave, onCancel }) {
  const [name, setName] = useState(() => {
    // Si el mensaje viene de una DocumentCard del chat (msg._docMeta),
    // pre-rellenamos con el nombre real del documento. Para mensajes de
    // chat sueltos (sin marker [DOCUMENT]) seguimos con el patrón
    // "Documento de <Spec> · DD/MM/YYYY".
    const docName = msg && msg._docMeta && msg._docMeta.name;
    if (docName) return docName;
    const dateShort = new Date().toLocaleDateString("es-ES", { day: "2-digit", month: "2-digit", year: "numeric" });
    return `Documento de ${spec.name} · ${dateShort}`;
  });
  const [targetType, setTargetType] = useState("negotiation");
  const [targetId, setTargetId] = useState(null);
  const [search, setSearch] = useState("");

  const source = targetType === "negotiation" ? negTargets : taskTargets;
  const filtered = search.trim()
    ? source.filter(item => {
        const q = search.toLowerCase();
        return (item.title || "").toLowerCase().includes(q)
            || (item.code || "").toLowerCase().includes(q)
            || (item.projectName || "").toLowerCase().includes(q);
      })
    : source;

  const canSave = !!name.trim() && targetId != null;

  const handleSave = () => {
    if (!canSave) return;
    const doc = {
      // Prefijo "doc_council_" para que sea identificable en debug; el
      // resto del shape sigue exactamente lo que persiste addInlineText
      // (DocumentUploader) — cambio aditivo cero impacto sobre la
      // mecánica existente de documentos inline.
      id: "doc_council_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      name: name.trim(),
      type: "text/markdown",
      size: (msg.content || "").length,
      storagePath: null,
      url: null,
      text: msg.content || "",
      kind: "inline",
      uploadedAt: new Date().toISOString(),
      analyzedBy: null,
      analyzedAt: null,
      report: null,
      // Metadata propia del Consejo (no la consume el DocumentUploader
      // pero queda en jsonb para trazabilidad).
      _origin: { source: "consejo", specKey: spec.key, specName: spec.name, ts: msg.ts || Date.now() },
    };
    onSave({ targetType, targetId, doc });
  };

  return (
    <div onClick={onCancel} style={{
      position: "fixed", inset: 0,
      background: "rgba(0,0,0,0.45)",
      zIndex: 2000,
      display: "flex", alignItems: "center", justifyContent: "center",
      padding: 16,
    }}>
      <div onClick={e => e.stopPropagation()} style={{
        background: "#FAFAF7",
        border: "1px solid #E5E0D5",
        width: "100%", maxWidth: 560,
        display: "flex", flexDirection: "column",
        maxHeight: "90vh", overflow: "hidden",
      }}>
        {/* Header */}
        <div style={{ padding: "14px 18px", borderBottom: "0.5px solid #E5E0D5", display: "flex", alignItems: "center", gap: 10 }}>
          <span style={{ fontSize: 18 }}>📎</span>
          <h3 style={{ margin: 0, fontSize: 15, fontWeight: 700, color: "#3D2E12" }}>Guardar documento</h3>
          <button onClick={onCancel} title="Cerrar" style={{ marginLeft: "auto", background: "transparent", border: "none", fontSize: 20, cursor: "pointer", color: "#8B6914", padding: 0, fontFamily: "inherit", lineHeight: 1, width: 32, height: 32 }}>×</button>
        </div>
        {/* Body */}
        <div style={{ padding: "16px 18px", overflowY: "auto", flex: 1 }}>
          <div style={{ marginBottom: 14 }}>
            <label style={{ fontSize: 11, fontWeight: 700, color: "#8B6914", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 6, display: "block" }}>
              Nombre
            </label>
            <input
              type="text"
              value={name}
              onChange={e => setName(e.target.value)}
              style={{ width: "100%", padding: "10px 12px", border: "0.5px solid #D1D5DB", fontSize: 13, fontFamily: "inherit", outline: "none", background: "#fff", boxSizing: "border-box" }}
              autoFocus
            />
          </div>
          <div style={{ marginBottom: 4 }}>
            <label style={{ fontSize: 11, fontWeight: 700, color: "#8B6914", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 6, display: "block" }}>
              Destino
            </label>
            <div style={{ display: "flex", gap: 6, marginBottom: 10 }}>
              <button
                onClick={() => { setTargetType("negotiation"); setTargetId(null); }}
                style={{ flex: 1, padding: "10px 12px", minHeight: 44, background: targetType === "negotiation" ? "#C9A84C" : "#fff", color: targetType === "negotiation" ? "#fff" : "#3D2E12", border: `1px solid ${targetType === "negotiation" ? "#C9A84C" : "#E5E0D5"}`, fontSize: 12, fontWeight: 600, cursor: "pointer", fontFamily: "inherit" }}
              >
                🤝 Negociación
              </button>
              <button
                onClick={() => { setTargetType("task"); setTargetId(null); }}
                style={{ flex: 1, padding: "10px 12px", minHeight: 44, background: targetType === "task" ? "#C9A84C" : "#fff", color: targetType === "task" ? "#fff" : "#3D2E12", border: `1px solid ${targetType === "task" ? "#C9A84C" : "#E5E0D5"}`, fontSize: 12, fontWeight: 600, cursor: "pointer", fontFamily: "inherit" }}
              >
                ✅ Tarea
              </button>
            </div>
            <input
              type="text"
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder={targetType === "negotiation" ? "Buscar negociación…" : "Buscar tarea…"}
              style={{ width: "100%", padding: "9px 12px", border: "0.5px solid #D1D5DB", fontSize: 12, fontFamily: "inherit", outline: "none", background: "#fff", boxSizing: "border-box" }}
            />
            <div style={{ marginTop: 8, maxHeight: 240, overflowY: "auto", border: "0.5px solid #E5E0D5", background: "#fff" }}>
              {filtered.length === 0 ? (
                <div style={{ padding: "20px 12px", fontSize: 12, color: "#9CA3AF", textAlign: "center" }}>
                  {source.length === 0
                    ? (targetType === "negotiation" ? "No hay negociaciones activas." : "No hay tareas abiertas.")
                    : "Sin resultados."}
                </div>
              ) : (
                filtered.slice(0, 100).map(item => {
                  const selected = targetId === item.id;
                  return (
                    <div key={item.id}
                      onClick={() => setTargetId(item.id)}
                      style={{ padding: "10px 12px", borderBottom: "0.5px solid #F3F4F6", cursor: "pointer", fontSize: 12.5, background: selected ? "#FFFBEB" : "transparent", display: "flex", alignItems: "center", gap: 8, minHeight: 48 }}
                      onMouseEnter={e => { if (!selected) e.currentTarget.style.background = "#FAFAF7"; }}
                      onMouseLeave={e => { if (!selected) e.currentTarget.style.background = "transparent"; }}
                    >
                      {targetType === "task" && <span style={{ fontSize: 14 }}>{item.projectEmoji}</span>}
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ color: "#111827", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontWeight: selected ? 600 : 400 }}>{item.title}</div>
                        {targetType === "task" && item.projectName && (
                          <div style={{ fontSize: 10.5, color: "#6B7280", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{item.projectName}</div>
                        )}
                        {targetType === "negotiation" && item.code && (
                          <div style={{ fontSize: 10.5, color: "#6B7280" }}>{item.code}</div>
                        )}
                      </div>
                      {selected && <span style={{ color: "#C9A84C", fontSize: 15, fontWeight: 700 }}>✓</span>}
                    </div>
                  );
                })
              )}
            </div>
          </div>
        </div>
        {/* Footer */}
        <div style={{ padding: "12px 18px", borderTop: "0.5px solid #E5E0D5", display: "flex", gap: 8, justifyContent: "flex-end", background: "#fff" }}>
          <button
            onClick={onCancel}
            style={{ padding: "10px 18px", minHeight: 44, background: "#fff", border: "0.5px solid #D1D5DB", color: "#4B5563", fontSize: 13, fontWeight: 600, cursor: "pointer", fontFamily: "inherit" }}
          >
            Cancelar
          </button>
          <button
            onClick={handleSave}
            disabled={!canSave}
            style={{ padding: "10px 18px", minHeight: 44, background: canSave ? "#C9A84C" : "#E5E0D5", color: canSave ? "#fff" : "#9CA3AF", border: "none", fontSize: 13, fontWeight: 700, cursor: canSave ? "pointer" : "not-allowed", fontFamily: "inherit" }}
          >
            Guardar
          </button>
        </div>
      </div>
    </div>
  );
}
