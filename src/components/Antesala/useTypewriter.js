// useTypewriter — hook custom sin dependencias. Escribe un texto en
// pantalla carácter a carácter simulando tecleo natural. Se creó para
// la Antesala (20/08/2026) — Antonio pidió que las preguntas de Héctor
// no aparezcan de golpe: "Si aparecen de golpe es un formulario. Si se
// escriben, es una conversación. Esa diferencia es todo el valor de la
// Antesala."
//
// Requisitos que satisface:
// - Velocidad natural (default 22ms/char ≈ ~45 chars/s).
// - `done` boolean → el caller usa esto para mostrar el input/botón
//   SOLO cuando la pregunta ha terminado de escribirse.
// - `skip()` → completa el texto inmediatamente. El caller la conecta
//   a un tap/click sobre la pantalla mientras !done.
// - Sin cursor parpadeante — el efecto de escritura ya transmite
//   "estoy tecleando"; el pipe `|` es estética de terminal, no de
//   conversación institucional (decisión propia — Antonio delegó).
// - Cero librería, cero peso al bundle.
//
// Al cambiar `text` el hook reinicia desde 0. Al desmontar cancela el
// timer para evitar setState sobre componentes muertos.
import { useEffect, useState, useCallback } from "react";

export function useTypewriter(text, opts = {}) {
  const speedMs = typeof opts.speedMs === "number" ? opts.speedMs : 22;
  const startDelayMs = typeof opts.startDelayMs === "number" ? opts.startDelayMs : 200;
  const [shown, setShown] = useState("");
  const [done, setDone] = useState(false);

  useEffect(() => {
    const full = String(text || "");
    if (!full) { setShown(""); setDone(true); return; }
    setShown("");
    setDone(false);
    let cancelled = false;
    let i = 0;
    let timerId = null;
    const tick = () => {
      if (cancelled) return;
      i++;
      setShown(full.slice(0, i));
      if (i >= full.length) { setDone(true); return; }
      timerId = setTimeout(tick, speedMs);
    };
    timerId = setTimeout(tick, startDelayMs);
    return () => { cancelled = true; if (timerId) clearTimeout(timerId); };
  }, [text, speedMs, startDelayMs]);

  const skip = useCallback(() => {
    setShown(String(text || ""));
    setDone(true);
  }, [text]);

  return { shown, done, skip };
}
