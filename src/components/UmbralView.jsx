// UmbralView — F1.2 Antesala. Pantalla propia del owner para convocar
// nuevos CEOs a Kluxor. Reemplaza el bloque placebo de TeamView.
//
// Filosofía: "Kluxor no se contrata. Se recibe." Convocar es el gesto
// más importante de la marca — pantalla dedicada, material dorado
// (tarjeta descargable), listado de convocatorias emitidas con estado.
//
// Guard doble (defensa en profundidad):
//   - Frontend: if (!isOwner) return null.
//   - Backend:  api/create-invite.js:39 responde 403 si el caller no es
//              owner de un tenant. api/revoke-invite.js filtra por
//              invited_by = auth.uid() — sin exposición cruzada.
//
// Lectura del listado: SELECT directo desde supabase-js. La policy RLS
// invitations_select_own (migrations/2026-08-18-invitations-table.sql:
// 105-109) filtra automáticamente a las del owner logueado. Cero
// endpoint backend nuevo para leer.

import React, { useCallback, useEffect, useMemo, useState } from "react";
import UmbralCard, { buildInviteMessage } from "./UmbralCard.jsx";
import { supa } from "../lib/sync.js";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Deriva el estado visual de una invitación desde used_at/revoked_at/expires_at.
// No hay columna "status" en BD — es una función determinista pura.
function deriveStatus(inv, nowMs = Date.now()) {
  if (!inv) return "?";
  if (inv.used_at)    return "Aceptada";
  if (inv.revoked_at) return "Revocada";
  const exp = inv.expires_at ? new Date(inv.expires_at).getTime() : 0;
  if (exp && exp < nowMs) return "Caducada";
  return "Pendiente";
}

// Color del badge según estado. Paleta operativa Kluxor.
function statusStyle(status) {
  switch (status) {
    case "Aceptada": return { fg: "#0E7C5A", bg: "#DCFCE7", bd: "#86EFAC" };
    case "Revocada": return { fg: "#6B6B6B", bg: "#F5F5F0", bd: "#E5E0D5" };
    case "Caducada": return { fg: "#8A2020", bg: "#FBEFEF", bd: "#FCA5A5" };
    default:         return { fg: "#9A6F14", bg: "#F5F0E4", bd: "#C9A84C" }; // Pendiente = oro
  }
}

function fmtDate(iso) {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleDateString("es-ES", { day: "2-digit", month: "short", year: "numeric" });
  } catch { return iso; }
}

export default function UmbralView({ authSession, isOwner, ownerName }) {
  // Guard duro: si no es owner, no renderizamos nada. Segunda capa
  // tras el 403 del backend.
  if (!isOwner) return null;

  const [name, setName]           = useState("");
  const [email, setEmail]         = useState("");
  const [busy, setBusy]           = useState(false);
  const [error, setError]         = useState(null);
  const [invite, setInvite]       = useState(null); // { url, expires_at, name }
  const [cardActions, setCardActions] = useState(null);
  const [copiedKey, setCopiedKey] = useState(null);

  // Listado de convocatorias emitidas por el owner (RLS filtra).
  const [list, setList]           = useState([]);
  const [listLoading, setListLoading] = useState(false);
  const [listError, setListError] = useState(null);
  const [confirmRevokeId, setConfirmRevokeId] = useState(null);

  const reloadList = useCallback(async () => {
    if (!supa) { setListError("Supabase no configurado."); return; }
    setListLoading(true);
    setListError(null);
    try {
      const { data, error: err } = await supa
        .from("invitations")
        .select("id, token, name, email, expires_at, used_at, revoked_at, created_at")
        .order("created_at", { ascending: false });
      if (err) throw err;
      setList(Array.isArray(data) ? data : []);
    } catch (e) {
      setListError(e?.message || "Error cargando convocatorias");
    } finally {
      setListLoading(false);
    }
  }, []);

  useEffect(() => { reloadList(); }, [reloadList]);

  const submit = async (e) => {
    e.preventDefault();
    setError(null);
    setInvite(null);
    setCardActions(null);
    setCopiedKey(null);
    const cleanName  = name.trim();
    const cleanEmail = email.trim().toLowerCase();
    if (!cleanName)                    { setError("Introduzca nombre y apellidos."); return; }
    if (cleanName.length > 120)        { setError("Nombre demasiado largo (máx 120)."); return; }
    if (!EMAIL_RE.test(cleanEmail))    { setError("Correo inválido."); return; }
    const bearer = authSession?.access_token;
    if (!bearer)                       { setError("Sesión no disponible. Recargue la página."); return; }
    setBusy(true);
    try {
      const res = await fetch("/api/create-invite", {
        method: "POST",
        headers: { "content-type": "application/json", "authorization": `Bearer ${bearer}` },
        body: JSON.stringify({ email: cleanEmail, name: cleanName }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        const msg = body?.error || `HTTP ${res.status}`;
        if (msg.includes("no bearer token"))            setError("Sesión caducada. Vuelva a entrar.");
        else if (msg.includes("solo owners"))           setError("Solo el owner de un tenant puede convocar.");
        else if (msg.includes("email inválido"))        setError("Correo inválido.");
        else if (msg.includes("nombre demasiado largo")) setError("Nombre demasiado largo.");
        else                                            setError(msg);
        return;
      }
      const withEmail = body.url + (body.url.includes("?") ? "&" : "?") + "email=" + encodeURIComponent(cleanEmail);
      setInvite({ url: withEmail, expires_at: body.expires_at, name: cleanName });
      setName("");
      setEmail("");
      // Recarga listado para reflejar la nueva.
      reloadList();
    } catch (netErr) {
      setError(`Error de red: ${netErr.message || netErr}`);
    } finally {
      setBusy(false);
    }
  };

  const copy = async (key, text) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedKey(key);
      setTimeout(() => setCopiedKey(prev => prev === key ? null : prev), 2200);
    } catch {
      setError("No pude copiar al portapapeles. Selecciónelo y copie a mano.");
    }
  };

  const message = useMemo(() => {
    if (!invite) return "";
    return buildInviteMessage({
      inviteeName: invite.name,
      ownerName,
      url: invite.url,
      expiresAt: invite.expires_at,
    });
  }, [invite, ownerName]);

  const dismissInvite = () => {
    setInvite(null);
    setCardActions(null);
    setCopiedKey(null);
  };

  const doRevoke = async (token) => {
    if (!authSession?.access_token) { setListError("Sesión no disponible."); return; }
    try {
      const res = await fetch("/api/revoke-invite", {
        method: "POST",
        headers: { "content-type": "application/json", "authorization": `Bearer ${authSession.access_token}` },
        body: JSON.stringify({ token }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) { setListError(body?.error || `HTTP ${res.status}`); return; }
      setConfirmRevokeId(null);
      reloadList();
    } catch (e) {
      setListError(`Error de red: ${e.message || e}`);
    }
  };

  const nowMs = Date.now();

  return (
    <div style={S.wrap}>
      <style>{`
        .kx-um-btn{transition:background .2s ease,color .2s ease}
        .kx-um-btn:hover:not(:disabled){background:#C9A84C;color:#0F0E0C}
        .kx-um-btn:disabled{background:#4E4A42;cursor:wait}
        .kx-um-input:focus{border-color:#0F0E0C;outline:none}
      `}</style>

      {/* Cabecera */}
      <div style={S.head}>
        <div style={S.eyebrow}>EL UMBRAL</div>
        <div style={S.tagline}>
          <span style={S.taglineItalic}>Kluxor no se contrata.</span> Se recibe.
        </div>
      </div>

      {/* Sección de convocatoria: form o preview */}
      {!invite ? (
        <form onSubmit={submit} style={S.form}>
          <label style={S.label}>Nombre y apellidos</label>
          <input
            type="text"
            value={name}
            onChange={e => setName(e.target.value)}
            placeholder="Nombre completo del convocado"
            disabled={busy}
            style={S.input}
            className="kx-um-input"
            maxLength={120}
          />

          <label style={S.label}>Correo electrónico</label>
          <input
            type="email"
            value={email}
            onChange={e => setEmail(e.target.value)}
            placeholder="correo@ejemplo.com"
            disabled={busy}
            autoComplete="email"
            style={S.input}
            className="kx-um-input"
          />

          {error && <div style={S.error}>{error}</div>}

          <div style={S.submitRow}>
            <button
              type="submit"
              disabled={busy || !name.trim() || !email.trim()}
              className="kx-um-btn"
              style={{ ...S.btnPrimary, cursor: busy ? "wait" : "pointer" }}
            >
              {busy ? "Generando…" : "Convocar"}
            </button>
          </div>
        </form>
      ) : (
        <div style={S.result}>
          <div style={S.resultTitle}>CONVOCATORIA EMITIDA</div>

          <UmbralCard
            inviteeName={invite.name}
            ownerName={ownerName}
            url={invite.url}
            expiresAt={invite.expires_at}
            onReady={setCardActions}
          />

          <div style={S.actionsRow}>
            <button
              type="button"
              onClick={() => cardActions?.downloadPng?.()}
              disabled={!cardActions}
              style={S.btnAction}
            >
              Descargar tarjeta (PNG)
            </button>
            <button
              type="button"
              onClick={() => cardActions?.downloadPdf?.()}
              disabled={!cardActions}
              style={S.btnAction}
            >
              Descargar tarjeta (PDF)
            </button>
            <button
              type="button"
              onClick={() => copy("msg", message)}
              style={S.btnAction}
            >
              {copiedKey === "msg" ? "Copiado" : "Copiar mensaje"}
            </button>
            <button
              type="button"
              onClick={() => copy("url", invite.url)}
              style={S.btnAction}
            >
              {copiedKey === "url" ? "Copiado" : "Copiar enlace"}
            </button>
          </div>

          {/* Preview del mensaje para leerlo antes de copiar */}
          <details style={S.msgPreview}>
            <summary style={S.msgSummary}>Ver mensaje que se enviará</summary>
            <pre style={S.msgPre}>{message}</pre>
          </details>

          <div style={S.newRow}>
            <button
              type="button"
              onClick={dismissInvite}
              style={S.btnGhost}
            >
              Nueva convocatoria
            </button>
          </div>
        </div>
      )}

      {/* Listado de convocatorias emitidas */}
      <div style={S.listSection}>
        <div style={S.listTitle}>CONVOCATORIAS EMITIDAS</div>
        {listError && <div style={S.error}>{listError}</div>}
        {listLoading && !list.length ? (
          <div style={S.listEmpty}>Cargando…</div>
        ) : list.length === 0 ? (
          <div style={S.listEmpty}>Aún no ha convocado a nadie.</div>
        ) : (
          <table style={S.table}>
            <thead>
              <tr>
                <th style={S.th}>Nombre</th>
                <th style={S.th}>Correo</th>
                <th style={S.th}>Emitida</th>
                <th style={S.th}>Estado</th>
                <th style={S.thRight}> </th>
              </tr>
            </thead>
            <tbody>
              {list.map(inv => {
                const status  = deriveStatus(inv, nowMs);
                const ss      = statusStyle(status);
                const canRev  = status === "Pendiente";
                const isConfirming = confirmRevokeId === inv.id;
                return (
                  <tr key={inv.id} style={S.tr}>
                    <td style={S.td}>{inv.name || <span style={S.dim}>—</span>}</td>
                    <td style={S.td}>{inv.email}</td>
                    <td style={S.td}>{fmtDate(inv.created_at)}</td>
                    <td style={S.td}>
                      <span style={{
                        display: "inline-block", padding: "3px 10px",
                        fontSize: 10.5, fontWeight: 600, letterSpacing: "0.06em",
                        color: ss.fg, background: ss.bg, border: `1px solid ${ss.bd}`,
                      }}>{status.toUpperCase()}</span>
                    </td>
                    <td style={S.tdRight}>
                      {canRev && !isConfirming && (
                        <button
                          type="button"
                          onClick={() => setConfirmRevokeId(inv.id)}
                          style={S.btnRevoke}
                        >Revocar</button>
                      )}
                      {canRev && isConfirming && (
                        <span style={S.confirmBlock}>
                          <span style={S.confirmText}>La convocatoria dejará de ser válida.</span>
                          <button
                            type="button"
                            onClick={() => doRevoke(inv.token)}
                            style={S.btnRevokeConfirm}
                          >Revocar</button>
                          <button
                            type="button"
                            onClick={() => setConfirmRevokeId(null)}
                            style={S.btnCancel}
                          >Cancelar</button>
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

// ── Estilos operativos Kluxor ────────────────────────────────────────
const S = {
  wrap: {
    padding: "28px 24px",
    maxWidth: 820,
    margin: "0 auto",
    fontFamily: "'Inter', system-ui, -apple-system, sans-serif",
    color: "#1A1A1A",
  },
  head: { marginBottom: 28 },
  eyebrow: {
    fontSize: 11, fontWeight: 600, letterSpacing: "0.32em",
    textTransform: "uppercase", color: "#9A6F14", marginBottom: 10,
  },
  tagline: {
    fontSize: 22, color: "#1A1A1A", lineHeight: 1.4,
  },
  taglineItalic: {
    fontFamily: "'Instrument Serif', Georgia, serif", fontStyle: "italic",
    color: "#9A6F14",
  },
  form: {
    background: "#FFF", border: "1px solid #E5E0D5", padding: 28, marginBottom: 32,
  },
  label: {
    display: "block", fontSize: 11.5, fontWeight: 500,
    color: "#1A1A1A", marginBottom: 6, letterSpacing: "0.01em",
  },
  input: {
    width: "100%", minHeight: 56, boxSizing: "border-box",
    padding: "14px 16px", border: "1px solid #E5E0D5",
    background: "#FFF", fontSize: 15, fontFamily: "inherit", color: "#1A1A1A",
    marginBottom: 18, borderRadius: 0,
    WebkitAppearance: "none", appearance: "none",
  },
  error: {
    marginBottom: 14, fontSize: 13, color: "#8A2020",
    background: "#FBEFEF", border: "1px solid rgba(138,32,32,.2)",
    padding: "10px 14px", lineHeight: 1.4, borderRadius: 0,
  },
  submitRow: { display: "flex", justifyContent: "flex-end" },
  btnPrimary: {
    minHeight: 48, padding: "12px 30px", background: "#0F0E0C",
    color: "#FFF", border: "none", fontSize: 13, fontFamily: "inherit",
    fontWeight: 600, letterSpacing: "0.04em", borderRadius: 0,
  },
  result: {
    background: "#FFF", border: "1px solid #E5E0D5", padding: 28, marginBottom: 32,
  },
  resultTitle: {
    fontSize: 10.5, fontWeight: 600, letterSpacing: "0.32em",
    textTransform: "uppercase", color: "#9A6F14", marginBottom: 20, textAlign: "center",
  },
  actionsRow: {
    marginTop: 22, display: "flex", flexWrap: "wrap", gap: 10, justifyContent: "center",
  },
  btnAction: {
    minHeight: 48, padding: "12px 20px", background: "#C9A84C",
    color: "#0F0E0C", border: "none", fontSize: 12.5, fontFamily: "inherit",
    fontWeight: 600, cursor: "pointer", letterSpacing: "0.04em", borderRadius: 0,
  },
  msgPreview: {
    marginTop: 20, background: "#FAFAF7", border: "1px solid #E5E0D5", padding: 14,
  },
  msgSummary: {
    fontSize: 12, fontWeight: 600, letterSpacing: "0.06em",
    color: "#4E4A42", cursor: "pointer", textTransform: "uppercase",
  },
  msgPre: {
    marginTop: 12, whiteSpace: "pre-wrap", wordBreak: "break-word",
    fontFamily: "'SF Mono', Consolas, monospace", fontSize: 12.5,
    color: "#1A1A1A", lineHeight: 1.55,
  },
  newRow: { marginTop: 22, textAlign: "center" },
  btnGhost: {
    minHeight: 48, padding: "12px 22px", background: "transparent",
    color: "#4E4A42", border: "1px solid #E5E0D5", fontSize: 13,
    fontFamily: "inherit", fontWeight: 500, cursor: "pointer", borderRadius: 0,
  },
  listSection: {
    background: "#FFF", border: "1px solid #E5E0D5", padding: 24,
  },
  listTitle: {
    fontSize: 10.5, fontWeight: 600, letterSpacing: "0.32em",
    textTransform: "uppercase", color: "#9A6F14", marginBottom: 16,
  },
  listEmpty: {
    padding: "40px 12px", textAlign: "center", fontSize: 14, color: "#6B6B6B",
    fontFamily: "'Instrument Serif', Georgia, serif", fontStyle: "italic",
  },
  table: {
    width: "100%", borderCollapse: "collapse", fontSize: 13,
  },
  th: {
    textAlign: "left", padding: "10px 12px", fontSize: 10.5, fontWeight: 600,
    letterSpacing: "0.08em", textTransform: "uppercase", color: "#6B6B6B",
    borderBottom: "1px solid #E5E0D5",
  },
  thRight: {
    textAlign: "right", padding: "10px 12px", borderBottom: "1px solid #E5E0D5",
  },
  tr: { borderBottom: "1px solid #F5F0E4" },
  td: { padding: "12px", verticalAlign: "middle", color: "#1A1A1A" },
  tdRight: { padding: "12px", verticalAlign: "middle", textAlign: "right" },
  dim: { color: "#B0AEA8" },
  btnRevoke: {
    padding: "6px 12px", background: "transparent", color: "#8A2020",
    border: "1px solid rgba(138,32,32,.35)", fontSize: 11, fontWeight: 600,
    letterSpacing: "0.04em", cursor: "pointer", borderRadius: 0,
    fontFamily: "inherit",
  },
  confirmBlock: {
    display: "inline-flex", alignItems: "center", gap: 8, flexWrap: "wrap",
    justifyContent: "flex-end",
  },
  confirmText: {
    fontSize: 11.5, color: "#8A2020", fontStyle: "italic",
  },
  btnRevokeConfirm: {
    padding: "6px 12px", background: "#8A2020", color: "#FFF", border: "none",
    fontSize: 11, fontWeight: 600, letterSpacing: "0.04em", cursor: "pointer",
    borderRadius: 0, fontFamily: "inherit",
  },
  btnCancel: {
    padding: "6px 12px", background: "transparent", color: "#4E4A42",
    border: "1px solid #E5E0D5", fontSize: 11, fontWeight: 500, cursor: "pointer",
    borderRadius: 0, fontFamily: "inherit",
  },
};
