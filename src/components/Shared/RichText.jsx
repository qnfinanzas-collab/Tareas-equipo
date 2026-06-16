// RichText — wrapper de presentación para texto largo del usuario
// (descripciones, notas, memoria, etc.).
//
// Propósito único: respetar los saltos de línea (\n) que el CEO escribió
// en los <textarea>. Hasta ahora muchos sitios pintaban el texto con
// <div>{texto}</div> sin CSS y los \n se colapsaban a espacios → muro
// de texto ilegible.
//
// Diseño:
// · whiteSpace: "pre-wrap"  → respeta \n y espacios múltiples, pero
//                              sigue haciendo wrap automático en el
//                              ancho disponible (NO horizontal scroll).
// · wordBreak: "break-word" → URLs largas / palabras kilométricas no
//                              rompen el layout en mobile.
// · lineHeight configurable → cada sitio que sustituya puede pasar el
//                              suyo (default 1.5, que es el más común).
// · style override          → permite a cada caller añadir colores,
//                              padding, font-size sin estorbarse con el
//                              componente base.
//
// Seguridad: NO usamos dangerouslySetInnerHTML. El texto se inyecta
// como children y React lo escapa por defecto. Si el CEO escribe HTML
// literal ("<script>") aparece como texto literal, no como código.
// Markdown (bold, listas) queda fuera del alcance — upgrade opcional
// futuro.
//
// Defensivo: si text es null/undefined/no-string, devuelve null para
// que el caller no tenga que hacer `{text && <RichText…>}`.

import React from "react";

export default function RichText({ text, lineHeight = 1.5, style = {} }) {
  if (!text || typeof text !== "string") return null;
  return (
    <div style={{
      whiteSpace: "pre-wrap",
      wordBreak: "break-word",
      lineHeight,
      ...style,
    }}>{text}</div>
  );
}
