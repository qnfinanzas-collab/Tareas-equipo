// HectorFloat — widget flotante responsive que abre HectorPanel en panel
// lateral (desktop/iPad) o pantalla completa (móvil). Posicionamiento
// adaptativo para no solapar con el FAB principal del Asesor IA
// (ese vive en bottom:24/right:24, z-index 1500):
//   - Móvil (<768px):  esquina inferior IZQUIERDA, libera el lado derecho
//                      para el FAB principal.
//   - iPad (768-1023): esquina inferior derecha pero más arriba (bottom 120px).
//   - Desktop (≥1024): esquina inferior derecha, justo encima del FAB
//                      (bottom 96px = FAB 24px + 60px FAB + 12px gap).
// Tamaño del widget también responsive: 48 / 52 / 60. z-index 1600 para
// quedar siempre por encima del FAB principal sin solaparlo en pantalla.
import React, { useEffect, useState } from "react";
import HectorPanel from "./HectorPanel.jsx";

const STATE_BORDER = {
  analyzing:   "#F39C12",
  recommending:"#27AE60",
  listening:   "#3498DB",
  paused:      "#9CA3AF",
};

// Cálculo de la posición del widget según el viewport. Devuelve solo
// propiedades CSS de posicionamiento — el resto se aplica aparte.
function getHectorWidgetLayout(width){
  if (width < 768) {
    return { bottom: 24, left: 24, right: "auto", size: 48, font: 22, badge: 18 };
  }
  if (width < 1024) {
    return { bottom: 120, right: 24, left: "auto", size: 52, font: 24, badge: 20 };
  }
  return { bottom: 96, right: 24, left: "auto", size: 60, font: 26, badge: 22 };
}

// Estilo del panel lateral cuando se abre. En móvil ocupa toda la
// pantalla (incluye safe-area-top vía padding superior); en iPad/desktop
// es lateral derecho con anchos distintos.
function getPanelLayout(width){
  if (width < 768) {
    return {
      top: 0, left: 0, right: 0, bottom: 0,
      width: "100vw", height: "100vh",
      borderRadius: 0,
      headerPadTop: "max(14px, env(safe-area-inset-top, 14px))",
      closeFontSize: 28,
    };
  }
  if (width < 1024) {
    return {
      top: 0, right: 0, bottom: 0, left: "auto",
      width: 320, height: "100vh",
      borderRadius: 0,
      headerPadTop: 14,
      closeFontSize: 24,
    };
  }
  return {
    top: 0, right: 0, bottom: 0, left: "auto",
    width: 400, height: "100vh",
    borderRadius: 0,
    headerPadTop: 14,
    closeFontSize: 22,
  };
}

export default function HectorFloat({
  isOpen,
  onToggle,
  lastRecommendation,
  hasNewRecommendation,
  hectorState = "listening",
  tasks = [],
  currentFocus = null,
  riesgos = [],
  agent,
  ceoMemory,
  userId,
  userName,
  onStateChange,
  onNewRecommendation,
  onRecommendationClick,
  onCompleteTask,
  onPostponeTask,
  onAssignTask,
  onArchiveTask,
  onOpenTask,
  financeContext,
}) {
  const borderColor = STATE_BORDER[hectorState] || STATE_BORDER.listening;
  const pendingCount = lastRecommendation ? 1 : 0;
  const [vw, setVw] = useState(typeof window !== "undefined" ? window.innerWidth : 1280);
  useEffect(() => {
    const handleResize = () => setVw(window.innerWidth);
    window.addEventListener("resize", handleResize);
    window.addEventListener("orientationchange", handleResize);
    return () => {
      window.removeEventListener("resize", handleResize);
      window.removeEventListener("orientationchange", handleResize);
    };
  }, []);

  const widget = getHectorWidgetLayout(vw);
  const panel  = getPanelLayout(vw);

  return (
    <>
      <style>{`
        @keyframes hf-pulse { 0% { transform: scale(1); opacity: 1; } 50% { transform: scale(1.05); opacity: 0.85; } 100% { transform: scale(1); opacity: 1; } }
        @keyframes hf-slideInRight { from { transform: translateX(100%); } to { transform: translateX(0); } }
        @keyframes hf-slideInUp { from { transform: translateY(100%); } to { transform: translateY(0); } }
      `}</style>

      {/* Botón flotante minimizado */}
      <button
        onClick={onToggle}
        title={hasNewRecommendation ? "Héctor tiene una nueva recomendación" : "Abrir Héctor"}
        style={{
          position: "fixed",
          bottom: widget.bottom,
          right: widget.right,
          left: widget.left,
          width: widget.size,
          height: widget.size,
          borderRadius: "50%",
          backgroundColor: "white",
          boxShadow: "0 4px 20px rgba(0,0,0,0.15)",
          cursor: "pointer",
          border: `3px solid ${borderColor}`,
          fontSize: widget.font,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          zIndex: 1600,                         // por encima del FAB principal (1500)
          fontFamily: "inherit",
          animation: hasNewRecommendation ? "hf-pulse 1s infinite" : "none",
          transition: "border-color .25s ease, bottom .2s ease, right .2s ease, left .2s ease",
        }}
      >
        <span>🧙</span>
        {pendingCount > 0 && (
          <span style={{
            position: "absolute",
            top: -4,
            right: -4,
            minWidth: widget.badge,
            height: widget.badge,
            padding: "0 6px",
            background: "#E74C3C",
            color: "#fff",
            borderRadius: widget.badge / 2,
            fontSize: vw < 768 ? 10 : 11,
            fontWeight: 700,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            border: "2px solid #fff",
            boxShadow: "0 2px 6px rgba(231,76,60,0.4)",
          }}>{pendingCount}</span>
        )}
      </button>

      {/* Panel responsive */}
      {isOpen && (
        <>
          <div onClick={onToggle} style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.35)",
            zIndex: 1998,
          }} />
          <div style={{
            position: "fixed",
            top: panel.top,
            right: panel.right,
            bottom: panel.bottom,
            left: panel.left,
            width: panel.width,
            height: panel.height,
            backgroundColor: "white",
            boxShadow: vw < 768 ? "none" : "-2px 0 20px rgba(0,0,0,0.1)",
            zIndex: 1999,
            animation: vw < 768 ? "hf-slideInUp 0.25s ease" : "hf-slideInRight 0.3s ease",
            display: "flex",
            flexDirection: "column",
            overflow: "hidden",
            borderRadius: panel.borderRadius,
          }}>
            <div style={{
              padding: vw < 768 ? `${panel.headerPadTop} 16px 12px` : "12px 16px",
              borderBottom: "0.5px solid #e5e7eb",
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              background: "#FAFAFA",
              flexShrink: 0,
            }}>
              <div style={{ fontSize: vw < 768 ? 15 : 13, fontWeight: 700, color: "#111827" }}>🧙 Héctor — panel</div>
              <button
                onClick={onToggle}
                title="Cerrar"
                style={{
                  background: "none",
                  border: "none",
                  fontSize: panel.closeFontSize,
                  cursor: "pointer",
                  color: "#6B7280",
                  lineHeight: 1,
                  padding: vw < 768 ? "6px 10px" : 0,
                  minWidth: vw < 768 ? 44 : "auto",
                  minHeight: vw < 768 ? 44 : "auto",
                  fontFamily: "inherit",
                }}
              >×</button>
            </div>
            <div style={{ flex: 1, overflowY: "auto", padding: vw < 768 ? 12 : 16, minHeight: 0 }}>
              <HectorPanel
                tasks={tasks}
                currentFocus={currentFocus}
                riesgos={riesgos}
                agent={agent}
                ceoMemory={ceoMemory}
                userId={userId}
                userName={userName}
                onStateChange={onStateChange}
                onNewRecommendation={onNewRecommendation}
                onRecommendationClick={onRecommendationClick}
                onCompleteTask={onCompleteTask}
                onPostponeTask={onPostponeTask}
                onAssignTask={onAssignTask}
                onArchiveTask={onArchiveTask}
                onOpenTask={onOpenTask}
                financeContext={financeContext}
              />
            </div>
          </div>
        </>
      )}
    </>
  );
}
