// Browser-native voice: zero cost, no API keys.
// Usa Web Speech API: speechSynthesis (TTS) + webkitSpeechRecognition (STT).

export const isIOS = typeof navigator !== "undefined"
  && /iPad|iPhone|iPod/.test(navigator.userAgent)
  && !window.MSStream;

// En iOS, SpeechRecognition con continuous:true no emite interims
// estables y puede cortarse; además speechSynthesis.speak() solo
// funciona dentro de un gesture de usuario (click/touch). Quien
// consuma el módulo debe adaptar UX en consecuencia.

export const voiceSupported = () => {
  const synth = typeof window !== "undefined" && "speechSynthesis" in window;
  const rec = typeof window !== "undefined" && ("SpeechRecognition" in window || "webkitSpeechRecognition" in window);
  return { tts: synth, stt: rec };
};

let cachedVoices = null;
let voicesReadyListenerAttached = false;
export function getVoices(){
  if(typeof window === "undefined") return [];
  if(cachedVoices && cachedVoices.length) return cachedVoices;
  const v = window.speechSynthesis.getVoices();
  if(v && v.length){
    cachedVoices = v;
    return v;
  }
  // getVoices() devuelve [] hasta que el motor TTS carga el catálogo.
  // Registramos el listener una sola vez para refrescar la cache cuando
  // el navegador dispare voiceschanged.
  if(!voicesReadyListenerAttached && "addEventListener" in window.speechSynthesis){
    voicesReadyListenerAttached = true;
    window.speechSynthesis.addEventListener("voiceschanged", ()=>{
      cachedVoices = window.speechSynthesis.getVoices();
    });
  }
  return [];
}

// Espera a que el motor TTS termine de cargar el catálogo. En iOS la
// primera llamada a getVoices() suele devolver []. Sin esperar, speak()
// caía al fallback porque no veía las voces españolas. Timeout de 1.5s
// para no bloquear indefinidamente si el evento nunca llega.
export function getVoicesReady(){
  return new Promise(resolve => {
    if(typeof window === "undefined"){ resolve([]); return; }
    const immediate = window.speechSynthesis.getVoices();
    if(immediate && immediate.length > 0){ cachedVoices = immediate; resolve(immediate); return; }
    let done = false;
    const onChange = ()=>{
      if(done) return; done = true;
      window.speechSynthesis.removeEventListener("voiceschanged", onChange);
      const v = window.speechSynthesis.getVoices() || [];
      if(v.length) cachedVoices = v;
      resolve(v);
    };
    window.speechSynthesis.addEventListener("voiceschanged", onChange);
    setTimeout(()=>{
      if(done) return; done = true;
      window.speechSynthesis.removeEventListener("voiceschanged", onChange);
      const v = window.speechSynthesis.getVoices() || [];
      if(v.length) cachedVoices = v;
      resolve(v);
    }, 1500);
  });
}

// Elige voz española priorizando por nombre propio. Las voces del SO no
// suelen incluir "male"/"female" en el name, así que comparamos con lista
// de nombres y, en móviles donde los nombres varían (Google TTS, Android,
// iOS sin voces extra instaladas), EXCLUIMOS las voces femeninas conocidas
// y devolvemos la primera restante — nunca caemos al primer elemento
// genérico (suele ser Mónica en iOS → fallo silencioso del género).
const MALE_ES_NAMES = [
  // Desktop / iOS si el usuario las ha instalado
  "jorge","diego","pablo","enrique","miguel","andrés","andres","carlos","juan",
  // Android / Google TTS — códigos comunes de voces masculinas
  "eee","eef","eed",
  // Etiquetas genéricas que a veces aparecen
  "male","hombre","masculino",
];
const FEMALE_ES_NAMES = [
  "mónica","monica","paulina","rosa","elena","conchita","lucía","lucia",
  "carmen","isabel","marisol","francisca","angelica","angélica","grandma",
  "esperanza","sofia","sofía","laura","marta",
  "female","mujer","femenino",
];

// Cascada para "male":
//   name-match       → match explícito por nombre propio masculino
//   quality-filter   → entre las no-femeninas, primera neural/premium/
//                      enhanced/google (en ese orden de preferencia)
//   first-non-female → primera voz es-* que no contenga nombre femenino
//   fallback         → primera voz es-* cualquiera (warn: todas parecen
//                      femeninas y no hay mejor opción que mostrar la
//                      aplicación muda)
//
// La exclusión de femeninas se hace ANTES del quality-filter para que
// una "Monica Premium" no gane a "Google español" cuando pedimos male.
export function pickVoice(preferredGender = "any"){
  const voices = getVoices();
  const ua = typeof navigator !== "undefined" ? navigator.userAgent : "";
  console.log("[voice] platform:", ua.slice(0, 80));
  console.log("[voice] available voices:", voices.map(v=>v.name).join(", ") || "(ninguna aún)");

  // Filtro estricto BCP 47: lang debe ser "es" exacto, "es-XX" o "es_XX".
  // El regex anterior /^es[-_]?/ también colaba accidentalmente cualquier
  // lang que empezase por "es" sin separador (esperanto, español...).
  // Más importante: este filtro es la ÚNICA puerta — ninguna rama posterior
  // puede traer una voz que no esté en esVoices.
  const esVoices = voices.filter(v => /^es($|[-_])/i.test(v.lang||""));
  console.log("[voice] voces ES completas:", esVoices.map(v => `${v.name} | ${v.lang}`));
  if(esVoices.length === 0){
    // NUNCA caemos a una voz en otro idioma — preferimos voice:null y
    // dejamos que el navegador use su default para u.lang="es-ES".
    // Caer a "Microsoft David - English" haría que Héctor leyera el
    // español con acento inglés (bug crítico que reportó el usuario).
    console.warn("[voice] sin voces es-* disponibles; devolviendo null para que el navegador use su default es-ES");
    return { voice: null, method: "no-es-available" };
  }

  // nameHas: match parcial case-insensitive. Crítico en iOS donde el
  // name puede ser "Jorge", "Jorge (mejorada)", "Jorge (Premium)" o
  // incluso el identificador "com.apple.voice.compact.es-ES.Jorge".
  // Todos deben casar con "jorge" de la lista.
  const nameHas = (v, list)=>{
    const n = (v.name||"").toLowerCase();
    return list.some(x => n.includes(x));
  };
  // Cuando hay varias voces que casan (ej: "Jorge" + "Jorge (mejorada)"),
  // preferimos la variante mejorada/premium/neural/enhanced.
  const preferEnhanced = (matches)=>{
    if(matches.length <= 1) return matches[0] || null;
    return matches.find(v => /mejorada|enhanced|premium|neural|plus|\(mejorada\)|\(premium\)/i.test(v.name))
        || matches[0];
  };
  const qualityPick = (pool)=>{
    // Orden explícito: neural > premium > enhanced > google
    return pool.find(v => /neural/i.test(v.name))
        || pool.find(v => /premium|mejorada/i.test(v.name))
        || pool.find(v => /enhanced/i.test(v.name))
        || pool.find(v => /google/i.test(v.name))
        || null;
  };
  // Devuelve { voice, method } para que speak() pueda decidir si aplicar
  // el pitch compensatorio (cuando method="fallback" + gender="male" y
  // solo hay voces femeninas — típico Safari iOS que no expone Jorge).
  const logPick = (v, method)=>{
    console.log("[voice] selected:", v?.name, "| method:", method, "| lang:", v?.lang);
    return { voice: v, method };
  };

  if(preferredGender === "male"){
    // 1) name-match — recoge TODAS las voces que casan y elige la
    //    variante mejorada/premium si hay más de una (iOS: "Jorge" y
    //    "Jorge (mejorada)" conviven; nos quedamos con la mejorada).
    const allMale = esVoices.filter(v => nameHas(v, MALE_ES_NAMES));
    console.log("[voice] candidatos masculinos:", allMale.map(v=>v.name));
    const explicit = preferEnhanced(allMale);
    if(explicit) return logPick(explicit, "name-match");

    // Pool tras excluir femeninas conocidas
    const nonFemale = esVoices.filter(v => !nameHas(v, FEMALE_ES_NAMES));
    if(nonFemale.length > 0){
      // 2) quality-filter dentro del pool no-femenino
      const quality = qualityPick(nonFemale);
      if(quality) return logPick(quality, "quality-filter");
      // 3) primera no-femenina
      return logPick(nonFemale[0], "first-non-female");
    }

    // 4) fallback — todas las es-* parecen femeninas
    console.warn("[voice] todas las es-* parecen femeninas:", esVoices.map(v=>v.name));
    return logPick(esVoices[0], "fallback");
  }

  if(preferredGender === "female"){
    const allFemale = esVoices.filter(v => nameHas(v, FEMALE_ES_NAMES));
    const explicit = preferEnhanced(allFemale);
    if(explicit) return logPick(explicit, "name-match");
  }

  // "any" — calidad primero, si no la primera es-*
  const quality = qualityPick(esVoices);
  if(quality) return logPick(quality, "quality-filter");
  return logPick(esVoices[0], "fallback");
}

// Limpia sintaxis markdown del texto antes de pasarlo a un TTS o de
// mostrarlo crudo. Segura: no escapa contenido legítimo (ej. "5-year"
// no matchea ^-\s). Se aplica también en speak() como safety net por
// si el LLM ignora la regla del system prompt.
export function stripMarkdown(text){
  if(!text) return text;
  return String(text)
    .replace(/\*\*/g, "")
    .replace(/\*/g, "")
    .replace(/#{1,6}\s?/g, "")
    .replace(/^[-•]\s/gm, "")
    .replace(/^\d+\.\s/gm, "")
    .trim();
}

let currentUtterance = null;

export async function speak(text, { rate = 1, pitch = 1, gender = "any", onEnd } = {}){
  if(!("speechSynthesis" in window)){ onEnd?.(); return null; }
  stopSpeaking();
  // En iOS la primera vez getVoices() devuelve [] hasta que el motor
  // dispara voiceschanged. Esperar evita que speak() elija una voz
  // por defecto equivocada antes de que aparezca la neural masculina.
  await getVoicesReady();
  const u = new SpeechSynthesisUtterance(stripMarkdown(text));
  const { voice: v, method } = pickVoice(gender);
  // Compensación para voces masculinas no disponibles: si method==="fallback"
  // y pedimos "male", el SO solo ofrece voces femeninas (típico Safari iOS
  // que no expone Jorge al Web Speech API). Forzamos pitch=0.5 para que
  // Mónica/Paulina suenen más graves y menos claramente femeninas.
  const finalPitch = (gender === "male" && method === "fallback") ? 0.5 : pitch;
  // Guard duro: si el voice elegido (por error de pickVoice) no es es-*,
  // lo descartamos antes de pasarlo al motor. NUNCA queremos que Héctor
  // hable con acento inglés. Dejar voice sin asignar hace que el motor
  // use su default para u.lang="es-ES" — al menos respeta el idioma.
  const voiceIsEs = v && /^es($|[-_])/i.test(v.lang||"");
  if(v && !voiceIsEs){
    console.warn("[voice] descartando voz no-es:", v.name, "|", v.lang);
  }
  console.log("[voice] speak() · gender:", gender, "· voz:", voiceIsEs?v.name:"(ninguna)", "· method:", method, "· pitch:", finalPitch);
  if(voiceIsEs) u.voice = v;
  // u.lang fijado a es-ES siempre — independientemente de la voz — para
  // que el motor no infiera el idioma del default del sistema.
  u.lang = voiceIsEs ? v.lang : "es-ES";
  u.rate = rate;
  u.pitch = finalPitch;
  u.onend = () => { if(currentUtterance === u) currentUtterance = null; onEnd?.(); };
  u.onerror = () => { if(currentUtterance === u) currentUtterance = null; onEnd?.(); };
  currentUtterance = u;
  window.speechSynthesis.speak(u);
  return u;
}

// Lee una respuesta de agente IA usando SU configuración de voz (agent.voice).
// Pensado para auto-reproducir respuestas cuando la interacción se inició por
// voz. Thin wrapper sobre speak() — respeta defaults seguros y el fallback
// silencioso si speechSynthesis no está disponible.
export function speakAgentResponse(text, agent, opts = {}){
  if(!text) return null;
  const cfg = agent?.voice || {};
  return speak(text, {
    gender: cfg.gender || "any",
    rate:   cfg.rate   || 1.0,
    pitch:  cfg.pitch  || 1.0,
    onEnd:  opts.onEnd,
  });
}

export function stopSpeaking(){
  if(typeof window === "undefined") return;
  window.speechSynthesis.cancel();
  currentUtterance = null;
}

export function isSpeaking(){
  return typeof window !== "undefined" && window.speechSynthesis.speaking;
}

// Starts a one-shot recognition session. Returns a stop() function.
export function listen({ onInterim, onFinal, onError, onStart, onEnd, continuous = false } = {}){
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if(!SR){ onError?.(new Error("No disponible")); return () => {}; }
  const r = new SR();
  r.lang = "es-ES";
  r.continuous = continuous;
  r.interimResults = true;
  r.maxAlternatives = 1;
  r.onstart = () => onStart?.();
  r.onresult = e => {
    let interim = "", final = "";
    for(let i = e.resultIndex; i < e.results.length; i++){
      const tr = e.results[i][0].transcript;
      if(e.results[i].isFinal) final += tr;
      else interim += tr;
    }
    if(interim) onInterim?.(interim);
    if(final) onFinal?.(final.trim());
  };
  r.onerror = ev => onError?.(new Error(ev.error || "error"));
  r.onend = () => onEnd?.();
  try { r.start(); } catch(e) { onError?.(e); }
  return () => { try { r.stop(); } catch(_){} };
}
