// signupPath — parser puro de la URL /signup?token=X&email=Y.
// Extraído de SignupView.jsx a un .js puro para poder testarlo desde
// Node smoke sin loader de JSX. La función es determinista y sin deps.

// Devuelve {token, email} si la URL es /signup con token válido; null si no.
// Reglas:
//   - path debe ser EXACTAMENTE "/signup" (sin slash final, sin subpath).
//   - token requerido, ≥8 caracteres.
//   - email opcional; si viene, se normaliza (trim + lowercase).
//
// La URL construida por InviteCEO incluye ambos params. Si alguien
// manipula el email a otro distinto, /api/signup lo detecta y devuelve
// error explícito ("email no coincide con la invitación").
export function parseSignupPath(pathname, search) {
  if (pathname !== "/signup") return null;
  const params = new URLSearchParams(search || "");
  const token = params.get("token");
  if (!token || token.length < 8) return null;
  const email = params.get("email") || "";
  return { token, email: email.trim().toLowerCase() };
}
