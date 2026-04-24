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
  "carmen","isabel","marisol","esperanza","sofia","sofía","laura","marta",
  "female","mujer","femenino",
];

export function pickVoice(preferredGender = "any"){
  const voices = getVoices();
  console.log("[voice] voces disponibles:", voices.map(v=>`${v.name} | ${v.lang}${v.default?" (default)":""}`));
  const esVoices = voices.filter(v => /^es[-_]?/i.test(v.lang));
  if(esVoices.length === 0){
    console.warn("[voice] sin voces es-*, fallback a voices[0]:", voices[0]?.name);
    return voices[0] || null;
  }

  const nameHas = (v, list)=>{
    const n = (v.name||"").toLowerCase();
    return list.some(x => n.includes(x));
  };

  if(preferredGender === "male"){
    // 1) Nombre masculino explícito
    const explicit = esVoices.find(v => nameHas(v, MALE_ES_NAMES));
    if(explicit){
      console.log("[voice] male match (nombre explícito):", explicit.name, "|", explicit.lang);
      return explicit;
    }
    // 2) Excluir voces femeninas conocidas → primera restante
    const nonFemale = esVoices.filter(v => !nameHas(v, FEMALE_ES_NAMES));
    if(nonFemale.length > 0){
      console.log("[voice] male fallback (excluyendo femeninas):", nonFemale[0].name, "|", nonFemale[0].lang);
      return nonFemale[0];
    }
    // 3) Todas las voces es-* parecen femeninas. Mejor Mónica que nada.
    console.warn("[voice] ninguna voz masculina disponible, todas las es-* parecen femeninas:", esVoices.map(v=>v.name));
    return esVoices[0];
  }

  if(preferredGender === "female"){
    const explicit = esVoices.find(v => nameHas(v, FEMALE_ES_NAMES));
    if(explicit){
      console.log("[voice] female match:", explicit.name);
      return explicit;
    }
  }

  // "any" — preferimos voces marcadas como neural/premium/enhanced
  const neural = esVoices.find(v => /neural|premium|enhanced|google/i.test(v.name));
  const picked = neural || esVoices[0];
  console.log("[voice] any match:", picked?.name, "|", picked?.lang);
  return picked;
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

export function speak(text, { rate = 1, pitch = 1, gender = "any", onEnd } = {}){
  if(!("speechSynthesis" in window)){ onEnd?.(); return null; }
  stopSpeaking();
  const u = new SpeechSynthesisUtterance(stripMarkdown(text));
  const v = pickVoice(gender);
  console.log("[voice] speak() · gender solicitado:", gender, "· voz final:", v?.name||"(ninguna)", "· lang:", v?.lang);
  if(v) u.voice = v;
  u.lang = v?.lang || "es-ES";
  u.rate = rate;
  u.pitch = pitch;
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
