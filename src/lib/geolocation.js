// Geolocalización "bajo orden" para HectorDirect — Fase D1.
//
// Diseño de producto:
//   - GPS SOLO se dispara tras orden explícita del CEO ("desde mi
//     ubicación" / variantes). NUNCA automático, NUNCA al montar la app.
//   - Datos EFÍMEROS: coords viven en useState local con TTL 5 min.
//     Nada en localStorage, sessionStorage ni Supabase. Al desmontar el
//     componente que usa el hook, se pierden.
//   - Blast radius mínimo: módulo aislado sin dependencias del resto de
//     la app. HectorDirectView lo importa y consume; nadie más.
//
// El prompt nativo de iOS/Safari aparece la primera vez que se llama a
// navigator.geolocation.getCurrentPosition. Como request() solo se
// invoca desde handleSend cuando la regex de intención matchea, el
// permiso NUNCA se pide sin que el CEO lo haya pedido.

import { useState, useCallback, useRef } from "react";

// Regex de intención — cubre las formas naturales en español. Cualquier
// texto que la matchee dispara la solicitud de GPS. Sin matches falsos
// tipo "cerca de mí" (ambiguo) o "desde casa" (es un lugar, no GPS).
export const UBICACION_INTENT_RE = /\b(desde\s+(mi\s+ubicaci[oó]n|mi\s+posici[oó]n|aqu[ií]|donde\s+estoy)|us(a|ando)\s+mi\s+ubicaci[oó]n)\b/i;

// Detector puro — testeable sin hook. Devuelve boolean.
export function hasUbicacionIntent(text) {
  if (!text || typeof text !== "string") return false;
  return UBICACION_INTENT_RE.test(text);
}

// TTL de reuso en memoria: 5 min. Si el CEO envía varios turns seguidos
// con "desde mi ubicación", reusa la última captura sin re-encender GPS
// (batería) ni re-prompt de permiso. Al minuto 6 se re-captura.
const TTL_MS = 5 * 60 * 1000;

// Options del getCurrentPosition. timeout 8s = suficiente para GPS iOS
// en interior; si no responde, liberamos el turn con reason "timeout".
// maximumAge 60s = si el sistema tiene una lectura reciente, se usa
// (más rápido, menos batería).
const GEO_OPTIONS = { enableHighAccuracy: true, timeout: 8000, maximumAge: 60000 };

// Traduce el code numérico del GeolocationPositionError al reason string
// que consume handleSend para el mensaje inline al CEO.
function reasonFromError(err) {
  if (!err) return "unavailable";
  if (err.code === 1) return "denied";       // PERMISSION_DENIED
  if (err.code === 2) return "unavailable";  // POSITION_UNAVAILABLE
  if (err.code === 3) return "timeout";      // TIMEOUT
  return "unavailable";
}

// Hook único de captura. NO expone watchPosition ni ningún método pasivo
// — solo request() bajo demanda. El estado se pierde al desmontar (nada
// persistente).
//
// Uso desde HectorDirectView:
//   const { coords, status, request } = useCurrentLocation();
//   ...
//   if (hasUbicacionIntent(txt) && isOwner) {
//     const result = await request();
//     if (result.ok) { ubicacionForTurn = result.coords; }
//     else { pushInlineNotice(result.reason); }
//   }
export function useCurrentLocation() {
  const [coords, setCoords] = useState(null);
  const [status, setStatus] = useState("idle");
  const [error, setError] = useState(null);
  // Dedup de llamadas concurrentes: si el CEO envía dos mensajes con
  // intención muy seguidos, la segunda espera la promesa en vuelo en
  // lugar de disparar un segundo getCurrentPosition en paralelo.
  const pendingRef = useRef(null);

  const isFresh = useCallback(() => {
    if (!coords || !coords.ts) return false;
    return (Date.now() - coords.ts) < TTL_MS;
  }, [coords]);

  const request = useCallback(() => {
    // Reuso de cache — no dispara GPS ni permiso.
    if (coords && (Date.now() - coords.ts) < TTL_MS) {
      return Promise.resolve({ ok: true, coords });
    }
    if (typeof navigator === "undefined" || !("geolocation" in navigator)) {
      setStatus("unsupported");
      return Promise.resolve({ ok: false, reason: "unsupported" });
    }
    // Dedup: si ya hay una request en vuelo, devolvemos la misma promesa.
    if (pendingRef.current) return pendingRef.current;
    setStatus("requesting");
    setError(null);
    const p = new Promise((resolve) => {
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          const c = {
            lat: pos.coords.latitude,
            lng: pos.coords.longitude,
            accuracy: pos.coords.accuracy,
            ts: Date.now(),
          };
          setCoords(c);
          setStatus("ready");
          pendingRef.current = null;
          resolve({ ok: true, coords: c });
        },
        (err) => {
          const reason = reasonFromError(err);
          setStatus(reason);
          setError(err?.message || null);
          pendingRef.current = null;
          resolve({ ok: false, reason });
        },
        GEO_OPTIONS
      );
    });
    pendingRef.current = p;
    return p;
  }, [coords]);

  const clear = useCallback(() => {
    setCoords(null);
    setStatus("idle");
    setError(null);
  }, []);

  return { coords, status, error, request, clear, isFresh };
}
