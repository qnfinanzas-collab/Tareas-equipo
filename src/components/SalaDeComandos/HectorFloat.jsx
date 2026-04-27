// HectorFloat — widget flotante siempre visible (esquina inferior derecha)
// que abre un panel lateral con HectorPanel completo. Refleja el estado de
// Héctor (analyzing/recommending/listening) mediante color de borde y un
// badge rojo con número de recomendaciones nuevas. Animación pulse cuando
// llega recomendación reciente.
import React from "react";
import HectorPanel from "./HectorPanel.jsx";

const STATE_BORDER = {
  analyzing:   "#F39C12",
  recommending:"#27AE60",
  listening:   "#3498DB",
  paused:      "#9CA3AF",
};

export default function HectorFloat({
  isOpen,
  onToggle,
  lastRecommendation,
  hasNewRecommendation,
  hectorState = "listening",
  // Datos para HectorPanel cuando el panel lateral se abre.
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
  onOpenTask,
}) {
  const borderColor = STATE_BORDER[hectorState] || STATE_BORDER.listening;
  const pendingCount = lastRecommendation ? 1 : 0; // simple: 1 reco viva = 1 badge

  return (
    <>
      <style>{`
        @keyframes hf-pulse { 0% { transform: scale(1); opacity: 1; } 50% { transform: scale(1.05); opacity: 0.85; } 100% { transform: scale(1); opacity: 1; } }
        @keyframes hf-slideInRight { from { transform: translateX(100%); } to { transform: translateX(0); } }
      `}</style>

      {/* Botón flotante minimizado */}
      <button
        onClick={onToggle}
        title={hasNewRecommendation ? "Héctor tiene una nueva recomendación" : "Abrir Héctor"}
        style={{
          position: "fixed",
          bottom: 96,
          right: 24,
          width: 60,
          height: 60,
          borderRadius: "50%",
          backgroundColor: "white",
          boxShadow: "0 4px 20px rgba(0,0,0,0.15)",
          cursor: "pointer",
          border: `3px solid ${borderColor}`,
          fontSize: 26,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          zIndex: 1500,
          fontFamily: "inherit",
          animation: hasNewRecommendation ? "hf-pulse 1s infinite" : "none",
          transition: "border-color .25s ease",
        }}
      >
        <span>🧙</span>
        {pendingCount > 0 && (
          <span style={{
            position: "absolute",
            top: -4,
            right: -4,
            minWidth: 22,
            height: 22,
            padding: "0 6px",
            background: "#E74C3C",
            color: "#fff",
            borderRadius: 11,
            fontSize: 11,
            fontWeight: 700,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            border: "2px solid #fff",
            boxShadow: "0 2px 6px rgba(231,76,60,0.4)",
          }}>{pendingCount}</span>
        )}
      </button>

      {/* Panel lateral expandido */}
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
            right: 0,
            top: 0,
            width: 400,
            maxWidth: "92vw",
            height: "100vh",
            backgroundColor: "white",
            boxShadow: "-2px 0 20px rgba(0,0,0,0.1)",
            zIndex: 1999,
            animation: "hf-slideInRight 0.3s ease",
            display: "flex",
            flexDirection: "column",
            overflow: "hidden",
          }}>
            <div style={{ padding: "12px 16px", borderBottom: "0.5px solid #e5e7eb", display: "flex", alignItems: "center", justifyContent: "space-between", background: "#FAFAFA" }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: "#111827" }}>🧙 Héctor — panel</div>
              <button onClick={onToggle} title="Cerrar" style={{ background: "none", border: "none", fontSize: 22, cursor: "pointer", color: "#6B7280", lineHeight: 1, padding: 0 }}>×</button>
            </div>
            <div style={{ flex: 1, overflowY: "auto", padding: 16 }}>
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
                onOpenTask={onOpenTask}
              />
            </div>
          </div>
        </>
      )}
    </>
  );
}
