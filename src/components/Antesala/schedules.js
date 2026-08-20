// Presets de horario del CEO — se ofrecen en el Paso 6 de la Antesala
// y se reutilizan en applyAntesalaAnswers para mapear scheduleKey →
// member.avail al persistir. Extraído del componente Step6 para poder
// importarse tanto desde JSX como desde Node puro (smokes).
//
// help: cadena legible del horario. Guión largo (–) en los rangos
// para no colisionar con el punto medio (·) que el Summary usa como
// separador entre horario y ciudad.
//
// Los planners de tareas ya leen los campos morningStart/morningEnd/
// afternoonStart/afternoonEnd/hoursPerDay de member.avail — no hay
// que tocar nada más para que el horario ancla funcione.

export const SCHEDULES = [
  { key: "morning",  label: "Mañana",   help: "09:00–14:00",                 morningStart:"09:00", morningEnd:"14:00", afternoonStart:"",      afternoonEnd:"",      hoursPerDay: 5 },
  { key: "split",    label: "Partido",  help: "09:00–14:00 y 16:00–19:00",   morningStart:"09:00", morningEnd:"14:00", afternoonStart:"16:00", afternoonEnd:"19:00", hoursPerDay: 8 },
  { key: "straight", label: "Continuo", help: "09:00–17:00",                 morningStart:"09:00", morningEnd:"17:00", afternoonStart:"",      afternoonEnd:"",      hoursPerDay: 8 },
];
