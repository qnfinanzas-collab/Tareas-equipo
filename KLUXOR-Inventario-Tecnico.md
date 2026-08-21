# KLUXOR — Inventario Técnico

**Fecha de corte:** 2026-08-21
**Rama:** `main` · HEAD `39f74dc`
**Alcance:** todo lo que existe hoy en el repo `Tareas-equipo` (privado) más lo persistido en la instancia Supabase de producción.

**Leyenda:**
- ✅ **Verificado** — comprobado en código o BD con comando reproducible (auditable en due diligence).
- 🟡 **Estimación** — juicio del ejecutor basado en la evidencia, no medido directamente.

---

## Índice

1. [Volumen de código](#1-volumen-de-código)
2. [Módulos funcionales](#2-módulos-funcionales)
3. [Los agentes](#3-los-agentes-ia)
4. [Datos e infraestructura](#4-datos-e-infraestructura)
5. [Seguridad y calidad](#5-seguridad-y-calidad)
6. [Lo que NO existe](#6-lo-que-no-existe)
7. [Esfuerzo de reconstrucción](#7-esfuerzo-de-reconstrucción)

---

## 1. Volumen de código

### 1.1 Rango temporal y commits ✅

| Métrica | Valor |
|---|---|
| Primer commit | `2026-04-20 10:46` (`Initial commit: TaskFlow con persistencia localStorage`) |
| Último commit | `2026-08-21 12:11` |
| Total commits | **624** |
| Ventana calendario | 123 días |
| Días con actividad | 60 (49% de días) |
| Sesiones de trabajo (≤90 min gap) | 114 |
| Horas de codificación con commit | ~140,7 h |

*Comando de verificación:* `git log --format='%aI' --reverse | wc -l` (obtiene 624), `git log --format='%aI' --reverse | sed -n '1p;$p'` (rango).

### 1.2 Líneas por bloque ✅

| Bloque | Líneas | Ficheros | Comentario |
|---|---:|---:|---|
| `src/` (JS + JSX + CSS) | **48.713** | 92 | Aplicación React |
| `api/` (Vercel serverless) | 876 | 8 | 6 endpoints + 2 libs de servicio |
| `scripts/` (Node .mjs) | 18.215 | 76 | 48 en `scripts/smoke/`, 28 en `scripts/` (onboarding, diagnósticos, decontaminación) |
| `migrations/` (SQL) | 756 | 6 | Migraciones versionadas de Supabase |
| `public/` (HTML) | 6.020 | 9 | 2 landings (ES 1.882 + EN 1.816), 1 landing legacy, 5 microsites |
| **Total línea contable** | **~74.580** | ~191 | Sin `node_modules`, sin `dist/`, sin `package-lock.json` |

*Comandos de verificación:* `find src -type f \( -name '*.jsx' -o -name '*.js' -o -name '*.css' \) -exec cat {} + | wc -l` y equivalentes por carpeta.

### 1.3 Distribución dentro de `src/` ✅

| Carpeta | Líneas |
|---|---:|
| `src/App.jsx` (monolito) | **16.658** |
| `src/lib/` (32 módulos) | 6.869 |
| `src/components/Finanzas/` (12 ficheros) | 5.065 |
| `src/components/SalaDeComandos/` (2) | 3.574 |
| `src/components/HectorDirectView.jsx` | 2.784 |
| `src/components/Shared/` (8) | 2.033 |
| `src/components/Gobernanza/` (3) | 1.962 |
| `src/components/MantenimientoView.jsx` | 1.620 |
| `src/components/Antesala/` (11 incl. 7 steps) | 1.525 |
| `src/components/Vault/` (3) | 1.237 |
| `src/components/ConsejoView.jsx` | 1.055 |
| `src/components/MiDiaView.jsx` | 1.032 |
| `src/components/MisLugaresView.jsx` | 821 |

### 1.4 Composición React ✅

| Tipo | Cantidad |
|---|---:|
| Componentes React (`*.jsx`) | 56 |
| Módulos JS puros (`*.js`) | 36 |
| Endpoints serverless (`api/*.js`) | 6 |
| Módulos librería (`src/lib/`) | 32 |
| Scripts totales (`scripts/*.mjs`) | 76 |
| Smokes E2E (`scripts/smoke/*.mjs`) | 48 (20 activos en `npm run smoke`) |
| Migraciones SQL versionadas | 6 |

---

## 2. Módulos funcionales

Todos los tamaños de código son verificados con `wc -l` sobre los ficheros implicados. El estado (Producción / Beta / Parcial / Prototipo) es 🟡 estimación del ejecutor basada en presencia de smokes, uso en producción por Antonio, y comentarios en código.

### 2.1 Chat y agentes IA

| Módulo | Ficheros principales | Líneas | Estado | Función |
|---|---|---:|---|---|
| **Héctor Directo** | `HectorDirectView.jsx` | 2.784 | 🟢 Producción | Chat 1:1 con Héctor. Streaming, memoria persistente (localStorage + Supabase `hector_chat`), TaskListCard, ActionProposal, invocación a especialistas vía `[INVOCAR:mario\|jorge\|alvaro\|gonzalo\|diego:tarea]`. Bloques `[ACTIONS]` (creación) y `[TASKS_LIST]` (consultas), `[RUTA]` (planificación día). Detector anti-fake-success + banner amarillo. Validación fechas post-LLM. Reescritura propositiva. |
| **Sala de Mando (HectorPanel)** | `SalaDeComandos/HectorPanel.jsx`, `HectorFloat.jsx` | 3.574 | 🟢 Producción | Análisis proactivo de Héctor sobre las tareas del CEO. Recomendaciones automáticas con "urgencia + impacto". Persiste en `hector_panel_state`. Widget flotante en toda la app. CEO Memory persistente. JSON-mode bloquea `[ACTIONS]` de creación (asimetría documentada con HectorDirect). |
| **El Consejo** | `ConsejoView.jsx` | 1.055 | 🟢 Producción | Selección de especialista (Mario Legal, Jorge Finanzas, Álvaro Inmobiliario, Gonzalo Gobernanza, Diego). Chat directo con cada uno. Guardado de documentos generados por el Consejo. Visibilidad dependiente de rol (owner vs member). |
| **Diego (Finanzas conversacional)** | `Finanzas/Diego.jsx` | 627 | 🟢 Producción | Analista financiero embebido dentro del bloque Finanzas. Puede crear/categorizar movimientos, conciliaciones, asientos contables PGC pyme, facturas. Genera bloques `[ACTIONS]` con `add_accounting_entry`, `add_invoice`, `update_bank_movement`, etc. |
| **Bruno Mantenimiento** | `MantenimientoView.jsx` | 1.620 | 🟢 Producción | Chat con especialista de mantenimiento. Registra incidencias, genera prompts de diagnóstico. Persiste en `hector_tickets` (Supabase). |

**Total 6 módulos de agente:** ~9.660 líneas.

### 2.2 Negociaciones con Consultor IA por hilo ✅

Estructura de `data.negotiations[N]` (verificado en `App.jsx:1499-1504` y `App.jsx:923-935`):

```
negotiation = {
  id, code (NEG-NNN), title, counterparty, status, ownerId, members[], visibility,
  projectId, relatedProjects[{projectId,role,priority}], relationships[], stakeholders[],
  documents[],              // adjuntos subidos por el CEO
  hectorChat[],             // hilo aislado de conversación por negociación
  hectorAnalysis,           // análisis actual del asesor
  briefing,                 // resumen ejecutivo
  memory: {                 // memoria a largo plazo por negociación
    keyFacts[], agreements[], redFlags[], chatSummaries[], updatedAt
  },
  sessions: [{              // sesiones de negociación (reuniones)
    id, attendees[], entries[],
    agentConversations[]    // conversaciones con especialistas dentro de la sesión
  }],
  result                    // outcome final
}
```

**Cada negociación tiene su propio hilo con Héctor**, con memoria persistente separada de la conversación global. Los stakeholders (personas externas), los redFlags y los keyFacts se acumulan a lo largo de la vida de la negociación. Cada sesión de negociación (reunión) puede tener su propio conjunto de conversaciones con especialistas. Estado: 🟢 **Producción** — usado activamente en el tenant de Antonio.

### 2.3 Gestión operativa

| Módulo | Fichero(s) | Líneas | Estado | Función |
|---|---|---:|---|---|
| **Tareas + Kanban** | `TaskKanban.jsx`, `Tasks/TaskTimeline.jsx`, dentro de `App.jsx` | 272 + inline | 🟢 Producción | Kanban drag-and-drop sin librería externa. Timeline por tarea (comentarios humanos + entradas IA). Refs `CODE-NNN` autogenerados. |
| **Proyectos** | inline en `App.jsx` | ~800 | 🟢 Producción | CRUD, código de 3 letras, colors, emojis, workspaces, ownerId/members, visibility private/team. |
| **Matriz de Eisenhower** | `lib/eisenhower.js` + inline | 8 + inline | 🟢 Producción | Q1-Q4 auto por urgencia + prioridad. |
| **Mi Día** | `MiDiaView.jsx` | 1.032 | 🟢 Producción | Vista diaria del CEO. Bloque unificado día (ruta Héctor + tareas del día). |
| **Cierre de Día** | `CierreDia.jsx` | ~200 | 🟢 Producción | Retrospectiva diaria. |
| **Briefing Matinal** | `BriefingMatinal.jsx` | ~200 | 🟢 Producción | Preview del día generado por Héctor. |
| **Pulso Dinámico** | `PulsoDinamico.jsx` | ~150 | 🟢 Producción | Indicador de estado del día. |
| **Riesgos Panel** | `RiesgosPanel.jsx` | ~200 | 🟢 Producción | Riesgos derivados detectados por Héctor. |

### 2.4 Rutas y ubicaciones

| Módulo | Fichero(s) | Líneas | Estado | Función |
|---|---|---:|---|---|
| **Mis Lugares** | `MisLugaresView.jsx`, `lib/places.js` | 821 + 62 | 🟢 Producción | Repositorio personal de sitios (dormir/comer/visitar/cafe/gasolina). Aislado por member. Salvar vía `[ACTIONS] save_place` de Héctor. |
| **DayPlanBlock (ruta)** | `Shared/DayPlanBlock.jsx`, `Shared/RutaCard.jsx`, `lib/dayPlans.js` | 316 + 211 | 🟢 Producción | Persistencia de rutas `[RUTA]` emitidas por Héctor. Indexadas por fecha. Ancla a `task.dueDate` para evitar desalineamientos. |
| **Google Maps URL** | `lib/mapsUrl.js` | 117 | 🟢 Producción | Generación de URLs Google Maps con paradas ordenadas. |
| **Geolocalización** | `lib/geolocation.js` | 125 | 🟢 Producción | Solicitud de ubicación al usuario con permisos, fallback a ciudad. |

### 2.5 Finanzas y contabilidad

| Módulo | Fichero(s) | Líneas | Estado | Función |
|---|---|---:|---|---|
| **Finance Dashboard** | `Finanzas/FinanceDashboard.jsx`, `lib/financeSummary.js` | 335 + 342 | 🟢 Producción | KPIs (saldo, ingresos/gastos/neto del mes, facturas pendientes, runway). Chart SVG nativo cash-flow. Top 5 gastos. Alertas financieras. |
| **Bancos** | `Finanzas/Bancos.jsx` | 610 | 🟢 Producción | Multi-empresa. CRUD cuentas. Sumatoria saldos. |
| **Tesorería** | `Finanzas/Tesoreria.jsx` | 331 | 🟢 Producción | Movimientos bancarios, categorización, reconciliación. |
| **Facturación** | `Finanzas/Facturacion.jsx`, `FacturaImportZone.jsx`, `InvoiceBulkImportModal.jsx` | 698 + inline + 439 | 🟢 Producción | Facturas emitidas y recibidas. Numeración YYYY/NNN auto. Import bulk desde PDF (con `lib/invoiceAI.js` para OCR/parse). PDF de exportación (`lib/invoicePdf.js`). |
| **Contabilidad PGC** | `Finanzas/Contabilidad.jsx`, `lib/parseAsientos.js`, `Shared/AsientoCard.jsx` | 625 + 132 + inline | 🟢 Producción | Libro diario. 30 cuentas PGC pyme sembradas. Asientos con `[ASIENTOS]` de Diego. Cuadre debe/haber. |
| **Importar Extracto** | `Finanzas/ImportExtractoModal.jsx` | 481 | 🟢 Producción | Parseo de CSV / Excel de bancos. Detección de duplicados. |
| **Conciliación** | `Finanzas/ConciliacionModal.jsx` | ~200 | 🟢 Producción | Cruce factura ↔ movimiento bancario. |
| **Export Gestoría** | `Finanzas/ExportGestoriaModal.jsx` | 340 | 🟢 Producción | Export contable trimestral para asesor. |

**Total Finanzas:** ~5.400 líneas (5.065 en carpeta + FinanceDashboard/summary). Bloque más maduro tras chat.

### 2.6 Gobernanza y compliance

| Módulo | Fichero(s) | Líneas | Estado | Función |
|---|---|---:|---|---|
| **Gobernanza principal** | `Gobernanza/GobernanzaView.jsx` | 776 | 🟢 Producción | Empresas (multi-empresa por CIF), obligaciones fiscales (Modelo 200/202/303/111/347/390/720/115), alertas por vencimiento, documentos societarios. |
| **Documentación tab** | `Gobernanza/DocumentacionTab.jsx`, `documentTemplates.js` | 980 + inline | 🟢 Producción | Plantilla de documentos societarios canónicos. |

### 2.7 Vault personal / familiar

| Módulo | Fichero(s) | Líneas | Estado | Función |
|---|---|---:|---|---|
| **Vault Owner** | `Vault/VaultView.jsx` | 729 | 🟢 Producción | Espacios personales del CEO y familiares. 35+ documentos por plantilla (`Vault/personalTemplates.js`, 146 líneas). PIN + accessToken por espacio para compartir sin login. Categorías: identificación, fiscal, propiedades, financiero, seguros, familia, vehículos, formación. Alertas por caducidad (DNI, pasaporte, ITV, seguros). |
| **Vault Invitado** | `Vault/VaultGuestView.jsx` | 362 | 🟢 Producción | Acceso guest vía URL `/vault/:token` con PIN. Sin login Kluxor. Auth vía `vault_token` + `vault_pin` en `POST /api/agent` (para chat con Bruno sobre el vault). |

### 2.8 El Umbral (onboarding invitaciones)

| Módulo | Fichero(s) | Líneas | Estado | Función |
|---|---|---:|---|---|
| **El Umbral (owner)** | `UmbralView.jsx`, `UmbralCard.jsx` | 500 + inline | 🟢 Producción | Panel para que un owner cree invitaciones a otros CEOs. Muestra invitaciones enviadas, revocadas, expiradas. |
| **InviteCEO** | `InviteCEO.jsx` | ~200 | 🟢 Producción | Formulario de invitación con nombre + email. Genera URL vía `POST /api/create-invite`. Copiado + link `wa.me`. |
| **Signup** | `SignupView.jsx`, `lib/signupPath.js` | ~200 + 21 | 🟢 Producción | Landing `/signup?token=…`. Crea usuario, tenant, taskflow_state con rollback si algo falla. |

### 2.9 Antesala (onboarding CEO nuevo)

| Módulo | Fichero(s) | Líneas | Estado | Función |
|---|---|---:|---|---|
| **Antesala Flow** | `Antesala/AntesalaFlow.jsx`, `AntesalaWelcome.jsx`, `AntesalaStep.jsx`, `AntesalaSummary.jsx` | 1.525 total (11 ficheros) | 🟢 Producción | Diálogo Héctor↔CEO en 7 pasos: nombre → empresa → equipo → frentes → time-sink → horario+ciudad → asesores actuales. Al terminar, materializa 3 proyectos y siembra opener de Héctor. |
| **Aplicador respuestas** | `Antesala/applyAntesalaAnswers.js` | ~100 | 🟢 Producción | Función pura idempotente que aplica las respuestas al `ceoProfile` con status `progressing` / `skipped` / `full-answered` / `completed`. |
| **Materializador frentes** | `Antesala/materializeAntesalaFronts.js` | ~120 | 🟢 Producción | Convierte los 3 frentes elegidos en proyectos reales con boards. |
| **Typewriter** | `Antesala/useTypewriter.js` | ~50 | 🟢 Producción | Efecto typewriter de Héctor en bloques 2 y 3. |

### 2.10 Landings y microsites ✅

| Fichero | Líneas | Función |
|---|---:|---|
| `public/kluxor-landing-es.html` | 1.882 | Landing magistral cordón rojo (español, prod) |
| `public/kluxor-landing-en.html` | 1.816 | Landing magistral (inglés) |
| `public/landing.html` | 1.055 | Landing legacy TaskFlow |
| `public/antesala.html` | 291 | Microsite Antesala |
| `public/umbral.html` | 267 | Microsite El Umbral |
| `public/landing-publica.html` | 272 | Landing pública alternativa |
| `public/accesos.html` | 198 | Microsite accesos |
| `public/vitrina.html` | 140 | Microsite vitrina |
| `public/presentacion.html` | 99 | Microsite presentación |

Total HTML: **6.020 líneas**. Todas hechas a mano, sin frameworks CSS.

### 2.11 Bibliotecas y utilidades (`src/lib/`) ✅

**32 módulos JS puros — 6.869 líneas totales.** Los mayores:

| Módulo | Líneas | Función |
|---|---:|---|
| `agent.js` | 1.689 | Motor de agentes (briefings, respuestas, comandos, avatares, tools de web search) |
| `agentActions.js` | 1.665 | Hub central: parseAgentActions, parseTasksList, parseRuta, detectFalseSuccessClaim (75 patrones), validateAndCorrectDueDate, validateTasksAgainstDatabase, rewriteToPropositive, executeAgentActions, stripCeoProfile, buildSpecialistContext, order interpreter |
| `financeSummary.js` | 342 | Cálculos financieros derivados (KPIs, cash-flow, obligaciones fiscales) |
| `voice.js` | 269 | TTS (Web Speech API) para agentes con voz |
| `storage.js` | 247 | Wrappers localStorage con expiración y namespacing |
| `invoicePdf.js` | 245 | Generación PDF facturas |
| `invoiceAI.js` | 233 | Parser IA de facturas subidas |
| `hectorContext.js` | 219 | Snapshot compacto del estado del CEO para meter en prompts |
| `dayPlans.js` | 211 | Persistencia rutas por fecha |
| `ics.js` | 192 | Parser de calendarios ICS (Google Calendar) |

---

## 3. Los agentes IA

### 3.1 Inventario ✅ (verificado en BD del tenant fundador)

Query: `SELECT data->'agents' FROM taskflow_state WHERE tenant_id='89934a37-…'`.

| ID | Nombre | Rol | promptBase (chars) | Specialties + ext |
|---:|---|---|---:|---|
| 1 | Mario Legal | Abogado mercantil senior (25+ años) | **17.093** | 9 + 5 |
| 2 | Héctor | Jefe de Gabinete Estratégico | **32.176** | 5 + 6 |
| 3 | Jorge Finanzas | Analista de Inversiones Senior (15+ años) | **31.503** | 8 + 5 |
| 4 | Álvaro Inmobiliario | Especialista Real Estate | **16.982** | 8 + 5 |
| 5 | Gonzalo Gobernanza | Especialista societario | **17.466** | 8 + 6 |
| 6 | Diego | Analista financiero + contable | **19.815** | 8 + 0 |
| **Total** | **6 agentes** | | **135.035 chars** | **46 + 27** |

**~33.759 tokens** de prompts sembrados por tenant. En el tenant de Antonio, los 6 promptBases pesan lo mismo que una novela corta.

### 3.2 Arquitectura del Consultor IA por negociación ✅

Cada `data.negotiations[N]` (verificado en `App.jsx:1499-1504` y `App.jsx:923-935`):

- **Hilo aislado:** `hectorChat[]` — mensajes solo de esta negociación, no se cruzan con el chat global de Héctor.
- **Análisis persistente:** `hectorAnalysis` — última evaluación estratégica generada por Héctor con framework Voss + Harvard + BATNA + 5 fuerzas + Aristóteles + Séneca.
- **Briefing:** `briefing` — resumen ejecutivo de la operación.
- **Documentación adjunta:** `documents[]` — contratos, propuestas, actas subidos por el CEO. Se envían como attachments al LLM.
- **Memoria a largo plazo:**
  - `memory.keyFacts[]` — hechos clave establecidos
  - `memory.agreements[]` — acuerdos alcanzados
  - `memory.redFlags[]` — señales de alerta detectadas
  - `memory.chatSummaries[]` — resúmenes de conversaciones previas para reingesta en siguientes turnos (previene saturación del contexto)
- **Sesiones (reuniones):** `sessions[N]` con `attendees[]`, `entries[]` (notas manuales del CEO), `agentConversations[]` (conversaciones con especialistas dentro de la sesión).
- **Stakeholders:** `stakeholders[]` — personas externas mapeadas con rol, influencia, notas.
- **Result:** outcome final (`cerrado_ganado` / `cerrado_perdido` / `acuerdo_parcial` / `archived`).

Estado: **🟢 Producción**. Estructura de datos madura, usada activamente. Sin librería externa de "AI framework" — todo hecho a medida.

### 3.3 Sistemas de validación post-LLM ✅

Todos en `src/lib/agentActions.js` (1.665 líneas). Enumerado por función exportada:

| Función | Líneas ~ | Función |
|---|---:|---|
| `parseAgentActions(responseText)` | 65 | Parser del bloque `[ACTIONS]{JSON}[/ACTIONS]`. Devuelve `{summary, confirmRequired, actions[]}` validando tipos permitidos. **NO se ejecuta si el JSON está malformado** (fallback silencioso). |
| `parseTasksList(responseText)` | 20 | Parser del bloque `[TASKS_LIST]{tareas}[/TASKS_LIST]` para consultas. Pipeline separado del de creación (asimetría deliberada). |
| `parseRuta(responseText)` | 45 | Parser del bloque `[RUTA]{json}[/RUTA]` para rutas del día. |
| `cleanAgentResponse`, `cleanTasksListBlock`, `cleanRutaBlock` | ~40 | Limpian los bloques marcados del texto visible al CEO. |
| `detectFalseSuccessClaim(text, actions)` | 12 | **75 patrones** en `SUCCESS_PATTERNS` que detectan afirmaciones falsas de éxito del LLM ("he creado la tarea", "actualicé la factura", etc.). Solo dispara si NO hay actions parseadas (evita falso positivo cuando sí hay `[ACTIONS]` real). Salida → banner amarillo al CEO. |
| `validateAndCorrectDueDate(dueDateString)` | 70 | Función pura. Corrige `dueDate` en año pasado (bug conocido: Sonnet 4.5 con cutoff enero 2025 emite años pasados). Scope reducido intencionalmente a `task.dueDate` — no toca fechas de facturas/movimientos (Diego debe registrar operaciones reales del pasado). |
| `correctActionsDates(proposal)` | 25 | Aplica `validateAndCorrectDueDate` sobre toda la propuesta de ACTIONS. |
| `resolveDueDate(relative)` | 65 | Convierte fechas relativas ("hoy", "mañana", "+7d") a ISO. |
| `validateTasksAgainstDatabase(emittedTasks, allRealTasks, projectCodeFilter)` | 130 | Filtra las tareas emitidas por Héctor en `[TASKS_LIST]` contra las tareas reales en `data.boards`. Descarta las que Héctor inventó. |
| `rewriteToPropositive(summaryText)` | 30 | **32 verbos en pasado → infinitivo** (créo → crear, actualicé → actualizar, envié → enviar). Convierte el summary del ACTIONS a lenguaje propositivo antes de la confirmación del CEO. |
| `flattenRealTasks(data)` | 20 | Aplanador de `data.boards` para pasarlo a `validateTasksAgainstDatabase`. |
| `detectProjectCodeFilter(message, projects)` | 30 | Detecta si el CEO mencionó un código de proyecto en su mensaje para filtrar consultas de tareas. |
| `classifyReply(text)` | 55 | Clasifica respuesta ambigua sí/no del CEO (para confirmaciones de ACTIONS). |
| `stripCeoProfile(promptBase)` | 5 | Quita bloque `PERFIL CEO:` del promptBase cuando el user activo no es owner. Blindaje intra-tenant (miembros del equipo no ven info privada del CEO). |
| `buildSpecialistContext(ceoProfile)` | 25 | Prepend defensivo al system prompt de especialistas para tenants no-Antonio: fuerza al modelo a no mencionar Antonio/Alma Dimo/Kluxor/Marbella si el CEO es distinto. |
| `buildOrderInterpreterSystemPrompt(todayISO)` | 25 | System prompt del intérprete de órdenes naturales sobre una tarea concreta (modo diferente al de `[ACTIONS]`). |
| `parseOrderInterpreterJson(text)` | 40 | Parser + whitelist de campos modificables (`ORDER_FIELD_WHITELIST`). |
| `suggestNegotiationEmoji(title, desc)` | 25 | Heurística de emoji auto para negociaciones (91 emojis mapeados por keywords). |
| `resolveCompanyId`, `resolveAssignees`, `sanitizeTaskLinks` | 60 | Helpers de resolución/validación de IDs y URLs. |
| `executeAgentActions(actions, helpers)` | 500 | **Hub central de ejecución**. Aplica cada acción validada (`create_project`, `create_tasks`, `create_negotiation`, `create_movement`, `update_bank_movement`, `add_bank_movement`, `add_accounting_entry`, `add_invoice`, `update_invoice`, `save_place`) al `data`. Firma de retorno: `{ok, appliedActions, errors}`. |

**Filosofía documentada:** "Cuando el modelo es impredecible, NO lo discutas en el system prompt. Verifícalo en el frontend con datos reales o reglas deterministas." Explicitada en `CLAUDE.md` como "patrón ganador post-LLM".

**Marcas de versión:** `ACTIONS_v18` (última). Migración idempotente en `_migrate` bumpea la versión persistida en promptBases de agentes existentes.

---

## 4. Datos e infraestructura

### 4.1 Tablas Supabase ✅

Verificado con `SELECT count(*) FROM <tabla>` con service_role el 2026-08-21.

| Tabla | Rows | Función |
|---|---:|---|
| `tenants` | 8 | Identidad de cada CEO. Columnas: `id (uuid)`, `name`, `owner_uid (uuid)`, `plan`, `status`, `trial_start`, `trial_ends_at`, `created_at`. RLS activa. |
| `tenant_members` | 11 | Vinculación users↔tenants con `role ('admin'\|'member')`. RLS activa. |
| `taskflow_state` | 8 | Fila JSONB por tenant con TODO el estado de la app (`data`). Columnas: `id (bigint IDENTITY)`, `tenant_id (uuid)`, `data (jsonb)`, `updated_at`. RLS **FORCE** (bloquea incluso al owner de la tabla). |
| `hector_chat` | 6 | Historial de chat de cada user_id (auth.uid). Columnas: `user_id (uuid)`, `messages (jsonb)`, `updated_at`. Realtime activo. |
| `hector_panel_state` | ? | Estado persistente de la Sala de Mando por user. |
| `hector_tickets` | ? | Incidencias registradas por Bruno Mantenimiento. |
| `ceo_memory` | ? | (Referenciada por código, pendiente migración `ceo_decisions` según CLAUDE.md) |
| `invitations` | 9 | Invitaciones El Umbral. Columnas: `id`, `token (uuid unique)`, `email`, `name`, `invited_by (uuid)`, `tenant_id (nullable)`, `expires_at`, `used_at`, `revoked_at`. Constraint email lowercase + shape básico. |

**Total: 8 tablas de dominio.** Todas con RLS activa. `taskflow_state` con `FORCE ROW LEVEL SECURITY` (blindaje reforzado tras el "incidente emergency-rls" de julio 2026).

### 4.2 Migraciones versionadas ✅

`ls migrations/`:

| Fichero | Fecha | Cambio |
|---|---|---|
| `2026-06-14-fase1-tenant-id.sql` | 14/06 | Añade `tenant_id` a `taskflow_state`. Crea tabla `tenants`. Backfill del tenant fundador `89934a37-…`. |
| `2026-07-12-emergency-rls-taskflow-state.sql` | 12/07 | **DROP** de todas las políticas RLS previas y re-creación con `FORCE ROW LEVEL SECURITY`. Cierra vector RLS bypass detectado. |
| `2026-08-18-invitations-table.sql` | 18/08 | Crea `invitations` con token único, constraints email. |
| `2026-08-18-invitations-name.sql` | 18/08 | Añade columna `name` a invitations. |
| `2026-08-18-taskflow-state-identity.sql` | 18/08 | Cambia PK a `IDENTITY` para evitar colisión con `id=1` (Antonio) en signups. |
| `2026-08-18-tenants-signup-columns.sql` | 18/08 | Añade `plan`, `status`, `trial_start`, `trial_ends_at` a tenants. |

**6 migraciones**, todas idempotentes (envueltas en `BEGIN/COMMIT` con `IF NOT EXISTS`).

### 4.3 Endpoints serverless (Vercel) ✅

`ls api/*.js` → 6 endpoints + 2 libs de servicio (`api/_lib/supa.js`, `api/_lib/blank-state.js`).

| Endpoint | Método | Autenticación | Función |
|---|---|---|---|
| `/api/agent` | POST | Bearer JWT Supabase **O** `{vault_token, vault_pin}` | Proxy a Anthropic API (Claude Sonnet 4.5). `maxDuration:180`s. Body: `{system, messages, max_tokens?, attachments?, vault_token?, vault_pin?}`. **~254 líneas.** Cierre B1 (19/08/2026) — el vector que agotó saldo Anthropic está cerrado. |
| `/api/create-invite` | POST | Bearer JWT (owner de tenant) | Genera invitación con token UUID, expiración 7 días, atada a email. URL canonicalizada a `kluxor.com` (fix 21/08). |
| `/api/signup` | POST | Ninguna (usa token de invitación) | Crea auth.user + tenant + taskflow_state + tenant_members + marca invite como usada. Rollback completo si cualquier paso falla. Guard `id!=1` (protege fila fundador). |
| `/api/revoke-invite` | POST | Bearer JWT | Marca `revoked_at`. Guard: solo el creador puede revocar (`invited_by === auth.uid()`). |
| `/api/mark-first-login` | POST | Bearer JWT | Marca `trial_start = now()` en el tenant del caller. Idempotente. |
| `/api/fetch-url` | GET | Sin auth (uso interno) | Descarga URL pública y devuelve texto limpio para pasar al LLM. |

**Total endpoints: 6.** Todos con validación de método (405 si no coincide) y respuestas JSON estructuradas.

### 4.4 Integraciones externas ✅

| Servicio | Uso | Estado |
|---|---|---|
| **Supabase** | Auth + Postgres + Realtime + Storage | 🟢 Producción crítica. Instancia `iqilkicirtmmpvykogot.supabase.co`. |
| **Anthropic** | Claude Sonnet 4.5 (por defecto), Opus para tareas específicas. Multimodal (documentos, imágenes). | 🟢 Producción. API key en env Vercel. Cierre B1 impide fugas. |
| **Vercel** | Hosting SPA + serverless functions + preview URLs por PR. Deploy automático desde `main`. | 🟢 Producción. Custom domain `kluxor.com`. |
| **Google Calendar (ICS)** | Sincronización lectura vía ICS URL. Proxy `api.allorigins.win` para evitar CORS. | 🟡 Parcial (solo lectura, sin OAuth) |
| **Google Maps** | URLs de navegación con paradas (generadas, no API) | 🟢 Producción (URL sin key) |
| **WhatsApp** | Enlaces `wa.me` (no Twilio) | 🟡 Solo enlaces, sin API real |

---

## 5. Seguridad y calidad

### 5.1 Modelo de aislamiento multi-tenant ✅

**3 capas superpuestas:**

1. **Capa BD (Supabase RLS):**
   - `taskflow_state` con `FORCE ROW LEVEL SECURITY`. Cada SELECT/UPDATE/DELETE se filtra por `tenant_id` derivado de `current_tenant_id()` (RPC que resuelve el tenant del `auth.uid()`).
   - `tenants`, `tenant_members`, `hector_chat`, `invitations`: RLS activa. Cada user solo ve las filas donde participa.
   - Auditado con `scripts/smoke/smoke_f1_rls_full_audit.mjs`: verifica que INSERTs cross-tenant son bloqueados.

2. **Capa aplicación (React):**
   - `src/lib/permissions.js` — matriz de permisos por feature por member (agentes IA, finanzas, etc.).
   - `src/lib/visibility.js` — filtra proyectos/tareas por membership antes de renderizar (fix `07/07/2026` tras incidente Elena veía proyectos de Antonio).
   - `stripCeoProfile` y `buildSpecialistContext` — sanitizan prompts al LLM cuando el user activo no es owner del tenant.

3. **Capa auth (Supabase Auth):**
   - JWT Bearer requerido en 5/6 endpoints. `/api/agent` acepta también `vault_token+PIN` para invitados.
   - `resolveSessionMember(session, members)` en cliente vincula `auth.user.id` con `data.members[N].supabaseUid` — sin match, "Acceso no autorizado".

**Verificación:** smoke `smoke_fase2_isolation.mjs` (lecturas cross-tenant bloqueadas), `smoke_visibility_isolation.mjs` (intra-tenant), `smoke_places_isolation.mjs` (Mis Lugares por member), `smoke_c1.mjs` (owner vs member en Consejo), `smoke_c2.mjs` (feature-flag Consejo por rol), `smoke_no_founder_data_leak.mjs` (fix 21/08/2026: escritura de seeds cross-tenant).

### 5.2 Suite de tests ✅

`ls scripts/smoke/*.mjs` → **48 ficheros de smoke**, 20 activos en `npm run smoke`.

**Cobertura por categoría:**

| Categoría | Smokes activos |
|---|---|
| Aislamiento multi-tenant | `smoke_fase2_isolation`, `smoke_visibility_isolation`, `smoke_places_isolation`, `smoke_no_founder_data_leak`, `smoke_chat_key_isolation` |
| Aislamiento intra-tenant (Consejo, roles) | `smoke_c1`, `smoke_c2` |
| Endpoints y auth | `smoke_signup_routing`, `smoke_umbral_routing`, `smoke_b1_agent_auth`, `smoke_landing_redirect` |
| Parseo y validación LLM | `smoke_false_success_detector`, `smoke_parse_ruta`, `smoke_maps_url`, `smoke_save_place`, `smoke_day_plan` |
| Antesala | `smoke_antesala_persist` (15 casos), `smoke_antesala_materialize` (7 casos) |
| E2E creación | `smoke_create_task_e2e` |

**Total: ~200 checks explícitos** entre todos los smokes (los grandes tienen 20-30 checks cada uno). Suite corre en <60 segundos localmente.

**Smoke:prod** — verifica que canary strings del último commit están servidas en el bundle prod de Vercel. Ejecutable tras cada push.

### 5.3 Autenticación y rate limiting

- **Auth:** Bearer JWT Supabase (email + password, sin 2FA hoy). Trial 7 días desde `mark-first-login`.
- **Rate limiting:** ❌ No implementado. `/api/agent` sin límite por caller.
- **RLS forzada:** ✅ Sí (`FORCE ROW LEVEL SECURITY` en la tabla crítica).
- **HTTPS:** ✅ Sí (Vercel).
- **Secrets:** en env vars de Vercel + `.env.local` para desarrollo. Nunca committeadas.

---

## 6. Lo que NO existe

Contado a partir de:
- `CLAUDE.md § Próximos pasos vigentes` (9 items).
- Memoria del ejecutor (`project_taskflow.md`, `project_hector_prompt_saturation.md`).
- Grep de `TODO/FIXME/HACK/pendiente` (271 ocurrencias en el código).

### 6.1 Funcionalidad no implementada / a medias

| Item | Estado real | Impacto |
|---|---|---|
| **Auth por miembro** — que cada member (no admin) vea solo su vista | 🟡 Parcial. Existe `permissions.js` pero el usuario auth es siempre el owner del tenant. Members "reales" vía Supabase Auth aún no. | Alto para expansión a equipos grandes |
| **Google Calendar OAuth2** — leer/escribir eventos reales | ❌ No implementado. Solo lectura vía ICS URL con proxy CORS. | Alto para operativa CEO |
| **WhatsApp Twilio** — envío real de mensajes | ❌ No implementado. Solo enlaces `wa.me`. | Medio |
| **Sincronización chat entre dispositivos** — de localStorage a Supabase | 🟡 Parcial. HectorDirect ya sincroniza a `hector_chat` en Supabase (con realtime). HectorPanel (Sala de Mando) NO. | Alto |
| **HectorPanel — paridad con HectorDirect** — TaskListCard, validaciones post-LLM, reescritura propositiva | 🟡 Parcial. Asimetría documentada en CLAUDE.md. HectorPanel carece de 4 de los 6 validadores de HectorDirect. | Medio |
| **Héctor Intérprete** — módulo de traducción contextual con voz | ❌ No implementado. Prioridad CEO según CLAUDE.md. | Alto para uso móvil |
| **Deep link clicable** desde TaskListCard a tarea concreta | ❌ No implementado. Hoy degrada a `onNavigate("mytasks")`. | Bajo |
| **Sistema memoria decisiones CEO** (`ceo_decisions` en Supabase) | ❌ No implementado. Hoy `ceoMemory` vive dentro de `data.ceoMemory` (JSONB per-tenant). | Medio |
| **Refactorización de App.jsx** — 16.658 líneas | ❌ Pendiente. Sesión dedicada, sin features nuevas. | Alto para velocidad de desarrollo |
| **Storage para adjuntos grandes** (PDFs, imágenes) | 🟡 Parcial. Se usan attachments base64 en `/api/agent`. Sin bucket de Supabase Storage con TTL. | Medio |
| **Backup automático de BD** | 🟡 Parcial. Docs de dump policies en `F0` (memoria). No hay cron automático propio. | Alto para producción con CEOs pagos |
| **Rate limiting `/api/agent`** | ❌ No implementado. Vector potencial de agotamiento de saldo Anthropic (mitigado por auth B1, pero no bloqueado). | Alto |
| **2FA** | ❌ No implementado. | Medio (privacidad CEO) |
| **D2 clasificador post-Héctor** | ❌ Revertido tras 4 fallos en producción. Documento del rediseño en `docs/hector-d2-fallos.md`. | (bloqueado en backlog) |
| **Feature flags reales** | 🟡 Solo `localStorage.getItem("kluxor.legacyMode")` como flag manual. No hay GrowthBook / LaunchDarkly. | Medio |
| **Observabilidad / monitoring** | ❌ No hay Sentry, Datadog, LogRocket. Solo console logs y smoke:prod. | Alto |
| **Onboarding de members no-owner** (para invitados que se unen a un tenant existente) | 🟡 Parcial. El flujo signup crea SIEMPRE un tenant nuevo. Onboards manuales (Luis, Robert) por script. | Medio |

### 6.2 Deuda técnica explícita

- **`memberSeed.id === 0` en signup vs Antonio con `id === 6`.** Colisión potencial cross-tenant en cualquier estructura scoped por `member.id` numérico. Mitigado hoy en localStorage vía `authUid`; queda como deuda estructural.
- **App.jsx monolito de 16.658 líneas.** Todo el orquestador, migración de versiones ACTIONS, state global. Refactorización explícitamente listada como próximo paso.
- **Prompt saturation en Héctor (33k chars).** Reglas nuevas al final del promptBase NO funcionan bien — Sonnet prioriza cabecera. Rediseño estructural pendiente (memoria `project_hector_prompt_saturation.md`).
- **Seeds hardcoded del founder ya blindados hoy** (21/08/2026), pero el patrón "escribir cross-tenant" era viable. Nuevo smoke `smoke_no_founder_data_leak.mjs` cierra el vector.
- **271 marcadores TODO/FIXME/HACK/pendiente/WIP** en el código (grep verificado). Distribución no analizada por falta de tiempo — un due-diligence técnico debería auditarlos.

---

## 7. Esfuerzo de reconstrucción

### 7.1 Metodología

Estimación 🟡 **basada en el inventario verificado**, no en horas trabajadas. Se calcula **meses-persona (MP) por perfil** para reconstruir el mismo scope desde cero, con la calidad actual (RLS, smokes, validadores post-LLM, UX pulida).

Supuestos:
- Equipo profesional senior (no junior), remoto, con conocimiento previo del stack React/Supabase/Vercel.
- Sin sacar features nuevas — reconstruir exactamente lo que hay.
- Sprints de 2 semanas, ritmo sostenible.
- 1 MP = 4 semanas laborables efectivas (asumiendo overhead de coordinación, code review, QA).
- Cifras ancla del código: ~74.500 líneas, 6 agentes de 17-32k chars cada uno, 6 endpoints, 8 tablas RLS, 200+ smoke checks, 6 migraciones.

### 7.2 Desglose por perfil

| Perfil | MP | Justificación (basada en inventario) |
|---|---:|---|
| **Backend / Supabase engineer** | **4,0** | 6 endpoints serverless con rollback + validación auth (~876 líneas + 2 libs). 8 tablas con RLS `FORCE` (auditadas). 6 migraciones idempotentes. Multi-tenant desde el día 1 con `tenant_id` en JSONB (patrón no trivial). Suite smoke_f1_rls_* (auditoría determinística de escritura cross-tenant). Onboarding scripts (Luis, Robert) con rollback completo. |
| **Frontend React engineer** | **10,0** | 48.713 líneas de React sin librería CSS ni componentes externos. 56 componentes JSX + 32 módulos JS puros. Kanban drag-and-drop nativo. 12 pantallas de Finanzas (Bancos, Tesorería, Facturación, Contabilidad PGC, Diego chat, Conciliación, Export gestoría, Dashboard con SVG chart nativo, Importadores). Gobernanza multi-empresa. Vault personal + Guest con PIN. Mi Día, Cierre, Briefing, Pulso. Antesala 7 pasos con typewriter. El Umbral. 9 landings/microsites HTML a mano (6.020 líneas). |
| **AI / Prompt engineer** | **6,0** | 6 agentes especializados con promptBase de 17-32k chars cada uno (135k totales, ~34k tokens). Cada uno con `advice{default,overdue,noDueDate,noSubtasks,overBudget,q1,q2,...}`, `specialtiesExtended`, `opener`, `style`, `voice`. Consultor IA por negociación con hilo aislado, memoria persistente (keyFacts/agreements/redFlags/chatSummaries), sesiones anidadas con agentConversations, briefings, análisis Voss+Harvard+Aristóteles+Séneca. **~20 validadores post-LLM** (agentActions.js 1.665 líneas): 3 parsers de bloques marcados (`[ACTIONS]/[TASKS_LIST]/[RUTA]`), detector fake-success con 75 patrones, validador de fechas con corrección año, validador de tareas contra BD, reescritura propositiva 32 verbos, order interpreter con whitelist, buildSpecialistContext defensivo, stripCeoProfile intra-tenant. Sistema de migraciones de versión de prompt (ACTIONS_v1→v18 con corte por marcador). Anti-patrones documentados (D2 revertido, saturación de prompt). |
| **UX / Product Designer** | **3,0** | Rediseño integral de landings ES + EN (1.882 + 1.816 líneas). Antesala como diálogo con typewriter en bloques 2/3 (decisión de tono explícita). El Umbral con estética "cordón rojo silent luxury". Vault con PIN + accessToken (UX invitado sin login). Regla de forma explícita (border-radius 0 en marca externa, suave en app operativa). Sistema de emojis validado, 91 emojis mapeados en negociaciones. 6 avatares con voice profiles distintos. |
| **QA / Test engineer** | **2,0** | 48 smoke files, 20 activos en suite `npm run smoke`. ~200 checks explícitos. Cobertura: aislamiento multi-tenant, intra-tenant, endpoints/auth, parsers y validadores LLM, Antesala persist+materialize, E2E creación. Auditoría determinística RLS de escritura cross-tenant. `smoke:prod` con detección de canary en bundle. Suite corre en <60s. |
| **Product Manager / CEO técnico** | **2,0** | Definición de 20+ módulos funcionales cohesionados. Filosofía documentada (post-LLM > prompt engineering). Priorización de scope (borrado de features fallidas como D2). CLAUDE.md como brújula operativa (9 próximos pasos vigentes, glosario, anti-patrones). Trazabilidad de decisiones por commit (624 commits con mensajes descriptivos). |
| **DevOps / Deploy** | **0,5** | Vercel deploy auto desde main. `vercel.json` con routing custom. Vercel serverless con `maxDuration:180`. Custom domain `kluxor.com`. Env vars gestionadas. Sin CI/CD complejo (Vercel se encarga). Preview URLs por PR. |
| **Legal / compliance / contenido** | **0,5** | Textos legales de landings. Redacción de invitación El Umbral. Copy de la Antesala (7 pasos, tono medido). Contenido de landings ES + EN. Docs internos. Sin abogado externo (deuda). |

### 7.3 Totales

**Esfuerzo total: 28,0 meses-persona** (rango razonable **26-32 MP** según overhead real de coordinación).

### 7.4 Plazo de calendario

Un equipo mínimo viable **no puede paralelizar todo** — hay dependencias fuertes:

- Backend + AI + Frontend en fase inicial pueden solaparse.
- QA arranca cuando hay superficie estable (mes 3+).
- UX ancla decisiones desde el día 1.

**Escenario A · Equipo pequeño (3 senior):** 1 fullstack, 1 AI, 1 UX/frontend. Ratio real de paralelización ~40%. Plazo: **11-13 meses calendario**.

**Escenario B · Equipo intermedio (5-6):** 1 backend, 2 frontend, 1 AI/prompt, 1 UX, 1 QA. Ratio ~55%. Plazo: **7-8 meses calendario**.

**Escenario C · Equipo agresivo (8-10):** duplica frontend y AI, añade PM. Ratio ~65%. Plazo: **5-6 meses calendario**. Rendimientos decrecientes marcados por complejidad de coordinación en el core de agentes IA (que resiste paralelización).

**Recomendación:** Escenario B ofrece la mejor relación esfuerzo/plazo. Un equipo de 3 tarda casi el doble por serialización forzosa; uno de 8-10 no baja del rango 5-6 meses por dependencias funcionales.

### 7.5 Advertencia sobre esta estimación

Esta cifra es **conservadora** — asume que el equipo receptor ya conoce el patrón "verificación post-LLM > prompt engineering" que Kluxor documenta en CLAUDE.md y en la memoria del ejecutor. Un equipo que aterriza sin esa filosofía tarda más y comete los mismos errores que Antonio ya cazó y revirtió (7 commits exitosos + 2 reverts en una sesión típica, documentado en CLAUDE.md).

**No se ha incluido:** costes de infraestructura (Supabase Pro, Anthropic API, Vercel Pro, dominio), horas de discusión con el CEO cliente para replicar el "criterio de producto" que hoy está solo en la cabeza de Antonio, ni el coste de las 2-3 iteraciones típicas de UX antes de que un módulo quede "vestido para ver a un inversor".

**Referencia de plausibilidad:** el propio Antonio (no-programador, con asistencia de IA) ha llegado hasta aquí en 4 meses calendario con ~140h de codificación con commit (+ tiempo estratégico y de decisión no medible). Un equipo profesional debería recorrer ese mismo camino en 7-8 meses reales si preserva calidad y no toma atajos.

---

## Apéndice A · Comandos de verificación reproducibles

Todas las cifras marcadas ✅ se pueden reproducir por auditor externo:

```bash
# Volumen
git log --format='%aI' --reverse | sed -n '1p;$p'
git rev-list --count HEAD
find src -type f \( -name '*.jsx' -o -name '*.js' -o -name '*.css' \) -exec cat {} + | wc -l
find api -type f -name '*.js' -exec cat {} + | wc -l
find scripts -type f -name '*.mjs' -exec cat {} + | wc -l
find migrations -type f -exec cat {} + | wc -l
find public -type f \( -name '*.html' \) -exec cat {} + | wc -l

# Componentes
find src -name '*.jsx' | wc -l
find src -name '*.js' | wc -l
find src/lib -type f | wc -l

# Endpoints
ls api/*.js

# Agentes (requiere SUPABASE_SERVICE_ROLE_KEY)
node --env-file=.env.local -e "
  import { createClient } from '@supabase/supabase-js';
  const a = createClient('https://iqilkicirtmmpvykogot.supabase.co', process.env.SUPABASE_SERVICE_ROLE_KEY);
  const { data } = await a.from('taskflow_state').select('data').eq('tenant_id', '89934a37-60d9-49ac-8a41-dad10601ad81').single();
  console.log(data.data.agents.map(x => [x.id, x.name, (x.promptBase||'').length]));
"

# Suite smokes
cd scripts/smoke && cat package.json | grep '"all"'
grep 'check(' scripts/smoke/*.mjs | wc -l

# Migraciones
ls migrations/*.sql

# TODOs
grep -rnE "TODO|FIXME|HACK|deuda|pendiente|WIP" src api scripts --include='*.js' --include='*.jsx' | wc -l
```

---

**Fin del inventario.**
Documento redactado el 2026-08-21 a partir del estado del repo en HEAD `39f74dc` y BD Supabase de producción.
