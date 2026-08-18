// InviteCEO — F1.2 Antesala, pieza 1.
// Sustituye el botón "Invitar" placebo de TeamView (App.jsx:7180) que
// pintaba un toast falso sin llamar a ningún endpoint. Ahora llama
// realmente a /api/create-invite y muestra el enlace generado.
//
// Semántica IMPORTANTE (respetada del backend, no cambiada por el frontend):
//   El endpoint crea una invitación que, al aceptarse, dará al invitado
//   su propio tenant nuevo (nuevo Kluxor aislado). NO le añade al tenant
//   ni al proyecto del invitador. Por eso el copy es "Convocar a un CEO",
//   no "Añadir al proyecto" — para no engañar al usuario del sistema.
//
// Solo visible si el caller es owner de un tenant existente (backend lo
// verifica también en /api/create-invite.js:33-41 con 403 si no lo es;
// aquí lo escondemos por UX). Un member ni siquiera ve el bloque.
//
// El link generado incluye el email como query param además del token,
// para que la pantalla /signup pueda prellenarlo. El backend valida en
// /api/signup.js:54 que el email de submit coincide con el de la
// invitación — si alguien manipula la URL a otro email, signup falla.
import React, { useState } from "react";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default function InviteCEO({ authSession, isOwner }) {
  const [email, setEmail]     = useState("");
  const [busy, setBusy]       = useState(false);
  const [error, setError]     = useState(null);
  const [invite, setInvite]   = useState(null); // { url, expires_at }
  const [copied, setCopied]   = useState(false);

  // Guard duro: si no es owner, no renderizamos nada. Segunda capa tras
  // el 403 del backend (defensa en profundidad).
  if (!isOwner) return null;

  const submit = async (e) => {
    e.preventDefault();
    setError(null);
    setInvite(null);
    setCopied(false);
    const cleanEmail = email.trim().toLowerCase();
    if (!EMAIL_RE.test(cleanEmail)) { setError("Email inválido."); return; }
    const bearer = authSession?.access_token;
    if (!bearer) { setError("Sesión no disponible. Recarga la página."); return; }
    setBusy(true);
    try {
      const res = await fetch("/api/create-invite", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "authorization": `Bearer ${bearer}`,
        },
        body: JSON.stringify({ email: cleanEmail }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        // Mensajes honestos y específicos del endpoint, no genéricos.
        const msg = body?.error || `HTTP ${res.status}`;
        // Renombramos los 3 errores más frecuentes a lenguaje operativo.
        if (msg.includes("no bearer token"))              setError("Sesión caducada. Vuelve a entrar.");
        else if (msg.includes("solo owners"))             setError("Solo el owner de un tenant puede invitar.");
        else if (msg.includes("email inválido"))          setError("Email inválido.");
        else                                               setError(msg);
        return;
      }
      // Construimos el enlace final con email en query param — el signup
      // lo lee para prellenarlo. Token ya viene incluido en body.url.
      const withEmail = body.url + (body.url.includes("?") ? "&" : "?") + "email=" + encodeURIComponent(cleanEmail);
      setInvite({ url: withEmail, expires_at: body.expires_at });
      setEmail("");
    } catch (netErr) {
      setError(`Error de red: ${netErr.message || netErr}`);
    } finally {
      setBusy(false);
    }
  };

  const copyLink = async () => {
    if (!invite?.url) return;
    try {
      await navigator.clipboard.writeText(invite.url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2200);
    } catch {
      setError("No pude copiar al portapapeles. Selecciona y copia a mano.");
    }
  };

  const dismissInvite = () => { setInvite(null); setCopied(false); };

  return (
    <div style={S.wrap}>
      <div style={S.eyebrow}>Convocar a un CEO a Kluxor</div>
      <div style={S.subtitle}>
        El invitado recibirá su propio Kluxor aislado. No formará parte de este proyecto ni de tu tenant.
      </div>
      <form onSubmit={submit} style={S.form}>
        <input
          type="email"
          value={email}
          onChange={e => setEmail(e.target.value)}
          placeholder="email@ejemplo.com"
          disabled={busy || !!invite}
          autoComplete="email"
          style={S.input}
        />
        <button
          type="submit"
          disabled={busy || !email.trim() || !!invite}
          style={{ ...S.btn, cursor: busy ? "wait" : (invite ? "default" : "pointer") }}
        >
          {busy ? "Generando…" : "Invitar"}
        </button>
      </form>
      {error && <div style={S.error}>{error}</div>}
      {invite && (
        <div style={S.result}>
          <div style={S.resultTitle}>Enlace de invitación</div>
          <div style={S.linkBox}>{invite.url}</div>
          <div style={S.actions}>
            <button type="button" onClick={copyLink} style={S.copyBtn}>
              {copied ? "Copiado" : "Copiar enlace"}
            </button>
            <button type="button" onClick={dismissInvite} style={S.dismissBtn}>
              Nueva invitación
            </button>
          </div>
          <div style={S.meta}>
            Caduca el {new Date(invite.expires_at).toLocaleDateString("es-ES", { day: "2-digit", month: "long", year: "numeric" })}.
            Distribuye este enlace de forma segura — quien lo abra podrá completar el alta.
          </div>
        </div>
      )}
    </div>
  );
}

const S = {
  wrap: {
    borderTop: "1px solid #E5E0D5",
    paddingTop: 20,
    marginTop: 20,
    fontFamily: "'Inter',system-ui,-apple-system,sans-serif",
  },
  eyebrow: {
    fontSize: 10.5, fontWeight: 600, letterSpacing: "0.32em",
    textTransform: "uppercase", color: "#9A6F14", marginBottom: 8,
  },
  subtitle: {
    fontSize: 13, color: "#4E4A42", lineHeight: 1.55, marginBottom: 16,
  },
  form: {
    display: "flex", gap: 10, flexWrap: "wrap",
  },
  input: {
    flex: 1, minWidth: 200, minHeight: 56, boxSizing: "border-box",
    padding: "14px 16px", border: "1px solid rgba(15,14,12,.18)",
    background: "#FFF", fontSize: 15, fontFamily: "inherit",
    color: "#1A1A1A", borderRadius: 0, outline: "none",
    transition: "border-color .15s ease",
  },
  btn: {
    minHeight: 48, padding: "12px 22px", background: "#0F0E0C",
    color: "#FFF", border: "none", fontSize: 13, fontFamily: "inherit",
    fontWeight: 600, letterSpacing: "0.04em", borderRadius: 0,
    transition: "background .2s ease, color .2s ease",
  },
  error: {
    marginTop: 12, fontSize: 13, color: "#8A2020",
    background: "#FBEFEF", border: "1px solid rgba(138,32,32,.2)",
    padding: "10px 14px", lineHeight: 1.4, borderRadius: 0,
  },
  result: {
    marginTop: 16, padding: 18, background: "#FAFAF7",
    border: "1px solid #E5E0D5", borderRadius: 0,
  },
  resultTitle: {
    fontSize: 11, fontWeight: 600, letterSpacing: "0.24em",
    textTransform: "uppercase", color: "#9A6F14", marginBottom: 10,
  },
  linkBox: {
    padding: "10px 12px", background: "#FFF",
    border: "1px solid #E5E0D5", fontSize: 12.5, color: "#1A1A1A",
    fontFamily: "'SF Mono',Consolas,monospace", wordBreak: "break-all",
    lineHeight: 1.5, borderRadius: 0, marginBottom: 12,
  },
  actions: {
    display: "flex", gap: 10, flexWrap: "wrap",
  },
  copyBtn: {
    minHeight: 48, padding: "12px 22px", background: "#C9A84C",
    color: "#0F0E0C", border: "none", fontSize: 13, fontFamily: "inherit",
    fontWeight: 600, cursor: "pointer", letterSpacing: "0.04em",
    borderRadius: 0,
  },
  dismissBtn: {
    minHeight: 48, padding: "12px 22px", background: "transparent",
    color: "#4E4A42", border: "1px solid #E5E0D5", fontSize: 13,
    fontFamily: "inherit", fontWeight: 500, cursor: "pointer",
    borderRadius: 0,
  },
  meta: {
    marginTop: 12, fontSize: 11.5, color: "#6B6B6B", lineHeight: 1.5,
  },
};
