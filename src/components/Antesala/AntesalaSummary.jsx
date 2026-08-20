// AntesalaSummary — pantalla de devolución tras la sexta pregunta
// (Antonio, 20/08/2026: la Antesala no es un registro, es un
// diagnóstico exprés — y toda consultoría debe devolver algo al final).
//
// Héctor devuelve lo que ha entendido de la entrevista antes de que
// el CEO entre en Kluxor. Los tres proyectos NO se han creado aún:
// se crean AL PULSAR "Entrar en Kluxor". Eso da al CEO la última
// oportunidad de corregir cualquier respuesta antes de que la app
// materialice nada.
//
// Estructura:
//   Monograma H
//   "Esto es lo que he entendido."   ← serif grande
//   ─── filete oro ───
//   SU EMPRESA        · [company + description]
//   SU EQUIPO         · [N personas]
//   SUS TRES FRENTES  · [f1] [f2] [f3] + "Los he convertido en proyectos."
//   LO QUE LE ROBA TIEMPO · [respuesta] + "Lo tendré presente."
//   SU DÍA            · [schedule label] · [city]
//   ─── filete oro ───
//   "Su gabinete está listo. Empecemos."
//   Botón: "Entrar en Kluxor"
//   Debajo, discreto: "Corregir algo" → despliega lista y vuelve al paso.
import React, { useState } from "react";
import AgentAvatar from "../Shared/AgentAvatar.jsx";
import { COLORS } from "./AntesalaStep.jsx";
import { SCHEDULES } from "./steps/Step6ScheduleCity.jsx";
import { ADVISOR_OPTIONS } from "./steps/Step7Advisors.jsx";

const { BG, CARD, INK, GRAY, GOLD, BLACK, PEARL, HAIR, SERIF, SANS } = COLORS;

function GoldRule() {
  return (
    <div style={{
      width: "100%",
      maxWidth: 220,
      height: 1,
      background: GOLD,
      opacity: 0.45,
      margin: "40px auto",
    }} />
  );
}

// Eyebrow small-caps en oro, misma línea que "EL CONSEJO" del Welcome.
function Eyebrow({ children }) {
  return (
    <div style={{
      fontSize: 11,
      color: GOLD,
      letterSpacing: "0.24em",
      fontWeight: 500,
      marginBottom: 10,
      textTransform: "uppercase",
    }}>{children}</div>
  );
}

// Bloque estándar: eyebrow + contenido en serif.
function Section({ label, children }) {
  return (
    <div style={{ marginBottom: 28 }}>
      <Eyebrow>{label}</Eyebrow>
      <div style={{
        fontFamily: SERIF,
        fontSize: "clamp(17px, 2.6vw, 19px)",
        fontWeight: 500,
        lineHeight: 1.45,
        color: INK,
        letterSpacing: "-0.005em",
      }}>{children}</div>
    </div>
  );
}

// Etiqueta gris debajo del bloque para las coletillas "Los he convertido
// en proyectos." / "Lo tendré presente." — voz de Héctor, no ruido.
function Aside({ children }) {
  return (
    <div style={{
      marginTop: 8,
      fontSize: 13,
      color: GRAY,
      lineHeight: 1.5,
      fontStyle: "italic",
    }}>{children}</div>
  );
}

// Devuelve el horario legible del schedule elegido, o cadena vacía.
// SIN el label ("Mañana"/"Partido"/"Continuo") para no acumular puntos
// medios en el summary — el chip del paso 6 ya educó al CEO sobre la
// etiqueta. Aquí solo los horarios reales. Ejemplo:
//   "09:00–14:00 y 16:00–19:00 · Marbella"
function scheduleLabel(key) {
  const found = (SCHEDULES || []).find(s => s.key === key);
  if (!found) return "";
  return found.help || "";
}

// Devuelve el listado humano de asesores marcados en el Paso 7. Si el
// CEO marcó "Ahora mismo, nadie" devuelve la etiqueta única.
function advisorsHumanList(advisors) {
  if (!Array.isArray(advisors) || advisors.length === 0) return "";
  if (advisors.length === 1 && advisors[0] === "none") return "Nadie ahora mismo";
  const labels = advisors
    .filter(k => k !== "none")
    .map(k => (ADVISOR_OPTIONS.find(o => o.key === k) || {}).label || k)
    .filter(Boolean);
  return labels.join(" · ");
}

// Índice de secciones para "Corregir algo". Cada entrada apunta al step
// que hay que reabrir. Los pasos son 1..7 (los mismos del AntesalaFlow).
const CORRECT_ITEMS = [
  { step: 1, label: "El nombre con el que le llamo" },
  { step: 2, label: "Su empresa" },
  { step: 3, label: "El tamaño de su equipo" },
  { step: 4, label: "Sus tres frentes" },
  { step: 5, label: "Lo que le roba tiempo" },
  { step: 6, label: "Su horario y ciudad" },
  { step: 7, label: "Quién le asesora hoy" },
];

export default function AntesalaSummary({ answers, onEnter, onCorrect }) {
  const [showCorrect, setShowCorrect] = useState(false);
  const a = answers || {};

  const company = String(a.company || "").trim();
  const description = String(a.description || "").trim();
  const teamSize = typeof a.teamSize === "number" ? a.teamSize : 0;
  const fronts = Array.isArray(a.fronts) ? a.fronts.map(f => String(f || "").trim()).filter(Boolean) : [];
  const timeSink = String(a.timeSink || "").trim();
  const city = String(a.city || "").trim();
  const scheduleLbl = scheduleLabel(a.scheduleKey);
  const advisorsLbl = advisorsHumanList(a.advisors);

  return (
    <div style={{
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
      {/* Cabecera marca — coherente con Welcome y steps. */}
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

      {/* Tarjeta principal — sin sombra, contraste #FAFAF7 vs #FFFFFF. */}
      <div style={{
        width: "100%",
        maxWidth: 560,
        background: CARD,
        padding: "56px 40px",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
      }}>

        <AgentAvatar agent="hector" size={64} />

        <div style={{
          marginTop: 32,
          fontFamily: SERIF,
          fontSize: "clamp(26px, 4.4vw, 32px)",
          fontWeight: 500,
          lineHeight: 1.25,
          color: INK,
          letterSpacing: "-0.005em",
          textAlign: "center",
        }}>Esto es lo que he entendido.</div>

        <GoldRule />

        {/* Cuerpo del entregable. Alineación izquierda, ancho contenido. */}
        <div style={{ width: "100%", maxWidth: 440, margin: "0 auto" }}>

          <Section label="Su empresa">
            <div>{company || <em style={{ color: GRAY, fontStyle: "normal" }}>Sin respuesta</em>}</div>
            {description ? (
              <div style={{ marginTop: 6, fontSize: 15, color: GRAY, lineHeight: 1.5, fontFamily: SANS }}>{description}</div>
            ) : null}
          </Section>

          <Section label="Su equipo">
            {teamSize > 0 ? `${teamSize} persona${teamSize === 1 ? "" : "s"}` : <em style={{ color: GRAY, fontStyle: "normal" }}>Sin respuesta</em>}
          </Section>

          <Section label="Sus tres frentes">
            {fronts.length > 0 ? (
              <ul style={{
                margin: 0,
                paddingLeft: 20,
                fontFamily: SERIF,
                fontSize: "clamp(17px, 2.6vw, 19px)",
                fontWeight: 500,
                lineHeight: 1.6,
                color: INK,
                listStyleType: "none",
              }}>
                {fronts.map((f, i) => (
                  <li key={i} style={{
                    position: "relative",
                  }}>
                    <span style={{
                      position: "absolute",
                      left: -18,
                      color: GOLD,
                    }}>·</span>{f}
                  </li>
                ))}
              </ul>
            ) : <em style={{ color: GRAY, fontStyle: "normal" }}>Sin respuesta</em>}
            {fronts.length === 3 ? <Aside>Los he convertido en proyectos.</Aside> : null}
          </Section>

          <Section label="Lo que le roba tiempo">
            {timeSink || <em style={{ color: GRAY, fontStyle: "normal" }}>Sin respuesta</em>}
            {timeSink ? <Aside>Lo tendré presente.</Aside> : null}
          </Section>

          <Section label="Su día">
            {(scheduleLbl || city)
              ? [scheduleLbl, city].filter(Boolean).join(" · ")
              : <em style={{ color: GRAY, fontStyle: "normal" }}>Sin respuesta</em>}
          </Section>

          <Section label="Quién le asesora hoy">
            {advisorsLbl || <em style={{ color: GRAY, fontStyle: "normal" }}>Sin respuesta</em>}
          </Section>

        </div>

        <GoldRule />

        <div style={{
          fontFamily: SERIF,
          fontSize: "clamp(19px, 3vw, 22px)",
          fontWeight: 500,
          lineHeight: 1.35,
          color: INK,
          maxWidth: 440,
          margin: "0 auto",
          letterSpacing: "-0.005em",
          textAlign: "center",
        }}>Su gabinete está listo. Empecemos.</div>

        <div style={{
          marginTop: 36,
          display: "flex",
          justifyContent: "center",
        }}>
          <button
            type="button"
            onClick={onEnter}
            style={{
              minWidth: 220,
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
          >Entrar en Kluxor</button>
        </div>

        {/* Corregir algo — colapsable. Al abrir muestra lista de las 6
            secciones, cada una devuelve al paso correspondiente. Sin
            caja, sin borde, discreto. */}
        <div style={{ marginTop: 20, width: "100%", display: "flex", flexDirection: "column", alignItems: "center" }}>
          <button
            type="button"
            onClick={() => setShowCorrect(v => !v)}
            style={{
              background: "transparent",
              border: "none",
              padding: "8px 12px",
              fontFamily: "inherit",
              fontSize: 12,
              color: GRAY,
              cursor: "pointer",
              letterSpacing: "0.01em",
            }}
          >{showCorrect ? "Cerrar" : "Corregir algo"}</button>

          {showCorrect ? (
            <div style={{
              marginTop: 6,
              width: "100%",
              maxWidth: 360,
              display: "flex",
              flexDirection: "column",
              opacity: 0,
              animation: "kluxorFadeIn 220ms ease-out forwards",
            }}>
              {CORRECT_ITEMS.map(item => (
                <button
                  key={item.step}
                  type="button"
                  onClick={() => onCorrect?.(item.step)}
                  style={{
                    background: "transparent",
                    border: "none",
                    borderBottom: `1px solid ${HAIR}`,
                    padding: "12px 4px",
                    fontFamily: "inherit",
                    fontSize: 13,
                    color: INK,
                    textAlign: "left",
                    cursor: "pointer",
                  }}
                >{item.label}</button>
              ))}
            </div>
          ) : null}
        </div>

      </div>

      <style>{`@keyframes kluxorFadeIn{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:translateY(0)}}`}</style>
    </div>
  );
}
