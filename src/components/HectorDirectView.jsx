// HectorDirectView — interfaz conversacional dedicada a Héctor.
// Aditiva al panel "Sala de Mando" (HectorPanel.jsx) — comparte el
// historial vía localStorage `soulbaric.hector.chat.${userId}` para
// que ambas vistas sigan la misma conversación. La sincronización se
// hace en montaje (cada vez que el CEO entra a la vista, re-lee
// localStorage), no en tiempo real bidireccional dentro de la misma
// pestaña — pero como el routing condicional desmonta una y monta la
// otra, en la práctica funcionan como vistas alternas del mismo chat.
//
// Diseño: layout vertical fijo con header (64px), apertura colapsable,
// chat scrollable (flex:1) y compositor de mensajes (input + mic + send).
// Responsive: maxWidth 680px en desktop, 600px en tablet, 100% en móvil.
import React, { useState, useEffect, useRef } from "react";
import { callAgentSafe, PLAIN_TEXT_RULE } from "../lib/agent.js";
import { parseAgentActions, cleanAgentResponse } from "../lib/agentActions.js";
import ActionProposal from "./Shared/ActionProposal.jsx";

const CHAT_MAX = 50;

// Metadatos de especialistas invocables. Las claves coinciden con el
// regex INVOCAR; agentName mapea al campo `name` del agente en
// data.agents (lo que necesita callAgentSafe para localizar promptBase).
const SPECIALIST_META = {
  mario:   { label: "Mario Legal",         emoji: "⚖️", color: "#7C3AED", agentName: "Mario Legal" },
  jorge:   { label: "Jorge Finanzas",      emoji: "📊", color: "#0369A1", agentName: "Jorge Finanzas" },
  alvaro:  { label: "Álvaro Inmobiliario", emoji: "🏠", color: "#B45309", agentName: "Álvaro Inmobiliario" },
  gonzalo: { label: "Gonzalo Gobernanza",  emoji: "🏛️", color: "#065F46", agentName: "Gonzalo Gobernanza" },
  diego:   { label: "Diego Finanzas Op.",  emoji: "💰", color: "#B91C1C", agentName: "Diego" },
};

// Keywords que disparan timeout extendido (90s) para Mario Legal cuando
// la tarea pide redacción de documentos. Mismo set que App.jsx → Deal Room.
const REDACCION_KEYS = ["redacta","redactar","contrato","documento","acuerdo","escribe","elabora","borrador","clausula","clausulas","cláusula","cláusulas","arrendamiento","cesion","cesión","convenio","escritura"];

const INVOKE_RE = /\[INVOCAR:(mario|jorge|alvaro|gonzalo|diego):([^\]]+)\]/gi;

// Paleta — derivada de los colores que ya usan los demás componentes.
// Se exponen como constantes locales en vez de CSS vars porque el
// proyecto no tiene un sistema de design tokens.
const C = {
  borderTertiary:    "#E5E7EB",
  bgPrimary:         "#FFFFFF",
  bgSecondary:       "#FAFAFA",
  textTertiary:      "#9CA3AF",
  textSecondary:     "#6B7280",
  textPrimary:       "#111827",
  brand:             "#534AB7",   // morado CEO
  brandLight:        "#EEEDFE",   // fondo del avatar de Héctor
  hectorEmojiBg:     "#EEEDFE",
  statusGreen:       "#10B981",
  statusOrange:      "#F59E0B",
};

// Frase de apertura según hora local. Cambia 3 veces al día para
// situar al CEO en el momento del día — no es generación con LLM.
function getAperturaFrase() {
  const h = new Date().getHours();
  if (h >= 6  && h < 12) return "Buenos días. ¿Qué mueve la aguja hoy?";
  if (h >= 12 && h < 18) return "¿En qué necesitas avanzar antes de que acabe el día?";
  return "El día casi termina. ¿Qué queda sin cerrar?";
}

export default function HectorDirectView({ data, userId, onRunAgentActions, onNavigate, financeContext }) {
  const userKey = userId != null ? userId : "anon";
  // Misma clave que usa HectorPanel.jsx → conversación compartida.
  const CHAT_KEY = `soulbaric.hector.chat.${userKey}`;
  const userName = (data?.members || []).find(m => m.id === userId)?.name || "CEO";
  const userInitials = userName.split(" ").map(w => (w[0]||"").toUpperCase()).slice(0, 2).join("") || "CE";

  const [chatHistory, setChatHistory] = useState(() => {
    if (!userId) return [];
    try {
      const raw = localStorage.getItem(CHAT_KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.slice(-CHAT_MAX) : [];
    } catch { return []; }
  });
  const [inputText, setInputText]     = useState("");
  const [isLoading, setIsLoading]     = useState(false);
  const [showApertura, setShowApertura] = useState(true);
  const endRef       = useRef(null);
  const textareaRef  = useRef(null);

  // Persistencia con guard userId (mismo patrón que HectorPanel).
  useEffect(() => {
    if (!userId) return;
    try { localStorage.setItem(CHAT_KEY, JSON.stringify(chatHistory.slice(-CHAT_MAX))); } catch {}
  }, [chatHistory, CHAT_KEY, userId]);

  // Re-hidratación cross-tab: cuando otro tab (o HectorPanel en otra
  // ruta del mismo origen) escribe en localStorage, el evento `storage`
  // dispara y refrescamos. Dentro de la misma pestaña no dispara —
  // confiamos en que el routing condicional desmonta el componente
  // anterior y al re-montar este se lee localStorage en el useState init.
  useEffect(() => {
    const onStorage = (e) => {
      if (e.key !== CHAT_KEY || !e.newValue) return;
      try {
        const parsed = JSON.parse(e.newValue);
        if (Array.isArray(parsed)) setChatHistory(parsed.slice(-CHAT_MAX));
      } catch {}
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [CHAT_KEY]);

  // Auto-scroll al último mensaje en cada cambio del chat o del estado
  // de carga (el indicador de typing también debe quedar a la vista).
  useEffect(() => {
    requestAnimationFrame(() => {
      try { endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" }); } catch {}
    });
  }, [chatHistory.length, isLoading]);

  // Auto-grow del textarea hasta 120px (3-4 líneas).
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(120, el.scrollHeight) + "px";
  }, [inputText]);

  const aperturaText = getAperturaFrase();

  // Envío al modelo. Reusa callAgentSafe + el promptBase de Héctor que
  // vive en data.agents (con sus addons de migración: ACTIONS_v5,
  // Aristóteles, Séneca, INVOKE, etc). Sin reimplementar lógica del
  // panel — solo el bare minimum de chat.
  const handleSend = async () => {
    const txt = inputText.trim();
    if (!txt || isLoading) return;
    const userMsg = { role: "user", text: txt, ts: Date.now() };
    const next = [...chatHistory, userMsg].slice(-CHAT_MAX);
    setChatHistory(next);
    setInputText("");
    setIsLoading(true);
    try {
      const hector = (data?.agents || []).find(a => a.name === "Héctor");
      // Inyección de miembros reales: Héctor recibía solo el promptBase
      // estático y no podía validar si "Marc" o "Antonio" existían como
      // miembros. Sin esa lista, alucinaba assignees inventados. Pasamos
      // id+nombre+email+rol — formato compacto que cabe en 1-2 líneas
      // por miembro y permite citar el id en assignees.
      const membersLines = (data?.members || [])
        .filter(m => m && m.name)
        .map(m => `- id:${m.id} | nombre:"${m.name}"${m.email ? ` | email:${m.email}` : ""}${m.role ? ` | rol:${m.role}` : ""}`)
        .join("\n");
      const membersBlock = membersLines ? `\n\n---\nMIEMBROS REALES DEL EQUIPO (los únicos válidos para assignees y referencias):\n${membersLines}\n\nReglas:\n- Cuando el CEO mencione un nombre, comprueba primero si coincide EXACTAMENTE con algún miembro de esta lista.\n- Si NO coincide o es ambiguo (ej. "Marc" cuando hay varios "Marc..."), aplica la REGLA AMBIGÜEDAD del bloque CAPACIDAD DE EJECUCIÓN: pregunta antes de actuar.\n- Para assignees usa el id (number) cuando lo conozcas, o el nombre exacto entre comillas.` : "";

      // ── Contexto operativo (HD-context-v1) ────────────────────────
      // Antes Héctor recibía solo promptBase + miembros y respondía a
      // ciegas sobre operativa real. Inyectamos snapshots compactos de
      // tareas urgentes/vencidas, proyectos, negociaciones, finanzas y
      // gobernanza. Cada bloque tiene su guard: si el dato no existe
      // o está vacío, no se añade.

      // 1) Tareas urgentes/vencidas. Las tareas viven en data.boards
      // ({[projectId]: [{name, tasks:[]}]}), NO en data.tasks. Aplanamos.
      const todayMs = Date.now();
      const urgentRows = [];
      Object.entries(data?.boards || {}).forEach(([pid, cols]) => {
        const proj = (data?.projects || []).find(p => p.id === Number(pid));
        (cols || []).forEach(col => {
          if (!col || col.name === "Hecho") return;
          (col.tasks || []).forEach(t => {
            if (!t || t.archived) return;
            const dueMs = t.dueDate ? new Date(t.dueDate).getTime() : NaN;
            const isOverdue = !isNaN(dueMs) && dueMs < todayMs;
            const isHigh = t.priority === "alta";
            if (!isOverdue && !isHigh) return;
            urgentRows.push(`- [${proj?.code || "?"}] ${(t.title||"sin título").slice(0,70)} | prio:${t.priority||"—"} | vence:${t.dueDate || "sin fecha"}${isOverdue?" ⚠VENCIDA":""}`);
          });
        });
      });
      const urgentBlock = urgentRows.length
        ? `\n\n---\nTAREAS URGENTES O VENCIDAS (top ${Math.min(15, urgentRows.length)}):\n${urgentRows.slice(0,15).join("\n")}`
        : "";

      // 2) Proyectos activos (no archivados). Contamos tareas vivas
      // desde boards para que el dato no dependa de un campo .tasks
      // que el modelo Project no tiene.
      const projRows = (data?.projects || [])
        .filter(p => p && !p.archived)
        .slice(0, 25)
        .map(p => {
          const cols = (data?.boards?.[p.id]) || [];
          const taskCount = cols.reduce((s, c) => s + ((c?.tasks || []).filter(t => !t.archived).length), 0);
          return `- [${p.code || "?"}] ${(p.name||"Sin nombre").slice(0,60)} | tareas:${taskCount}`;
        });
      const projBlock = projRows.length ? `\n\n---\nPROYECTOS ACTIVOS:\n${projRows.join("\n")}` : "";

      // 3) Negociaciones activas. Status real: en_curso|pausado son las
      // vivas; el resto (cerrado_ganado/perdido/acuerdo_parcial) son
      // cerradas en este modelo.
      const ACTIVE_NEG = new Set(["en_curso", "pausado"]);
      const negRows = (data?.negotiations || [])
        .filter(n => n && ACTIVE_NEG.has(n.status))
        .slice(0, 20)
        .map(n => `- [${n.code || "?"}] ${(n.title||"Sin título").slice(0,60)} | ${n.status||"—"} | contraparte:${n.counterparty || "?"}`);
      const negBlock = negRows.length ? `\n\n---\nNEGOCIACIONES ACTIVAS:\n${negRows.join("\n")}` : "";

      // 4) Resumen financiero — viene precomputado como prop. Formateamos
      // los números con Intl para que Héctor vea cifras legibles, no
      // decimales de Float.
      let finBlock = "";
      if (financeContext && typeof financeContext === "object") {
        const fmt = n => n != null && !isNaN(n) ? new Intl.NumberFormat("es-ES",{maximumFractionDigits:0}).format(n) : "—";
        const finLines = [];
        if (financeContext.currentBalance != null)   finLines.push(`- Saldo actual: ${fmt(financeContext.currentBalance)} EUR`);
        if (financeContext.monthlyBurnRate != null)  finLines.push(`- Burn rate mensual: ${fmt(financeContext.monthlyBurnRate)} EUR`);
        if (financeContext.runway != null)           finLines.push(`- Runway: ${financeContext.runway} meses`);
        if (financeContext.pendingIncome)            finLines.push(`- Cobros pendientes: ${fmt(financeContext.pendingIncome)} EUR`);
        if (financeContext.upcomingExpenses)         finLines.push(`- Pagos próximos: ${fmt(financeContext.upcomingExpenses)} EUR`);
        if (financeContext.facturasVencidas)         finLines.push(`- Facturas vencidas: ${financeContext.facturasVencidas}`);
        if (Array.isArray(financeContext.alertas) && financeContext.alertas.length) {
          finLines.push(`- Alertas: ${financeContext.alertas.slice(0,3).map(a=>a.text||a.message||a).join("; ").slice(0,300)}`);
        }
        if (finLines.length) finBlock = `\n\n---\nRESUMEN FINANCIERO:\n${finLines.join("\n")}`;
      }

      // 5) Gobernanza. data.governance vive como objeto con companies
      // y documents según _migrate. Resumen compacto (≤300 chars).
      let govBlock = "";
      const gov = data?.governance;
      if (gov && typeof gov === "object") {
        const govLines = [];
        const companies = Array.isArray(gov.companies) ? gov.companies : [];
        if (companies.length) {
          const names = companies.map(c => c?.name || c?.code || "?").join(", ");
          govLines.push(`- Empresas: ${names.slice(0,200)}`);
        }
        const docs = Array.isArray(gov.documents) ? gov.documents : [];
        if (docs.length) govLines.push(`- Documentos: ${docs.length} en gestión`);
        if (govLines.length) govBlock = `\n\n---\nGOBERNANZA:\n${govLines.join("\n")}`;
      }

      const baseSystem = (hector?.promptBase
        ? hector.promptBase + "\n\n" + PLAIN_TEXT_RULE
        : "Eres Héctor, Chief of Staff estratégico. " + PLAIN_TEXT_RULE)
        + membersBlock + urgentBlock + projBlock + negBlock + finBlock + govBlock;
      // Convertimos el historial a la forma que espera la API.
      // Los mensajes "assistant" llevan el texto limpio (sin proposal).
      const messages = next.map(m => ({
        role: m.role === "user" ? "user" : "assistant",
        content: m.text || "",
      }));
      const reply = await callAgentSafe(
        { system: baseSystem, messages, max_tokens: 2048 },
        { timeoutMs: 60000 }
      );
      const proposal = parseAgentActions(reply);
      // Extracción de invocaciones [INVOCAR:agente:tarea]. Antes Héctor
      // emitía estas etiquetas y se renderizaban como texto plano —
      // ningún parser las recogía en HectorDirect. Ahora las extraemos
      // antes de mostrar la respuesta y, tras pintar la burbuja de
      // Héctor, llamamos secuencialmente a cada especialista.
      const invocations = [];
      const seenAg = new Set();
      let mInv;
      INVOKE_RE.lastIndex = 0; // reset porque INVOKE_RE es global y mantiene estado
      while ((mInv = INVOKE_RE.exec(reply)) !== null) {
        const key = mInv[1].toLowerCase();
        if (seenAg.has(key)) continue;
        seenAg.add(key);
        invocations.push({ key, task: (mInv[2] || "").trim() });
      }
      // Limpiamos [ACTIONS] (si hay proposal) y SIEMPRE [INVOCAR:].
      const stripInvokes = (s) => String(s || "")
        .replace(/\[INVOCAR:[^\]]+\]/gi, "")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
      const baseClean = proposal ? cleanAgentResponse(reply) : reply;
      const cleanText = stripInvokes(baseClean);
      // Detección anti-alucinación: si Héctor afirma éxito ("hecho",
      // "listo", "creado"...) pero NO emitió bloque [ACTIONS], marcamos
      // el mensaje para mostrar un aviso visible al CEO. Sin esto, la app
      // pintaba "Hecho ✅" como si se hubiera ejecutado algo y el CEO
      // asumía que estaba en BD. Patrón heurístico, no exhaustivo: cubre
      // los verbos de confirmación habituales en español.
      const SUCCESS_RE = /\b(hecho|listo|completad[oa]|creado|creada|actualizad[oa]|asignad[oa]|añadid[oa]|guardad[oa]|registrad[oa]|procesad[oa]|cerrad[oa]|vinculad[oa])\b/i;
      const fakeSuccess = !proposal && SUCCESS_RE.test(cleanText);
      setChatHistory(prev => [...prev, {
        role: "assistant",
        text: cleanText || "(sin texto)",
        proposal: proposal || null,
        fakeSuccess,
        ts: Date.now(),
      }].slice(-CHAT_MAX));

      // Ejecución secuencial de especialistas. Secuencial > paralelo
      // porque el orden cronológico de las burbujas debe ser predecible
      // y porque varias llamadas grandes en paralelo a /api/agent
      // pueden saturar el rate-limit del proxy.
      for (const inv of invocations) {
        const meta = SPECIALIST_META[inv.key];
        if (!meta) continue;
        const ag = (data?.agents || []).find(a => a.name === meta.agentName);
        if (!ag) {
          setChatHistory(prev => [...prev, {
            role: "specialist",
            specialistKey: inv.key,
            text: `⚠ ${meta.label} no está configurado en este workspace.`,
            error: true,
            ts: Date.now(),
          }].slice(-CHAT_MAX));
          continue;
        }
        const tempId = `sp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        setChatHistory(prev => [...prev, {
          role: "specialist",
          specialistKey: inv.key,
          text: `Consultando con ${meta.label}…`,
          loading: true,
          tempId,
          task: inv.task,
          ts: Date.now(),
        }].slice(-CHAT_MAX));
        try {
          const sys = (ag.promptBase || `Eres ${meta.label}, especialista invocado por Héctor.`) + "\n\n" + PLAIN_TEXT_RULE;
          const taskLow = inv.task.toLowerCase();
          const isRedaccion = inv.key === "mario" && REDACCION_KEYS.some(k => taskLow.includes(k));
          const timeoutMs = isRedaccion ? 90000 : 45000;
          const userPrompt = `TAREA QUE TE ENCARGA HÉCTOR (Chief of Staff):\n${inv.task}\n\nResponde con la información concreta que pide. Sin disclaimers extensos. Frases claras y accionables.`;
          const respuesta = await callAgentSafe(
            { system: sys, messages: [{ role: "user", content: userPrompt }], max_tokens: 2048 },
            { timeoutMs }
          );
          setChatHistory(prev => prev.map(m => m.tempId === tempId
            ? { ...m, text: respuesta || "(sin respuesta)", loading: false }
            : m
          ));
        } catch (e2) {
          console.warn(`[HectorDirect] invocación ${inv.key} fallo:`, e2?.message);
          setChatHistory(prev => prev.map(m => m.tempId === tempId
            ? { ...m, text: `⚠ ${meta.label} no respondió: ${e2?.message || "error"}`, loading: false, error: true }
            : m
          ));
        }
      }
    } catch (e) {
      console.warn("[HectorDirect] send fallo:", e?.message);
      setChatHistory(prev => [...prev, {
        role: "assistant",
        text: `⚠ ${e?.message || "Error consultando a Héctor"}`,
        error: true,
        ts: Date.now(),
      }].slice(-CHAT_MAX));
    } finally {
      setIsLoading(false);
    }
  };

  const handleKeyDown = (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const showAperturaBlock = chatHistory.length === 0 && showApertura;

  return (
    <div style={rootStyle}>
      <style>{`
        @keyframes hd-pulse {
          0%, 100% { opacity: 0.3; transform: scale(0.8); }
          50%      { opacity: 1;   transform: scale(1); }
        }
        /* Mobile: el mic pasa a FAB position:fixed encima del bottom
           nav (64px + safe-area). En desktop sigue inline en el input
           bar. Right:16px coincide con el inset estándar de iOS.
           HD-v2: subimos a 72px+safe-area para evitar solape con el
           bottom nav cuando hay teclado virtual o densidad alta. */
        @media (max-width: 768px) {
          [data-hd="mic-btn"] {
            position: fixed !important;
            bottom: calc(72px + env(safe-area-inset-bottom)) !important;
            right: 16px !important;
            z-index: 1100;
            box-shadow: 0 4px 12px rgba(83, 74, 183, 0.35);
          }
        }
      `}</style>

      {/* ZONA 1 — HEADER */}
      <div style={headerStyle}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, minWidth: 0 }}>
          <div style={hectorAvatarStyle}>🧙</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
            <div style={{ fontSize: 15, fontWeight: 500, color: C.textPrimary, lineHeight: 1.2 }}>Héctor</div>
            <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: C.textSecondary }}>
              <span style={{
                width: 7, height: 7, borderRadius: "50%",
                background: isLoading ? C.statusOrange : C.statusGreen,
                flexShrink: 0,
              }} />
              {isLoading ? "Pensando…" : "Listo para ejecutar"}
            </div>
          </div>
        </div>
        <div style={{ fontSize: 12, color: C.textTertiary, fontWeight: 500 }}>Chief of Staff</div>
      </div>

      {/* ZONA 1b — LINK SALA DE MANDO. Acceso discreto al panel completo
          (HectorPanel) para quien quiera el modo "centro de control" con
          tabs, urgentes, especialistas, etc. Compartem historial via
          localStorage, así que volver allí no pierde el contexto. */}
      {onNavigate && (
        <div style={{ textAlign: "right", padding: "4px 20px 6px", borderBottom: `0.5px solid ${C.borderTertiary}`, flexShrink: 0, background: C.bgPrimary }}>
          <span
            onClick={() => onNavigate("command")}
            style={{ fontSize: 12, color: C.textTertiary, cursor: "pointer", textDecoration: "underline" }}
          >
            Ver Sala de Mando →
          </span>
        </div>
      )}

      {/* ZONA 2 — APERTURA (solo si chat vacío y no colapsada) */}
      {showAperturaBlock && (
        <button
          type="button"
          onClick={() => setShowApertura(false)}
          style={aperturaStyle}
          title="Toca para ocultar"
        >
          {aperturaText}
        </button>
      )}

      {/* ZONA 3 — CHAT */}
      <div style={chatStyle}>
        {chatHistory.length === 0 && !showAperturaBlock && (
          <div style={{ fontSize: 13, color: C.textTertiary, fontStyle: "italic", textAlign: "center", padding: "20px 0" }}>
            Escribe el primer mensaje a Héctor.
          </div>
        )}
        {/* Filtramos mensajes sin texto visible (típicamente respuestas
            del modelo donde solo había bloque [ACTIONS] sin prosa: el
            cleanAgentResponse devuelve "(sin texto)" pero a veces la
            propuesta queda en m.proposal y el texto principal está
            vacío). Si hay proposal sin texto, mantenemos la entrada
            para que ActionProposal se renderice; si no hay ni texto
            ni proposal, descartamos. */}
        {chatHistory
          .map((m, i) => ({ m, i }))
          .filter(({ m }) => {
            if (m.role === "user") return true;
            if (m.role === "assistant") {
              const txt = typeof m.text === "string" ? m.text.trim() : "";
              if (txt.length > 0) return true;
              if (m.proposal && Array.isArray(m.proposal.actions) && m.proposal.actions.length > 0) return true;
              return false;
            }
            if (m.role === "specialist") return true;
            return false;
          })
          .map(({ m, i }) => (
            m.role === "specialist"
              ? <SpecialistBubble key={i} message={m} data={data} onRunAgentActions={onRunAgentActions}/>
              : <MessageBubble
                  key={i}
                  message={m}
                  userInitials={userInitials}
                  onRunAgentActions={onRunAgentActions}
                  onDiscardProposal={() => setChatHistory(prev => prev.map((x, idx) => idx === i ? { ...x, proposal: null, proposalDiscarded: true } : x))}
                />
          ))}
        {isLoading && <TypingIndicator />}
        <div ref={endRef} style={{ height: 1 }} />
      </div>

      {/* ZONA 4 — INPUT */}
      <div style={inputBarStyle}>
        <textarea
          ref={textareaRef}
          value={inputText}
          onChange={(e) => setInputText(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Dile algo a Héctor..."
          rows={1}
          style={textareaStyle}
        />
        <button
          type="button"
          data-hd="mic-btn"
          onClick={() => alert("Voz próximamente")}
          title="Dictar (próximamente)"
          style={micButtonStyle}
        >
          {/* Icono micrófono SVG inline */}
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z"/>
            <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
            <line x1="12" y1="19" x2="12" y2="22"/>
          </svg>
        </button>
        {inputText.trim() && (
          <button
            type="button"
            onClick={handleSend}
            disabled={isLoading}
            title="Enviar (Enter)"
            style={{ ...sendButtonStyle, opacity: isLoading ? 0.6 : 1, cursor: isLoading ? "wait" : "pointer" }}
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="12" y1="19" x2="12" y2="5"/>
              <polyline points="5 12 12 5 19 12"/>
            </svg>
          </button>
        )}
      </div>
    </div>
  );
}

// ── Subcomponentes ──────────────────────────────────────────────────

function MessageBubble({ message, userInitials, onRunAgentActions, onDiscardProposal }) {
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
          background: isUser ? C.brand : (message.error ? "#FEE2E2" : C.bgSecondary),
          color: isUser ? "white" : (message.error ? "#991B1B" : C.textPrimary),
          borderRadius: isUser ? "16px 4px 16px 16px" : "4px 16px 16px 16px",
          padding: "10px 14px",
          maxWidth: "78%",
          fontSize: 14,
          lineHeight: 1.5,
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
          border: message.error ? "1px solid #FCA5A5" : "0.5px solid " + C.borderTertiary,
        }}>
          {text}
        </div>
      </div>
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

function SpecialistBubble({ message, data, onRunAgentActions }) {
  const meta = SPECIALIST_META[message.specialistKey] || { label: "Especialista", emoji: "🤖", color: "#6B7280" };
  // Estado UI local de la burbuja: qué picker mostramos y qué feedback
  // inline tras una acción completada. Se desmonta con la propia burbuja
  // si el chat se limpia, así que no necesita persistencia.
  const [picker, setPicker] = useState(null);    // "task" | "neg" | null
  const [feedback, setFeedback] = useState("");
  const flash = (txt) => { setFeedback(txt); setTimeout(()=>setFeedback(""), 2400); };

  // Acción 1 — Crear tarea desde la respuesta. Necesita projectCode
  // porque el executor (create_tasks) lo exige; mostramos picker inline
  // si hay proyectos, o flash de aviso si no hay ninguno.
  const handleCreateTask = (projCode) => {
    const fullText = (message.text || "").trim();
    const firstLine = fullText.split(/\r?\n/).find(l => l.trim()) || `Acción de ${meta.label}`;
    const title = firstLine.slice(0, 60).trim() || `Acción de ${meta.label}`;
    onRunAgentActions?.([{
      type: "create_tasks",
      projectCode: projCode,
      tasks: [{ title, description: fullText, priority: "alta" }],
    }]);
    setPicker(null);
    flash(`✓ Tarea creada en ${projCode}`);
  };

  // Acción 2 — Generar PDF. Abrimos una ventana con HTML formateado y
  // disparamos window.print(); en iOS Safari el menú "Compartir" del
  // diálogo de impresión incluye "Guardar PDF". Si el navegador bloquea
  // la ventana (popup), caemos a descarga .txt — fallback robusto.
  const handlePDF = () => {
    const date = new Date();
    const dateStr = date.toLocaleString("es-ES");
    const safeText = (message.text || "").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const html = `<!doctype html><html lang="es"><head><meta charset="utf-8"/><title>Informe ${meta.label} — ${dateStr}</title><style>
      body{font-family:'Segoe UI',system-ui,-apple-system,sans-serif;max-width:720px;margin:32px auto;padding:0 24px;color:#111827;line-height:1.55}
      header{border-bottom:2px solid ${meta.color};padding-bottom:12px;margin-bottom:18px}
      h1{font-size:18px;margin:0 0 4px;color:${meta.color}}
      .sub{font-size:12px;color:#6b7280}
      .task{font-size:13px;color:#374151;margin-top:6px;padding:6px 10px;background:#f9fafb;border-radius:6px;border-left:3px solid ${meta.color}}
      pre{font-family:inherit;white-space:pre-wrap;word-break:break-word;font-size:14px}
      footer{margin-top:32px;padding-top:12px;border-top:0.5px solid #e5e7eb;font-size:11px;color:#9ca3af;text-align:center}
      @media print{body{margin:0;max-width:none}header{break-after:avoid}}
    </style></head><body>
      <header>
        <h1>${meta.emoji} Informe — ${meta.label}</h1>
        <div class="sub">Generado el ${dateStr}</div>
        ${message.task ? `<div class="task"><b>Tarea:</b> ${message.task.replace(/</g,"&lt;")}</div>` : ""}
      </header>
      <pre>${safeText}</pre>
      <footer>Generado por SoulBaric · ${dateStr}</footer>
    </body></html>`;
    let win = null;
    try { win = window.open("", "_blank"); } catch {}
    if (win && win.document) {
      win.document.open();
      win.document.write(html);
      win.document.close();
      // Damos un tick al render antes de imprimir.
      setTimeout(() => { try { win.focus(); win.print(); } catch {} }, 250);
      flash("✓ PDF abierto para imprimir/guardar");
    } else {
      // Fallback: descarga .txt cuando popup bloqueado (típico iOS).
      const blob = new Blob([
        `Informe ${meta.label} — ${dateStr}\n` +
        (message.task ? `Tarea: ${message.task}\n` : "") +
        `\n${message.text || ""}\n\n— Generado por SoulBaric (${dateStr})\n`
      ], { type: "text/plain" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `informe-${meta.label.toLowerCase().replace(/\s+/g,"-")}-${date.toISOString().slice(0,10)}.txt`;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(()=>URL.revokeObjectURL(url), 2000);
      flash("✓ Informe descargado (.txt)");
    }
  };

  // Acción 3 — Adjuntar a negociación. No hay action type para esto en
  // el executor y updateNegotiation no se expone como prop; el spec del
  // CEO autoriza explícitamente fallback a localStorage. Persistimos la
  // respuesta bajo soulbaric.specialist.attachments.${negId} para que un
  // futuro panel de negociación pueda recuperarlas. La sincronización
  // con Supabase queda como TODO documentado.
  const handleAttachNeg = (negId, negCode) => {
    const key = `soulbaric.specialist.attachments.${negId}`;
    let existing = [];
    try { const raw = localStorage.getItem(key); if (raw) existing = JSON.parse(raw); } catch {}
    if (!Array.isArray(existing)) existing = [];
    existing.push({
      specialist: message.specialistKey,
      label: meta.label,
      task: message.task || "",
      response: message.text || "",
      ts: Date.now(),
    });
    try { localStorage.setItem(key, JSON.stringify(existing.slice(-100))); } catch {}
    setPicker(null);
    flash(`✓ Adjuntado a ${negCode}`);
  };

  const projects = (data?.projects || []).filter(p => p && !p.archived && p.code);
  const ACTIVE_NEG = new Set(["en_curso", "pausado"]);
  const negs = (data?.negotiations || []).filter(n => n && ACTIVE_NEG.has(n.status));

  const buttons = [
    { id: "task", label: "📋 Tarea",  onClick: () => {
        if (!projects.length) { flash("⚠ Crea un proyecto primero"); return; }
        setPicker(p => p === "task" ? null : "task");
      } },
    { id: "pdf",  label: "📄 PDF",    onClick: () => handlePDF() },
    { id: "neg",  label: "📁 Neg.",   onClick: () => {
        if (!negs.length) { flash("⚠ Sin negociaciones activas"); return; }
        setPicker(p => p === "neg" ? null : "neg");
      } },
  ];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4, alignItems: "flex-start" }}>
      <div style={{ display: "flex", flexDirection: "row", gap: 10, alignItems: "flex-start", maxWidth: "100%" }}>
        <div style={{
          width: 32, height: 32, borderRadius: "50%",
          background: meta.color, color: "#fff",
          display: "flex", alignItems: "center", justifyContent: "center",
          fontSize: 16, flexShrink: 0,
        }}>{meta.emoji}</div>
        <div style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 0, flex: 1 }}>
          <div style={{ fontSize: 11, fontWeight: 600, color: meta.color, letterSpacing: 0.2 }}>
            {meta.label}{message.task ? ` · ${message.task.slice(0, 60)}${message.task.length > 60 ? "…" : ""}` : ""}
          </div>
          <div style={{
            background: message.error ? "#FEE2E2" : C.bgSecondary,
            color: message.error ? "#991B1B" : C.textPrimary,
            borderRadius: "4px 16px 16px 16px",
            padding: "10px 14px",
            maxWidth: "100%",
            fontSize: 14,
            lineHeight: 1.5,
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
            border: message.error ? "1px solid #FCA5A5" : `0.5px solid ${C.borderTertiary}`,
            opacity: message.loading ? 0.7 : 1,
            fontStyle: message.loading ? "italic" : "normal",
          }}>
            {message.text}
          </div>
        </div>
      </div>

      {/* Acciones — sólo cuando la respuesta está lista (no loading ni error) */}
      {!message.loading && !message.error && (
        <div style={{ display: "flex", gap: 6, marginTop: 6, marginLeft: 42, flexWrap: "wrap" }}>
          {buttons.map(b => (
            <button
              key={b.id}
              type="button"
              onClick={b.onClick}
              style={{
                fontSize: 11,
                padding: "5px 11px",
                borderRadius: 20,
                border: `0.5px solid ${C.borderTertiary}`,
                background: picker === b.id ? meta.color : C.bgSecondary,
                color: picker === b.id ? "#fff" : C.textSecondary,
                cursor: "pointer",
                fontFamily: "inherit",
                lineHeight: 1.4,
              }}
            >{b.label}</button>
          ))}
        </div>
      )}

      {/* Feedback inline tras una acción */}
      {feedback && (
        <div style={{ marginLeft: 42, marginTop: 4, fontSize: 11, color: meta.color, fontWeight: 500 }}>
          {feedback}
        </div>
      )}

      {/* Picker de proyecto (Acción 1) */}
      {picker === "task" && projects.length > 0 && (
        <div style={{ marginLeft: 42, marginTop: 6, width: "calc(100% - 42px)", maxWidth: 360, background: "#fff", border: `0.5px solid ${C.borderTertiary}`, borderRadius: 8, overflow: "hidden", boxShadow: "0 4px 12px rgba(0,0,0,0.06)" }}>
          <div style={{ padding: "6px 12px", fontSize: 10, fontWeight: 600, color: C.textTertiary, textTransform: "uppercase", letterSpacing: "0.07em", borderBottom: `0.5px solid ${C.borderTertiary}`, background: C.bgSecondary }}>Crear tarea en…</div>
          {projects.slice(0, 12).map(p => (
            <div key={p.id}
              onClick={() => handleCreateTask(p.code)}
              style={{ padding: "8px 12px", cursor: "pointer", fontSize: 13, color: C.textPrimary, borderBottom: `0.5px solid ${C.borderTertiary}` }}
              onMouseEnter={e => e.currentTarget.style.background = C.bgSecondary}
              onMouseLeave={e => e.currentTarget.style.background = "transparent"}
            >
              <span style={{ fontWeight: 600, color: meta.color }}>[{p.code}]</span> {p.name || "Sin nombre"}
            </div>
          ))}
        </div>
      )}

      {/* Picker de negociación (Acción 3) */}
      {picker === "neg" && negs.length > 0 && (
        <div style={{ marginLeft: 42, marginTop: 6, width: "calc(100% - 42px)", maxWidth: 360, background: "#fff", border: `0.5px solid ${C.borderTertiary}`, borderRadius: 8, overflow: "hidden", boxShadow: "0 4px 12px rgba(0,0,0,0.06)" }}>
          <div style={{ padding: "6px 12px", fontSize: 10, fontWeight: 600, color: C.textTertiary, textTransform: "uppercase", letterSpacing: "0.07em", borderBottom: `0.5px solid ${C.borderTertiary}`, background: C.bgSecondary }}>Adjuntar a negociación…</div>
          {negs.slice(0, 12).map(n => (
            <div key={n.id}
              onClick={() => handleAttachNeg(n.id, n.code || `#${n.id}`)}
              style={{ padding: "8px 12px", cursor: "pointer", fontSize: 13, color: C.textPrimary, borderBottom: `0.5px solid ${C.borderTertiary}` }}
              onMouseEnter={e => e.currentTarget.style.background = C.bgSecondary}
              onMouseLeave={e => e.currentTarget.style.background = "transparent"}
            >
              <span style={{ fontWeight: 600, color: meta.color }}>[{n.code || "?"}]</span> {(n.title || "Sin título").slice(0, 50)}
              {n.counterparty ? <span style={{ fontSize: 11, color: C.textTertiary, marginLeft: 6 }}>· {n.counterparty}</span> : null}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function TypingIndicator() {
  return (
    <div style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
      <div style={hectorAvatarSmall}>🧙</div>
      <div style={{
        background: C.bgSecondary,
        borderRadius: "4px 16px 16px 16px",
        padding: "12px 16px",
        border: "0.5px solid " + C.borderTertiary,
        display: "flex",
        gap: 5,
        alignItems: "center",
      }}>
        {[0, 0.2, 0.4].map((delay, i) => (
          <span key={i} style={{
            width: 6, height: 6, borderRadius: "50%",
            background: C.textTertiary,
            display: "inline-block",
            animation: `hd-pulse 1s infinite`,
            animationDelay: `${delay}s`,
          }} />
        ))}
      </div>
    </div>
  );
}

// ── Estilos ─────────────────────────────────────────────────────────

const rootStyle = {
  // height: 100% para llenar el área main-content de App.jsx (que ya está
  // BAJO el topbar). 100dvh tomaba el viewport completo y empujaba el
  // header de HectorDirect fuera de pantalla en móvil (oculto tras el
  // topbar de la app).
  // HD-v3: paddingBottom reserva el espacio del bottom nav (64px +
  // safe-area). main-content ya añade ese padding via CSS global, pero
  // como el root usa overflow:hidden, el inputBar se quedaba debajo
  // del nav. Reservamos el espacio aquí también para que el input quede
  // pegado por encima del nav en móvil.
  height: "100%",
  paddingBottom: "calc(64px + env(safe-area-inset-bottom))",
  display: "flex",
  flexDirection: "column",
  overflow: "hidden",
  width: "100%",
  maxWidth: 680,
  margin: "0 auto",
  borderLeft: `0.5px solid ${C.borderTertiary}`,
  borderRight: `0.5px solid ${C.borderTertiary}`,
  background: C.bgPrimary,
  boxSizing: "border-box",
};

const headerStyle = {
  height: 64,
  padding: "0 20px",
  borderBottom: `0.5px solid ${C.borderTertiary}`,
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  flexShrink: 0,
  background: C.bgPrimary,
};

const hectorAvatarStyle = {
  width: 44,
  height: 44,
  borderRadius: "50%",
  background: C.hectorEmojiBg,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  fontSize: 22,
  flexShrink: 0,
};

const hectorAvatarSmall = {
  width: 32,
  height: 32,
  borderRadius: "50%",
  background: C.hectorEmojiBg,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  fontSize: 16,
  flexShrink: 0,
};

const ceoAvatarStyle = {
  width: 32,
  height: 32,
  borderRadius: "50%",
  background: C.brand,
  color: "white",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  fontSize: 13,
  fontWeight: 500,
  flexShrink: 0,
};

const aperturaStyle = {
  padding: "12px 20px",
  background: C.bgSecondary,
  borderBottom: `0.5px solid ${C.borderTertiary}`,
  fontSize: 13.5,
  color: C.textSecondary,
  cursor: "pointer",
  textAlign: "left",
  border: "none",
  fontFamily: "inherit",
  flexShrink: 0,
  width: "100%",
};

const chatStyle = {
  flex: 1,
  overflowY: "auto",
  overflowX: "hidden",
  padding: "16px 20px",
  display: "flex",
  flexDirection: "column",
  gap: 12,
  minHeight: 0,
};

const inputBarStyle = {
  padding: "12px 16px",
  borderTop: `0.5px solid ${C.borderTertiary}`,
  background: C.bgPrimary,
  display: "flex",
  alignItems: "flex-end",
  gap: 10,
  flexShrink: 0,
};

const textareaStyle = {
  flex: 1,
  minHeight: 48,
  maxHeight: 120,
  padding: "12px 16px",
  borderRadius: 28,
  border: `0.5px solid ${C.borderTertiary}`,
  background: C.bgSecondary,
  fontSize: 15,
  resize: "none",
  lineHeight: 1.5,
  fontFamily: "inherit",
  outline: "none",
  boxSizing: "border-box",
};

const micButtonStyle = {
  width: 48,
  height: 48,
  borderRadius: "50%",
  background: C.brand,
  border: "none",
  cursor: "pointer",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  flexShrink: 0,
  padding: 0,
};

const sendButtonStyle = {
  width: 48,
  height: 48,
  borderRadius: "50%",
  background: C.brand,
  border: "none",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  flexShrink: 0,
  padding: 0,
};
