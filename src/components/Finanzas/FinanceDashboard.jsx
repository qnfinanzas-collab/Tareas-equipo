// FinanceDashboard — visión ejecutiva de finanzas para el CEO.
// Toda la lógica de cálculo vive en src/lib/financeSummary.js (mismo helper
// que consumen Gonzalo y Héctor). Aquí solo dibujamos.
//
// Bloques:
//   1) KPI cards (saldo, ingresos/gastos/neto del mes, fact pendientes, runway)
//   2) Cash-flow chart (SVG nativo): barras apiladas ingresos/gastos + línea saldo
//   3) Alertas financieras (clickables → navegan a otra pestaña vía onNavigate)
//   4) Top 5 gastos del mes con barras de progreso
//
// Sin recharts: el chart es SVG nativo, consistente con la convención del
// proyecto (no UI libs externas) y para no inflar el bundle (~70KB extra).
import React, { useMemo, useState } from "react";
import ExportGestoriaModal from "./ExportGestoriaModal.jsx";
import { buildFinanceSummary } from "../../lib/financeSummary.js";

const fmtEur = (n) => new Intl.NumberFormat("es-ES", { style: "currency", currency: "EUR", maximumFractionDigits: 0 }).format(Number(n)||0);
const fmtEur2 = (n) => new Intl.NumberFormat("es-ES", { style: "currency", currency: "EUR", maximumFractionDigits: 2 }).format(Number(n)||0);

const C = {
  green: "#27AE60",
  red: "#E24B4A",
  blue: "#3498DB",
  amber: "#E67E22",
  gray: "#6B7280",
  purple: "#8E44AD",
};

export default function FinanceDashboard({ data, selectedCompanyId = "all", onNavigate }) {
  const summary = useMemo(() => buildFinanceSummary(data, selectedCompanyId), [data, selectedCompanyId]);

  const goTo = (tab) => {
    if (typeof onNavigate === "function" && tab) onNavigate(tab);
  };

  return (
    <div>
      {/* Botón exportar gestoría */}
      <DashboardExportButton data={data} selectedCompanyId={selectedCompanyId} />

      {/* 1) KPIs principales */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 12, marginBottom: 16 }}>
        <KpiCard
          label="Saldo total"
          value={fmtEur2(summary.saldo)}
          hint="Cuentas activas (multi-empresa)"
          color={summary.saldo >= 0 ? C.green : C.red}
          onClick={() => goTo("bancos")}
        />
        <KpiCard
          label="Ingresos — mes"
          value={"+ " + fmtEur(summary.ingresosMes)}
          hint={new Date().toLocaleDateString("es-ES", { month: "long", year: "numeric" })}
          color={C.green}
          accent
          onClick={() => goTo("bancos")}
        />
        <KpiCard
          label="Gastos — mes"
          value={"− " + fmtEur(summary.gastosMes)}
          hint={new Date().toLocaleDateString("es-ES", { month: "long", year: "numeric" })}
          color={C.red}
          accent
          onClick={() => goTo("bancos")}
        />
        <KpiCard
          label="Neto — mes"
          value={(summary.netoMes >= 0 ? "+ " : "− ") + fmtEur(Math.abs(summary.netoMes))}
          hint="Ingresos - gastos del mes"
          color={summary.netoMes >= 0 ? C.green : C.red}
        />
        <KpiCard
          label="Pendiente cobro"
          value={`${summary.facturasPendientesCobro.count} · ${fmtEur(summary.facturasPendientesCobro.total)}`}
          hint="Facturas emitidas no cobradas"
          color={summary.facturasPendientesCobro.count > 0 ? C.amber : C.gray}
          onClick={() => goTo("facturacion")}
        />
        <KpiCard
          label="Pendiente pago"
          value={`${summary.facturasPendientesPago.count} · ${fmtEur(summary.facturasPendientesPago.total)}`}
          hint="Facturas recibidas no pagadas"
          color={summary.facturasPendientesPago.count > 0 ? C.amber : C.gray}
          onClick={() => goTo("facturacion")}
        />
        <KpiCard
          label="Runway estimado"
          value={summary.runway != null ? `${summary.runway} m` : "—"}
          hint={summary.burnRate > 0 ? `Burn ${fmtEur(summary.burnRate)}/mes (3 meses)` : "Sin gasto histórico para calcular"}
          color={summary.runway == null ? C.gray : summary.runway < 2 ? C.red : summary.runway < 4 ? C.amber : C.green}
        />
      </div>

      {/* 2) Cash-flow chart 6 meses */}
      <CashFlowChart series={summary.series} />

      {/* 3) Alertas financieras */}
      <AlertsBlock alertas={summary.alertas} onNav={(nav) => nav?.tab && goTo(nav.tab)} />

      {/* 4) Top gastos del mes */}
      <TopGastosBlock topGastos={summary.topGastos} totalGastos={summary.gastosMes} />
    </div>
  );
}

// ── KPI card ────────────────────────────────────────────────────────────
function KpiCard({ label, value, hint, color, accent, onClick }) {
  const clickable = typeof onClick === "function";
  return (
    <div
      onClick={onClick}
      style={{
        background: "#fff",
        border: "1px solid #E5E7EB",
        borderRadius: 12,
        padding: 16,
        borderLeft: accent ? `4px solid ${color}` : "1px solid #E5E7EB",
        cursor: clickable ? "pointer" : "default",
        transition: "transform .12s, box-shadow .12s",
      }}
      onMouseDown={clickable ? e => e.currentTarget.style.transform = "scale(0.99)" : undefined}
      onMouseUp={clickable ? e => e.currentTarget.style.transform = "" : undefined}
      onMouseLeave={clickable ? e => e.currentTarget.style.transform = "" : undefined}
    >
      <div style={{ fontSize: 11, fontWeight: 700, color: "#6B7280", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 6 }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 700, color: color || "#111827", lineHeight: 1.1 }}>{value}</div>
      <div style={{ fontSize: 11, color: "#9CA3AF", marginTop: 4 }}>{hint}</div>
    </div>
  );
}

// ── Cash-flow chart (SVG nativo) ────────────────────────────────────────
// Stacked: ingresos arriba (verde), gastos invertidos abajo (rojo). Encima
// se traza la línea de saldo acumulado (escala derecha). Diseño limpio,
// sin librería: pasamos por puntos de la propia serie.
function CashFlowChart({ series }) {
  if (!series || series.length === 0) return null;

  const W = 760, H = 240;
  const PAD = { top: 26, right: 50, bottom: 32, left: 56 };
  const innerW = W - PAD.left - PAD.right;
  const innerH = H - PAD.top - PAD.bottom;
  const barGroupW = innerW / series.length;
  const barW = Math.min(28, barGroupW * 0.32);

  // Escala flujo (eje izquierdo): el máximo entre ingresos y gastos.
  const maxFlow = Math.max(1, ...series.flatMap(s => [s.ingresos, s.gastos]));
  const flowToY = (v, sign) => {
    // sign +1 ingresos arriba, -1 gastos abajo. Bar se dibuja desde el centro.
    const half = innerH / 2;
    const h = (v / maxFlow) * half;
    return sign > 0 ? PAD.top + half - h : PAD.top + half;
  };
  const flowToHeight = (v) => (v / maxFlow) * (innerH / 2);
  const centerY = PAD.top + innerH / 2;

  // Escala saldo (eje derecho).
  const saldos = series.map(s => s.saldo);
  const maxSaldo = Math.max(0, ...saldos);
  const minSaldo = Math.min(0, ...saldos);
  const saldoSpan = Math.max(1, maxSaldo - minSaldo);
  const saldoToY = (v) => PAD.top + innerH - ((v - minSaldo) / saldoSpan) * innerH;

  // Path saldo
  const linePath = series.map((s, i) => {
    const x = PAD.left + barGroupW * i + barGroupW / 2;
    const y = saldoToY(s.saldo);
    return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" ");

  return (
    <div style={{ background: "#fff", border: "1px solid #E5E7EB", borderRadius: 12, padding: 16, marginBottom: 16 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: "#111827" }}>📈 Cash flow · últimos 6 meses</div>
        <div style={{ display: "flex", gap: 12, fontSize: 11, color: "#6B7280" }}>
          <Legend color={C.green} label="Ingresos" />
          <Legend color={C.red} label="Gastos" />
          <Legend color={C.blue} label="Saldo (acum.)" line />
        </div>
      </div>
      <div style={{ width: "100%", overflowX: "auto" }}>
        <svg viewBox={`0 0 ${W} ${H}`} width="100%" preserveAspectRatio="xMidYMid meet" style={{ display: "block" }}>
          {/* Eje cero del flujo */}
          <line x1={PAD.left} x2={W - PAD.right} y1={centerY} y2={centerY} stroke="#E5E7EB" strokeWidth={1} />
          {/* Etiquetas eje flujo */}
          <text x={PAD.left - 6} y={PAD.top + 4} textAnchor="end" fontSize={9.5} fill="#9CA3AF">{fmtEur(maxFlow)}</text>
          <text x={PAD.left - 6} y={centerY + 3} textAnchor="end" fontSize={9.5} fill="#9CA3AF">0</text>
          <text x={PAD.left - 6} y={PAD.top + innerH - 2} textAnchor="end" fontSize={9.5} fill="#9CA3AF">{fmtEur(maxFlow)}</text>
          {/* Etiquetas eje saldo (derecha) */}
          <text x={W - PAD.right + 6} y={PAD.top + 4} textAnchor="start" fontSize={9.5} fill="#3498DB">{fmtEur(maxSaldo)}</text>
          <text x={W - PAD.right + 6} y={PAD.top + innerH - 2} textAnchor="start" fontSize={9.5} fill="#3498DB">{fmtEur(minSaldo)}</text>

          {/* Barras */}
          {series.map((s, i) => {
            const cx = PAD.left + barGroupW * i + barGroupW / 2;
            const xIn = cx - barW - 2;
            const xEx = cx + 2;
            const hIn = flowToHeight(s.ingresos);
            const hEx = flowToHeight(s.gastos);
            return (
              <g key={i}>
                <title>{`${s.label}: +${fmtEur(s.ingresos)} / -${fmtEur(s.gastos)} · saldo ${fmtEur(s.saldo)}`}</title>
                {s.ingresos > 0 && (
                  <rect x={xIn} y={centerY - hIn} width={barW} height={hIn} fill={C.green} fillOpacity={0.85} rx={2} />
                )}
                {s.gastos > 0 && (
                  <rect x={xEx} y={centerY} width={barW} height={hEx} fill={C.red} fillOpacity={0.85} rx={2} />
                )}
                <text x={cx} y={H - 10} textAnchor="middle" fontSize={11} fill="#374151" fontWeight={600}>{s.label}</text>
              </g>
            );
          })}

          {/* Línea saldo */}
          <path d={linePath} stroke={C.blue} strokeWidth={2} fill="none" strokeLinejoin="round" strokeLinecap="round" />
          {series.map((s, i) => {
            const x = PAD.left + barGroupW * i + barGroupW / 2;
            const y = saldoToY(s.saldo);
            return <circle key={i} cx={x} cy={y} r={3.5} fill="#fff" stroke={C.blue} strokeWidth={2} />;
          })}
        </svg>
      </div>
    </div>
  );
}

function Legend({ color, label, line }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
      {line ? (
        <span style={{ width: 16, height: 2, background: color, display: "inline-block" }} />
      ) : (
        <span style={{ width: 10, height: 10, background: color, borderRadius: 2, display: "inline-block" }} />
      )}
      {label}
    </span>
  );
}

// ── Alertas financieras ────────────────────────────────────────────────
function AlertsBlock({ alertas, onNav }) {
  if (!alertas || alertas.length === 0) {
    return (
      <div style={{ background: "#fff", border: "1px solid #E5E7EB", borderRadius: 12, padding: 16, marginBottom: 16 }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: "#111827", marginBottom: 8 }}>✅ Sin alertas financieras</div>
        <div style={{ fontSize: 12, color: "#9CA3AF", fontStyle: "italic" }}>No hay facturas vencidas, runway crítico ni movimientos sin categorizar. Buen momento para foco estratégico.</div>
      </div>
    );
  }
  return (
    <div style={{ background: "#fff", border: "1px solid #E5E7EB", borderRadius: 12, padding: 16, marginBottom: 16 }}>
      <div style={{ fontSize: 13, fontWeight: 700, color: "#111827", marginBottom: 10 }}>⚠️ Alertas financieras ({alertas.length})</div>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {alertas.map(a => {
          const palette = a.level === "critical" ? { bg: "#FEE2E2", border: "#FCA5A5", color: "#991B1B" }
            : a.level === "warning" ? { bg: "#FEF3C7", border: "#FCD34D", color: "#92400E" }
            : { bg: "#DBEAFE", border: "#93C5FD", color: "#1E40AF" };
          const clickable = !!a.nav?.tab;
          return (
            <div
              key={a.key}
              onClick={() => clickable && onNav(a.nav)}
              style={{
                background: palette.bg,
                border: `1px solid ${palette.border}`,
                borderRadius: 8,
                padding: "10px 14px",
                display: "flex",
                alignItems: "center",
                gap: 10,
                cursor: clickable ? "pointer" : "default",
              }}
            >
              <span style={{ fontSize: 16 }}>{a.icon}</span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 12.5, fontWeight: 700, color: palette.color }}>{a.title}</div>
                {a.detail && <div style={{ fontSize: 11.5, color: palette.color, opacity: 0.85, marginTop: 2 }}>{a.detail}</div>}
              </div>
              {clickable && <span style={{ color: palette.color, fontSize: 14 }}>→</span>}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Top 5 gastos del mes ────────────────────────────────────────────────
function TopGastosBlock({ topGastos, totalGastos }) {
  if (!topGastos || topGastos.length === 0) return null;
  const max = topGastos[0]?.total || 1;
  return (
    <div style={{ background: "#fff", border: "1px solid #E5E7EB", borderRadius: 12, padding: 16 }}>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 10 }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: "#111827" }}>💸 Top 5 gastos · este mes</div>
        <div style={{ fontSize: 11, color: "#9CA3AF" }}>Total: {fmtEur(totalGastos)}</div>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {topGastos.map(c => (
          <div key={c.id} style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", fontSize: 12 }}>
              <div style={{ color: "#1F2937", fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1, minWidth: 0 }}>
                {c.name} {c.pgc && <span style={{ color: "#9CA3AF", fontFamily: "ui-monospace,monospace", fontWeight: 400, fontSize: 11 }}>· {c.pgc}</span>}
              </div>
              <div style={{ color: "#111827", fontWeight: 700, fontFamily: "ui-monospace,monospace" }}>{fmtEur(c.total)}</div>
            </div>
            <div style={{ background: "#F3F4F6", borderRadius: 6, height: 8, overflow: "hidden" }}>
              <div style={{ background: C.red, height: "100%", width: `${Math.round((c.total / max) * 100)}%`, transition: "width .25s" }} />
            </div>
            <div style={{ fontSize: 10.5, color: "#9CA3AF" }}>{c.count} mov{c.count!==1?"s":""} · {c.percent}% del total categorizado</div>
          </div>
        ))}
      </div>
    </div>
  );
}

// Botón "Exportar para gestoría" alineado a la derecha sobre los KPIs.
// Vive en su propio componente para que SheetJS no se incluya hasta que el
// CEO abre el modal.
function DashboardExportButton({ data, selectedCompanyId }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 12 }}>
        <button
          onClick={() => setOpen(true)}
          title="Exportar movimientos, facturas y resumen IVA para la gestoría"
          style={{ padding: "7px 14px", borderRadius: 8, background: "#fff", color: "#0E7C5A", border: "1px solid #27AE60", fontSize: 12, fontWeight: 600, cursor: "pointer", fontFamily: "inherit" }}
        >📥 Exportar para gestoría</button>
      </div>
      {open && <ExportGestoriaModal data={data} selectedCompanyId={selectedCompanyId} onClose={() => setOpen(false)} />}
    </>
  );
}
