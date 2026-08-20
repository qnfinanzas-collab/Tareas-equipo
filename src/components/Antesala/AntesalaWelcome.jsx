// AntesalaWelcome — pantalla 0 de la Antesala (versión 2, 20/08/2026
// tras rediseño de Antonio: quitar bloque compacto de 9 líneas sin
// jerarquía; introducir cadencia con filetes oro).
//
// Estructura vertical con AIRE generoso entre bloques:
//   1. Monograma H grande.
//   2. Serif GRANDE — se escribe con typewriter:
//      "Soy Héctor, su Jefe de Gabinete."
//   3. Dos frases cortas separadas, tamaño medio, se escriben en
//      secuencia (cada una tras la anterior):
//      "Mi trabajo es proteger su tiempo."
//      "Cada mañana sabrá qué decide hoy, qué puede esperar y qué se
//       le está enfriando."
//   4. Filete oro.
//   5. Eyebrow oro "EL CONSEJO" + 5 monogramas con nombre y materia.
//      (No repetir nombres en prosa — los monogramas ya lo dicen.)
//   6. Filete oro.
//   7. "Antes de empezar, permítame seis preguntas." (frase sola).
//   8. Botón "Empezar" único.
//   9. Pie diminuto en oro espaciado:
//      "KLUXOR — NO SE CONTRATA. SE RECIBE."
//
// Regla animación (Antonio): typewriter SOLO en bloques 2 y 3. Los
// bloques 4-9 aparecen después, ya montados, con fade suave.
//
// Regla contenido: ninguna frase de más de dos líneas. Sin "Buenos
// días" (podría entrar de noche). Sin "mover la aguja" (jerga
// consultora).
//
// Tap en fondo mientras se escribe → completa todo instantáneamente.
import React, { useEffect, useState } from "react";
import AgentAvatar from "../Shared/AgentAvatar.jsx";
import { useTypewriter } from "./useTypewriter.js";
import { COLORS } from "./AntesalaStep.jsx";

const TXT_HEADLINE = "Soy Héctor, su Jefe de Gabinete.";
const TXT_LINE_A   = "Mi trabajo es proteger su tiempo.";
const TXT_LINE_B   = "Cada mañana sabrá qué decide hoy, qué puede esperar y qué se le está enfriando.";
// Puente al Consejo (Antonio, 20/08/2026 opción C): dos líneas cortas.
// "un Consejo" en singular — es el nombre del producto y los monogramas
// aparecen justo después con nombre y materia (la frase anuncia, los
// monogramas presentan). Sin repetir nombres.
const TXT_LINE_C   = "Tiene a su disposición un Consejo: legal, financiero, inmobiliario, societario y contable.";
const TXT_LINE_D   = "Yo lo convoco cuando la decisión lo pide.";
// Encuadre de diagnóstico. La Antesala no es un registro — es un
// diagnóstico exprés. Dos frases: apertura + promesa del entregable
// ("gabinete configurado"), coherente con la pantalla de devolución
// final (AntesalaSummary).
const TXT_ASK_A    = "Empecemos por conocer su empresa.";
const TXT_ASK_B    = "Siete preguntas. Al terminar, su gabinete queda configurado.";
const TXT_FOOT     = "KLUXOR — NO SE CONTRATA. SE RECIBE.";

const COUNCIL = [
  { key: "mario",   name: "Mario",   role: "Legal" },
  { key: "jorge",   name: "Jorge",   role: "Finanzas" },
  { key: "alvaro",  name: "Álvaro",  role: "Inmobiliario" },
  { key: "gonzalo", name: "Gonzalo", role: "Gobernanza" },
  { key: "diego",   name: "Diego",   role: "Contabilidad" },
];

const { BG, CARD, INK, GRAY, GOLD, BLACK, PEARL, SERIF, SANS } = COLORS;

// Filete oro sutil — separador entre bloques. Opacidad baja para no
// dominar la mirada; el oro señala frontera sin gritar.
function GoldRule() {
  return (
    <div style={{
      width: "100%",
      maxWidth: 220,
      height: 1,
      background: GOLD,
      opacity: 0.45,
      margin: "48px auto",
    }} />
  );
}

export default function AntesalaWelcome({ onStart }) {
  // phase: 1 (headline) → 2 (línea A) → 3 (línea B) → 4 (línea C
  // Consejo) → 5 (línea D Consejo) → done (aparecen bloques 4-9 con fade).
  const [phase, setPhase] = useState(1);
  const t1 = useTypewriter(TXT_HEADLINE, { startDelayMs: 350 });
  const t2 = useTypewriter(phase >= 2 ? TXT_LINE_A : "", { startDelayMs: 260 });
  const t3 = useTypewriter(phase >= 3 ? TXT_LINE_B : "", { startDelayMs: 260 });
  const t4 = useTypewriter(phase >= 4 ? TXT_LINE_C : "", { startDelayMs: 340 });
  const t5 = useTypewriter(phase >= 5 ? TXT_LINE_D : "", { startDelayMs: 260 });

  useEffect(() => {
    if (phase === 1 && t1.done) { const id = setTimeout(() => setPhase(2), 220); return () => clearTimeout(id); }
    if (phase === 2 && t2.done) { const id = setTimeout(() => setPhase(3), 220); return () => clearTimeout(id); }
    if (phase === 3 && t3.done) { const id = setTimeout(() => setPhase(4), 320); return () => clearTimeout(id); }
    if (phase === 4 && t4.done) { const id = setTimeout(() => setPhase(5), 220); return () => clearTimeout(id); }
    if (phase === 5 && t5.done) setPhase("done");
  }, [phase, t1.done, t2.done, t3.done, t4.done, t5.done]);

  const isDone = phase === "done";
  const skipAll = () => {
    t1.skip(); t2.skip(); t3.skip(); t4.skip(); t5.skip();
    setPhase("done");
  };
  const onBgClick = (e) => {
    if (!isDone && e.target === e.currentTarget) skipAll();
  };

  // Texto renderizado: si done, siempre el completo (skip ya lo forzó).
  const line1 = isDone ? TXT_HEADLINE : t1.shown;
  const line2 = isDone ? TXT_LINE_A : t2.shown;
  const line3 = isDone ? TXT_LINE_B : t3.shown;
  const line4 = isDone ? TXT_LINE_C : t4.shown;
  const line5 = isDone ? TXT_LINE_D : t5.shown;

  return (
    <div
      onClick={onBgClick}
      style={{
        position: "fixed",
        inset: 0,
        background: BG,
        overflowY: "auto",
        WebkitOverflowScrolling: "touch",
        fontFamily: SANS,
        color: INK,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        padding: "min(6vh, 48px) 24px 40px",
      }}>
      {/* Cabecera: marca en oro, coherente con los pasos siguientes.
          No hay contador "X de N" — la pantalla 0 no es un paso. */}
      <div style={{
        width: "100%",
        maxWidth: 560,
        marginBottom: 32,
      }}>
        <div style={{
          fontFamily: SERIF,
          fontSize: 14,
          fontWeight: 500,
          color: GOLD,
          letterSpacing: "0.24em",
        }}>KLUXOR</div>
      </div>

      {/* Tarjeta principal. Sin sombra — contraste #FAFAF7 vs #FFFFFF. */}
      <div
        onClick={onBgClick}
        style={{
          width: "100%",
          maxWidth: 560,
          background: CARD,
          padding: "64px 40px",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          textAlign: "center",
        }}>

        {/* 1. Monograma H grande. */}
        <AgentAvatar agent="hector" size={80} />

        {/* 2. Serif grande — headline typewriter. */}
        <div style={{
          marginTop: 40,
          fontFamily: SERIF,
          fontSize: "clamp(26px, 4.4vw, 32px)",
          fontWeight: 500,
          lineHeight: 1.25,
          color: INK,
          letterSpacing: "-0.005em",
          minHeight: "1.25em",
        }}>{line1}</div>

        {/* 3. Dos frases separadas — tamaño normal — typewriter. */}
        <div style={{
          marginTop: 32,
          fontSize: 17,
          lineHeight: 1.55,
          color: INK,
          maxWidth: 420,
          minHeight: "1.55em",
        }}>{line2}</div>

        <div style={{
          marginTop: 20,
          fontSize: 17,
          lineHeight: 1.55,
          color: INK,
          maxWidth: 420,
          minHeight: "1.55em",
        }}>{line3}</div>

        {/* Líneas puente al Consejo — se escriben tras las dos frases
            anteriores. La primera anuncia la disponibilidad; los
            monogramas de la sección siguiente presentan. */}
        <div style={{
          marginTop: 28,
          fontSize: 17,
          lineHeight: 1.55,
          color: INK,
          maxWidth: 460,
          minHeight: "1.55em",
        }}>{line4}</div>

        <div style={{
          marginTop: 12,
          fontSize: 17,
          lineHeight: 1.55,
          color: INK,
          maxWidth: 460,
          minHeight: "1.55em",
        }}>{line5}</div>

        {/* Bloques 4-9: solo cuando isDone. Aparecen ya montados con
            fade suave, sin typewriter. */}
        {isDone ? (
          <>
            <div style={{
              width: "100%",
              opacity: 0,
              animation: "kluxorFadeIn 320ms ease-out forwards",
            }}>
              {/* 4. Filete oro. */}
              <GoldRule />

              {/* 5. Eyebrow + Consejo. */}
              <div style={{
                fontSize: 11,
                color: GOLD,
                letterSpacing: "0.24em",
                fontWeight: 500,
                marginBottom: 28,
              }}>EL CONSEJO</div>
              <div style={{
                display: "flex",
                justifyContent: "space-between",
                flexWrap: "wrap",
                gap: 20,
                maxWidth: 480,
                margin: "0 auto",
              }}>
                {COUNCIL.map(c => (
                  <div key={c.key} style={{
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "center",
                    gap: 10,
                    minWidth: 72,
                  }}>
                    <AgentAvatar agent={c.key} size={44} />
                    <div style={{
                      fontFamily: SERIF,
                      fontSize: 15,
                      fontWeight: 500,
                      color: INK,
                      lineHeight: 1.1,
                    }}>{c.name}</div>
                    <div style={{
                      fontSize: 11,
                      color: GRAY,
                      letterSpacing: "0.02em",
                      lineHeight: 1.1,
                    }}>{c.role}</div>
                  </div>
                ))}
              </div>

              {/* 6. Filete oro. */}
              <GoldRule />

              {/* 7. Encuadre de diagnóstico — dos frases separadas. */}
              <div style={{
                fontFamily: SERIF,
                fontSize: "clamp(19px, 3vw, 22px)",
                fontWeight: 500,
                lineHeight: 1.35,
                color: INK,
                maxWidth: 440,
                margin: "0 auto",
                letterSpacing: "-0.005em",
              }}>{TXT_ASK_A}</div>
              <div style={{
                marginTop: 14,
                fontFamily: SERIF,
                fontSize: "clamp(17px, 2.6vw, 19px)",
                fontWeight: 500,
                lineHeight: 1.4,
                color: INK,
                maxWidth: 440,
                margin: "14px auto 0",
                letterSpacing: "-0.005em",
              }}>{TXT_ASK_B}</div>

              {/* 8. Botón único. */}
              <div style={{
                marginTop: 40,
                display: "flex",
                justifyContent: "center",
              }}>
                <button
                  type="button"
                  onClick={onStart}
                  style={{
                    minWidth: 200,
                    height: 48,
                    padding: "0 32px",
                    background: BLACK,
                    color: PEARL,
                    border: "none",
                    fontFamily: "inherit",
                    fontSize: 14,
                    fontWeight: 600,
                    letterSpacing: "0.04em",
                    cursor: "pointer",
                  }}
                >Empezar</button>
              </div>

              {/* 9. Pie de marca en oro, diminuto, espaciado. */}
              <div style={{
                marginTop: 56,
                textAlign: "center",
                fontSize: 10,
                color: GOLD,
                letterSpacing: "0.32em",
                fontWeight: 500,
              }}>{TXT_FOOT}</div>
            </div>
          </>
        ) : null}
      </div>

      <style>{`@keyframes kluxorFadeIn{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:translateY(0)}}`}</style>
    </div>
  );
}
