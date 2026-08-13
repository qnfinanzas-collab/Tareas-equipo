// smoke_false_success_detector — fixture de regresión de detectFalseSuccessClaim.
//
// Protege el detector post-LLM contra dos tipos de regresión:
//   POSITIVE — frases que DEBEN disparar (el modelo afirma ejecución sin
//              bloque [ACTIONS] real). Fallo = falso negativo del detector.
//   NEGATIVE — frases de conversación normal, sin claim de ejecución. NO
//              deben disparar. Fallo = falso positivo (banner amarillo
//              indebido, como el ticket 4155d543 del 13/08/2026).
//
// Regla de gobernanza: cada modificación de SUCCESS_PATTERNS debe correr
// este fixture antes de push. Si aparece un caso nuevo de falso negativo,
// se AÑADE un patrón específico nuevo — NUNCA se ensancha uno existente.

import { detectFalseSuccessClaim } from "../../src/lib/agentActions.js";

// ── POSITIVE: DEBEN disparar (cobertura por familia de patrones) ────────
const POSITIVE_FIXTURES = [
  // Familia "he + verbo"
  "He creado la tarea de comprar dominios",
  "He guardado el proyecto en tu carpeta",
  "He registrado el movimiento bancario",
  "He asignado la tarea a Marc",
  "He completado la revisión pendiente",
  "He actualizado los datos que pediste",
  "He añadido el enlace a la ficha",
  "He ejecutado la acción sin problemas",
  // Familia "sustantivo + participio"
  "Tarea creada correctamente",
  "Tarea añadida al proyecto",
  "Proyecto creado y añadido al equipo",
  "Negociación creada con el proveedor",
  // Familia "se ha + participio"
  "Se ha creado la negociación con éxito",
  "Se ha guardado en tu perfil",
  "Se ha registrado el asiento contable",
  "Se ha asignado al equipo indicado",
  "Se ha añadido a tu lista de tareas",
  // Familia "quedó + participio"
  "Quedó creada la ficha de cliente",
  "Quedó guardada en el repositorio",
  "Quedó registrada la operación",
  // Familia "ya" + muletilla (cubre patrones nuevos y viejos)
  "Ya está hecho, listo para siguiente paso",   // ya está + ya hecho (nuevo)
  "Ya está listo el informe",                    // nuevo pattern
  "Ya está registrado en el sistema",            // ya está (existente)
  "Ya he actualizado los datos",                 // ya he (existente)
  // Familia "añadido/creado + prep" (v2)
  "Tres tareas más añadidas a MAR",
  "Dos elementos creados en el board",
  // Familia con palabra intermedia
  "Proyecto Marbella creado con éxito",
  "Negociación Rafa creada correctamente",
  // Familia "añadido al sistema"
  "Añadido al sistema correctamente",
];

// ── NEGATIVE: NO deben disparar (conversación normal) ───────────────────
const NEGATIVE_FIXTURES = [
  // Ticket 4155d543 — regresión original que motivó este fixture
  "Listo para presentación meeting.",
  "Listo cuando arranques (15:16).",
  "Antonio, RECIBIDO. MODO DEMO ACTIVADO. Listo para presentación meeting. Listo cuando arranques.",
  // "Listo" como adjetivo (preparado)
  "Listo para ayudarte cuando quieras",
  "Listo si quieres empezar por otro tema",
  "Listo, avísame cuando confirmes",
  // "Hecho" como adjetivo o sustantivo
  "hecho a mano con cariño",
  "está hecho de madera maciza",
  "un hecho relevante para tu decisión",
  "El hecho es que necesitas más contexto",
  "de hecho, deberíamos revisarlo primero",
  // "echo" (verbo echar) — el patrón borrado que causaba falsos positivos
  "echo un vistazo al proyecto ahora",
  "echo de menos aquellos tiempos",
  "echo el cierre de la tienda esta tarde",
  "voy a echar un vistazo primero",
  // Acknowledgments conversacionales sin claim de ejecución
  "MODO DEMO ACTIVADO",
  "RECIBIDO. Continuemos.",
  "Perfecto, entendido",
  "De acuerdo, cuenta conmigo",
  "vale, seguimos así entonces",
  // Léxico de análisis / propuesta (sin ejecución)
  "podría proponer varias opciones",
  "voy a proponer un plan alternativo",
  "necesito más contexto para responder",
  "no dispongo de esos datos ahora mismo",
  // Frases neutras que aparecieron en el ticket real
  "Nombres de clientes que tienes activos",
  "Datos financieros de la empresa",
  "Ningún dato sensible ni personal",
  "¿Qué necesitas que muestre en la demo?",
];

const failures = [];

for (const text of POSITIVE_FIXTURES) {
  const fired = detectFalseSuccessClaim(text, null);
  if (!fired) failures.push({ type: "false-negative", text });
}
for (const text of NEGATIVE_FIXTURES) {
  const fired = detectFalseSuccessClaim(text, null);
  if (fired) failures.push({ type: "false-positive", text });
}

// Caso adicional: con [ACTIONS] válido presente, NINGUNA frase debe
// disparar (el detector solo dispara cuando no hay bloque ejecutable).
const withActions = { actions: [{ type: "create_tasks", tasks: [{ title: "x" }] }] };
if (detectFalseSuccessClaim("He creado la tarea", withActions)) {
  failures.push({ type: "unexpected-fire-with-actions", text: "He creado la tarea (con [ACTIONS] válido)" });
}

if (failures.length > 0) {
  console.error("\n=== FALSE-SUCCESS DETECTOR SMOKE FAIL ===");
  for (const f of failures) {
    console.error(`  [${f.type}] "${f.text}"`);
  }
  console.error(`\nTotal fallos: ${failures.length}`);
  process.exit(1);
}

console.log("=== FALSE-SUCCESS DETECTOR SMOKE OK ===");
console.log(`  Positive (deben disparar): ${POSITIVE_FIXTURES.length}/${POSITIVE_FIXTURES.length} ✓`);
console.log(`  Negative (NO deben disparar): ${NEGATIVE_FIXTURES.length}/${NEGATIVE_FIXTURES.length} ✓`);
console.log(`  Gate [ACTIONS] válido → no dispara ✓`);
