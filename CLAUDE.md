# CLAUDE.md — Kluxor

Sistema vivo en producción. Antes de tocar código, lee estas reglas. No son sugerencias.

---

## Identidad del proyecto

**Kluxor — CEO Operating System** con IA multi-agente. Marca paraguas: *Kluxor — Silent Luxury Circle*. Categoría nueva (no CRM, no chatbot). Antes se llamaba SoulBaric / TaskFlow — referencias a esos nombres están obsoletas.

---

## Stack

- **React 18** + **Vite 5**
- **Supabase** (auth + Postgres + RLS activo)
- **Claude Sonnet 4.5** vía API (timeout Héctor 60s, Mario 90s, otros 45s)
- **Vercel** (deploy automático desde main)
- Sin librerías de UI externas — CSS inline con variables propias
- Repo: github.com/qnfinanzas-collab/Tareas-equipo
- Local: `/Users/antoniodiaz/Desktop/ap tipo trello`

---

## Arrancar en local

```bash
npm install
npm run dev        # → http://localhost:3000
npm run build      # → dist/
npm run preview    # previsualiza el build
```

---

## Estructura del proyecto

```
kluxor/
├── index.html
├── vite.config.js
├── vercel.json           # routing /landing.html + SPA catch-all
├── package.json
├── public/
│   └── landing.html      # landing magistral cordón rojo
└── src/
    ├── main.jsx
    ├── App.jsx           # ~10000 líneas, en proceso de refactorización
    ├── components/
    │   ├── HectorDirectView.jsx
    │   ├── HectorPanel.jsx          # Sala de Mando
    │   ├── ActionProposal.jsx       # card oro (no tocar lógica)
    │   └── ...
    └── lib/
        └── agentActions.js          # hub central
```

---

## Archivos críticos

- **`App.jsx`** — orquestador, state global, migración de versiones ACTIONS. Necesita refactorización.
- **`src/lib/agentActions.js`** — hub central. Contiene:
  - `parseAgentActions` — parser de [ACTIONS] (creación)
  - `parseTasksList` / `cleanTasksListBlock` — parser de [TASKS_LIST] (consultas)
  - `detectFalseSuccessClaim` — 58 patrones, banner amarillo
  - `validateAndCorrectDueDate` — corrige año pasado (scope reducido a task.dueDate)
  - `validateTasksAgainstDatabase` — filtra tareas inventadas contra data.boards
  - `rewriteToPropositive` — 32 verbos pasado→infinitivo
  - `AGENT_ACTIONS_ADDON` — system prompt addon (v10)
- **`src/components/HectorDirectView.jsx`** — chat directo con Héctor
- **`src/components/HectorPanel.jsx`** — Sala de Mando (asimetrías importantes)
- **`src/components/ActionProposal.jsx`** — card oro de propuestas (recibe datos ya procesados, **no tocar lógica**)

---

## Pipelines paralelos (CRÍTICO)

Hay dos pipelines independientes que NO se deben mezclar:

- **Creación:** parseAgentActions → ActionProposal oro → ejecución
- **Consulta:** parseTasksList → TaskListCard gris azulado → solo lectura

Tocar uno NO afecta al otro. Esto protege la creación de tareas cuando se arregla algo en consultas. Cualquier fix nuevo debe respetar esta separación.

---

## Asimetría HectorDirect vs HectorPanel

| Capacidad | HectorDirect | HectorPanel |
|-----------|:---:|:---:|
| Detector anti-fake-success | ✅ | ✅ |
| Banner amarillo | ✅ | ✅ |
| TaskListCard | ✅ | ❌ |
| Validación tareas post-LLM | ✅ | ❌ |
| Validación fechas post-LLM | ✅ | ❌ (inyecta fecha en prompt) |
| Reescritura propositiva | ✅ | ❌ |
| Parseo [INVOCAR:] | ✅ | ❌ |
| CEO Memory persistente | ❌ | ✅ |
| JSON-mode (bloquea [ACTIONS] de creación) | ❌ | ✅ |

**Diego** vive en función separada (`callDiegoDirect`).
**Sincronización HD↔HP** vía localStorage compartido (no entre dispositivos).

---

## Datos predefinidos

### Usuarios (constante `MP[]`, indexada por member.id)

| ID | Nombre        | Color    | Rol     | ICS configurado |
|----|---------------|----------|---------|-----------------|
| 5  | Marc Díaz     | Coral    | Manager | Sí (URL en INITIAL_DATA) |
| 6  | Antonio Díaz  | Rosa     | Editor  | No              |
| 7  | Albert Díaz   | Verde    | Editor  | No              |
| 0–4| Equipo demo   | Varios   | Varios  | No              |

### Disponibilidad

Objeto `avail` en cada miembro. Ver `BASE_AVAIL` para defaults. Mañanas 08:00–13:00 fijas reservadas en el planificador IA.

### ICS Google Calendar

Para evitar bloqueos CORS del navegador, el fetch ICS pasa por proxy: `api.allorigins.win`.

### ACTIONS

**Versión actual: v10.** Cada bump tiene migración en App.jsx. v11 fue revertida (anti-fabrication causó regresión).

---

## Filosofía post-LLM (patrón ganador)

Cuando el modelo es impredecible, NO lo discutas en el system prompt. Verifícalo en el frontend con datos reales o reglas deterministas.

Casos validados (todos en commits del 02/05/2026):
- **Fechas (fa328df):** validateAndCorrectDueDate corrige año pasado, scope reducido a task.dueDate
- **Tareas inventadas (5430355):** validateTasksAgainstDatabase filtra contra data.boards
- **Lenguaje propositivo (a3ab1a2 + 28887ae):** rewriteToPropositive reescribe verbos en pasado

**Cuándo NO aplicar post-LLM:** cuando el dato no existe en frontend ni BD, o cuando el cambio es puramente cosmético.

---

## Anti-patrones (NO repetir)

### ❌ Modificar system prompt para controlar fechas
**Caso:** dateBlock al inicio del prompt (commit 54a360b)
**Resultado:** Héctor dejó de emitir [ACTIONS]. Revertido.
**Lección:** fechas se validan post-LLM, no se inyectan en prompt de HectorDirect.

### ❌ Reglas amplias de "no inventes" en el prompt
**Caso:** anti-fabrication-v1 con regla v11 (commit e92a252)
**Resultado:** Héctor interpretó "proponer crear" como "fabricar" y bloqueó creación. Revertido.
**Lección:** validación post-LLM contra BD real, no reglas de prompt.

### ❌ Duplicar funciones entre vistas
**Lección:** funciones compartidas viven en agentActions.js exportadas. Cada vista las importa. Si añades fix en una vista, evalúa propagarlo a las demás.

### ❌ Tocar variables/keys/funciones en rebrandings
**Lección:** solo strings visibles. Nunca renombrar variables, claves de localStorage o funciones.

### ❌ Confiar en lo que el modelo dice que ha hecho
**Lección:** verificar SIEMPRE en BD. El detector + banner protege visualmente, pero la verificación contra BD es la única verdad.

---

## Protocolo obligatorio para cambios

1. **Diagnóstico ANTES de tocar.** Si el bug toca system prompt, ACTIONS_v*, parseAgentActions o agentActions.js: investigar primero, reportar plan, esperar aprobación.
2. **Plan con confirmación.** No implementar sin que Antonio (o Claude.ai) apruebe explícitamente.
3. **Implementación.** Commit local SIN push hasta validación.
4. **Tests de regresión obligatorios.** Especialmente el que protege la creación de tareas.
5. **Push solo si tests pasan.**
6. **Validación en producción con HARD RELOAD.** Cmd+Shift+R obligatorio tras cada deploy.
7. **Si hay regresión, revert sin titubear.** Cada commit es prueba antes del siguiente.

---

## Reglas de código no negociables

1. **Border-radius 0 en todo.** Cero esquinas redondeadas.
2. **Sin frameworks CSS** en producción (Tailwind solo en artifacts).
3. **No duplicar funciones** — exportar desde agentActions.js.
4. **Funciones de validación deben ser puras** (sin side effects).
5. **Logging consola obligatorio** cuando hay corrección automática (trazabilidad).
6. **Cero emojis** salvo los 6 de agentes (🧙 ⚖️ 💰 📊 🏠 🏛️) y funcionales validados (✅ ❌ ℹ️ 🔍 ⚠️).
7. **No tocar la lógica de creación** ([ACTIONS]) cuando trabajes en consultas o UX.
8. **Matching de strings con duda:** preferir falso positivo (mostrar) sobre falso negativo (ocultar).

---

## Convenciones de código

- **Paleta de colores:** constante `MP[]` (array indexado por member.id)
- **Disponibilidad:** objeto `avail` en cada miembro (ver `BASE_AVAIL`)
- **Datos:** todo en `useState(INITIAL_DATA)` en el componente raíz
- **Callbacks:** `useCallback` para evitar re-renders innecesarios
- **Confirmaciones de borrado:** inline en la UI (sin `window.confirm`)
- **ICS fetch:** proxy CORS `api.allorigins.win` para evitar bloqueos del navegador

---

## Funcionalidades implementadas

- Tableros Kanban con drag & drop (sin librería externa)
- Matriz de Eisenhower automática (Q1–Q4 por urgencia + prioridad)
- Planificador IA async que lee ICS de Google Calendar
- Motor de margen de transporte (30 min por defecto)
- Asignación automática respetando mañanas 08:00–13:00 fijas
- Sistema de alertas (críticas, avisos, asesor IA)
- Control de tiempo por tarea con cronómetro
- Reportes de tiempo por miembro y proyecto
- Gestión de proyectos / usuarios (crear / editar / eliminar inline)
- Sincronización Google Calendar (enlace wa.me + WhatsApp)
- Vista de disponibilidad semanal con bloqueos recurrentes
- 6 agentes IA (Héctor 🧙, Mario ⚖️, Diego 💰, Jorge 📊, Álvaro 🏠, Gonzalo 🏛️)
- Detector anti-fake-success con 58 patrones + banner amarillo
- TaskListCard (modo BD-driven y Validated)
- Validación post-LLM de fechas y tareas
- Reescritura propositiva de propuestas
- Landing magistral cordón rojo

---

## Próximos pasos vigentes

1. **HectorPanel** — extender fixes de HectorDirect (TaskListCard, validaciones post-LLM, reescritura propositiva)
2. **Héctor Intérprete** — módulo de traducción contextual con voz (prioridad CEO)
3. **Deep link clicable** desde TaskListCard a tarea concreta
4. **Sincronización chat entre dispositivos** — de localStorage a Supabase
5. **Sistema memoria decisiones CEO** (`ceo_decisions` en Supabase)
6. **Refactorización de App.jsx** — sesión dedicada, sin features nuevas
7. **Auth real** — login por usuario para que cada miembro vea solo su vista
8. **Google Calendar OAuth2** — integración real para leer/escribir eventos
9. **WhatsApp real** — Twilio API en lugar de enlaces wa.me

---

## Glosario mínimo

- **ACTIONS_v[N]:** versión del system prompt addon
- **ActionProposal:** card oro con propuesta de creación (botones "Crear todo / No crear")
- **TaskListCard:** card gris azulado #3B5573 para consultas (solo lectura)
- **Banner amarillo:** alerta cuando detector caza afirmación falsa de éxito
- **BD-driven mode:** TaskListCard muestra TODAS las tareas reales del proyecto desde data.boards (cuando hay código de proyecto válido)
- **Validated mode:** TaskListCard filtra emisiones contra BD (consulta global sin código)
- **parseAgentActions:** parser de [ACTIONS] (creación). NO confundir con parseTasksList.
- **parseTasksList:** parser de [TASKS_LIST] (consultas). Pipeline separado.
- **detectFalseSuccessClaim:** función con 58 patrones para cazar afirmaciones falsas de éxito.

---

## CEO

**Antonio Díaz.** ALMA DIMO INVESTMENTS S.L. (CIF B19929256). Marbella-Estepona, Costa del Sol.

Comunicación: directa, opciones A/B concretas, móvil primero. Filosofía: el tiempo es el único activo real (Aristóteles + Séneca).

---

**Última actualización:** 03/05/2026
**Origen:** Sesión 02/05/2026 — 7 commits exitosos + 2 reverts.
