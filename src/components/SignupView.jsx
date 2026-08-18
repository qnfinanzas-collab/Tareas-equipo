// SignupView — F1.2 Antesala, pieza 2.
// Ruta pública /signup?token=<uuid>&email=<email>. Es la primera cara de
// Kluxor para un CEO invitado: pantalla completa, sin sidebar ni auth
// previa. Trato de USTED (marca externa, no chat operativo).
//
// Backend contra el que habla:
//   POST /api/signup {email, password, token}
//     → 200 {ok:true, tenant_id}
//     → 400 {error: "invitación no encontrada" | "invitación ya usada" |
//                    "invitación revocada" | "invitación expirada" |
//                    "email no coincide con la invitación" | "email inválido" |
//                    "contraseña mínimo 8 caracteres" | ...}
//     → 500 {error: "..."} (raros)
//
// Al éxito, hacemos signIn programático con el mismo email/password para
// que la SPA arranque ya autenticada — el invitado ve su Kluxor sin
// pasar por LoginScreen.
//
// Precedente visual: LoginScreen (App.jsx:2100-2229) — misma paleta.
// Precedente estructural: VaultGuestView.parseVaultGuestPath — parser
// exportado desde el propio componente, usado por App.jsx en el gate
// antes del auth (App.jsx:15602).

import React, { useState } from "react";
import { signIn } from "../lib/auth.js";
// parseSignupPath vive en src/lib/signupPath.js como función pura JS
// para poder testarlo desde Node smoke sin loader de JSX. Re-export
// aquí para preservar el patrón "parser exportado desde el propio
// componente" que hereda de VaultGuestView.
export { parseSignupPath } from "../lib/signupPath.js";

// Mensaje humano para cada error del endpoint. Fallback: eco literal.
function humanizeError(msg) {
  if (!msg) return "Ocurrió un error inesperado.";
  const m = msg.toLowerCase();
  if (m.includes("invitación no encontrada")
   || m.includes("invitación ya usada")
   || m.includes("invitación revocada")
   || m.includes("invitación expirada")) {
    return "Esta invitación ya no es válida. Solicite una nueva a quien le invitó.";
  }
  if (m.includes("email no coincide")) {
    return "El correo introducido no coincide con el de la invitación.";
  }
  if (m.includes("contraseña")) {
    return "La contraseña debe tener al menos 8 caracteres.";
  }
  if (m.includes("email inválido")) {
    return "El correo tiene un formato inválido.";
  }
  return msg;
}

export default function SignupView({ token, initialEmail, onSuccess, onAlreadyLoggedIn, isLoggedIn }) {
  const [email, setEmail]       = useState(initialEmail || "");
  const [password, setPassword] = useState("");
  const [busy, setBusy]         = useState(false);
  const [error, setError]       = useState(null);

  // Caso "ya hay sesión activa": el user visitó /signup pero ya está
  // logueado. Bloqueamos con aviso — el backend fallaría al crear el
  // auth.user (email UNIQUE) o crearía un tenant duplicado.
  if (isLoggedIn) {
    return (
      <Shell>
        <Eyebrow>Sesión activa</Eyebrow>
        <p style={S.tagline}>
          Ya está autenticado en Kluxor. Cierre sesión antes de aceptar una nueva invitación.
        </p>
        <button
          type="button"
          onClick={onAlreadyLoggedIn}
          style={S.primary}
        >
          Volver a mi Kluxor
        </button>
      </Shell>
    );
  }

  const submit = async (e) => {
    e.preventDefault();
    setError(null);
    const cleanEmail = email.trim().toLowerCase();
    if (!cleanEmail || !password) { setError("Introduzca correo y contraseña."); return; }
    if (password.length < 8) { setError("La contraseña debe tener al menos 8 caracteres."); return; }
    setBusy(true);
    try {
      const res = await fetch("/api/signup", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: cleanEmail, password, token }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(humanizeError(body?.error));
        return;
      }
      // Signup OK. Iniciamos sesión programáticamente con las mismas
      // credenciales — así la SPA arranca autenticada sin pasar por
      // LoginScreen. Si esto fallara, mostramos error específico.
      const session = await signIn(cleanEmail, password);
      if (typeof onSuccess === "function") onSuccess(session);
    } catch (loginErr) {
      setError(`Cuenta creada, pero no se pudo iniciar sesión automáticamente: ${loginErr.message}. Vaya a la pantalla de acceso e inicie sesión manualmente.`);
    } finally {
      setBusy(false);
    }
  };

  // Caso "sin token válido en la URL" — Antonio se refiere al mismo
  // texto para "no existe / caducado / usado". Aquí solo cubrimos el
  // parse; los otros los coge humanizeError tras el submit.
  if (!token) {
    return (
      <Shell>
        <Eyebrow>Invitación no válida</Eyebrow>
        <p style={S.tagline}>
          Esta invitación ya no es válida. Solicite una nueva a quien le invitó.
        </p>
        <a href="/" style={S.link}>Volver a la landing</a>
      </Shell>
    );
  }

  const emailReadOnly = !!initialEmail;

  return (
    <Shell>
      <Eyebrow>Ha sido convocado.</Eyebrow>
      <p style={S.tagline}>
        Complete su alta para recibir su propio Kluxor.
      </p>
      <form onSubmit={submit}>
        <label style={S.label}>Correo electrónico</label>
        <input
          type="email"
          value={email}
          onChange={e => setEmail(e.target.value)}
          readOnly={emailReadOnly}
          required
          placeholder="usted@ejemplo.com"
          disabled={busy}
          style={{
            ...S.input,
            background: emailReadOnly ? "#F5F0E4" : "#FFF",
            color: emailReadOnly ? "#4E4A42" : "#1A1A1A",
            cursor: emailReadOnly ? "not-allowed" : "text",
          }}
        />

        <label style={S.label}>Contraseña</label>
        <input
          type="password"
          value={password}
          onChange={e => setPassword(e.target.value)}
          required
          minLength={8}
          placeholder="Mínimo 8 caracteres"
          disabled={busy}
          autoFocus={emailReadOnly}
          style={S.input}
        />

        {error && <div style={S.error}>{error}</div>}

        <button
          type="submit"
          disabled={busy || !email.trim() || !password}
          style={{ ...S.primary, cursor: busy ? "wait" : "pointer" }}
        >
          {busy ? "Creando su cuenta…" : "Entrar"}
        </button>
      </form>
      <div style={S.footer}>
        Al continuar acepta que se cree una cuenta a su nombre en Kluxor.
      </div>
    </Shell>
  );
}

// ── Sub-componentes visuales ─────────────────────────────────────────

function Shell({ children }) {
  return (
    <div style={S.shell}>
      <style>{`
        .kx-sg-btn{transition:background .2s ease,color .2s ease}
        .kx-sg-btn:hover:not(:disabled){background:#C9A84C;color:#0F0E0C}
        .kx-sg-btn:disabled{background:#4E4A42;cursor:wait}
        .kx-sg-input:focus{border-color:#0F0E0C;outline:none}
      `}</style>
      <div style={S.card}>
        <div style={S.wordmark}>
          <span aria-hidden="true" style={S.diamond}/>
          <span style={S.brand}>Kluxor</span>
        </div>
        {children}
      </div>
    </div>
  );
}

function Eyebrow({ children }) {
  return <div style={S.eyebrow}>{children}</div>;
}

const S = {
  shell: {
    position: "fixed", inset: 0, background: "#FAFAF7",
    display: "flex", alignItems: "center", justifyContent: "center",
    padding: 20, zIndex: 5000,
    fontFamily: "'Inter',system-ui,-apple-system,sans-serif",
  },
  card: {
    background: "#FFF", border: "1px solid #E5E0D5",
    padding: "44px 40px 32px", width: 440, maxWidth: "100%",
    borderRadius: 0,
  },
  wordmark: {
    display: "flex", alignItems: "center", gap: 12, marginBottom: 24,
  },
  diamond: {
    display: "inline-block", width: 11, height: 11,
    background: "#C9A84C", transform: "rotate(45deg)",
  },
  brand: {
    fontSize: 22, fontWeight: 600, letterSpacing: "-0.01em", color: "#0F0E0C",
  },
  eyebrow: {
    fontSize: 10.5, fontWeight: 600, letterSpacing: "0.32em",
    textTransform: "uppercase", color: "#9A6F14", marginBottom: 12,
  },
  tagline: {
    fontSize: 15, color: "#1A1A1A", lineHeight: 1.55,
    marginBottom: 28, marginTop: 0, fontWeight: 400,
  },
  label: {
    display: "block", fontSize: 11.5, fontWeight: 500,
    color: "#1A1A1A", marginBottom: 6, letterSpacing: "0.01em",
  },
  input: {
    width: "100%", minHeight: 56, boxSizing: "border-box",
    padding: "14px 16px", border: "1px solid #E5E0D5",
    fontSize: 15, fontFamily: "inherit", color: "#1A1A1A",
    marginBottom: 16, transition: "border-color .15s ease",
    borderRadius: 0, WebkitAppearance: "none", appearance: "none",
  },
  error: {
    fontSize: 13, color: "#8A2020",
    background: "#FBEFEF", border: "1px solid rgba(138,32,32,.2)",
    padding: "10px 14px", marginBottom: 14, lineHeight: 1.4,
    borderRadius: 0,
  },
  primary: {
    className: "kx-sg-btn",
    width: "100%", minHeight: 48, padding: "14px 22px",
    background: "#0F0E0C", color: "#FFF", border: "none",
    fontSize: 14, fontFamily: "inherit", fontWeight: 600,
    letterSpacing: "0.04em", borderRadius: 0,
  },
  link: {
    display: "inline-block", marginTop: 20,
    color: "#9A6F14", textDecoration: "none",
    borderBottom: "1px solid rgba(154,111,20,.35)",
    fontSize: 13, paddingBottom: 2,
  },
  footer: {
    marginTop: 22, paddingTop: 16,
    borderTop: "1px solid #E5E0D5",
    fontSize: 12, color: "#6B6B6B", lineHeight: 1.5,
    textAlign: "center",
  },
};
