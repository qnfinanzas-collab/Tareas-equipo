// agentActions — sistema de acciones ejecutables propuestas por agentes IA.
//
// Concepto: cada agente (Héctor, Gonzalo, Mario, Jorge, Álvaro) puede
// terminar su respuesta con un bloque [ACTIONS]{...}[/ACTIONS] que el UI
// parsea, oculta del texto visible y ofrece al CEO con un panel de
// confirmación. Si el CEO acepta, executeAgentActions ejecuta todas las
// mutaciones reales (createProject, addTask, addNegotiation, etc).
//
// Diseño:
//   - Single source of truth de los TIPOS y SCHEMA en este archivo.
//   - parseAgentActions extrae el JSON entre marcadores [ACTIONS]...[/ACTIONS]
//   - cleanAgentResponse remueve el bloque del texto antes de mostrarlo.
//   - executeAgentActions recibe los mutators de App.jsx vía `helpers` y
//     ejecuta todas las acciones; devuelve resultados para feedback (toasts).

export const AGENT_ACTION_TYPES = {
  CREATE_PROJECT:       "create_project",
  CREATE_TASKS:         "create_tasks",
  CREATE_NEGOTIATION:   "create_negotiation",
  COMPLETE_TASK:        "complete_task",
  CREATE_MOVEMENT:      "create_movement",
  // Acciones bancarias propuestas por Diego (Analista Financiero).
  UPDATE_BANK_MOVEMENT: "update_bank_movement",
  ADD_BANK_MOVEMENT:    "add_bank_movement",
  // Asientos del libro diario (Diego: contabilidad PGC pyme).
  ADD_ACCOUNTING_ENTRY: "add_accounting_entry",
};

// Marcadores. Públicos para que los prompts puedan referenciarlos exactamente.
export const ACTIONS_OPEN = "[ACTIONS]";
export const ACTIONS_CLOSE = "[/ACTIONS]";
const ACTIONS_RE = /\[ACTIONS\]([\s\S]*?)\[\/ACTIONS\]/;

// Parsea el bloque de acciones de la respuesta de un agente. Devuelve
// `null` si no hay bloque o si el JSON es inválido (no fallamos ruidoso:
// el chat sigue funcionando aunque la propuesta no sea ejecutable).
export function parseAgentActions(responseText) {
  if (!responseText || typeof responseText !== "string") return null;
  const m = responseText.match(ACTIONS_RE);
  if (!m) return null;
  try {
    let raw = m[1].trim();
    // Tolerancia: si el modelo envuelve en ```json...``` lo limpiamos.
    raw = raw.replace(/^```json\s*|\s*```$/g, "").replace(/^```\s*|\s*```$/g, "");
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.actions)) return null;
    return {
      actions: parsed.actions,
      confirmRequired: parsed.confirmRequired !== false,
      summary: parsed.summary || "El agente propone las siguientes acciones",
    };
  } catch (e) {
    console.warn("[agentActions] parse fallo:", e?.message);
    return null;
  }
}

// Quita el bloque [ACTIONS]...[/ACTIONS] del texto antes de mostrarlo en
// el chat. Colapsa saltos de línea triples que pueda dejar el strip.
export function cleanAgentResponse(responseText) {
  if (!responseText) return "";
  return String(responseText)
    .replace(ACTIONS_RE, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// Resuelve fechas relativas tipo "+7d", "+1m", "+2h" a ISO string. Si la
// entrada ya parece ISO o YYYY-MM-DD, la devuelve tal cual. Devuelve null
// para entradas vacías.
export function resolveDueDate(relative) {
  if (!relative) return null;
  if (typeof relative !== "string") return null;
  const s = relative.trim();
  if (!s) return null;
  // Ya es ISO o YYYY-MM-DD → devolvemos tal cual
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s;
  const match = s.match(/^\+?(\d+)([dhm])$/i);
  if (!match) return s;
  const num = parseInt(match[1], 10);
  const unit = match[2].toLowerCase();
  const d = new Date();
  if (unit === "d") d.setDate(d.getDate() + num);
  if (unit === "h") d.setHours(d.getHours() + num);
  if (unit === "m") d.setMonth(d.getMonth() + num);
  // Devolvemos solo YYYY-MM-DD (formato que usan dueDate en data.boards).
  return d.toISOString().slice(0, 10);
}

// Resuelve companyId con cadena de fallback:
//   1) `actionCompanyId` (lo que el agente puso en el JSON)
//   2) `defaultCompanyId` (la empresa filtrada en la UI cuando aplica)
//   3) Si solo hay UNA empresa registrada en data.governance.companies,
//      la usamos automáticamente. En grupos pyme con 1 sola sociedad esto
//      evita que las acciones financieras de Diego fallen silenciosamente
//      cuando el selector está en "all".
//   4) null → el caller decide qué error reportar.
export function resolveCompanyId(actionCompanyId, defaultCompanyId, data) {
  if (actionCompanyId && typeof actionCompanyId === "string") return actionCompanyId;
  if (defaultCompanyId && typeof defaultCompanyId === "string" && defaultCompanyId !== "all") return defaultCompanyId;
  const companies = data?.governance?.companies || [];
  if (companies.length === 1 && companies[0]?.id) return companies[0].id;
  return null;
}

// Resuelve un alias o nombre/email a memberId. "admin" → primer
// accountRole==="admin". Cualquier otro string → match por nombre/email
// (case-insensitive, includes). Devuelve fallback si no encuentra.
export function resolveAssignees(assigneeRefs, allMembers, fallbackMemberId) {
  if (!Array.isArray(assigneeRefs) || !allMembers) return fallbackMemberId != null ? [fallbackMemberId] : [];
  const out = [];
  const adminMember = allMembers.find(m => m.accountRole === "admin");
  for (const ref of assigneeRefs) {
    if (typeof ref === "number") { out.push(ref); continue; }
    if (!ref || typeof ref !== "string") continue;
    if (ref.toLowerCase() === "admin" && adminMember) { out.push(adminMember.id); continue; }
    const lower = ref.toLowerCase();
    const found = allMembers.find(m =>
      (m.name || "").toLowerCase().includes(lower) ||
      (m.email || "").toLowerCase().includes(lower)
    );
    if (found) out.push(found.id);
  }
  if (out.length === 0 && fallbackMemberId != null) return [fallbackMemberId];
  return Array.from(new Set(out));
}

// Ejecutor central. Recibe el array de acciones y un objeto `helpers` con
// las funciones de mutación de App.jsx. Devuelve {results} con un item
// por acción ejecutada (para toasts).
//
// IMPORTANTE: las funciones de helpers son las MISMAS que usa la UI manual
// (createProject, addTask, etc), así la persistencia y sync con Supabase
// es automática. No duplicamos lógica.
export function executeAgentActions(actions, helpers) {
  const results = [];
  if (!Array.isArray(actions)) return results;
  const {
    data,
    adminMemberId,
    allMembers = [],
    createProject,        // ({name, code, desc, color, emoji, members, columns, workspaceId, visibility}) → side-effect
    findProjectByCode,    // (code) → project | undefined  (lee dataRef tras setData)
    addTaskToProject,     // (projectId, payload) → side-effect
    createNegotiation,    // (payload) → side-effect
    addFinanceMovement,   // (payload) → side-effect
    addBankMovement,      // (payload) → side-effect (Diego)
    updateBankMovement,   // (id, patch) → side-effect (Diego)
    addAccountingEntry,   // (payload) → side-effect (Diego: libro diario)
    defaultCompanyId,     // string|null — empresa filtrada en la UI cuando aplica
  } = helpers || {};

  for (const action of actions) {
    try {
      switch (action.type) {
        case AGENT_ACTION_TYPES.CREATE_PROJECT: {
          const memberIds = resolveAssignees(action.assignees || ["admin"], allMembers, adminMemberId);
          const code = (action.code || (action.name||"PRJ").replace(/[^A-Z]/gi, "").slice(0,3).toUpperCase() || "PRJ").slice(0,3).padEnd(3,"X");
          createProject?.({
            name: action.name || "Proyecto sin nombre",
            code,
            desc: action.description || "",
            color: action.color || "#3498DB",
            emoji: action.emoji || "📁",
            members: memberIds,
            columns: ["Por hacer", "En progreso", "Hecho"],
            workspaceId: action.workspaceId ?? null,
            visibility: action.visibility || "private",
          });
          // Las tareas iniciales se crean a continuación, pero
          // necesitamos el id del nuevo proyecto. createProject hace
          // setData async; el caller debe usar findProjectByCode después
          // del flush. Aquí guardamos las tareas como pendientes para
          // que el caller las disparé en una segunda pasada.
          results.push({
            type: "project",
            name: action.name,
            code,
            taskCount: (action.tasks || []).length,
            pendingTasks: action.tasks || [],
            assignees: memberIds,
          });
          break;
        }

        case AGENT_ACTION_TYPES.CREATE_TASKS: {
          const project = findProjectByCode?.(action.projectCode);
          if (!project) {
            results.push({ type: "error", action: action.type, error: `Proyecto con code ${action.projectCode} no encontrado` });
            break;
          }
          let count = 0;
          for (const task of (action.tasks || [])) {
            const memberIds = resolveAssignees(task.assignees || ["admin"], allMembers, adminMemberId);
            addTaskToProject?.(project.id, {
              title: task.title,
              desc: task.description || "",
              priority: task.priority || "media",
              dueDate: resolveDueDate(task.dueDate),
              assignees: memberIds,
              tags: (task.tags || []).map(l => ({ l, c: "purple" })),
              timeline: makeAgentTimelineEntry(action._agentName),
            });
            count++;
          }
          results.push({ type: "tasks", count, project: project.name });
          break;
        }

        case AGENT_ACTION_TYPES.CREATE_NEGOTIATION: {
          const memberIds = resolveAssignees(action.assignees || ["admin"], allMembers, adminMemberId);
          const linkedProj = action.linkedProjectCode ? findProjectByCode?.(action.linkedProjectCode) : null;
          const nowIso = new Date().toISOString();
          const factToItem = (text) => ({ id: cryptoRandomId("kf"), text, source: "agent", addedAt: nowIso });
          createNegotiation?.({
            title: action.title || "Negociación sin título",
            counterparty: action.counterparty || "Por definir",
            status: "en_curso",
            value: null, currency: "EUR",
            description: action.notes || action.description || "",
            ownerId: adminMemberId,
            visibility: action.visibility || "team",
            members: memberIds,
            projectId: linkedProj?.id || null,
            agentId: null,
            relatedProjects: linkedProj ? [{ projectId: linkedProj.id, role: "principal", priority: "high" }] : [],
            relationships: [],
            stakeholders: (action.stakeholders || []).map(s => ({
              id: cryptoRandomId("stk"),
              name: s.name || "(sin nombre)",
              company: s.company || "",
              email: s.email || "",
              phone: s.phone || "",
              role: s.role || "other",
              influence: s.influence || "influencer",
              notes: s.notes || "",
            })),
            // memory.* lo deja completar createNegotiation con sus defaults;
            // pero podemos pre-poblar los hechos vía un patch posterior si
            // hace falta. Aquí pasamos memory como payload extra.
            memory: {
              keyFacts:      (action.facts || []).map(factToItem),
              agreements:    [],
              redFlags:      (action.redFlags || []).map(factToItem),
              chatSummaries: [],
              updatedAt:     nowIso,
            },
          });
          results.push({ type: "negotiation", name: action.title });
          break;
        }

        case AGENT_ACTION_TYPES.CREATE_MOVEMENT: {
          addFinanceMovement?.({
            type: action.movementType || "expense",
            concept: action.concept || "(sin concepto)",
            amount: Number(action.amount) || 0,
            date: resolveDueDate(action.date || "+0d"),
            category: action.category || "Otros gastos",
            status: action.status || "pending",
          });
          results.push({ type: "movement", concept: action.concept, amount: action.amount });
          break;
        }

        case AGENT_ACTION_TYPES.UPDATE_BANK_MOVEMENT: {
          // Diego propone categorizar/conciliar/anotar movimientos.
          // El parámetro `id` debe ser el id real del bankMovement.
          const patch = {};
          if (action.category !== undefined)    patch.category = action.category || null;
          if (action.subcategory !== undefined) patch.subcategory = action.subcategory || null;
          if (action.reconciled !== undefined)  patch.reconciled = !!action.reconciled;
          if (action.notes !== undefined)       patch.notes = String(action.notes || "");
          if (action.concept !== undefined)     patch.concept = String(action.concept || "");
          if (Object.keys(patch).length === 0 || !action.id) {
            results.push({ type: "error", action: action.type, error: "Falta id o no hay campos a actualizar" });
            break;
          }
          updateBankMovement?.(action.id, patch);
          results.push({ type: "bank_update", id: action.id, fields: Object.keys(patch) });
          break;
        }

        case AGENT_ACTION_TYPES.ADD_BANK_MOVEMENT: {
          // Diego propone añadir un movimiento bancario manual (raro, pero
          // útil si el CEO le pide registrar algo no presente en el extracto).
          // Cadena de fallback para accountId:
          //   1) action.accountId (explícito)
          //   2) Si la empresa filtrada/única tiene solo 1 cuenta activa, la usamos.
          let accountId = action.accountId || null;
          if (!accountId) {
            const companyId = resolveCompanyId(action.companyId, defaultCompanyId, data);
            const accountsForCompany = (data?.bankAccounts || []).filter(a =>
              a.isActive !== false && (!companyId || a.companyId === companyId)
            );
            if (accountsForCompany.length === 1) accountId = accountsForCompany[0].id;
          }
          if (!accountId) {
            results.push({ type: "error", action: action.type, error: "Falta accountId — la empresa tiene varias cuentas, especifica una" });
            break;
          }
          addBankMovement?.({
            accountId,
            date: resolveDueDate(action.date || "+0d"),
            concept: action.concept || "(sin concepto)",
            amount: Number(action.amount) || 0,
            category: action.category || null,
            notes: action.notes || "",
            reconciled: !!action.reconciled,
            importedFrom: "manual",
          });
          results.push({ type: "bank_add", concept: action.concept, amount: action.amount });
          break;
        }

        case AGENT_ACTION_TYPES.ADD_ACCOUNTING_ENTRY: {
          // [DEBUG] Logs temporales para auditar el pipeline executor →
          // mutator. Permite ver qué llega de Diego (action) y qué se
          // pasa al mutator (payload normalizado).
          console.log("[runAgentActions] add_accounting_entry payload:", JSON.stringify(action).slice(0, 500));
          // Diego crea un asiento del libro diario. La validación dura
          // (cuadre debe=haber) la hace addAccountingEntry; aquí solo
          // marcamos la propuesta y dejamos que el mutator decida.
          const companyId = resolveCompanyId(action.companyId, defaultCompanyId, data);
          if (!companyId) {
            console.error("[runAgentActions] add_accounting_entry: companyId no resuelto · action.companyId=", action.companyId, "· default=", defaultCompanyId, "· companies=", (data?.governance?.companies||[]).length);
            results.push({ type: "error", action: action.type, error: "Selecciona una empresa concreta antes de crear asientos contables" });
            break;
          }
          if (!Array.isArray(action.lines) || action.lines.length < 2) {
            console.error("[runAgentActions] add_accounting_entry: líneas insuficientes ·", action.lines?.length || 0);
            results.push({ type: "error", action: action.type, error: "El asiento necesita al menos 2 líneas" });
            break;
          }
          const mutatorPayload = {
            companyId,
            date: resolveDueDate(action.date || "+0d"),
            description: action.description || "(sin descripción)",
            lines: action.lines.map(l => ({
              account: String(l.account || "").trim(),
              accountName: String(l.accountName || "").trim(),
              debit:  Number(l.debit)  || 0,
              credit: Number(l.credit) || 0,
            })),
            invoiceId: action.invoiceId || null,
            bankMovementId: action.bankMovementId || null,
            source: "diego",
            status: action.status === "borrador" ? "borrador" : "confirmado",
          };
          const newId = addAccountingEntry?.(mutatorPayload);
          console.log("[runAgentActions] add_accounting_entry resultado:", { newId, companyId, lineCount: mutatorPayload.lines.length });
          if (!newId) {
            // El mutator rechazó (descuadre o validación). Lo reflejamos.
            results.push({ type: "error", action: action.type, error: "Asiento descuadrado o inválido — no creado" });
          } else {
            results.push({ type: "accounting_entry", description: action.description, id: newId });
          }
          break;
        }

        default:
          results.push({ type: "error", action: action.type, error: `Tipo de acción desconocido: ${action.type}` });
      }
    } catch (e) {
      console.error("[agentActions] error en acción:", action?.type, e);
      results.push({ type: "error", action: action?.type, error: e?.message || String(e) });
    }
  }
  return results;
}

// Genera id corto sin dependencia de Node crypto.
function cryptoRandomId(prefix = "id") {
  if (typeof crypto !== "undefined" && crypto.randomUUID) return `${prefix}_${crypto.randomUUID().slice(0,12)}`;
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2,8)}`;
}

// Genera una entrada de timeline tipo "ai" para tareas creadas por agentes.
function makeAgentTimelineEntry(agentName) {
  return [{
    id: cryptoRandomId("tl"),
    type: "ai",
    author: agentName || "Agente IA",
    authorId: null,
    authorAvatar: "🤖",
    text: `Tarea creada automáticamente como parte de un plan propuesto.`,
    timestamp: new Date().toISOString(),
    isMilestone: false,
    relatedRecommendationId: null,
  }];
}

// Instrucción minimal (~600 chars) que se inyecta SOLO en flujos de chat
// donde tiene sentido proponer acciones (sendOrderToHector, chat con
// Gonzalo, etc). NO en análisis automáticos como generateHectorThought
// que piden JSON estricto. La versión anterior era 2.5KB y disparaba
// timeouts en Sonnet 4.5 con prompts grandes.
//
// Marca de versión "ACTIONS_v2" para que la migración pueda reemplazar
// la versión larga por esta corta sin duplicar.
export const AGENT_ACTIONS_ADDON = `

CAPACIDAD DE EJECUCIÓN (ACTIONS_v3):
Si el CEO te pide explícitamente crear proyectos, tareas, negociaciones o movimientos, añade AL FINAL de tu respuesta un bloque:
[ACTIONS]{"summary":"breve","confirmRequired":true,"actions":[...]}[/ACTIONS]

Tipos: "create_project" {name,code(3 letras mayúsculas),description,emoji,assignees:["admin","marc"],tasks:[{title,description,priority(alta|media|baja),dueDate("+7d"|YYYY-MM-DD),tags}]}; "create_negotiation" {title,notes,counterparty,assignees,facts,redFlags,stakeholders:[{name,role,company}],linkedProjectCode}; "create_tasks" {projectCode,tasks:[...]}; "create_movement" {concept,amount,movementType("expense"|"income"),category,date}; "update_bank_movement" {id,category?,subcategory?,reconciled?,notes?,concept?} (Diego: categorizar/conciliar movimientos del extracto, usa el id real); "add_bank_movement" {accountId,date,concept,amount,category?,notes?,reconciled?} (Diego: añadir movimiento manual); "add_accounting_entry" {companyId,date,description,lines:[{account(código PGC),accountName,debit,credit}],invoiceId?,bankMovementId?,status?("borrador"|"confirmado")} (Diego: asiento contable; cada línea solo tiene debit O credit, total debit DEBE = total credit, mínimo 2 líneas, usa cuentas del PGC pyme español: 100/170 financiación, 213/281 inmovilizado, 300 mercaderías, 400/410/430/472/473/475/476 acreedores y deudores, 523/570/572 financieras, 600/621/623/625/626/627/628/629/631/640/642/681 compras y gastos, 700/705/759/769 ventas e ingresos; subcuentas formato XXXNNNN ej 2130001).

Reglas: solo cuando lo pidan explícitamente, NUNCA en análisis ni consultas. El bloque se OCULTA del CEO. Tu prosa va ANTES del bloque.`;
