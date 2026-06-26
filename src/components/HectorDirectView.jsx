// HectorDirectView — interfaz conversacional dedicada a Héctor.
// Aditiva al panel "Sala de Mando" (HectorPanel.jsx) — comparte el
// historial vía localStorage `kluxor.hector.chat.${userId}` para
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
import { callAgentSafe, PLAIN_TEXT_RULE, HECTOR_SEARCH_TOOL } from "../lib/agent.js";

// Reglas de uso de web_search para Héctor. Disparadores explícitos +
// test de decisión claro. R1 crítica: si decide buscar, hacerlo ANTES
// de emitir [ACTIONS] para no romper el JSON.
//
// Versión 2 (22/06/2026): retiramos la prohibición global "al crear no
// busques" porque mataba el caso real "búscame la opción más barata Y
// créame la tarea de reserva". Ahora la regla es: SI el CEO pide CREAR
// algo que requiere datos externos reales (reservas, comparativas,
// proveedores, plataformas), busca PRIMERO y emite [ACTIONS] con los
// resultados reales. Añadidos disparadores de comparación/recomendación
// y test "¿cambiaría la respuesta en 6 meses?" para decidir mejor.
const HECTOR_SEARCH_RULES = [
  "HERRAMIENTA web_search — Tienes acceso a búsqueda web (máx 2 usos por turno).",
  "",
  "ÚSALA cuando la respuesta correcta requiere información FRESCA del mundo real:",
  "- Vuelos, trenes, ferries, autobuses (horarios, disponibilidad, precios actuales).",
  "- Ubicaciones físicas (direcciones, mapas, horarios de comercios y restaurantes).",
  "- Precios actuales de productos o servicios.",
  "- Normativa vigente con fecha posterior a tu cutoff (BOE, AEAT, EUR-Lex recientes).",
  "- Eventos próximos (conferencias, ferias, fechas de cierre).",
  "- Datos meteorológicos o de mercado en tiempo real.",
  "- Comparativas y recomendaciones: 'cuál es la mejor', 'la más barata', 'compárame', 'investiga opciones', 'recomiéndame plataformas/proveedores', 'qué proveedor uso'. Si el CEO te delega la decisión sobre QUÉ plataforma o servicio usar (no sabe cuál, te lo pide), BUSCA y compara antes de recomendar. Aprovecha los 2 usos para cruzar al menos dos fuentes (ej. booking.com + skyscanner, AEAT + BOE).",
  "",
  "CASO ESPECIAL — crear + buscar en el mismo turno:",
  "Si el CEO te pide CREAR algo que requiere datos externos reales (reservar un vuelo, comprar un producto, abrir un trámite, contratar un proveedor), busca PRIMERO los datos y DESPUÉS emite [ACTIONS] con los resultados REALES (URLs de proveedores encontrados, no inventadas). NO inventes plataformas de memoria — usa solo las que aparezcan en los resultados de búsqueda. Patrón correcto: prosa breve → web_search → resumen comparativo con datos reales → [ACTIONS] al final con links de las opciones recomendadas.",
  "",
  "NO LA USES para:",
  "- Criterio personal, recomendaciones estratégicas, opiniones de Jefe de Gabinete (Bezos/Munger/Aristóteles, marcos de decisión).",
  "- Preguntas sobre tareas, proyectos, negociaciones, miembros del equipo o cualquier dato INTERNO del CEO (lo tienes en el contexto inyectado).",
  "- Redacción de correos, briefings, resúmenes o documentos basados en información que ya tienes.",
  "- Análisis de negociaciones, valoraciones, modelos financieros propios.",
  "- Preguntas conversacionales o de coaching.",
  "",
  "TEST DE DECISIÓN: ¿la respuesta correcta sería distinta hoy de hace 6 meses (precios, plataformas activas, normativa vigente, eventos)? → BUSCA. ¿La respuesta no cambia con el tiempo (criterio estratégico, framework, opinión, contexto interno del CEO)? → no busques.",
  "",
  "REGLA CRÍTICA R1: Si decides usar web_search, hazlo SIEMPRE antes de emitir el bloque [ACTIONS]. NUNCA en medio del JSON — eso lo rompe. Patrón: prosa → web_search → resumen → [ACTIONS] al final si procede.",
  "",
  "Cuando uses web_search, cita la fuente con su URL al final del párrafo correspondiente. El sistema mostrará las citaciones automáticamente al pie del mensaje.",
].join("\n");

// Regla de fecha ausente al crear tareas. El sistema tiene rolling anchor
// (22/06/2026): tareas sin fecha se arrastran al Mi Día de cada día hasta
// completarse. Pero para tareas de MOMENTO CONCRETO (llamada, reunión,
// visita) eso es peor que preguntar — si el CEO no dijo cuándo, el momento
// importa. Para tareas DIFUSAS (investigar, leer, organizar) crear directo
// sin fecha es lo correcto: aparecen en Mi Día y la rolling anchor las
// recuerda hasta que el CEO las haga.
const HECTOR_NODATE_RULES = [
  "FECHA AUSENTE al crear tarea — cuándo preguntar vs cuándo crear directo:",
  "",
  "Si el CEO te pide CREAR una tarea SIN especificar cuándo (hoy/mañana/fecha/sin urgencia):",
  "",
  "(A) PREGUNTA si la tarea tiene MOMENTO CONCRETO — el éxito depende del cuándo:",
  "- Llamar / WhatsApp / email a una persona específica.",
  "- Asistir a reunión, sesión, comida/cena, evento, cita médica.",
  "- Visitar / desplazarse a un sitio concreto.",
  "- Entrega física, recogida, firma presencial.",
  "- Presentar documento ante organismo (AEAT, registro, juzgado).",
  "- Cualquier acción que sea distinta hacerla hoy vs pasado mañana.",
  "En estos casos: NO emitas [ACTIONS] en este turno. Responde algo como 'Para cuándo lo dejo? Puedes decirme hoy, mañana, una fecha concreta, o sin fecha si va al backlog'. Espera la respuesta del CEO y entonces sí crea con la fecha.",
  "",
  "(B) CREA DIRECTO (sin preguntar, sin startDate, sin dueDate) si la tarea es DIFUSA o de FONDO:",
  "- Investigar / leer / revisar / comparar opciones / estudiar.",
  "- Organizar, limpiar, ordenar, archivar.",
  "- Pensar, reflexionar, decidir (interno).",
  "- Preparar borrador sin destinatario concreto.",
  "- Cualquier acción donde da igual hacerla hoy o pasado mañana.",
  "El sistema tiene ROLLING ANCHOR: estas tareas aparecen en el Mi Día de cada día hasta que el CEO las complete. No se pierden.",
  "",
  "(C) NUNCA preguntes si el CEO ya señaló temporalidad en su mensaje, aunque sea vaga: 'sin prisa', 'cuando puedas', 'backlog', 'para más adelante', 'pendiente', 'algún día'. Eso es señal explícita de 'sin fecha' — crea directo, sin preguntar.",
  "",
  "REGLA DE ORO: la pregunta tiene SENTIDO si la diferencia entre hoy y mañana cambia el éxito. 'Llamar a Juan' → preguntas. 'Investigar opciones de seguros' → creas directo, da igual el día.",
  "",
  "Si el CEO te pide MÚLTIPLES tareas en el mismo turno y unas son de momento y otras difusas: crea las difusas en un [ACTIONS] y pregunta SOLO por las de momento concreto. No bloquees todo por una.",
].join("\n");

import { parseAgentActions, cleanAgentResponse, detectFalseSuccessClaim, parseTasksList, cleanTasksListBlock, correctActionsDates, flattenRealTasks, detectProjectCodeFilter, validateTasksAgainstDatabase, rewriteToPropositive, collectHectorFailures, stripCeoProfile, buildSpecialistContext } from "../lib/agentActions.js";
import { formatCeoMemoryForPrompt } from "../lib/memory.js";
import { isAccountOwner } from "../lib/auth.js";
import { supa } from "../lib/sync.js";
import ActionProposal from "./Shared/ActionProposal.jsx";
import ChatBubble, { CHAT_PALETTE, ceoAvatarStyle, hectorAvatarSmall } from "./Shared/ChatBubble.jsx";
import AgentAvatar from "./Shared/AgentAvatar.jsx";

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

// Detector heurístico de decisiones del CEO (commit 6 — CEOMemoryList).
// Aplicado SOBRE cleanText (la síntesis de Héctor tras validar). El
// detected_from de la BD se rellena con el mensaje original del CEO
// (txt) — el regex sobre cleanText captura cuando Héctor sintetiza la
// decisión en su prosa ("Vale, lo pongo en standby"; "Decidido: Y va
// primero"). Sin llamada a LLM, sin dedup, fire-and-forget.
const CEO_DECISION_PATTERNS = [
  /\b(ponlo|pon|déjalo|dejalo|pónlo)\s+(en\s+)?standby\b/i,
  /\besto\s+(va\s+primero|es\s+prioridad)\b/i,
  /\bno\s+(avanzar|tocar)\s+hasta\b/i,
  /\b(decidido|decisión|hemos\s+decidido)\s*[:.]?\s/i,
  /\b(aparcamos|aplazamos|cancelamos)\b/i,
  /\b(la\s+regla\s+es|a\s+partir\s+de\s+ahora)\b/i,
];

function detectCEODecision(text) {
  if (!text || typeof text !== "string") return { isDecision: false };
  let matchIdx = -1;
  for (const re of CEO_DECISION_PATTERNS) {
    const m = text.match(re);
    if (m && m.index !== undefined) { matchIdx = m.index; break; }
  }
  if (matchIdx === -1) return { isDecision: false };
  // Extraemos la frase contenedora del match (delimitada por . ! ? \n)
  // para que decision_text quede legible en CEOMemoryList sin volcar
  // toda la respuesta de Héctor. Cap a 500 chars por seguridad.
  const before = text.slice(0, matchIdx).split(/[.!?\n]/).pop() || "";
  const after  = text.slice(matchIdx).split(/[.!?\n]/)[0] || "";
  const sentence = (before + after).trim().slice(0, 500);
  const decisionText = sentence || text.slice(0, 500);
  // Status: si la frase contiene "standby", marcamos en standby; si no,
  // por defecto activo. CEO podrá cambiarlo en commits posteriores.
  const status = /\bstandby\b/i.test(decisionText) ? "standby" : "activo";
  return { isDecision: true, text: decisionText, status };
}

// Paleta Kluxor "operational" — fuente de verdad en Shared/ChatBubble
// para que HectorDirect y HectorPanel compartan exactamente los
// mismos colores. Aquí solo aliasamos como `C` por brevedad.
const C = CHAT_PALETTE;

// Filtra el marcador interno [SISTEMA — turno anterior] que la Capa A
// inyecta en el historial enviado al modelo. Claude lo eco a veces de
// vuelta en su prosa, y entonces ese texto interno acaba visible en la
// burbuja del CEO. Strip puramente visual: NO se modifica m.text ni
// m.replyRaw en chatHistory; el mapper sigue enviando el marcador real
// a Claude en el siguiente turno (Capa A intacta).
const SYSTEM_MARKER_RE = /\n*\[SISTEMA[^\]]*\][\s\S]*?(?=\n\n|$)/g;
function stripSystemMarker(text) {
  if (!text || typeof text !== "string") return text;
  return text.replace(SYSTEM_MARKER_RE, "").trim();
}

// Frase de apertura según hora local. Cambia 3 veces al día para
// situar al CEO en el momento del día — no es generación con LLM.
function getAperturaFrase() {
  const h = new Date().getHours();
  if (h >= 6  && h < 12) return "Buenos días. ¿Qué mueve la aguja hoy?";
  if (h >= 12 && h < 18) return "¿En qué necesitas avanzar antes de que acabe el día?";
  return "El día casi termina. ¿Qué queda sin cerrar?";
}

// Sync del chat a Supabase. Upsert por user_id (la tabla hector_chat
// tiene UNIQUE en user_id → una fila por CEO, columna messages jsonb).
// Silencioso: si Supabase falla, localStorage sigue funcionando como
// fuente local. Sin reintentos — el siguiente flush (cada 5 mensajes
// o al desmontar) cubrirá la pérdida.
async function flushChatToSupabase(authUid, messages) {
  if (!authUid || !supa) return;
  try {
    const safe = Array.isArray(messages) ? messages.slice(-CHAT_MAX) : [];
    const { error } = await supa.from("hector_chat").upsert({
      user_id: authUid,
      messages: safe,
      updated_at: new Date().toISOString(),
    }, { onConflict: "user_id" });
    if (error) {
      console.warn(`[Kluxor] Chat flush Supabase error: ${error.message}`);
    } else {
      console.log(`[Kluxor] Chat sincronizado a Supabase: ${safe.length} mensajes`);
    }
  } catch (e) {
    console.warn(`[Kluxor] Chat flush threw: ${e?.message || e}`);
  }
}

// Fase 2C — ceoBlock dinámico.
//
// Antes la identidad del CEO vivía hardcodeada en un literal dentro del
// componente (Antonio Díaz · ALMA DIMO · CIF B19929256 · etc.). Eso
// hacía imposible multi-tenant: un CEO distinto vería el prompt de
// Héctor identificándose como Antonio.
//
// Ahora `buildCeoBlock` lee `data.ceoProfile` (vive dentro del JSONB
// per-tenant de taskflow_state). Si tiene algún campo no vacío → compone
// el bloque dinámico. Si está vacío/inexistente → fallback al literal de
// Antonio para no romper el comportamiento actual de la fila id=1 mientras
// no se le rellene su ceoProfile (Fase 2D).
//
// El header "USUARIO ACTIVO — CEO Y PROPIETARIO:" es el mismo en ambos
// caminos: marker estable que reconocen los smokes C1 como "este prompt
// tiene contexto owner".

function buildCeoBlockLegacyAntonio(email) {
  return `USUARIO ACTIVO — CEO Y PROPIETARIO:
Nombre: Antonio Díaz
Empresa: ALMA DIMO INVESTMENTS S.L. · CIF: B19929256
Email: ${email}
Ubicación: Marbella-Estepona, Costa del Sol, España

PERFIL PROFESIONAL:
Antonio es un visionario de negocio y arquitecto digital. Pionero digital desde 1998. Ha liderado equipos completos de diseño, creatividad, marketing, programación, finanzas, administración y ventas. No es programador técnico pero tiene criterio de producto y arquitectura de negocio de alto nivel. Entiende cada capa de una empresa porque ha dirigido a las personas que las ejecutan.

PROYECTOS ACTIVOS:
- Kluxor: CEO Operating System con IA multi-agente (marca paraguas)
- QuickNex: Plataforma B2B2C colaboración empresarial con IA
- Cámara Hiperbárica HD5000 Plus: expansión Marbella-Estepona
- Negociaciones activas en Marbella-Estepona

SECTORES: Salud hiperbárica · Inversiones · Real estate · Tecnología IA · Colaboración empresarial B2B

CÓMO COMUNICARTE CON ANTONIO:
- Directo al punto, sin tecnicismos innecesarios
- No repitas lo que ya sabe
- Da opciones concretas (A o B, no listas de 10)
- Explica el impacto de negocio, no solo el técnico
- Trata como CEO con criterio, no como usuario técnico
- Prioriza lo que mueve la aguja hoy

FILOSOFÍA: Aristóteles + Séneca. El tiempo es el único activo real. Tecnología al servicio del negocio, nunca al revés.

REGLA CRÍTICA DE IDENTIDAD:
Antonio Díaz es SIEMPRE la parte principal en contratos, documentos y acciones. NUNCA uses otro miembro del equipo como parte principal sin confirmación explícita.
Datos legales: ALMA DIMO INVESTMENTS S.L. · CIF B19929256
Jurisdicción: Juzgados de Marbella.

---
`;
}

export function buildCeoBlock(profile, usuarioActivo) {
  const email = usuarioActivo?.email || "qn.finanzas@gmail.com";
  const hasAny = profile && (profile.name || profile.company || profile.sector || profile.description);
  if (!hasAny) return buildCeoBlockLegacyAntonio(email);
  const name        = profile.name || "el CEO";
  const company     = profile.company ? `\nEmpresa: ${profile.company}` : "";
  const sector      = profile.sector ? `\nSector: ${profile.sector}` : "";
  const description = profile.description ? `\n\nLO QUE LE OCUPA:\n${profile.description}` : "";
  return `USUARIO ACTIVO — CEO Y PROPIETARIO:
Nombre: ${name}${company}
Email: ${email}${sector}${description}

CÓMO COMUNICARTE:
- Háblale por su nombre (${name}).
- Directo al punto. Sin tecnicismos innecesarios.
- Da opciones concretas (A o B), no listas de 10.
- Adapta tus ejemplos y referencias al sector si lo conoces.
- Si lo que le ocupa apunta a un riesgo concreto, entra directo — no lo eludas.

---
`;
}

export default function HectorDirectView({ data, userId, authUid, onRunAgentActions, onNavigate, financeContext, pendingExecBridge, onConsumePendingExecBridge, onSaveCouncilDocument }) {
  const userKey = userId != null ? userId : "anon";
  // Misma clave que usa HectorPanel.jsx → conversación compartida.
  const CHAT_KEY = `kluxor.hector.chat.${userKey}`;
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
  // Puente desde El Consejo. Cuando el CEO pulsa "Accionar con Héctor" en
  // un chat de especialista, App.jsx aterriza el paquete en pendingExecBridge
  // y navega aquí. Lo consumimos: precargamos el input con instrucción +
  // contexto, mostramos banner oro arriba con resumen colapsable, y dejamos
  // que el CEO pulse Enviar. Pipeline normal de Héctor [ACTIONS] → ActionProposal.
  const [bridgeBanner, setBridgeBanner] = useState(null);
  const [showBridgeDetails, setShowBridgeDetails] = useState(false);
  const endRef       = useRef(null);
  const textareaRef  = useRef(null);
  useEffect(() => {
    if (!pendingExecBridge) return;
    const FROM_NAME = { mario: "Mario", jorge: "Jorge", alvaro: "Álvaro" }[pendingExecBridge.fromKey] || pendingExecBridge.fromKey;
    const FROM_EMOJI = { mario: "⚖️", jorge: "📊", alvaro: "🏠" }[pendingExecBridge.fromKey] || "💼";
    // Si el especialista entregó un documento (marker [DOCUMENT]), lo
    // mandamos ÍNTEGRO a Héctor. Sin recortes: el documento es el
    // contexto principal. Si no hay documento, mantenemos el recorte
    // legacy de la prosa a 2000 chars (no se infla por hipotéticas
    // respuestas conversacionales largas).
    const doc = pendingExecBridge.originDocument;
    const proseTruncated = String(pendingExecBridge.originReply || "").slice(0, 2000);
    const prompt = doc
      ? `Contexto recibido desde El Consejo (${FROM_NAME}):

CONSULTA ORIGINAL DEL CEO: "${pendingExecBridge.originalQuery || ""}"

NOTA DE ${FROM_NAME.toUpperCase()}: "${proseTruncated}"

DOCUMENTO ENTREGADO POR ${FROM_NAME.toUpperCase()} (tipo: ${doc.docType || "documento"} · "${doc.name || "sin nombre"}"):
"""
${doc.content || ""}
"""

ACCIÓN: Convierte este documento y su contexto en acciones operativas. Si procede, propón tareas (revisión, firma, registro), adjunta el documento a la negociación o proyecto relevante, y vincula los pasos siguientes. Si no hay acciones claras, dilo explícitamente.`
      : `Contexto recibido desde El Consejo (${FROM_NAME}):

CONSULTA ORIGINAL DEL CEO: "${pendingExecBridge.originalQuery || ""}"

ANÁLISIS DE ${FROM_NAME.toUpperCase()}: "${proseTruncated}"

ACCIÓN: Convierte este análisis en acciones operativas. Si procede, propón tareas concretas con responsable, fecha estimada y prioridad, y vincula a un proyecto o negociación existente si corresponde. Si no hay acciones claras, dilo explícitamente.`;
    setInputText(prompt);
    setBridgeBanner({
      fromKey: pendingExecBridge.fromKey,
      fromName: FROM_NAME,
      fromEmoji: FROM_EMOJI,
      originalQuery: pendingExecBridge.originalQuery,
      originReply: pendingExecBridge.originReply,
      originDocument: doc || null,
    });
    setShowBridgeDetails(false);
    // Foco al textarea para que el CEO pueda editar o pulsar Enter directo.
    setTimeout(() => { try { textareaRef.current?.focus(); } catch {} }, 50);
    onConsumePendingExecBridge?.();
  }, [pendingExecBridge]); // eslint-disable-line react-hooks/exhaustive-deps

  // Refs para sync Supabase. lastFlushedLengthRef rastrea cuántos
  // mensajes ya se enviaron a Supabase (para el umbral cada-5).
  // Init = chatHistory.length (no 0) para evitar que el persist
  // useEffect haga flush inmediato al montar — pisaría datos de
  // otro dispositivo en Supabase con localStorage stale antes de
  // que la carga async resuelva. Solo flusheamos cambios reales.
  // chatHistoryRef contiene la copia viva para que el cleanup del
  // unmount pueda hacer flush final sin closure stale.
  // hydratedAuthUidRef garantiza que la carga desde Supabase solo
  // corre una vez por authUid (no re-fetch en cada render).
  const lastFlushedLengthRef = useRef(chatHistory.length);
  const chatHistoryRef = useRef(chatHistory);
  useEffect(() => { chatHistoryRef.current = chatHistory; }, [chatHistory]);
  const hydratedAuthUidRef = useRef(null);
  // Timer pendiente del debounce de flush a Supabase. Reemplaza el
  // throttle anterior de cada-5-msgs porque el realtime requiere que
  // los flushes ocurran tras cada mensaje (sin UPDATE en Supabase no
  // hay evento postgres_changes que el otro dispositivo reciba).
  const flushDebounceRef = useRef(null);

  // Carga inicial desde Supabase. Resolución de conflicto por
  // timestamp del último mensaje: el dispositivo con la actividad
  // más reciente gana, independientemente del número de mensajes.
  // Tres caminos:
  //  - remote vacío → mantener localStorage
  //  - remote_last_ts >= local_last_ts → Supabase gana (override)
  //  - local_last_ts > remote_last_ts → local gana (mantener prev);
  //    lastFlushedLengthRef = remote.length para que la próxima
  //    diff con local cuente correctamente y dispare flush.
  useEffect(() => {
    if (!authUid || !supa || hydratedAuthUidRef.current === authUid) return;
    hydratedAuthUidRef.current = authUid;
    (async () => {
      try {
        const { data: row, error } = await supa
          .from("hector_chat")
          .select("messages")
          .eq("user_id", authUid)
          .maybeSingle();
        if (error) {
          console.warn(`[Kluxor] Chat load Supabase error: ${error.message}`);
          return;
        }
        const remote = Array.isArray(row?.messages) ? row.messages : [];
        const local = chatHistoryRef.current || [];
        if (remote.length === 0) {
          // Supabase vacío + local con contenido → bootstrap inmediato.
          // Sin esto, el primer dispositivo nunca propagaba sus msgs
          // hasta acumular 5 nuevos sobre los ya existentes.
          if (local.length > 0) {
            flushChatToSupabase(authUid, local);
            lastFlushedLengthRef.current = local.length;
            console.log(`[Kluxor] Chat Supabase vacío, propagando local: ${local.length} mensajes`);
          } else {
            console.log("[Kluxor] Chat Supabase vacío, usando localStorage");
          }
          return;
        }
        const remoteLastTs = remote[remote.length - 1]?.ts || 0;
        const localLastTs  = local[local.length - 1]?.ts || 0;
        if (remoteLastTs >= localLastTs) {
          setChatHistory(remote.slice(-CHAT_MAX));
          lastFlushedLengthRef.current = remote.length;
          console.log(`[Kluxor] Chat cargado desde Supabase: ${remote.length} mensajes (más reciente)`);
        } else {
          // Local más reciente → propaga YA a Supabase sin esperar a
          // que el CEO escriba 5 mensajes más. Cierra el gap entre el
          // dispositivo con cambios offline y la copia central.
          flushChatToSupabase(authUid, local);
          lastFlushedLengthRef.current = local.length;
          console.log(`[Kluxor] Chat local más reciente, propagando a Supabase: ${local.length} mensajes`);
        }
      } catch (e) {
        console.warn(`[Kluxor] Chat load threw: ${e?.message || e}`);
      }
    })();
  }, [authUid]);

  // Realtime: suscripción a UPDATE en hector_chat filtrado por user_id.
  // Cuando otro dispositivo flushea sus mensajes a Supabase, este canal
  // dispara y aplicamos remote a chatHistory. Guard de eco: si los ts
  // del remote son <= ts local, ignoramos (eco de nuestro propio flush
  // o cambio más antiguo). Filtro server-side por user_id evita recibir
  // eventos de otros usuarios. Requiere que la tabla esté en la
  // publication supabase_realtime (ya habilitado en Supabase).
  // isFirstSubscribeRef distingue la primera suscripción (al montar)
  // de las reconexiones posteriores. iPhone Safari mata el WebSocket
  // cuando el tab pasa a background — al volver, la cadena de status
  // típica es CLOSED → CHANNEL_ERROR → SUBSCRIBED. Durante el corte
  // los eventos UPDATE del otro dispositivo se pierden. Al recuperar
  // SUBSCRIBED (post-primera), refetch puntual a Supabase para
  // alinear el state con lo que haya pasado mientras estábamos fuera.
  const isFirstSubscribeRef = useRef(true);

  useEffect(() => {
    if (!authUid || !supa) return;
    // Refetch one-shot tras reconexión. Misma lógica que el load
    // useEffect pero sin merge de análisis (HectorDirect no genera
    // hector_analysis). Actualiza lastFlushedLengthRef para evitar
    // que el debounce dispare un flush eco hacia Supabase con datos
    // que acabamos de recibir.
    const refetchFromSupabase = async () => {
      try {
        const { data: row, error } = await supa
          .from("hector_chat")
          .select("messages")
          .eq("user_id", authUid)
          .maybeSingle();
        if (error) {
          console.warn(`[Kluxor] Chat refetch error: ${error.message}`);
          return;
        }
        const remote = Array.isArray(row?.messages) ? row.messages : [];
        if (remote.length === 0) return;
        const local = chatHistoryRef.current || [];
        const remoteLastTs = remote[remote.length - 1]?.ts || 0;
        const localLastTs  = local[local.length - 1]?.ts || 0;
        if (remoteLastTs <= localLastTs) return;
        setChatHistory(remote.slice(-CHAT_MAX));
        lastFlushedLengthRef.current = remote.length;
        console.log(`[Kluxor] Chat resync tras reconexión: ${remote.length} mensajes`);
      } catch (e) {
        console.warn(`[Kluxor] Chat refetch threw: ${e?.message || e}`);
      }
    };
    const ch = supa
      .channel("hector-chat-" + authUid)
      .on("postgres_changes", {
        event: "UPDATE",
        schema: "public",
        table: "hector_chat",
        filter: "user_id=eq." + authUid,
      }, (payload) => {
        const remote = payload.new?.messages;
        if (!Array.isArray(remote)) return;
        setChatHistory(prev => {
          const remoteLastTs = remote[remote.length - 1]?.ts || 0;
          const localLastTs  = prev[prev.length - 1]?.ts || 0;
          if (remoteLastTs <= localLastTs) return prev;
          lastFlushedLengthRef.current = remote.length;
          return remote.slice(-CHAT_MAX);
        });
        console.log(`[Kluxor] Chat sync realtime: ${remote.length} mensajes`);
      })
      .subscribe((status) => {
        // Log del status para debugging: SUBSCRIBED = canal vivo;
        // CHANNEL_ERROR = RLS bloqueando o tabla no en publication;
        // TIMED_OUT = server no respondió; CLOSED = desconectado.
        console.log(`[Kluxor] Chat realtime status: ${status}`);
        if (status === "SUBSCRIBED") {
          if (isFirstSubscribeRef.current) {
            // Primera suscripción al montar: el useEffect de carga
            // inicial ya hizo su fetch. Solo marcamos y salimos.
            isFirstSubscribeRef.current = false;
            return;
          }
          // Reconexión (Safari volvió del background, red estable):
          // recupera mensajes que pudieron llegar durante el corte.
          refetchFromSupabase();
        }
      });
    return () => { try { supa.removeChannel(ch); } catch {} };
  }, [authUid]);

  // Persistencia con guard userId (mismo patrón que HectorPanel).
  // localStorage siempre, síncrono. Supabase con debounce 500ms para
  // que el realtime del otro dispositivo reciba el UPDATE en tiempo
  // razonable. Antes era throttle cada-5-msgs y dejaba 4 mensajes
  // sin flushear hasta que la conversación acumulaba — incompatible
  // con realtime. El debounce naturalmente batchea updates rápidos
  // (eco de specialist loading→done dentro de 500ms se condensa en
  // un único flush). El check de length evita flushes inútiles en
  // updates in-place que no cambian la longitud.
  useEffect(() => {
    if (!userId) return;
    try { localStorage.setItem(CHAT_KEY, JSON.stringify(chatHistory.slice(-CHAT_MAX))); } catch {}
    if (!authUid) return;
    flushDebounceRef.current = setTimeout(() => {
      const msgs = chatHistoryRef.current;
      lastFlushedLengthRef.current = msgs.length;
      flushChatToSupabase(authUid, msgs);
      flushDebounceRef.current = null;
    }, 500);
    return () => {
      if (flushDebounceRef.current) {
        clearTimeout(flushDebounceRef.current);
        flushDebounceRef.current = null;
      }
    };
  }, [chatHistory, CHAT_KEY, userId, authUid]);

  // Flush final al desmontar para no dejar mensajes huérfanos entre
  // umbrales de 5. Separado del useEffect anterior porque ahí el
  // cleanup dispararía en cada cambio de chatHistory; aquí solo
  // dispara una vez al desmontar (dependencia estable [authUid]).
  useEffect(() => {
    return () => {
      if (!authUid) return;
      const finalMsgs = chatHistoryRef.current;
      if (Array.isArray(finalMsgs) && finalMsgs.length !== lastFlushedLengthRef.current) {
        flushChatToSupabase(authUid, finalMsgs);
      }
    };
  }, [authUid]);

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
      // Identidad del usuario activo. Resolución encadenada:
      //  1) data.me / data.currentUser si el shape los expusiera
      //  2) data.members.find por userId (camino real en este codebase)
      // Si ninguno resuelve, dejamos el bloque vacío para no alucinar
      // un nombre. Se inyecta AL INICIO del system para que el modelo
      // lo lea antes que cualquier otro contexto.
      const usuarioActivo = (data?.me || data?.currentUser || (data?.members || []).find(m => m && m.id === userId)) || null;
      // GATE DE PRIVACIDAD (incidente fuga de contexto privado del CEO):
      // El bloque hardcodeado con identidad de Antonio y la ceoMemory
      // global SOLO se inyectan si el usuario activo es el dueño de la
      // cuenta (accountRole === "admin"). Para members el LLM recibe un
      // memberBlock mínimo SIN datos sensibles. Modo demo: nunca se
      // considera owner (precaución contra demos públicos).
      const isOwner = isAccountOwner(usuarioActivo, { legacyMode: typeof window !== "undefined" && localStorage.getItem("kluxor.legacyMode") === "1" });
      // memberBlock mínimo — para que Héctor sepa quién es sin filtrar
      // datos privados. Solo si NO es owner y hay usuario activo.
      const memberBlock = (!isOwner && usuarioActivo) ? `USUARIO ACTIVO:
Nombre: ${usuarioActivo.name || "(sin nombre)"}
Rol: miembro del equipo (no es el CEO ni el propietario de la cuenta).

INSTRUCCIONES DE PRIVACIDAD:
- NO eres el asesor del CEO. Eres un asistente del equipo.
- NUNCA reveles datos personales del CEO (nombres propios privados, CIFs, decisiones privadas, preferencias del CEO, contexto de sus negociaciones privadas, finanzas, gobernanza societaria).
- Si el usuario pregunta por algo privado del CEO, responde "no tengo acceso a esa información desde esta cuenta".
- Limítate a ayudarle con los proyectos y tareas a los que el usuario tiene acceso explícito.

---
` : "";
      // ceoBlock dinámico: lee identidad/perfil desde data.ceoProfile
      // (per-tenant) con fallback al literal de Antonio cuando ceoProfile
      // está vacío. Definición e implementación arriba (buildCeoBlock).
      const ceoBlock = (isOwner && usuarioActivo) ? buildCeoBlock(data?.ceoProfile, usuarioActivo) : "";
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

      // Composición final: ceoBlock al INICIO (la identidad del usuario
      // debe leerse antes que cualquier otra cosa), luego promptBase con
      // sus addons, luego PLAIN_TEXT_RULE, y al final los snapshots
      // operativos (miembros, tareas, proyectos, negs, finanzas, gov).
      // Instrucción para listar tareas como bloque estructurado
      // [TASKS_LIST]{json}[/TASKS_LIST]. Scoped solo a HectorDirect
       // (no toca AGENT_ACTIONS_ADDON ni la migración v10). Si Héctor
      // no emite el bloque cuando aplica, fallback natural a prosa.
      const tasksListBlock = `\n\n---\nFORMATO DE LISTA DE TAREAS:
Cuando el CEO te pida LISTAR, MOSTRAR, CONSULTAR o VER tareas (es decir, recuperar información de tareas que YA existen, NO crear nuevas), responde primero con un bloque [TASKS_LIST] y DESPUÉS añade tu prosa breve. Formato exacto:

[TASKS_LIST]
{"vencidas":[{"code":"MAR","title":"Documento sesión Rafael","priority":"alta","due":"YYYY-MM-DD"}],"proximas":[{"code":"BSF","title":"Formación app","priority":"media","due":"YYYY-MM-DD"}]}
[/TASKS_LIST]

Reglas:
- Usa SOLO datos reales del bloque "TAREAS URGENTES O VENCIDAS" que aparece arriba en este system prompt. NUNCA inventes tareas que no estén en ese bloque.
- "vencidas" = dueDate anterior a hoy. "proximas" = dueDate igual o posterior a hoy, o sin fecha.
- Campos por tarea: code (string, código del proyecto entre 2-4 letras), title (string), priority ("alta"|"media"|"baja"), due ("YYYY-MM-DD" o null si no tiene fecha). Omite campos que no conozcas.
- El bloque se OCULTA del chat y se renderiza como tarjeta visual. Tu prosa va DESPUÉS del bloque, máximo 1-2 frases (priorización, contexto o pregunta de seguimiento).
- Si no hay tareas relevantes que listar, NO emitas el bloque — responde solo con prosa.
- Este formato es SOLO para consultas de lectura. Para crear, modificar, asignar o eliminar tareas sigue siendo [ACTIONS] como hasta ahora.`;

      // Memoria permanente del CEO (preferences/keyFacts/decisions/lessons).
      // GATE: solo para el owner. Members reciben memBlock="".
      const memBlock = isOwner ? formatCeoMemoryForPrompt(data?.ceoMemory) : "";
      const memBlockFormatted = memBlock ? "\n\n----\n" + memBlock : "";

      // finBlock y govBlock construidos arriba usan datos privados del
      // CEO (saldos, runway, facturas, empresas del grupo). GATE: solo
      // owner los recibe. Para members, vacíos.
      const finBlockGated = isOwner ? finBlock : "";
      const govBlockGated = isOwner ? govBlock : "";

      // Composición final: ceoBlock SOLO si owner; memberBlock en su
      // lugar si NO owner (siempre uno de los dos vacíos por construcción).
      // stripCeoProfile: AGENT_ACTIONS_ADDON, appendido al promptBase de
      // todos los agentes en la migración v10, contiene un bloque
      // "PERFIL CEO:" hardcodeado con identidad de Antonio (nombre, empresa).
      // Para non-owners, lo eliminamos antes de inyectar al system prompt.
      const hectorPromptBase = isOwner
        ? hector?.promptBase
        : stripCeoProfile(hector?.promptBase);
      const baseSystem = (isOwner ? ceoBlock : memberBlock) + (hectorPromptBase
        ? hectorPromptBase + "\n\n" + PLAIN_TEXT_RULE
        : "Eres Héctor, Jefe de Gabinete estratégico. " + PLAIN_TEXT_RULE)
        + memBlockFormatted
        + membersBlock + urgentBlock + projBlock + negBlock + finBlockGated + govBlockGated + tasksListBlock
        + "\n\n" + HECTOR_SEARCH_RULES
        + "\n\n" + HECTOR_NODATE_RULES;
      // Convertimos el historial a la forma que espera la API.
      // Los mensajes "assistant" llevan el texto limpio (sin proposal).
      // Inyección de fecha actual en el USER prompt (commit 39): el system
      // prompt no la lleva por anti-patrón histórico (commit 54a360b roto
      // [ACTIONS]). Prefijamos el último mensaje del CEO con un meta-bloque
      // [Hoy es ...] para que Héctor razone con la fecha real, no con su
      // cutoff. No afecta a [ACTIONS] porque viene en user, no system.
      const today = new Date();
      const fechaContext = `[Hoy es ${today.toLocaleDateString("es-ES", { weekday: "long", day: "numeric", month: "long", year: "numeric" })} — ${today.toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit" })}]`;
      // Filtramos avisos locales (isLocalNotice: true) — son metadata
      // del sistema (ej. "He registrado una incidencia en Mantenimiento")
      // no parte del diálogo CEO↔Héctor. Enviarlos a Claude pollutearía
      // el contexto Y rompería la alternancia user/assistant exigida
      // por Anthropic (queda assistant→assistant consecutivos).
      const nextForApi = next.filter(m => !m.isLocalNotice);
      const lastIdx = nextForApi.length - 1;
      // Sintético: cuando un turn assistant terminó con content que iría
      // a la API como "(sin texto)" o cadena vacía, mandar eso a Claude
      // pierde contexto y, con varios turns así, induce un bucle (Claude
      // deja de emitir [ACTIONS], emite solo [INVOCAR:], etc.). Sustituimos
      // por contexto derivado del estado del mensaje (proposal/executed/
      // discarded) para que Claude entienda qué pasó en el turn anterior.
      const synthAssistantContent = (m) => {
        if (m.proposal?.summary) return `(Propuesta enviada al CEO: ${m.proposal.summary})`;
        if (m.proposalExecuted)  return `(Acciones ejecutadas en turno anterior)`;
        if (m.proposalDiscarded) return `(Propuesta descartada por el CEO)`;
        if (m.error)             return `(Turno anterior con error)`;
        return `(Respuesta sin contenido textual en turno anterior)`;
      };
      const messages = nextForApi.map((m, idx) => {
        const isLastUser = (idx === lastIdx && m.role === "user");
        if (m.role === "user") {
          const c = m.text || "";
          return { role: "user", content: isLastUser ? fechaContext + "\n" + c : c };
        }
        // Turn ASSISTANT: preferimos replyRaw (con [ACTIONS] incluido) sobre
        // text. Si ambos están vacíos o son "(sin texto)" literal (entradas
        // viejas antes del fix replyRaw, o casos edge), sustituimos por
        // contexto sintético derivado del estado del mensaje.
        let content = m.replyRaw || m.text || "";
        const stripped = (content || "").trim();
        if (!stripped || stripped === "(sin texto)") {
          content = synthAssistantContent(m);
        }
        // Capa A — marcador post-ejecución. Sin esta señal, Héctor ve su
        // [ACTIONS] previo en replyRaw pero no sabe si el CEO lo aceptó.
        // El addon prohíbe lenguaje confirmatorio sin [ACTIONS] en el
        // turno actual, así que cae en propositivo futuro ("¿creo X?")
        // sobre entidades que ya existen → banner falso positivo.
        if (m.proposalExecuted === true) {
          content = content + "\n\n[SISTEMA — turno anterior] Las acciones del bloque [ACTIONS] precedente fueron ACEPTADAS y EJECUTADAS por el CEO. Las entidades creadas (proyectos, tareas, negociaciones, movimientos) ya existen en la BD. Si el CEO se refiere a ellas en este turno, son entidades reales, no propuestas pendientes.";
        }
        return { role: "assistant", content };
      });
      // Anti-truncado (replica el patrón validado de buildCouncilDirect en
      // App.jsx). Antes: max_tokens 4096 sin detección de truncado → un
      // [ACTIONS] grande (fichas extensas) se cortaba antes del [/ACTIONS],
      // el parser no matcheaba y el JSON quedaba visible en el chat.
      // Cambios:
      //   - max_tokens: 4096 → 8000 (mismo techo que Consejo). Cubre fichas
      //     médicas / pactos / asientos contables completos sin red.
      //   - includeMeta: leemos stop_reason para detectar truncado real.
      //   - Continuación automática (1 retry máx): si la primera llamada
      //     vuelve con stop_reason="max_tokens", encadenamos {assistant: parcial,
      //     user: "Continúa…"}. La instrucción de continuación varía si
      //     estábamos dentro de un bloque [ACTIONS] abierto (no abrir otro)
      //     o de [TASKS_LIST] o de prosa libre. Concatenamos al texto.
      const MAX_TOKENS_PER_CALL = 8000;
      // timeoutMs 180s: Sonnet 4.5 a ~60-80 tok/s puede tardar 100-140s en
      // producir 8000 tokens. Antes 90s mataba la primera llamada antes de
      // que el modelo terminara, abortando el turno entero (la continuación
      // no se llegaba a disparar porque no había stop_reason que leer).
      // Alineado con api/agent.js maxDuration:180. Mantenemos
      // includeMeta:true para que la continuación automática siga siendo
      // red de seguridad si Sonnet emite [ACTIONS] sin cerrar.
      // tools: [HECTOR_SEARCH_TOOL] activa web_search (max_uses:1) para que
      // Héctor consulte vuelos/horarios/ubicaciones/precios actuales/normativa
      // vigente. Las reglas en HECTOR_SEARCH_RULES (system) acotan disparadores
      // y prohíben búsqueda dentro de [ACTIONS]. api/agent.js descarta los
      // tool_use blocks y concatena solo type:"text" — el reply final que llega
      // a parseAgentActions sigue siendo lineal, [ACTIONS] intacto.
      const callOnce = (msgs) => callAgentSafe(
        { system: baseSystem, messages: msgs, max_tokens: MAX_TOKENS_PER_CALL, tools: [HECTOR_SEARCH_TOOL] },
        { timeoutMs: 180000, includeMeta: true }
      );
      const first = await callOnce(messages);
      let reply = (first?.text || "");
      let finalStopReason = first?.stop_reason || null;
      // Acumulador de citaciones a lo largo de send + continuación
      // (max_tokens). Se renderizan al pie del bubble como footer
      // "🔍 N fuentes consultadas". Dedup por URL.
      const _seenUrls = new Set();
      const _finalCitations = [];
      const _absorb = (cs) => {
        if (!Array.isArray(cs)) return;
        for (const c of cs) {
          if (!c || typeof c.url !== "string") continue;
          if (_seenUrls.has(c.url)) continue;
          _seenUrls.add(c.url);
          _finalCitations.push(c);
        }
      };
      _absorb(first?.citations);
      console.log(`[Héctor] tool_use · citations: ${_finalCitations.length} · stop_reason: ${finalStopReason}`);
      if (finalStopReason === "max_tokens" && reply.trim()) {
        console.warn(`✂️ [HectorDirect] respuesta truncada (max_tokens, ${reply.length} chars) — intentando continuación…`);
        const aOpens   = (reply.match(/\[ACTIONS\]/gi) || []).length;
        const aCloses  = (reply.match(/\[\/ACTIONS\]/gi) || []).length;
        const tOpens   = (reply.match(/\[TASKS_LIST\]/gi) || []).length;
        const tCloses  = (reply.match(/\[\/TASKS_LIST\]/gi) || []).length;
        const inActions = aOpens > aCloses;
        const inTasks   = tOpens > tCloses;
        const continueInstruction = inActions
          ? "Continúa exactamente donde quedaste DENTRO del bloque [ACTIONS] abierto, sin repetir nada de lo anterior. NO abras un nuevo [ACTIONS]. Cuando termines el JSON, cierra con [/ACTIONS] en línea aparte. No añadas prosa después del cierre."
          : inTasks
          ? "Continúa exactamente donde quedaste DENTRO del bloque [TASKS_LIST] abierto, sin repetir nada de lo anterior. NO abras un nuevo [TASKS_LIST]. Cuando termines el JSON, cierra con [/TASKS_LIST] en línea aparte."
          : "Continúa exactamente donde quedaste, sin repetir nada de lo anterior. Mantén el formato y la estructura. No introduzcas, ve directo al siguiente carácter.";
        try {
          const continuationMsgs = [
            ...messages,
            { role: "assistant", content: reply },
            { role: "user", content: continueInstruction },
          ];
          const second = await callOnce(continuationMsgs);
          const tail = String(second?.text || "").trim();
          _absorb(second?.citations);
          if (tail) {
            const joiner = reply.endsWith("\n") ? "" : "\n";
            reply = reply + joiner + tail;
            finalStopReason = second?.stop_reason || null;
            console.log(`✂️ [HectorDirect] continuación OK · +${tail.length} chars (total ${reply.length}) · stop_reason: ${finalStopReason} · citations totales: ${_finalCitations.length}`);
          } else {
            console.warn(`✂️ [HectorDirect] continuación vacía — entregamos parcial sin concatenar`);
          }
        } catch (e) {
          console.warn(`✂️ [HectorDirect] fallo en continuación:`, e?.message);
        }
      }
      // Failsafe (c): si tras la continuación SIGUE habiendo [ACTIONS] abierto
      // sin cerrar (o [TASKS_LIST]) Y la última llamada terminó por max_tokens,
      // ocultamos el bloque truncado del chat (no dejamos JSON crudo a la vista)
      // y añadimos un aviso visible para que el CEO pida continuación manual.
      const aOpensF  = (reply.match(/\[ACTIONS\]/gi) || []).length;
      const aClosesF = (reply.match(/\[\/ACTIONS\]/gi) || []).length;
      const tOpensF  = (reply.match(/\[TASKS_LIST\]/gi) || []).length;
      const tClosesF = (reply.match(/\[\/TASKS_LIST\]/gi) || []).length;
      const stillOpenActions = aOpensF > aClosesF;
      const stillOpenTasks   = tOpensF > tClosesF;
      if ((stillOpenActions || stillOpenTasks) && finalStopReason === "max_tokens") {
        const which = stillOpenActions ? "ACTIONS" : "TASKS_LIST";
        const cutRe = stillOpenActions ? /\[ACTIONS\][\s\S]*$/ : /\[TASKS_LIST\][\s\S]*$/;
        console.warn(`✂️ [HectorDirect] failsafe — bloque [${which}] truncado tras continuación, ocultando JSON crudo`);
        reply = reply.replace(cutRe, "").trimEnd() + "\n\n⚠ Propuesta truncada — pídeme que continúe.";
      }
      console.log('[BUG_SINTEXTO] reply:', JSON.stringify(reply).slice(0, 1000));
      const sanitizedReply = reply.replace(/"(?:[^"\\]|\\.)*"/g, m =>
        m.replace(/[\n\r\t]/g, c => ({ "\n":"\\n", "\r":"\\r", "\t":"\\t" }[c]))
      );
      const proposal = parseAgentActions(sanitizedReply);
      console.log('[BUG_SINTEXTO] proposal:', proposal);
      // Validación post-LLM de fechas (date-validation-postllm-v1).
      // Sonnet 4.5 con cutoff enero 2025 emite años pasados al razonar
      // fechas relativas. correctActionsDates muta proposal in-place
      // SOLO sobre task.dueDate de create_tasks y create_project. Nada
      // que ver con .date contables — esos quedan intactos. La función
      // logea en consola cada corrección y marca task._dateFixed=true
      // para que ActionProposal pueda mostrar un indicador sutil.
      correctActionsDates(proposal);
      // Reescritura propositiva del summary (propositive-summary-v1).
      // Cuando Héctor emite "Tarea X creada en Y" en proposal.summary,
      // el CEO puede leer "creada" como confirmación de ejecución
      // cuando aún es solo una propuesta pendiente. La reescritura es
      // invisible para la UI: el wording final queda natural y
      // propositivo ("a crear"). Sin afectar títulos individuales de
      // tareas (van en proposal.actions[].tasks[].title) ni prosa libre.
      let propositiveIncident = null;
      let fabricatedRemoved = [];
      if (proposal && proposal.summary && proposal.confirmRequired !== false) {
        const r = rewriteToPropositive(proposal.summary);
        if (r.wasFixed) {
          console.log(`✏️ [agentActions] Resumen reescrito a propositivo: '${r.original}' → '${r.rewritten}'`);
          proposal.summary = r.rewritten;
          propositiveIncident = { where: "summary", original: r.original, rewritten: r.rewritten };
        }
      }
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
      // Parser de [TASKS_LIST]…[/TASKS_LIST]: bloque estructurado para
      // consultas de tareas que ya existen. Convive con [ACTIONS] (que
      // sigue siendo para crear/modificar). Si Héctor no emite el
      // bloque cuando aplica, fallback natural: la prosa se renderiza
      // como texto plano sin TaskListCard.
      const tasksListRaw = parseTasksList(reply);
      // Validación post-LLM contra BD (task-validation-postllm-v1).
      // Sonnet 4.5 inventa tareas plausibles cuando ve poco material;
      // aquí cruzamos con la realidad. Dos modos:
      //   - BD-driven: si el CEO mencionó un código de proyecto en su
      //     mensaje, ignoramos lo emitido por Héctor y mostramos TODAS
      //     las tareas reales de ese proyecto desde data.boards.
      //   - Validated: consulta global → filtramos cada emitida que no
      //     exista en BD (matching laxo por título contained-in).
      // En ambos modos, marcamos _filteredFromLLM para que TaskListCard
      // muestre el indicador "ℹ Mostrando solo tareas verificadas en
      // el sistema." debajo de la card.
      let tasksList = tasksListRaw;
      if (tasksList) {
        const projectCodeFilter = detectProjectCodeFilter(txt, data?.projects);
        const allRealTasks = flattenRealTasks(data);
        const todayIso = new Intl.DateTimeFormat("en-CA", {
          timeZone: "Europe/Madrid",
          year: "numeric", month: "2-digit", day: "2-digit",
        }).format(new Date());
        if (projectCodeFilter) {
          // BD-driven: la verdad es la BD, no Héctor.
          const realInProject = allRealTasks.filter(t => t.projectCode === projectCodeFilter);
          const emittedTotal = (tasksList.vencidas?.length || 0) + (tasksList.proximas?.length || 0);
          console.warn(`🔍 [agentActions] Consulta filtrada por proyecto ${projectCodeFilter}: mostrando ${realInProject.length} tareas reales de BD (Héctor emitió ${emittedTotal}, ignoradas)`);
          if (realInProject.length === 0) {
            tasksList = null;
          } else {
            const vencidas = [];
            const proximas = [];
            realInProject.forEach(t => {
              const item = {
                code: t.projectCode,
                title: t.title || "(sin título)",
                priority: t.priority || "media",
                due: t.dueDate || null,
              };
              if (t.dueDate && t.dueDate < todayIso) vencidas.push(item);
              else proximas.push(item);
            });
            tasksList = {
              vencidas,
              proximas,
              total: realInProject.length,
              _filteredFromLLM: true,
            };
          }
        } else {
          // Validated: consulta global. Filtramos emitidas contra BD
          // por separado en cada array para preservar la clasificación
          // que Héctor ya hizo (vencidas vs próximas).
          const venR = validateTasksAgainstDatabase(tasksList.vencidas, allRealTasks, null);
          const proR = validateTasksAgainstDatabase(tasksList.proximas, allRealTasks, null);
          const totalRemoved = venR.removedCount + proR.removedCount;
          if (totalRemoved > 0) {
            console.warn(`🔍 [agentActions] Filtradas ${totalRemoved} tareas inventadas por Héctor (no existen en BD)`);
            [...venR.removed, ...proR.removed].forEach(r =>
              console.warn(`  - removed: '${r?.title || "(sin título)"}'`)
            );
            fabricatedRemoved = [...venR.removed, ...proR.removed].map(r => ({
              title: r?.title || "(sin título)",
              code: r?.code || null,
            }));
          }
          const totalValid = venR.validated.length + proR.validated.length;
          if (totalValid === 0) {
            // Todas inventadas → omitimos card. La prosa de Héctor queda
            // intacta para que el CEO vea su contexto.
            tasksList = null;
          } else {
            tasksList = {
              vencidas: venR.validated,
              proximas: proR.validated,
              total: totalValid,
              _filteredFromLLM: totalRemoved > 0,
            };
          }
        }
      }
      // Limpiamos [ACTIONS] (si hay proposal), [TASKS_LIST] y SIEMPRE
      // [INVOCAR:]. Las tres familias de marker se ocultan del chat.
      const stripInvokes = (s) => String(s || "")
        .replace(/\[INVOCAR:[^\]]+\]/gi, "")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
      const afterActions = proposal ? cleanAgentResponse(reply) : reply;
      const afterTasks   = cleanTasksListBlock(afterActions);
      let   cleanText    = stripInvokes(afterTasks);
      // Reescritura propositiva extendida (propositive-prose-v1):
      // si la prosa narrativa de Héctor precede a un ActionProposal,
      // aplicamos la misma reescritura que ya hacemos al summary.
      // Cubre el caso "Tres tareas creadas en PCH" donde Héctor genera
      // prosa con verbos en participio antes de la card. Condición
      // estricta: solo si proposal.actions existe y no está vacío.
      // Prosa libre conversacional (sin actions) queda intacta — esa
      // es la frontera dura de seguridad que evita falsos positivos.
      if (proposal && Array.isArray(proposal.actions) && proposal.actions.length > 0 && proposal.confirmRequired !== false) {
        const r = rewriteToPropositive(cleanText);
        if (r.wasFixed) {
          console.log(`✏️ [agentActions] Prosa reescrita (precede ActionProposal): '${r.original}' → '${r.rewritten}'`);
          cleanText = r.rewritten;
          if (!propositiveIncident) {
            propositiveIncident = { where: "prose", original: r.original, rewritten: r.rewritten };
          }
        }
      }
      // Detección anti-alucinación (Capa 2 del blindaje anti-fake-success):
      // si la prosa de Héctor afirma éxito y NO viene acompañada de un
      // bloque [ACTIONS] válido, marcamos el mensaje. Importante: si la
      // respuesta es una CONSULTA con [TASKS_LIST], NO la consideramos
      // afirmación de éxito aunque la prosa contenga verbos como
      // "actualizado" — es lectura, no ejecución.
      console.log('[BUG_SINTEXTO] cleanText final:', cleanText);
      const fakeSuccess = !tasksList && detectFalseSuccessClaim(cleanText, proposal);
      // Fase 1 mantenimiento — fire-and-forget de incidentes a hector_tickets.
      // Agrega los 4 tipos cazados por los detectores post-LLM y los inserta
      // en Supabase. Sin await: no debe bloquear la UI ni el flujo de chat.
      try {
        const incidents = [];
        if (fakeSuccess) {
          incidents.push({ type: "false-success", text: (cleanText || "").slice(0, 500) });
        }
        if (proposal && Array.isArray(proposal.actions)) {
          const fixedTasks = [];
          proposal.actions.forEach(a => {
            if (Array.isArray(a?.tasks)) {
              a.tasks.forEach(t => {
                if (t && t._dateFixed) fixedTasks.push({ title: t.title || null, dueDate: t.dueDate || null });
              });
            }
          });
          if (fixedTasks.length > 0) incidents.push({ type: "stale-date-fix", tasks: fixedTasks });
        }
        if (propositiveIncident) {
          incidents.push({ type: "non-propositive-summary", ...propositiveIncident });
        }
        if (fabricatedRemoved.length > 0) {
          incidents.push({ type: "fabricated-tasks", removed: fabricatedRemoved });
        }
        if (incidents.length > 0 && supa) {
          collectHectorFailures({
            supabase: supa,
            agent: "hector_direct",
            userMessage: (txt || "").slice(0, 2000),
            agentResponse: (reply || "").slice(0, 4000),
            incidents,
          }).then((result) => {
            // Si el ticket se insertó realmente en hector_tickets, añadimos
            // un aviso al chat para que el CEO sepa que la incidencia quedó
            // registrada y puede revisarla en Mantenimiento. isLocalNotice
            // marca el mensaje para que no se envíe a Claude como contexto
            // de turn (es metadata interna del sistema, no parte del diálogo).
            if (result?.inserted) {
              setChatHistory(prev => [...prev, {
                role: "assistant",
                text: "He registrado una incidencia en Mantenimiento. Puedes verla y copiar el prompt de diagnóstico desde ahí.",
                isLocalNotice: true,
                ts: Date.now(),
              }].slice(-CHAT_MAX));
            }
          }).catch(() => { /* el insert ya logea su error internamente */ });
        }
      } catch (e) {
        console.warn("[collectHectorFailures] gather error:", e?.message);
      }
      setChatHistory(prev => [...prev, {
        role: "assistant",
        text: cleanText || "(sin texto)",
        // Reply raw (con [ACTIONS] incluido si lo había) — se conserva
        // para que cuando se reenvíe el historial a Claude en el siguiente
        // turn, Claude vea su propia respuesta original con todo el contexto
        // (no solo cleanText, que puede haber quedado vacío tras strippear
        // [ACTIONS]/[TASKS_LIST]/[INVOCAR:]). Sin esto, varios turns con
        // cleanText vacío → Claude pierde contexto, deja de emitir
        // [ACTIONS] y se entra en un bucle de "(sin texto)".
        replyRaw: reply,
        proposal: proposal || null,
        tasksList: tasksList || null,
        // citations: fuentes consultadas por web_search (acumuladas de
        // send + continuación, dedup por URL). ChatBubble las renderiza
        // como footer "🔍 N fuentes consultadas" si length>0. Paridad
        // con GobernanzaView (Gonzalo Normativa Viva).
        citations: _finalCitations.length > 0 ? _finalCitations : null,
        fakeSuccess,
        ts: Date.now(),
      }].slice(-CHAT_MAX));

      // Detección de decisión del CEO (commit 6 — CEOMemoryList).
      // Heurística regex sobre cleanText. Si matchea, INSERT directo a
      // la tabla ceo_memory con detected_from = mensaje original del CEO.
      // Sin dedup, sin notificación al CEO (silencioso), solo log
      // consola. Fire-and-forget: un fallo de red no debe interrumpir
      // el flujo principal. authUid se obtiene en este punto via
      // supa.auth.getSession() para no requerir nuevos props.
      try {
        const detection = detectCEODecision(cleanText);
        if (detection.isDecision) {
          (async () => {
            try {
              if (!supa) {
                console.log(`🧠 [CEOMemory] Decisión detectada (${detection.status}) pero sin Supabase: "${detection.text}"`);
                return;
              }
              const { data: sessionData } = await supa.auth.getSession();
              const sessionUid = sessionData?.session?.user?.id || null;
              if (!sessionUid) {
                console.log(`🧠 [CEOMemory] Decisión detectada (${detection.status}) pero sin sesión auth: "${detection.text}"`);
                return;
              }
              const { error } = await supa.from("ceo_memory").insert({
                user_id: sessionUid,
                decision_text: detection.text,
                status: detection.status,
                detected_from: (txt || "").slice(0, 200),
              });
              if (error) {
                console.warn(`🧠 [CEOMemory] insert error: ${error.message}`);
              } else {
                console.log(`🧠 [CEOMemory] Decisión detectada (${detection.status}): "${detection.text}"`);
              }
            } catch (e) {
              console.warn("🧠 [CEOMemory] insert exception:", e?.message);
            }
          })();
        }
      } catch (e) {
        console.warn("🧠 [CEOMemory] detection error:", e?.message);
      }

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
          // Propagamos ceoBlock también al especialista para que Mario
          // redacte contratos con Antonio Díaz como parte principal,
          // Jorge prepare informes para él, etc. Sin esto cada agente
          // podía coger al primer miembro como "parte" del documento.
          // memBlockFormatted del scope superior — el especialista también
          // conoce preferencias/decisiones/lecciones del CEO para
          // alinearse con criterios ya establecidos (mismo bloque que Héctor).
          // GATE de privacidad: si NO es owner, el specialist recibe
          // memberBlock + cero memoria (heredamos las variables ya
          // computadas en el scope superior por el send principal).
          const agPromptBase = isOwner ? ag.promptBase : stripCeoProfile(ag.promptBase);
          // Override identidad CEO para tenants nuevos cuando Héctor invoca
          // a Mario/Jorge/Álvaro/Gonzalo/Diego (defensivo: vacío para Antonio).
          const specCtx = buildSpecialistContext(data?.ceoProfile);
          const sys = (specCtx ? `${specCtx}\n\n` : "")
            + (isOwner ? ceoBlock : memberBlock)
            + (agPromptBase || `Eres ${meta.label}, especialista invocado por Héctor.`) + "\n\n" + PLAIN_TEXT_RULE + memBlockFormatted;
          const taskLow = inv.task.toLowerCase();
          // Todos los specialists obtienen 180s (subido desde 90s). Mismo
          // criterio que el send principal: respuestas largas con
          // max_tokens=8000 pueden necesitar 100-140s en Sonnet 4.5 y antes
          // se mataban antes de terminar. Alineado con api/agent.js
          // maxDuration:180. Mantengo la variable isRedaccion por si quiero
          // diferenciar microcopy más adelante.
          const isRedaccion = inv.key === "mario" && REDACCION_KEYS.some(k => taskLow.includes(k));
          const timeoutMs = 180000;
          const userPrompt = `TAREA QUE TE ENCARGA HÉCTOR (Jefe de Gabinete):\n${inv.task}\n\nResponde con la información concreta que pide. Sin disclaimers extensos. Frases claras y accionables.`;
          // Anti-truncado (mismo patrón que el send principal). Las
          // invocaciones a especialistas pueden producir respuestas largas
          // (Mario redactando contrato, Jorge tablas financieras). Sube a
          // 8000, detecta stop_reason="max_tokens" y encadena 1 retry.
          const SPEC_MAX_TOKENS = 8000;
          const specBaseMsgs = [{ role: "user", content: userPrompt }];
          const specOnce = (msgs) => callAgentSafe(
            { system: sys, messages: msgs, max_tokens: SPEC_MAX_TOKENS },
            { timeoutMs, includeMeta: true }
          );
          const specFirst = await specOnce(specBaseMsgs);
          let respuesta = (specFirst?.text || "");
          let specStop = specFirst?.stop_reason || null;
          if (specStop === "max_tokens" && respuesta.trim()) {
            console.warn(`✂️ [HectorDirect·${meta.label}] respuesta truncada (max_tokens, ${respuesta.length} chars) — continuación…`);
            try {
              const specSecond = await specOnce([
                ...specBaseMsgs,
                { role: "assistant", content: respuesta },
                { role: "user", content: "Continúa exactamente donde quedaste, sin repetir nada de lo anterior. Mantén el formato. Ve directo al siguiente carácter." },
              ]);
              const tail = String(specSecond?.text || "").trim();
              if (tail) {
                const joiner = respuesta.endsWith("\n") ? "" : "\n";
                respuesta = respuesta + joiner + tail;
                specStop = specSecond?.stop_reason || null;
                console.log(`✂️ [HectorDirect·${meta.label}] continuación OK · +${tail.length} chars (total ${respuesta.length})`);
                if (specStop === "max_tokens") {
                  respuesta += "\n\n⚠ Respuesta truncada — pídeme que continúe.";
                }
              }
            } catch (e2c) {
              console.warn(`✂️ [HectorDirect·${meta.label}] fallo en continuación:`, e2c?.message);
              respuesta += "\n\n⚠ Respuesta truncada — pídeme que continúe.";
            }
          }
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
      // Si fue un timeout (mensaje empieza con ⏱️ desde callAgentSafe),
      // añadimos sugerencia específica de Héctor: chats muy largos saturan
      // el contexto y aumentan la latencia — abrir uno nuevo es la salida
      // limpia. Mantenemos el mensaje original (que ya indica el límite real).
      const isTimeout = (e?.message || "").startsWith("⏱️");
      const baseMsg = e?.message || "Error consultando a Héctor";
      const suffix = isTimeout
        ? " Si la conversación es muy larga, abre un chat nuevo para resetear el contexto y vuelve a preguntar."
        : "";
      setChatHistory(prev => [...prev, {
        role: "assistant",
        text: `⚠ ${baseMsg}${suffix}`,
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
    <div data-hd="root" style={rootStyle}>
      <style>{`
        @keyframes hd-pulse {
          0%, 100% { opacity: 0.3; transform: scale(0.8); }
          50%      { opacity: 1;   transform: scale(1); }
        }
        /* Placeholder del textarea: gris claro Kluxor para no competir
           con el texto real pero seguir siendo legible. */
        [data-hd="root"] textarea::placeholder { color: #9B9B9B; }
        /* Focus ring: borde 1px oro al enfocar. Equivale al :focus
           del spec sin recurrir a outline nativo del navegador. */
        [data-hd="root"] textarea:focus { border-color: #C9A84C !important; border-width: 1px !important; }
        /* Mobile: el mic pasa a FAB position:fixed encima del bottom
           nav. Sombra dorada sutil para enmarcar sobre el fondo claro. */
        @media (max-width: 768px) {
          [data-hd="mic-btn"] {
            position: fixed !important;
            bottom: calc(72px + env(safe-area-inset-bottom)) !important;
            right: 16px !important;
            z-index: 1100;
            box-shadow: 0 4px 12px rgba(201, 168, 76, 0.35);
          }
        }
      `}</style>

      {/* ZONA 1 — HEADER */}
      <div style={headerStyle}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, minWidth: 0 }}>
          <AgentAvatar agent="hector" size={40} />
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
        <div style={{ fontSize: 12, color: C.textTertiary, fontWeight: 500 }}>Jefe de Gabinete</div>
      </div>

      {/* ZONA 1b — LINK SALA DE MANDO. Acceso discreto al panel completo
          (HectorPanel) para quien quiera el modo "centro de control" con
          tabs, urgentes, especialistas, etc. Compartem historial via
          localStorage, así que volver allí no pierde el contexto. */}
      {onNavigate && (
        <div style={{ textAlign: "right", padding: "4px 20px 6px", borderBottom: `0.5px solid ${C.borderTertiary}`, flexShrink: 0, background: C.bgPrimary }}>
          <span
            onClick={() => onNavigate("command")}
            onMouseEnter={e => e.currentTarget.style.color = C.brandHover}
            onMouseLeave={e => e.currentTarget.style.color = C.brand}
            style={{ fontSize: 12, color: C.brand, cursor: "pointer", textDecoration: "underline" }}
          >
            Ver Sala de Mando →
          </span>
        </div>
      )}

      {/* ZONA 1c — BANNER PUENTE DESDE EL CONSEJO. Aparece tras pulsar
          "Accionar con Héctor" en un chat de especialista. El input ya
          viene precargado con la instrucción + contexto; el CEO revisa,
          edita si quiere, y pulsa Enviar. Se descarta manualmente o tras
          enviar. */}
      {bridgeBanner && (
        <div style={{ background: "#FFFBEB", borderBottom: "1px solid #C9A84C", padding: "12px 20px", flexShrink: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
            <span style={{ fontSize: 14 }}>🧙</span>
            <span style={{ fontSize: 13, fontWeight: 700, color: "#8B6914" }}>
              Contexto cargado desde El Consejo · {bridgeBanner.fromEmoji} {bridgeBanner.fromName}
            </span>
            <button
              onClick={() => { setBridgeBanner(null); setInputText(""); }}
              title="Descartar contexto"
              style={{ marginLeft: "auto", background: "transparent", border: "none", color: "#8B6914", fontSize: 16, cursor: "pointer", padding: 0, fontFamily: "inherit" }}
            >×</button>
          </div>
          <div style={{ fontSize: 12, color: "#78350F", marginBottom: 6, lineHeight: 1.4 }}>
            {bridgeBanner.originDocument
              ? <>El input lleva la consulta original, una nota de {bridgeBanner.fromName} y el <strong>documento "{bridgeBanner.originDocument.name}" íntegro</strong>. Revisa y pulsa Enviar.</>
              : <>El input lleva ya la consulta original del CEO y el análisis de {bridgeBanner.fromName}. Revisa, edita si quieres, y pulsa Enviar.</>}
          </div>
          <button
            onClick={() => setShowBridgeDetails(v => !v)}
            style={{ background: "transparent", border: "none", color: "#B45309", fontSize: 11, cursor: "pointer", padding: 0, fontFamily: "inherit", fontWeight: 600 }}
          >
            {showBridgeDetails ? "▾ Ocultar contexto" : "▸ Mostrar contexto"}
          </button>
          {showBridgeDetails && (
            <div style={{ marginTop: 8, fontSize: 12, color: "#451A03", background: "#FEF3C7", border: "0.5px solid #FCD34D", padding: "10px 12px", display: "flex", flexDirection: "column", gap: 8 }}>
              <div>
                <div style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.08em", color: "#92400E", marginBottom: 3 }}>Pregunta original del CEO</div>
                <div style={{ whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{bridgeBanner.originalQuery || "(sin pregunta original)"}</div>
              </div>
              <div>
                <div style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.08em", color: "#92400E", marginBottom: 3 }}>Análisis de {bridgeBanner.fromName}</div>
                <div style={{ whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{bridgeBanner.originReply || "(sin respuesta)"}</div>
              </div>
              {bridgeBanner.originDocument && (
                <div>
                  <div style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.08em", color: "#92400E", marginBottom: 3 }}>
                    Documento adjunto · {bridgeBanner.originDocument.docType || "documento"} · {bridgeBanner.originDocument.name}
                  </div>
                  <div style={{ whiteSpace: "pre-wrap", wordBreak: "break-word", maxHeight: 200, overflowY: "auto", padding: 8, background: "#fff", border: "0.5px solid #FCD34D" }}>{bridgeBanner.originDocument.content || "(vacío)"}</div>
                </div>
              )}
            </div>
          )}
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
              if (m.tasksList && (m.tasksList.vencidas?.length || m.tasksList.proximas?.length)) return true;
              return false;
            }
            if (m.role === "specialist") return true;
            return false;
          })
          .map(({ m, i }) => (
            m.role === "specialist"
              ? <SpecialistBubble key={i} message={m} data={data} onRunAgentActions={onRunAgentActions} onSaveCouncilDocument={onSaveCouncilDocument}/>
              : <ChatBubble
                  key={i}
                  message={{ ...m, text: stripSystemMarker(m.text) }}
                  userInitials={userInitials}
                  onRunAgentActions={onRunAgentActions}
                  onDiscardProposal={() => setChatHistory(prev => prev.map((x, idx) => idx === i ? { ...x, proposal: null, proposalDiscarded: true } : x))}
                  onConfirmProposal={(executedActions) => setChatHistory(prev => prev.map((x, idx) => idx === i ? { ...x, proposal: null, proposalExecuted: true, executedAt: Date.now(), executedActions } : x))}
                  renderTaskList={(tasksList) => <TaskListCard tasksList={tasksList} />}
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
          {/* Icono micrófono SVG inline. Stroke blanco sobre fondo oro
              para look limpio en tema operacional claro. */}
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#FFFFFF" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
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
            onMouseEnter={e => { e.currentTarget.style.background = C.brandHover; }}
            onMouseLeave={e => { e.currentTarget.style.background = C.brand; }}
            style={{ ...sendButtonStyle, opacity: isLoading ? 0.6 : 1, cursor: isLoading ? "wait" : "pointer" }}
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#FFFFFF" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
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
// MessageBubble se mudó a Shared/ChatBubble.jsx (commit 37) para que
// HectorDirect y HectorPanel compartan exactamente el mismo render.

function SpecialistBubble({ message, data, onRunAgentActions, onSaveCouncilDocument }) {
  const meta = SPECIALIST_META[message.specialistKey] || { label: "Especialista", emoji: "🤖", color: "#6B7280" };
  // Estado UI local de la burbuja: qué picker mostramos y qué feedback
  // inline tras una acción completada. Se desmonta con la propia burbuja
  // si el chat se limpia, así que no necesita persistencia.
  const [picker, setPicker] = useState(null);    // "task" | "neg" | null
  const [feedback, setFeedback] = useState("");
  // Query del buscador inline de los pickers. Una sola pieza de state
  // porque solo hay un picker abierto a la vez. Se resetea al cambiar
  // (abrir/cerrar) para que cada apertura arranque limpia.
  const [query, setQuery] = useState("");
  useEffect(() => { setQuery(""); }, [picker]);
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

  // Helper común: abrir una ventana nueva, escribir el HTML, esperar a
  // onload y luego imprimir. El iframe oculto que usamos antes salía en
  // blanco en Safari iOS porque el print() se disparaba antes de que
  // contentDocument terminara de pintar el contenido. window.open con
  // espera explícita a onload soluciona el problema. Si Safari bloquea
  // el popup (gesto no reconocido como "user activation"), caemos a
  // descarga .html para que el CEO la abra manualmente desde el archivo.
  const imprimirHTML = (html, fileName) => {
    let ventana = null;
    try { ventana = window.open("", "_blank"); } catch {}
    if (!ventana) {
      // Fallback: descarga .html. El CEO puede abrirla desde Archivos
      // y el menú "Compartir › Imprimir" o el navegador la renderiza.
      try {
        const blob = new Blob([html], { type: "text/html" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = fileName + ".html";
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 2000);
        flash(`✓ ${fileName}.html descargado — ábrelo para imprimir`);
      } catch {
        flash("⚠ No pude generar el documento");
      }
      return;
    }
    ventana.document.write(html);
    ventana.document.close();
    let printed = false;
    const triggerPrint = () => {
      if (printed) return;
      printed = true;
      try { ventana.focus(); ventana.print(); } catch {}
      // Cerrar tras imprimir (no todos los navegadores soportan
      // onafterprint, así que también ponemos un cierre con margen).
      try { ventana.onafterprint = () => { try { ventana.close(); } catch {} }; } catch {}
    };
    // Camino normal: esperar a onload (Safari iOS necesita esto para
    // que el contenido renderice antes de imprimir).
    try { ventana.onload = triggerPrint; } catch {}
    // Fallback: si onload no dispara en 2s (algunos navegadores ya
    // disparan antes del handler porque document.close() es síncrono),
    // forzamos el print con un timeout. triggerPrint es idempotente.
    setTimeout(() => {
      if (!ventana.closed) triggerPrint();
    }, 2000);
    flash(`✓ ${fileName} abierto para imprimir/guardar`);
  };

  // Escape minimal para HTML — interpolamos message.text dentro de
  // <div class="content"> que respeta saltos de línea con white-space.
  // Sin esto, una respuesta del modelo con etiquetas literales <script>
  // ejecutaría código en el iframe.
  const escHTML = (s) => String(s || "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");

  // Mapa de nombres "humanos" para el header del informe — distintos
  // de meta.label en algún caso (ej. "Diego Financiero" vs "Diego
  // Finanzas Op."). Los pide así el spec del CEO.
  const AGENT_PRINT_NAME = {
    mario:   "Mario Legal",
    jorge:   "Jorge Analista",
    alvaro:  "Álvaro Inmobiliario",
    gonzalo: "Gonzalo Gobernanza",
    diego:   "Diego Financiero",
  };

  // Modo 1 — Informe ejecutivo. Tipografía Georgia, header con franja
  // morada (#534AB7 = brand Kluxor), prosa preservada con
  // white-space: pre-wrap, footer "Confidencial".
  const generarInforme = () => {
    const fecha = new Date().toLocaleDateString("es-ES", { day:"numeric", month:"long", year:"numeric" });
    const agentNombre = AGENT_PRINT_NAME[message.specialistKey] || meta.label;
    const fileName = `Informe_${message.specialistKey || "agente"}_${Date.now()}`;
    const html = `<!DOCTYPE html><html lang="es"><head><meta charset="utf-8"><title>${fileName}</title><style>
      body { font-family: Georgia, 'Times New Roman', serif; margin: 0; color: #1a1a1a; line-height: 1.6; }
      .wrap { padding: 60px; }
      /* Header strip Kluxor: fondo negro, texto pearl, franja oro abajo. */
      .header { background: #0A0A0A; color: #F5F0E8; padding: 28px 60px; border-bottom: 4px solid #C9A84C; margin: 0 -60px 30px; }
      .logo { font-size: 11px; color: #C9A84C; font-weight: bold; letter-spacing: 3px; }
      .header h1 { font-size: 22px; margin: 8px 0 4px; color: #F5F0E8; }
      .meta { font-size: 13px; color: rgba(245,240,232,0.8); }
      .task { font-size: 13px; color: #374151; margin-top: 14px; padding: 8px 12px; background: #fdf8ec; border-left: 3px solid #C9A84C; border-radius: 4px; }
      .content { font-size: 15px; white-space: pre-wrap; word-wrap: break-word; }
      .footer { margin-top: 60px; border-top: 1px solid #ddd; padding-top: 12px; font-size: 11px; color: #999; }
      @media print { body { margin: 0; } .wrap { padding: 30mm; } .header { margin-left: -30mm; margin-right: -30mm; padding-left: 30mm; padding-right: 30mm; } }
    </style></head><body>
      <div class="header">
        <div class="logo">KLUXOR — INFORME ESPECIALISTA</div>
        <h1>Informe ${escHTML(agentNombre)}</h1>
        <div class="meta">Fecha: ${escHTML(fecha)} · Preparado para: Antonio Díaz</div>
      </div>
      <div class="wrap">
        ${message.task ? `<div class="task"><b>Tarea:</b> ${escHTML(message.task)}</div><br/>` : ""}
        <div class="content">${escHTML(message.text)}</div>
        <div class="footer">Documento generado por Kluxor CEO OS · ${escHTML(fecha)} · Confidencial</div>
      </div>
    </body></html>`;
    imprimirHTML(html, fileName);
  };

  // Modo 2 — Documento legal. Tipografía Times New Roman, márgenes
  // amplios, "Documento Legal" centrado, contenido justificado, dos
  // bloques de firma al pie. Pensado para que cualquier especialista
  // (no solo Mario) pueda producir un texto firmable cuando aplique.
  const generarContrato = () => {
    const fecha = new Date().toLocaleDateString("es-ES", { day:"numeric", month:"long", year:"numeric" });
    const fileName = `Contrato_${Date.now()}`;
    const html = `<!DOCTYPE html><html lang="es"><head><meta charset="utf-8"><title>${fileName}</title><style>
      body { font-family: 'Times New Roman', Times, serif; margin: 0; color: #000; line-height: 1.8; font-size: 14px; }
      .wrap { padding: 80px; }
      /* Banda de título Kluxor: fondo negro con título oro, separador
         dorado fino abajo. El cuerpo se mantiene sobre blanco para
         legibilidad e impresión sobria. */
      .titlebar { background: #0A0A0A; color: #C9A84C; padding: 22px 80px; text-align: center; border-bottom: 2px solid #C9A84C; margin: 0 -80px 36px; }
      .titlebar h1 { color: #C9A84C; font-size: 18px; text-transform: uppercase; letter-spacing: 2px; margin: 0 0 4px; }
      .titlebar .marca { font-size: 10px; color: rgba(201,168,76,0.7); letter-spacing: 3px; }
      .subtitulo { text-align: center; font-size: 13px; color: #333; margin-bottom: 36px; }
      .content { text-align: justify; white-space: pre-wrap; word-wrap: break-word; }
      .firmas { margin-top: 80px; display: flex; justify-content: space-between; }
      .firma { text-align: center; width: 200px; }
      .linea-firma { border-top: 1px solid #000; margin-bottom: 8px; }
      .footer { margin-top: 40px; border-top: 1px solid #ccc; padding-top: 10px; font-size: 10px; color: #666; text-align: center; }
      @media print { body { margin: 0; } .wrap { padding: 40mm; } .titlebar { margin-left: -40mm; margin-right: -40mm; padding-left: 40mm; padding-right: 40mm; } .no-print { display: none; } }
    </style></head><body>
      <div class="titlebar">
        <div class="marca">KLUXOR</div>
        <h1>Documento Legal</h1>
      </div>
      <div class="wrap">
        <div class="subtitulo">Elaborado en Marbella, a ${escHTML(fecha)}</div>
        <div class="content">${escHTML(message.text)}</div>
        <div class="firmas">
          <div class="firma"><div class="linea-firma"></div><div>EL CEDENTE</div></div>
          <div class="firma"><div class="linea-firma"></div><div>EL CESIONARIO</div></div>
        </div>
        <div class="footer">Documento preparado con asistencia de Kluxor CEO OS · ${escHTML(fecha)} · Sujeto a revisión legal</div>
      </div>
    </body></html>`;
    imprimirHTML(html, fileName);
  };

  // Acción 3 — Adjuntar respuesta del especialista a una negociación.
  //
  // Reutiliza saveCouncilDocument (App.jsx) — el mismo pipeline que usa
  // ConsejoView para sus "Guardar como documento". Eso garantiza:
  //   · El adjunto vive en data.negotiations[i].documents (JSONB del tenant)
  //     y se sincroniza vía pushState → Supabase. Persistente, cross-device.
  //   · Aparece automáticamente en la sección 📎 Documentos del detalle de
  //     la negociación (NegotiationDetailView ya renderiza documents[]).
  //   · Héctor, al armar contexto de esa negociación, lee documents y lo ve.
  //   · _origin.source = "hector-specialist" lo distingue de los guardados
  //     desde ConsejoView (source: "consejo") para trazabilidad.
  //
  // Nombre AUTOMÁTICO: "{Especialista} · {primeros 40 chars de la task}
  // · YYYY-MM-DD" — sin abrir modal extra. Renombrable después desde el
  // visor de docs del detalle.
  //
  // Fallback transicional: si onSaveCouncilDocument llegara undefined
  // (orden de despliegue raro, prop no conectada), conservamos el escrito
  // a localStorage para no perder el adjunto. Eliminable en commit
  // posterior cuando el bundle nuevo sea estable en producción.
  const handleAttachNeg = (negId, negCode) => {
    const fechaCorta = new Date().toISOString().slice(0, 10);
    const taskShort  = (message.task || "Análisis").trim().slice(0, 40);
    const docName    = `${meta.label} · ${taskShort} · ${fechaCorta}`;
    const doc = {
      id: `doc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      name: docName,
      type: "text/markdown",
      size: (message.text || "").length,
      storagePath: null,
      url: null,
      text: message.text || "",
      kind: "inline",
      uploadedAt: new Date().toISOString(),
      analyzedBy: null,
      analyzedAt: null,
      report: null,
      _origin: { source: "hector-specialist", specKey: message.specialistKey, specName: meta.label, ts: Date.now() },
    };
    if (typeof onSaveCouncilDocument === "function") {
      const ok = onSaveCouncilDocument({ targetType: "negotiation", targetId: negId, doc });
      setPicker(null);
      // saveCouncilDocument ya emite toast "✓ Documento guardado en …".
      // Solo emitimos flash inline si volvió false (fallo de permisos o
      // negociación no encontrada), para que el CEO sepa que no se guardó.
      if (!ok) flash(`⚠ No se pudo adjuntar a ${negCode}`);
      return;
    }
    // Fallback transicional — solo si la prop no llegó (no debería pasar
    // tras el deploy de este commit, pero defendemos por si acaso).
    const key = `kluxor.specialist.attachments.${negId}`;
    let existing = [];
    try { const raw = localStorage.getItem(key); if (raw) existing = JSON.parse(raw); } catch {}
    if (!Array.isArray(existing)) existing = [];
    existing.push({ specialist: message.specialistKey, label: meta.label, task: message.task || "", response: message.text || "", ts: Date.now() });
    try { localStorage.setItem(key, JSON.stringify(existing.slice(-100))); } catch {}
    setPicker(null);
    flash(`✓ Adjuntado a ${negCode} (local)`);
  };

  const projects = (data?.projects || []).filter(p => p && !p.archived && p.code);
  const ACTIVE_NEG = new Set(["en_curso", "pausado"]);
  const negs = (data?.negotiations || []).filter(n => n && ACTIVE_NEG.has(n.status));

  // Filtros del buscador inline. case-insensitive contains. Cuando query
  // está vacío devolvemos la lista completa — el scroll del contenedor
  // hace el resto. Antes había un .slice(0, 12) hardcodeado que cortaba
  // los pickers a las 12 primeras entradas; con 57 proyectos / 57 negs
  // significaba que muchas no eran alcanzables. Eliminado.
  const queryLower = query.trim().toLowerCase();
  const filteredProjects = !queryLower ? projects : projects.filter(p =>
    (p.code || "").toLowerCase().includes(queryLower) ||
    (p.name || "").toLowerCase().includes(queryLower)
  );
  const filteredNegs = !queryLower ? negs : negs.filter(n =>
    (n.code || "").toLowerCase().includes(queryLower) ||
    (n.title || "").toLowerCase().includes(queryLower) ||
    (n.counterparty || "").toLowerCase().includes(queryLower)
  );

  const buttons = [
    { id: "task",     label: "📋 Tarea",    onClick: () => {
        if (!projects.length) { flash("⚠ Crea un proyecto primero"); return; }
        setPicker(p => p === "task" ? null : "task");
      } },
    { id: "informe",  label: "📊 Informe",  onClick: () => generarInforme() },
    { id: "contrato", label: "📄 Contrato", onClick: () => generarContrato() },
    { id: "neg",      label: "📁 Neg.",     onClick: () => {
        if (!negs.length) { flash("⚠ Sin negociaciones activas"); return; }
        setPicker(p => p === "neg" ? null : "neg");
      } },
  ];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4, alignItems: "flex-start" }}>
      <div style={{ display: "flex", flexDirection: "row", gap: 10, alignItems: "flex-start", maxWidth: "100%" }}>
        <AgentAvatar agent={message.specialistKey} size={32} />
        <div style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 0, flex: 1 }}>
          <div style={{ fontSize: 11, fontWeight: 500, color: C.brand, letterSpacing: 0.2 }}>
            {meta.label}{message.task ? ` · ${message.task.slice(0, 60)}${message.task.length > 60 ? "…" : ""}` : ""}
          </div>
          <div style={{
            background: message.error ? "#FEF2F2" : "#FFFFFF",
            color: message.error ? "#991B1B" : C.textPrimary,
            borderRadius: "4px 16px 16px 16px",
            padding: "10px 14px 10px 16px",
            maxWidth: "100%",
            fontSize: 14,
            lineHeight: 1.5,
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
            // Borde izquierdo dorado 2px = sello visual del especialista,
            // resto en borde sutil cálido para destacar sobre el fondo
            // operacional #FAFAF7.
            border: message.error ? "1px solid #FCA5A5" : `0.5px solid ${C.borderTertiary}`,
            borderLeft: message.error ? "2px solid #DC2626" : `2px solid ${C.brand}`,
            opacity: message.loading ? 0.7 : 1,
            fontStyle: message.loading ? "italic" : "normal",
          }}>
            {message.text}
          </div>
        </div>
      </div>

      {/* Acciones — sólo cuando la respuesta está lista (no loading ni error).
          Tema operacional Kluxor: fondo blanco con borde oro y texto oro;
          hover (y picker abierto) invierte a fondo oro + texto blanco. */}
      {!message.loading && !message.error && (
        <div style={{ display: "flex", gap: 6, marginTop: 6, marginLeft: 42, flexWrap: "wrap" }}>
          {buttons.map(b => (
            <button
              key={b.id}
              type="button"
              onClick={b.onClick}
              onMouseEnter={e => { if (picker !== b.id) { e.currentTarget.style.background = C.brand; e.currentTarget.style.color = "#FFFFFF"; } }}
              onMouseLeave={e => { if (picker !== b.id) { e.currentTarget.style.background = "#FFFFFF"; e.currentTarget.style.color = C.brand; } }}
              style={{
                fontSize: 12,
                fontWeight: 500,
                padding: "6px 14px",
                borderRadius: 20,
                border: `0.5px solid ${C.brand}`,
                background: picker === b.id ? C.brand : "#FFFFFF",
                color: picker === b.id ? "#FFFFFF" : C.brand,
                cursor: "pointer",
                fontFamily: "inherit",
                lineHeight: 1.4,
                transition: "background .15s ease, color .15s ease",
              }}
            >{b.label}</button>
          ))}
        </div>
      )}

      {/* Feedback inline tras una acción */}
      {feedback && (
        <div style={{ marginLeft: 42, marginTop: 4, fontSize: 11, color: C.brand, fontWeight: 500 }}>
          {feedback}
        </div>
      )}

      {/* Picker de proyecto (Acción 1) — tema operacional claro.
          maxHeight + overflowY auto en la lista interna para que con
          50+ proyectos haya scroll. Input de búsqueda (autoFocus) cuando
          hay >6 — umbral pragmático para no estorbar con pocos.
          data-c="task-picker" + data-c="task-row" facilitan smoke tests. */}
      {picker === "task" && projects.length > 0 && (
        <div data-c="task-picker" style={{ marginLeft: 42, marginTop: 6, width: "calc(100% - 42px)", maxWidth: 360, background: "#FFFFFF", border: `0.5px solid ${C.borderTertiary}`, borderRadius: 8, overflow: "hidden", boxShadow: "0 4px 14px rgba(26,26,26,0.08)", display: "flex", flexDirection: "column", maxHeight: 360 }}>
          <div style={{ padding: "6px 12px", fontSize: 10, fontWeight: 600, color: C.textTertiary, textTransform: "uppercase", letterSpacing: "0.07em", borderBottom: `0.5px solid ${C.borderTertiary}`, background: C.bgPrimary, flexShrink: 0 }}>Crear tarea en…</div>
          {projects.length > 6 && (
            <input
              data-c="task-search"
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder="Buscar por código o nombre…"
              autoFocus
              style={{ padding: "8px 12px", border: 0, borderBottom: `0.5px solid ${C.borderTertiary}`, fontSize: 13, outline: "none", fontFamily: "inherit", background: "#FFFFFF", flexShrink: 0 }}
            />
          )}
          <div style={{ overflowY: "auto", flex: 1 }}>
            {filteredProjects.length === 0 ? (
              <div style={{ padding: "16px 12px", fontSize: 12, color: C.textTertiary, textAlign: "center" }}>Sin resultados</div>
            ) : filteredProjects.map(p => (
              <div key={p.id} data-c="task-row"
                onClick={() => handleCreateTask(p.code)}
                style={{ padding: "8px 12px", cursor: "pointer", fontSize: 13, color: C.textPrimary, borderBottom: `0.5px solid ${C.borderTertiary}` }}
                onMouseEnter={e => e.currentTarget.style.background = C.bgSecondary}
                onMouseLeave={e => e.currentTarget.style.background = "transparent"}
              >
                <span style={{ fontWeight: 600, color: C.brand }}>[{p.code}]</span> {p.name || "Sin nombre"}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Picker de negociación (Acción 3) — mismo patrón que el de proyectos. */}
      {picker === "neg" && negs.length > 0 && (
        <div data-c="neg-picker" style={{ marginLeft: 42, marginTop: 6, width: "calc(100% - 42px)", maxWidth: 360, background: "#FFFFFF", border: `0.5px solid ${C.borderTertiary}`, borderRadius: 8, overflow: "hidden", boxShadow: "0 4px 14px rgba(26,26,26,0.08)", display: "flex", flexDirection: "column", maxHeight: 360 }}>
          <div style={{ padding: "6px 12px", fontSize: 10, fontWeight: 600, color: C.textTertiary, textTransform: "uppercase", letterSpacing: "0.07em", borderBottom: `0.5px solid ${C.borderTertiary}`, background: C.bgPrimary, flexShrink: 0 }}>Adjuntar a negociación…</div>
          {negs.length > 6 && (
            <input
              data-c="neg-search"
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder="Buscar por código, título o contraparte…"
              autoFocus
              style={{ padding: "8px 12px", border: 0, borderBottom: `0.5px solid ${C.borderTertiary}`, fontSize: 13, outline: "none", fontFamily: "inherit", background: "#FFFFFF", flexShrink: 0 }}
            />
          )}
          <div style={{ overflowY: "auto", flex: 1 }}>
            {filteredNegs.length === 0 ? (
              <div style={{ padding: "16px 12px", fontSize: 12, color: C.textTertiary, textAlign: "center" }}>Sin resultados</div>
            ) : filteredNegs.map(n => (
              <div key={n.id} data-c="neg-row"
                onClick={() => handleAttachNeg(n.id, n.code || `#${n.id}`)}
                style={{ padding: "8px 12px", cursor: "pointer", fontSize: 13, color: C.textPrimary, borderBottom: `0.5px solid ${C.borderTertiary}` }}
                onMouseEnter={e => e.currentTarget.style.background = C.bgSecondary}
                onMouseLeave={e => e.currentTarget.style.background = "transparent"}
              >
                <span style={{ fontWeight: 600, color: C.brand }}>[{n.code || "?"}]</span> {(n.title || "Sin título").slice(0, 50)}
                {n.counterparty ? <span style={{ fontSize: 11, color: C.textTertiary, marginLeft: 6 }}>· {n.counterparty}</span> : null}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// TaskListCard — card de solo lectura para consultas de tareas. Misma
// familia visual que ActionProposal (padding/tipografía/badges de
// prioridad) pero color borde gris azulado #3B5573 para distinguir
// "consulta" (información) de "propuesta" (acción pendiente). Sin
// checkboxes, sin botones. Hover sutil preparando deep-link futuro.
const TASK_BORDER  = "#3B5573";
const TASK_TINT    = "rgba(59,85,115,0.06)";
const TASK_HOVER   = "rgba(59,85,115,0.10)";
const TASK_PRIO_COLOR = { alta: "#B91C1C", media: "#92400E", baja: "#0E7C5A" };
const TASK_PRIO_LABEL = { alta: "Alta", media: "Media", baja: "Baja" };

function formatDueES(due) {
  if (!due) return null;
  const d = new Date(due);
  if (isNaN(d.getTime())) return String(due);
  const dia = d.getDate();
  const mes = ["ene","feb","mar","abr","may","jun","jul","ago","sep","oct","nov","dic"][d.getMonth()];
  return `${dia}-${mes}`;
}

function TaskRow({ task, vencida }) {
  const prio = (task.priority || "media").toLowerCase();
  const prioColor = TASK_PRIO_COLOR[prio] || "#6B6B6B";
  const dueLabel = formatDueES(task.due);
  return (
    <div
      onMouseEnter={e => e.currentTarget.style.background = TASK_HOVER}
      onMouseLeave={e => e.currentTarget.style.background = "transparent"}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "6px 8px",
        fontSize: 12.5,
        color: "#1A1A1A",
        borderBottom: "0.5px dashed #E5E0D5",
        transition: "background .15s ease",
      }}
    >
      <span style={{ fontSize: 11, color: "#6B6B6B", fontWeight: 600, minWidth: 44 }}>
        [{task.code || "?"}]
      </span>
      <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {task.title || "Sin título"}
      </span>
      <span style={{
        fontSize: 10,
        fontWeight: 600,
        padding: "1px 6px",
        background: prioColor + "18",
        color: prioColor,
        border: `1px solid ${prioColor}55`,
      }}>
        {TASK_PRIO_LABEL[prio] || prio}
      </span>
      {dueLabel && (
        <span style={{
          fontSize: 10.5,
          fontWeight: vencida ? 600 : 400,
          color: vencida ? "#B91C1C" : "#6B6B6B",
          minWidth: 70,
          textAlign: "right",
        }}>
          {vencida ? `VENCIDA ${dueLabel}` : `vence ${dueLabel}`}
        </span>
      )}
    </div>
  );
}

function TaskListCard({ tasksList }) {
  if (!tasksList) return null;
  const vencidas = Array.isArray(tasksList.vencidas) ? tasksList.vencidas : [];
  const proximas = Array.isArray(tasksList.proximas) ? tasksList.proximas : [];
  const total = vencidas.length + proximas.length;
  if (total === 0) return null;
  return (
    <div style={{
      marginTop: 10,
      background: TASK_TINT,
      border: `2px solid ${TASK_BORDER}`,
      padding: 14,
    }}>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
        <span style={{ fontSize: 18 }}>🔍</span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: "#111827" }}>Tareas encontradas</div>
        </div>
        <div style={{ fontSize: 11, color: TASK_BORDER, fontWeight: 600 }}>
          📋 {total}
        </div>
      </div>

      {/* Sección VENCIDAS */}
      {vencidas.length > 0 && (
        <div style={{ background: "#fff", border: `1px solid ${TASK_BORDER}33`, padding: "8px 10px", marginBottom: proximas.length > 0 ? 8 : 0 }}>
          <div style={{ fontSize: 10, fontWeight: 700, color: TASK_BORDER, textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 6 }}>
            ▼ Vencidas ({vencidas.length})
          </div>
          <div>
            {vencidas.map((t, i) => <TaskRow key={`v-${i}`} task={t} vencida={true} />)}
          </div>
        </div>
      )}

      {/* Sección PRÓXIMAS */}
      {proximas.length > 0 && (
        <div style={{ background: "#fff", border: `1px solid ${TASK_BORDER}33`, padding: "8px 10px" }}>
          <div style={{ fontSize: 10, fontWeight: 700, color: TASK_BORDER, textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 6 }}>
            ▼ Próximas ({proximas.length})
          </div>
          <div>
            {proximas.map((t, i) => <TaskRow key={`p-${i}`} task={t} vencida={false} />)}
          </div>
        </div>
      )}

      {/* Indicador post-validación: aparece cuando el frontend tuvo
          que filtrar tareas inventadas o sustituir por BD-driven (modo
          "consulta filtrada por proyecto"). Tono neutral, sin alarma. */}
      {tasksList._filteredFromLLM && (
        <div style={{
          marginTop: 10,
          fontSize: 11,
          color: "#6B6B6B",
          fontStyle: "italic",
          textAlign: "center",
          paddingTop: 6,
          borderTop: `0.5px dashed ${TASK_BORDER}33`,
        }}>
          ℹ Mostrando solo tareas verificadas en el sistema.
        </div>
      )}
    </div>
  );
}

function TypingIndicator() {
  return (
    <div style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
      <AgentAvatar agent="hector" size={32} />
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
  background: "#F0EDE5",
  border: `1px solid ${C.brand}`,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  fontSize: 22,
  flexShrink: 0,
};

// hectorAvatarSmall y ceoAvatarStyle se importan desde Shared/ChatBubble
// (commit 37) — fuente de verdad compartida con HectorPanel.

const aperturaStyle = {
  padding: "12px 20px",
  background: "transparent",
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
  background: "#FFFFFF",
  color: C.textPrimary,
  caretColor: C.brand,
  fontSize: 15,
  resize: "none",
  lineHeight: 1.5,
  fontFamily: "inherit",
  outline: "none",
  boxSizing: "border-box",
  transition: "border-color .15s ease",
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
