// Browser-native voice: zero cost, no API keys.
// Usa Web Speech API: speechSynthesis (TTS) + webkitSpeechRecognition (STT).

export const voiceSupported = () => {
  const synth = typeof window !== "undefined" && "speechSynthesis" in window;
  const rec = typeof window !== "undefined" && ("SpeechRecognition" in window || "webkitSpeechRecognition" in window);
  return { tts: synth, stt: rec };
};

let cachedVoices = null;
export function getVoices(){
  if(typeof window === "undefined") return [];
  if(cachedVoices && cachedVoices.length) return cachedVoices;
  cachedVoices = window.speechSynthesis.getVoices();
  return cachedVoices;
}

// Pick the best Spanish voice for an avatar (prefers higher quality / female/male match)
export function pickVoice(preferredGender = "any"){
  const voices = getVoices();
  const spanish = voices.filter(v => /es[-_]/i.test(v.lang));
  if(spanish.length === 0) return null;
  // Prefer local / neural voices
  const neural = spanish.filter(v => /neural|premium|enhanced|google/i.test(v.name));
  const pool = neural.length ? neural : spanish;
  if(preferredGender === "female"){
    const f = pool.find(v => /female|mujer|monica|elena|lucia|paulina|marisol/i.test(v.name));
    if(f) return f;
  }
  if(preferredGender === "male"){
    const m = pool.find(v => /male|hombre|diego|jorge|pablo|enrique|miguel/i.test(v.name));
    if(m) return m;
  }
  return pool[0];
}

let currentUtterance = null;

export function speak(text, { rate = 1, pitch = 1, gender = "any", onEnd } = {}){
  if(!("speechSynthesis" in window)){ onEnd?.(); return null; }
  stopSpeaking();
  const u = new SpeechSynthesisUtterance(text);
  const v = pickVoice(gender);
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
