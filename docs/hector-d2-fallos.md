# D2 · Fallos observados en producción y notas para el rediseño

**Fecha:** 19/08/2026
**Estado:** implementación revertida (`git revert 61e192e` → commit `111547f`, pushed).
**Motivo del revert:** cuatro fallos concretos en producción. El cuarto es descalificante — Mario respondió sobre competencia desleal mercantil a una consulta de derecho sucesorio. "Si le pregunto una consulta personal y me habla de empresa es que no está atendiéndome" (Antonio). Peor que el defecto original.

Este documento NO es un plan. Es el registro para la sesión de rediseño. No implementar nada basado en él sin revisión con Antonio.

---

## Contexto — qué era D2

Clasificador post-respuesta implementado en `src/lib/agent.js:classifyAgentDomain` (commit `61e192e`, revertido). Funcionamiento:

1. Tras la respuesta de Héctor, si NO había emitido `[INVOCAR:]` y su reply tenía >200 chars → llamada a Claude Haiku 4.5 clasificando la materia (`mario|jorge|gonzalo|alvaro|diego|ninguno`).
2. Si materia especializada → se reemplazaba la burbuja de Héctor por un puente breve `"Esto es materia de {Especialista}. Se lo paso."` y se añadía la invocación al pipeline con `task: txt` (mensaje literal del CEO).

Diseño previsto: post-LLM contra realidad. Coste esperado ~$0.02/día/CEO. Umbrales conservadores para no invocar en conversación estratégica.

**Precedente:** este cambio sustituyó al prompt `INVOKE_v2` (commit `3e6bd85`, revertido en `cdcebe5`). El prompt fue descartado tras verificar con `scripts/diag-hector-prompt-real.mjs` que la regla llegaba al system prompt y el modelo la ignoraba igual (Héctor firmó "GONZALO TE LO DIJO CLARO:" sin invocar).

---

## Los cuatro fallos

### FALLO 1 · Héctor sigue desarrollando el análisis completo

**Ejemplo real:** consulta sucesoria. Héctor respondió con artículos del Código Civil, causas tasadas de desheredación, reparto de legítima y cinco estrategias patrimoniales. Al final escribió "lo paso a Mario Legal". Después salió la burbuja de Mario con lo mismo.

**Consecuencia:** el CEO lee el análisis dos veces, firmado por dos personas distintas.

**Causa técnica probable:** la red de seguridad D1 (`stripInvokes` en `HectorDirectView.jsx` y `parseSpecialistTags` en `App.jsx`) solo trunca cuando el reply contiene literalmente `[INVOCAR:`. Cuando la invocación la fuerza D2 desde el frontend, el reply de Héctor NO tiene esa etiqueta — es prosa libre. D1 no dispara. La lógica de D2 sí reemplazaba `reply = "Esto es materia de X. Se lo paso."`, pero el commit revertido tenía ese `reply = puente` DESPUÉS de ejecutar `stripInvokes` sobre el original. Verificar en el rediseño el orden exacto: si el puente se pinta pero el original sigue accesible en otro punto del pipeline, se ve doble.

Nota adicional: si el rediseño mantiene la idea de puente sintético, debe garantizar que la prosa original de Héctor NUNCA se muestra al CEO cuando D2 fuerza. No basta con reasignar `reply`; hay que auditar todos los caminos donde `reply` original pueda salir a la UI (persistencia en `chatHistory`, timeline, snapshot).

---

### FALLO 2 · Falsos positivos con frases conversacionales

**Ejemplos reales del CEO:**
- `"la pregunta es particular"` → D2 invocó a Gonzalo.
- `"no te he pedido nada de empresa"` → D2 invocó a Gonzalo.

**Consecuencia:** Gonzalo respondió `"Adelante Antonio, dime qué necesitas saber"` y `"Disculpa el exceso"`. Absurdo evidente para el CEO.

**Causa técnica probable:** el trigger de D2 era `invocations.length === 0 && reply.length > 200`. El clasificador solo miraba (a) el mensaje del CEO (`txt`) y (b) los primeros 500 chars de la respuesta de Héctor. No miraba el HISTORIAL de la conversación. Esas frases son aclaraciones a un turno anterior donde Héctor sí había mencionado algo societario — el clasificador leyó "empresa" en el contexto reciente de Héctor y disparó Gonzalo.

Además, el umbral de 200 chars sobre la respuesta de Héctor es débil: Héctor puede responder 250 chars a una aclaración conversacional del CEO ("Perdona, entendí mal, ¿te refieres a X o a Y?"). Eso pasa el filtro y activa la clasificación.

**Restricción para el rediseño:** el clasificador necesita señales estructurales sobre el TIPO de turno del CEO (pregunta técnica nueva vs. aclaración/corrección/conversación), no solo palabras clave en el reply de Héctor.

---

### FALLO 3 · Ruteo inconsistente

**Ejemplo real:** una consulta sobre desheredación y legítima (derecho de sucesiones) fue clasificada a **Gonzalo** en un caso y a **Mario** en otro. Misma materia, dos destinos distintos en turnos consecutivos.

**Causa técnica probable:** el prompt del clasificador (`D2_SYSTEM` en `agent.js`) tenía lo sucesorio en dos sitios:

```
- mario: contratos, cláusulas, compliance, jurisprudencia, redacción legal.
- gonzalo: (...), planificación sucesoria, (...)
```

"Jurisprudencia" y "redacción legal" son territorio potencial de sucesorio (Código Civil, testamentos). "Planificación sucesoria" también. El clasificador Haiku no tenía criterio para desambiguar y elegía distinto cada turno.

**Restricción para el rediseño:** el mapa de materias necesita ser MECE (mutuamente exclusivo, colectivamente exhaustivo). Cada dominio en un único especialista, sin solapamientos. Y probablemente decidir de una vez: **derecho de sucesiones = Mario** (es jurisdicción del Código Civil, redacción de testamento, defensa de legítima). Gonzalo se queda con planificación fiscal de la herencia (no lo mismo).

---

### FALLO 4 · El especialista responde a otra cosa (EL MÁS GRAVE)

**Ejemplo real:** conversación en curso sobre desheredación, legítima y pruebas para acreditar causa. Antonio pregunta: `"si acreditas que durante toda la vida no hay una relación acreditada es válido"` — refiriéndose a la relación paterno-filial como causa de desheredación.

Mario respondió sobre **cláusulas de no competencia mercantiles**: art. 1255 CC, libertad de empresa, Ley de Competencia Desleal.

Nada que ver. Mario leyó "relación acreditada" sin contexto y lo interpretó como relación contractual entre empresas.

**Veredicto del CEO:** "Si le pregunto una consulta personal y me habla de empresa es que no está atendiéndome. Eso no es un bug cosmético, es la aplicación no atendiendo al CEO. Peor que el problema original."

**Causa técnica probable:** cuando D2 forzaba la invocación, ponía `task: txt` — el mensaje LITERAL del CEO, sin contexto. Compárese con el path natural: cuando Héctor emite `[INVOCAR:mario:Analizar desheredación total del hijo evitando legítima con prueba de abandono...]`, el specialist recibe una tarea REFORMULADA por Héctor con contexto del turno.

En `HectorDirectView.jsx:1597` el specialist recibe:
```
TAREA QUE TE ENCARGA HÉCTOR (Jefe de Gabinete):
{inv.task}
```

Con `inv.task = "si acreditas que durante toda la vida no hay una relación acreditada es válido"` como frase suelta, Mario no tiene forma de saber:
- Que hablamos de desheredación de hijo.
- Que la "relación" es paterno-filial, no contractual.
- Que "acreditar" se refiere a prueba judicial de la causa, no a validez contractual.

Sin ese contexto, Mario proyectó el dominio más frecuente en su promptBase (contratos mercantiles) sobre las palabras ambiguas.

**Restricción para el rediseño:** el traspaso al especialista NO puede ser el mensaje literal del CEO. Necesita:

- Reformulación de la tarea con el hilo de la conversación.
- El histórico de los últimos N turnos como contexto que el especialista pueda leer.
- Idealmente ambas cosas: `task` reformulado + `historyContext` estructurado.

---

## Restricciones acordadas para el rediseño

Del hilo de decisiones con Antonio (sesiones del 19/08/2026):

1. **Barato y rápido.** Cualquier llamada extra al modelo debe justificar coste (~$0.0005/turno es aceptable; +2 llamadas/turno probablemente no).
2. **NO disparar en conversación estratégica.** Priorización, decisiones, mentalidad, coaching, negociación → territorio de Héctor. Si el rediseño rompe eso, estropea lo que hoy funciona bien.
3. **Traspaso natural, no visible como corrección.** El CEO no debe percibir "hubo un fallo y se corrigió". Ver como Héctor delegando conscientemente.
4. **D1 sigue activo.** Si tras invocación forzada Héctor había escrito análisis, ese texto se descarta. Sin excepciones.
5. **Vía prompt descartada con dato.** El diag `scripts/diag-hector-prompt-real.mjs` confirmó que el patch INVOKE_v2 llegaba al system prompt y el modelo lo ignoraba. No volver a esa ruta. Ver también `memory/project_hector_prompt_saturation.md` (33k chars problema estructural).
6. **El defecto conocido "Héctor responde él en materia técnica" es tolerable como estado temporal.** Es acotado, no equivocado. Preferible a "specialist responde a otra cosa".

---

## Alternativas de rediseño identificadas (pendientes de discusión)

**A1 · Reformulación de la tarea antes de pasarla al especialista.**
Clasificador devuelve `{key, taskReframed, historyContext}` en vez de solo `key`. Coste marginal: +100-200 tokens output, ~500ms extra. Resuelve fallo 4.

**A2 · Contexto de conversación al especialista.**
Pasar últimos 3-5 turnos del chat al specialist como bloque `HILO PREVIO DE LA CONVERSACIÓN` en el system prompt del specialist. Refuerza A1. Coste: solo tokens de input al specialist (ya de por sí grandes).

**A3 · Umbral más restrictivo con señales estructurales.**
Además de longitud del reply de Héctor, mirar:
- Longitud del mensaje del CEO (< 40 chars probablemente es aclaración, no pregunta técnica).
- Presencia de marcadores conversacionales del CEO ("perdona", "espera", "no", "aclaro", "particular", "personal").
- Si el turno anterior de Héctor ya delegó (en curso) o si Héctor ya avisó de duda ("cuéntame más para poder ayudarte").

Resuelve fallo 2.

**A4 · Mapa MECE de materias.**
Sucesorio → Mario. Planificación fiscal de herencia → Gonzalo. Cero solapamiento entre keys. Documentado explícito en el prompt del clasificador. Resuelve fallo 3.

**A5 · Truncado del reply original ante D2 forzado.**
Cuando D2 fuerza la invocación, descartar el reply original de Héctor completamente ANTES de cualquier persistencia (chatHistory, timeline, sync a Supabase). Solo el puente sintético llega a la UI y a la BD. Resuelve fallo 1.

**A6 · D2 como sugerencia opt-in en vez de forzado.**
Banner amarillo bajo la burbuja de Héctor: "Esta consulta podría ser materia de Gonzalo. ¿Consultarle?" con botón. El CEO decide si delegar. Cero riesgo de FALLO 4 (nunca se invoca sin permiso). Cambia la promesa (invocación automática → sugerencia).

**A7 · Descartar D2 completamente.**
Aceptar el defecto conocido (Héctor responde de materias técnicas) hasta que haya sesión de rediseño profundo del promptBase de Héctor (33k chars). Escalable si Antonio prefiere estabilidad a experimentación.

**A8 · Doble check del specialist.**
Tras la respuesta del specialist, segundo clasificador ligero: "¿La respuesta encaja con la pregunta original?" Si no encaja → banner al CEO "Detecté posible malentendido. ¿Reformular la consulta?". Coste: +1 llm-call/invocación forzada. Resuelve fallo 4 tarde pero visible.

---

## Datos pendientes para la sesión de rediseño

- Confirmar con Antonio si acepta el defecto "Héctor responde él" como estado permanente (A7) o quiere reintentar D2 con arquitectura corregida.
- Si acepta reintentar: decidir entre A1+A2+A3+A4+A5 (D2 automático corregido) o A6 (D2 opt-in) o A8 (D2 con doble check).
- Confirmar el mapa MECE de materias — especialmente la línea entre Mario y Gonzalo para temas patrimoniales/sucesorios.
- Valorar el rediseño estructural del promptBase de Héctor (33k chars) en una sesión dedicada como habilitador de cualquier futura regla de comportamiento.

---

## Cambios pushed a producción tras el revert

- `111547f` — revert D2 (activo en prod, bundle `index-CWveo_wT.js`).
- Se conservan y siguen activos: `eaf8142` (D1 truncar + Diego negociación), `58d664e` (monogramas), `06478d4` (B1 auth /api/agent), `13e772a` (renderAgentText legibilidad).
- El commit del prompt `3e6bd85` ya estaba revertido antes (por `cdcebe5`).

## Estado post-revert

Héctor responde él en materia técnica (defecto conocido y acotado, mismo comportamiento pre-INVOKE_v2). D1 sigue truncando prosa post-`[INVOCAR:]` cuando Héctor sí invoca. Bug diego en chat de negociación corregido. Monogramas, seguridad B1, legibilidad — intactos.
