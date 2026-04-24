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

  const esVoices = voices.filter(v => /^es[-_]?/i.test(v.lang));
  if(esVoices.length === 0){
    const picked = voices[0] || null;
    console.log("[voice] selected:", picked?.name, "| method: no-es-fallback");
    return picked;
  }

  const nameHas = (v, list)=>{
    const n = (v.name||"").toLowerCase();
    return list.some(x => n.includes(x));
  };
  const qualityPick = (pool)=>{
    // Orden explícito: neural > premium > enhanced > google
    return pool.find(v => /neural/i.test(v.name))
        || pool.find(v => /premium/i.test(v.name))
        || pool.find(v => /enhanced/i.test(v.name))
        || pool.find(v => /google/i.test(v.name))
        || null;
  };
  const logPick = (v, method)=>{
    console.log("[voice] selected:", v?.name, "| method:", method, "| lang:", v?.lang);
    return v;
  };

  if(preferredGender === "male"){
    // 1) name-match
    const explicit = esVoices.find(v => nameHas(v, MALE_ES_NAMES));
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
    const explicit = esVoices.find(v => nameHas(v, FEMALE_ES_NAMES));
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
