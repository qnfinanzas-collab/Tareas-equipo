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


// pickVoice: garantiza que la voz devuelta SIEMPRE tenga lang es-*.
// PASO 1 (obligatorio): filtrar voces es-*. Sin excepciones, sin escapes.
// PASO 2 (solo si gender="male"): match por nombre masculino → exclusión
// de femeninas → quality-filter dentro del pool restante.
// PASO 3 (siempre): fallback a la primera voz es-*.
// Si no hay NINGUNA voz es-*, devolvemos voices[0] como rescate último,
// pero speak() compensa forzando u.lang="es-ES" para que el motor TTS
// no infiera el idioma del default del sistema.
export function pickVoice(gender = "male"){
  const all = speechSynthesis.getVoices();

  // PASO 1: Solo voces en español. Sin excepciones.
  const esVoices = all.filter(v => v.lang.toLowerCase().startsWith("es"));

  console.log("[voice] voces ES disponibles:", esVoices.map(v => v.name + "|" + v.lang));

  if(esVoices.length === 0){
    console.warn("[voice] ninguna voz ES disponible, usando primera del sistema");
    return { voice: all[0], method: "no-es-fallback" };
  }

  if(gender === "male"){
    const maleNames = ["jorge","diego","juan","pablo","carlos","miguel","enrique","andrés","andres"];
    const femaleNames = ["mónica","monica","marisol","paulina","rosa","elena","carmen","isabel","conchita","lucía","lucia","francisca","angélica","angelica"];

    // Buscar por nombre masculino dentro de esVoices SOLO
    const byName = esVoices.find(v => maleNames.some(n => v.name.toLowerCase().includes(n)));
    if(byName){
      console.log("[voice] selected:", byName.name, "| method: name-match");
      return { voice: byName, method: "name-match" };
    }

    // Excluir femeninas y quedarse con las restantes
    const nonFemale = esVoices.filter(v => !femaleNames.some(n => v.name.toLowerCase().includes(n)));

    if(nonFemale.length > 0){
      const quality = nonFemale.find(v => /neural|premium|enhanced|google/i.test(v.name)) || nonFemale[0];
      console.log("[voice] selected:", quality.name, "| method: non-female");
      return { voice: quality, method: "non-female" };
    }
  }

  // Fallback final: primera voz ES (Mónica en iOS, etc.)
  console.log("[voice] selected:", esVoices[0].name, "| method: fallback");
  return { voice: esVoices[0], method: "fallback" };
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
