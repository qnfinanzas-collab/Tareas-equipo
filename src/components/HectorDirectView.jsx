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
import { parseAgentActions, cleanAgentResponse, detectFalseSuccessClaim, parseTasksList, cleanTasksListBlock, correctActionsDates, flattenRealTasks, detectProjectCodeFilter, validateTasksAgainstDatabase, rewriteToPropositive } from "../lib/agentActions.js";
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

// Paleta Kluxor "operational" — claro/legible para uso diario, con oro
// como acento de marca y acción. La paleta dark negro/oro queda solo
// para los PDFs (comunicación externa). Filosofía: como un Rolls Royce
// — negro por fuera (PDFs), claro por dentro (la herramienta).
const C = {
  borderTertiary:    "#E5E0D5",   // borde sutil cálido
  bgPrimary:         "#FAFAF7",   // blanco roto cálido (fondo principal)
  bgSecondary:       "#F0EDE5",   // gris perla cálido (burbujas Héctor)
  textTertiary:      "#9B9B9B",   // gris claro (etiquetas, meta)
  textSecondary:     "#6B6B6B",   // gris medio (texto secundario)
  textPrimary:       "#1A1A1A",   // negro suave (texto principal)
  brand:             "#C9A84C",   // oro Kluxor (acción, énfasis)
  brandLight:        "#E8DFC4",   // oro suave (fondos sutiles, CEO bubble)
  brandHover:        "#B89638",   // oro más oscuro (hover)
  hectorEmojiBg:     "#F0EDE5",   // gris perla (avatar Héctor en header)
  statusGreen:       "#4A8B5C",   // verde estado (activo)
  statusOrange:      "#B89638",   // oro oscuro como estado "pensando"
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
      // Identidad del usuario activo. Resolución encadenada:
      //  1) data.me / data.currentUser si el shape los expusiera
      //  2) data.members.find por userId (camino real en este codebase)
      // Si ninguno resuelve, dejamos el bloque vacío para no alucinar
      // un nombre. Se inyecta AL INICIO del system para que el modelo
      // lo lea antes que cualquier otro contexto.
      const usuarioActivo = (data?.me || data?.currentUser || (data?.members || []).find(m => m && m.id === userId)) || null;
      // Perfil completo de Antonio Díaz como contexto permanente.
      // Sin esto, Héctor (y especialistas vía propagación) tratan al
      // CEO como "usuario técnico genérico", repiten información que
      // ya conoce y no calibran tono ni profundidad. El bloque incluye
      // identidad legal (parte principal en contratos), proyectos
      // activos, sectores, estilo de comunicación y filosofía.
      const ceoBlock = usuarioActivo ? `USUARIO ACTIVO — CEO Y PROPIETARIO:
Nombre: Antonio Díaz
Empresa: ALMA DIMO INVESTMENTS S.L. · CIF: B19929256
Email: ${usuarioActivo.email || "qn.finanzas@gmail.com"}
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
` : "";
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
{"vencidas":[{"code":"MAR","title":"Documento sesión Rafael","priority":"alta","due":"2026-05-02"}],"proximas":[{"code":"BSF","title":"Formación app","priority":"media","due":"2026-05-07"}]}
[/TASKS_LIST]

Reglas:
- Usa SOLO datos reales del bloque "TAREAS URGENTES O VENCIDAS" que aparece arriba en este system prompt. NUNCA inventes tareas que no estén en ese bloque.
- "vencidas" = dueDate anterior a hoy. "proximas" = dueDate igual o posterior a hoy, o sin fecha.
- Campos por tarea: code (string, código del proyecto entre 2-4 letras), title (string), priority ("alta"|"media"|"baja"), due ("YYYY-MM-DD" o null si no tiene fecha). Omite campos que no conozcas.
- El bloque se OCULTA del chat y se renderiza como tarjeta visual. Tu prosa va DESPUÉS del bloque, máximo 1-2 frases (priorización, contexto o pregunta de seguimiento).
- Si no hay tareas relevantes que listar, NO emitas el bloque — responde solo con prosa.
- Este formato es SOLO para consultas de lectura. Para crear, modificar, asignar o eliminar tareas sigue siendo [ACTIONS] como hasta ahora.`;

      const baseSystem = ceoBlock + (hector?.promptBase
        ? hector.promptBase + "\n\n" + PLAIN_TEXT_RULE
        : "Eres Héctor, Chief of Staff estratégico. " + PLAIN_TEXT_RULE)
        + membersBlock + urgentBlock + projBlock + negBlock + finBlock + govBlock + tasksListBlock;
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
      if (proposal && proposal.summary) {
        const r = rewriteToPropositive(proposal.summary);
        if (r.wasFixed) {
          console.log(`✏️ [agentActions] Resumen reescrito a propositivo: '${r.original}' → '${r.rewritten}'`);
          proposal.summary = r.rewritten;
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
      if (proposal && Array.isArray(proposal.actions) && proposal.actions.length > 0) {
        const r = rewriteToPropositive(cleanText);
        if (r.wasFixed) {
          console.log(`✏️ [agentActions] Prosa reescrita (precede ActionProposal): '${r.original}' → '${r.rewritten}'`);
          cleanText = r.rewritten;
        }
      }
      // Detección anti-alucinación (Capa 2 del blindaje anti-fake-success):
      // si la prosa de Héctor afirma éxito y NO viene acompañada de un
      // bloque [ACTIONS] válido, marcamos el mensaje. Importante: si la
      // respuesta es una CONSULTA con [TASKS_LIST], NO la consideramos
      // afirmación de éxito aunque la prosa contenga verbos como
      // "actualizado" — es lectura, no ejecución.
      const fakeSuccess = !tasksList && detectFalseSuccessClaim(cleanText, proposal);
      setChatHistory(prev => [...prev, {
        role: "assistant",
        text: cleanText || "(sin texto)",
        proposal: proposal || null,
        tasksList: tasksList || null,
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
          // Propagamos ceoBlock también al especialista para que Mario
          // redacte contratos con Antonio Díaz como parte principal,
          // Jorge prepare informes para él, etc. Sin esto cada agente
          // podía coger al primer miembro como "parte" del documento.
          const sys = ceoBlock + (ag.promptBase || `Eres ${meta.label}, especialista invocado por Héctor.`) + "\n\n" + PLAIN_TEXT_RULE;
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
            onMouseEnter={e => e.currentTarget.style.color = C.brandHover}
            onMouseLeave={e => e.currentTarget.style.color = C.brand}
            style={{ fontSize: 12, color: C.brand, cursor: "pointer", textDecoration: "underline" }}
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
              if (m.tasksList && (m.tasksList.vencidas?.length || m.tasksList.proximas?.length)) return true;
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
          background: isUser ? C.brandLight : (message.error ? "#FEF2F2" : C.bgSecondary),
          color: message.error ? "#991B1B" : C.textPrimary,
          borderRadius: isUser ? "16px 4px 16px 16px" : "4px 16px 16px 16px",
          padding: "10px 14px",
          maxWidth: "78%",
          fontSize: 14,
          lineHeight: 1.5,
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
          // Spec: burbuja Héctor sin borde; user bubble tampoco lo necesita
          // sobre el fondo cálido. Solo error mantiene borde rojo.
          border: message.error ? "1px solid #FCA5A5" : "none",
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
      {!isUser && message.tasksList && (
        <div style={{ alignSelf: "stretch", paddingLeft: 42 }}>
          <TaskListCard tasksList={message.tasksList} />
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
  // morada (#534AB7 = brand SoulBaric), prosa preservada con
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
        <div style={{
          width: 32, height: 32, borderRadius: "50%",
          background: meta.color, color: "#fff",
          display: "flex", alignItems: "center", justifyContent: "center",
          fontSize: 16, flexShrink: 0,
        }}>{meta.emoji}</div>
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

      {/* Picker de proyecto (Acción 1) — tema operacional claro */}
      {picker === "task" && projects.length > 0 && (
        <div style={{ marginLeft: 42, marginTop: 6, width: "calc(100% - 42px)", maxWidth: 360, background: "#FFFFFF", border: `0.5px solid ${C.borderTertiary}`, borderRadius: 8, overflow: "hidden", boxShadow: "0 4px 14px rgba(26,26,26,0.08)" }}>
          <div style={{ padding: "6px 12px", fontSize: 10, fontWeight: 600, color: C.textTertiary, textTransform: "uppercase", letterSpacing: "0.07em", borderBottom: `0.5px solid ${C.borderTertiary}`, background: C.bgPrimary }}>Crear tarea en…</div>
          {projects.slice(0, 12).map(p => (
            <div key={p.id}
              onClick={() => handleCreateTask(p.code)}
              style={{ padding: "8px 12px", cursor: "pointer", fontSize: 13, color: C.textPrimary, borderBottom: `0.5px solid ${C.borderTertiary}` }}
              onMouseEnter={e => e.currentTarget.style.background = C.bgSecondary}
              onMouseLeave={e => e.currentTarget.style.background = "transparent"}
            >
              <span style={{ fontWeight: 600, color: C.brand }}>[{p.code}]</span> {p.name || "Sin nombre"}
            </div>
          ))}
        </div>
      )}

      {/* Picker de negociación (Acción 3) — tema operacional claro */}
      {picker === "neg" && negs.length > 0 && (
        <div style={{ marginLeft: 42, marginTop: 6, width: "calc(100% - 42px)", maxWidth: 360, background: "#FFFFFF", border: `0.5px solid ${C.borderTertiary}`, borderRadius: 8, overflow: "hidden", boxShadow: "0 4px 14px rgba(26,26,26,0.08)" }}>
          <div style={{ padding: "6px 12px", fontSize: 10, fontWeight: 600, color: C.textTertiary, textTransform: "uppercase", letterSpacing: "0.07em", borderBottom: `0.5px solid ${C.borderTertiary}`, background: C.bgPrimary }}>Adjuntar a negociación…</div>
          {negs.slice(0, 12).map(n => (
            <div key={n.id}
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
  background: "#F0EDE5",
  border: `1px solid ${C.brand}`,
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

const ceoAvatarStyle = {
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
