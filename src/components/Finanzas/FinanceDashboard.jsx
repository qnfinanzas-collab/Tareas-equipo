// FinanceDashboard — visión global de tesorería con KPIs vivos.
// - Saldo hoy = entradas pagadas - salidas pagadas (acumulado histórico).
// - Entradas / Salidas del mes en curso.
// - Burn rate = media de salidas pagadas en los últimos 3 meses cerrados.
// - Runway = saldo / burn rate (meses).
// - Cash flow operativo = entradas mes - salidas mes.
// - Top 5 categorías de gasto del año en curso (paga + pendiente).
// - Gráfico SVG nativo de los últimos 6 meses (balance neto por mes).
// Todos los importes formateados en EUR español. Sin librerías externas.
import React, { useMemo, useState } from "react";
import ExportGestoriaModal from "./ExportGestoriaModal.jsx";

const formatEuros = (amount) => new Intl.NumberFormat("es-ES", { style: "currency", currency: "EUR", maximumFractionDigits: 0 }).format(amount || 0);
const formatEurosFull = (amount) => new Intl.NumberFormat("es-ES", { style: "currency", currency: "EUR" }).format(amount || 0);

const isSameMonth = (date, ref) => {
  const d = new Date(date);
  return d.getFullYear() === ref.getFullYear() && d.getMonth() === ref.getMonth();
};

const monthLabel = (d) => d.toLocaleDateString("es-ES", { month: "short" });

export default function FinanceDashboard({ data, selectedCompanyId = "all" }) {
  // Filtro por empresa: en "all" mostramos todo. Para empresa concreta
  // filtramos por companyId. Los movimientos legacy (companyId:null) se
  // muestran SIEMPRE — aún no están asignados, el CEO los reasignará.
  const allMovements = data?.financeMovements || [];
  const movements = selectedCompanyId === "all"
    ? allMovements
    : allMovements.filter(m => !m.companyId || m.companyId === selectedCompanyId);
  // Saldo desde cuentas bancarias filtradas también por empresa.
  const allAccounts = data?.bankAccounts || [];
  const accounts = selectedCompanyId === "all"
    ? allAccounts.filter(a => a.isActive !== false)
    : allAccounts.filter(a => a.isActive !== false && a.companyId === selectedCompanyId);
  const bankBalance = accounts.reduce((s, a) => s + (Number(a.currentBalance)||0), 0);
  const today = new Date();

  const stats = useMemo(() => {
    // Saldo histórico (solo movimientos pagados — los pendientes son previsión)
    const saldoHoy = movements.reduce((acc, m) => {
      if (m.status !== "paid") return acc;
      return m.type === "income" ? acc + Number(m.amount || 0) : acc - Number(m.amount || 0);
    }, 0);

    const entradasMes = movements
      .filter(m => m.type === "income" && m.status === "paid" && isSameMonth(m.date, today))
      .reduce((acc, m) => acc + Number(m.amount || 0), 0);

    const salidasMes = movements
      .filter(m => m.type === "expense" && m.status === "paid" && isSameMonth(m.date, today))
      .reduce((acc, m) => acc + Number(m.amount || 0), 0);

    // Burn rate = media de salidas pagadas en los 3 meses anteriores al actual
    const monthSalidas = [];
    for (let i = 1; i <= 3; i++) {
      const ref = new Date(today.getFullYear(), today.getMonth() - i, 1);
      const total = movements
        .filter(m => m.type === "expense" && m.status === "paid" && isSameMonth(m.date, ref))
        .reduce((acc, m) => acc + Number(m.amount || 0), 0);
      monthSalidas.push(total);
    }
    const burnRate = monthSalidas.reduce((a, b) => a + b, 0) / 3 || 0;
    const runway = burnRate > 0 ? saldoHoy / burnRate : null;

    // Series de los últimos 6 meses (incl. el actual) para el gráfico
    const series = [];
    for (let i = 5; i >= 0; i--) {
      const ref = new Date(today.getFullYear(), today.getMonth() - i, 1);
      const ent = movements
        .filter(m => m.type === "income" && m.status === "paid" && isSameMonth(m.date, ref))
        .reduce((acc, m) => acc + Number(m.amount || 0), 0);
      const sal = movements
        .filter(m => m.type === "expense" && m.status === "paid" && isSameMonth(m.date, ref))
        .reduce((acc, m) => acc + Number(m.amount || 0), 0);
      series.push({ ref, label: monthLabel(ref), entradas: ent, salidas: sal, neto: ent - sal });
    }

    // Top 5 categorías de gasto del año en curso (incluye pagados y pendientes)
    const yearStart = new Date(today.getFullYear(), 0, 1);
    const catTotals = {};
    movements
      .filter(m => m.type === "expense" && new Date(m.date) >= yearStart)
      .forEach(m => {
        const k = m.category || "Otros gastos";
        catTotals[k] = (catTotals[k] || 0) + Number(m.amount || 0);
      });
    const topCats = Object.entries(catTotals)
      .map(([name, total]) => ({ name, total }))
      .sort((a, b) => b.total - a.total)
      .slice(0, 5);
    const topMax = topCats[0]?.total || 1;

    return { saldoHoy, entradasMes, salidasMes, burnRate, runway, series, topCats, topMax, cashFlowMes: entradasMes - salidasMes };
  }, [movements, today.getMonth(), today.getFullYear()]);

  const C = { green: "#27AE60", red: "#E74C3C", blue: "#3498DB", orange: "#F39C12", grayBg: "#F8F9FA" };

  // Gráfico SVG: barras del balance neto por mes. Verde si neto>=0, rojo si <0.
  const chartW = 600, chartH = 140, padX = 24, padY = 18, axisH = 18;
  const innerW = chartW - padX * 2;
  const innerH = chartH - padY - axisH;
  const maxAbs = Math.max(1, ...stats.series.map(s => Math.abs(s.neto)));
  const zeroY = padY + innerH / 2;
  const barW = (innerW / stats.series.length) - 12;

  return (
    <div>
      <DashboardExportButton data={data} selectedCompanyId={selectedCompanyId} />
      {/* KPIs principales */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 12, marginBottom: 16 }}>
        <div style={{ background: "#fff", border: "1px solid #E5E7EB", borderRadius: 12, padding: 16 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: "#6B7280", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 6 }}>Saldo hoy</div>
          <div style={{ fontSize: 28, fontWeight: 700, color: stats.saldoHoy >= 0 ? C.green : C.red, lineHeight: 1.1 }}>{formatEurosFull(stats.saldoHoy)}</div>
          <div style={{ fontSize: 11, color: "#6B7280", marginTop: 4 }}>Entradas - salidas pagadas</div>
        </div>
        <div style={{ background: "#fff", border: "1px solid #E5E7EB", borderRadius: 12, padding: 16, borderLeft: `4px solid ${C.green}` }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: "#6B7280", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 6 }}>Entradas — mes</div>
          <div style={{ fontSize: 24, fontWeight: 700, color: C.green, lineHeight: 1.1 }}>+ {formatEurosFull(stats.entradasMes)}</div>
          <div style={{ fontSize: 11, color: "#6B7280", marginTop: 4 }}>{today.toLocaleDateString("es-ES", { month: "long", year: "numeric" })}</div>
        </div>
        <div style={{ background: "#fff", border: "1px solid #E5E7EB", borderRadius: 12, padding: 16, borderLeft: `4px solid ${C.red}` }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: "#6B7280", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 6 }}>Salidas — mes</div>
          <div style={{ fontSize: 24, fontWeight: 700, color: C.red, lineHeight: 1.1 }}>− {formatEurosFull(stats.salidasMes)}</div>
          <div style={{ fontSize: 11, color: "#6B7280", marginTop: 4 }}>{today.toLocaleDateString("es-ES", { month: "long", year: "numeric" })}</div>
        </div>
      </div>

      {/* Gráfico 6 meses */}
      <div style={{ background: "#fff", border: "1px solid #E5E7EB", borderRadius: 12, padding: 16, marginBottom: 16 }}>
        <div style={{ fontSize: 12, fontWeight: 700, color: "#374151", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 10 }}>Flujo de caja — últimos 6 meses</div>
        {stats.series.every(s => s.entradas === 0 && s.salidas === 0) ? (
          <div style={{ fontSize: 12, color: "#9CA3AF", fontStyle: "italic", padding: "20px 0", textAlign: "center" }}>Sin movimientos registrados aún. Añade el primero desde Tesorería.</div>
        ) : (
          <svg viewBox={`0 0 ${chartW} ${chartH}`} style={{ width: "100%", height: "auto", maxHeight: 180 }}>
            {/* Línea de cero */}
            <line x1={padX} y1={zeroY} x2={chartW - padX} y2={zeroY} stroke="#E5E7EB" strokeDasharray="4 3" />
            {stats.series.map((s, i) => {
              const cx = padX + (innerW / stats.series.length) * (i + 0.5);
              const h = (Math.abs(s.neto) / maxAbs) * (innerH / 2);
              const y = s.neto >= 0 ? zeroY - h : zeroY;
              const fill = s.neto >= 0 ? C.green : C.red;
              return (
                <g key={i}>
                  <title>{`${s.label}: ${formatEurosFull(s.entradas)} entradas / ${formatEurosFull(s.salidas)} salidas / neto ${formatEurosFull(s.neto)}`}</title>
                  <rect x={cx - barW / 2} y={y} width={barW} height={Math.max(2, h)} rx={3} fill={fill} opacity={0.85} />
                  <text x={cx} y={s.neto >= 0 ? y - 4 : y + h + 11} textAnchor="middle" fontSize="9" fill="#374151" fontWeight="600">{formatEuros(s.neto)}</text>
                  <text x={cx} y={chartH - 4} textAnchor="middle" fontSize="10" fill="#6B7280" textTransform="uppercase">{s.label}</text>
                </g>
              );
            })}
          </svg>
        )}
      </div>

      {/* Top 5 categorías de gasto */}
      <div style={{ background: "#fff", border: "1px solid #E5E7EB", borderRadius: 12, padding: 16, marginBottom: 16 }}>
        <div style={{ fontSize: 12, fontWeight: 700, color: "#374151", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 10 }}>Top 5 categorías de gasto · {today.getFullYear()}</div>
        {stats.topCats.length === 0 ? (
          <div style={{ fontSize: 12, color: "#9CA3AF", fontStyle: "italic", padding: "16px 0", textAlign: "center" }}>Sin gastos registrados este año.</div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {stats.topCats.map(c => (
              <div key={c.name} style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <div style={{ flex: "0 0 160px", fontSize: 12, color: "#374151", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.name}</div>
                <div style={{ flex: 1, height: 12, background: "#F3F4F6", borderRadius: 6, overflow: "hidden" }}>
                  <div style={{ width: `${(c.total / stats.topMax) * 100}%`, height: "100%", background: C.red, opacity: 0.85 }} />
                </div>
                <div style={{ flex: "0 0 90px", textAlign: "right", fontSize: 12, fontWeight: 600, color: "#374151", fontFamily: "ui-monospace,monospace" }}>{formatEuros(c.total)}</div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* KPIs derivados */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 12 }}>
        <div style={{ background: "#fff", border: "1px solid #E5E7EB", borderRadius: 12, padding: 14 }}>
          <div style={{ fontSize: 10.5, fontWeight: 700, color: "#6B7280", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 4 }}>Burn rate mensual</div>
          <div style={{ fontSize: 18, fontWeight: 700, color: "#374151" }}>{formatEurosFull(stats.burnRate)}</div>
          <div style={{ fontSize: 10.5, color: "#9CA3AF", marginTop: 3 }}>media últimos 3 meses</div>
        </div>
        <div style={{ background: "#fff", border: "1px solid #E5E7EB", borderRadius: 12, padding: 14 }}>
          <div style={{ fontSize: 10.5, fontWeight: 700, color: "#6B7280", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 4 }}>Runway</div>
          <div style={{ fontSize: 18, fontWeight: 700, color: stats.runway === null ? "#9CA3AF" : stats.runway < 3 ? C.red : stats.runway < 6 ? C.orange : C.green }}>
            {stats.runway === null ? "—" : `${stats.runway.toFixed(1)} meses`}
          </div>
          <div style={{ fontSize: 10.5, color: "#9CA3AF", marginTop: 3 }}>saldo / burn rate</div>
        </div>
        <div style={{ background: "#fff", border: "1px solid #E5E7EB", borderRadius: 12, padding: 14 }}>
          <div style={{ fontSize: 10.5, fontWeight: 700, color: "#6B7280", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 4 }}>Cash flow operativo</div>
          <div style={{ fontSize: 18, fontWeight: 700, color: stats.cashFlowMes >= 0 ? C.green : C.red }}>
            {stats.cashFlowMes >= 0 ? "+ " : "− "}{formatEurosFull(Math.abs(stats.cashFlowMes))}
          </div>
          <div style={{ fontSize: 10.5, color: "#9CA3AF", marginTop: 3 }}>entradas - salidas (mes)</div>
        </div>
      </div>
    </div>
  );
}

// Botón "Exportar para gestoría" alineado a la derecha sobre los KPIs.
// Vive en su propio componente para que el ExportGestoriaModal solo se
// instancie cuando el CEO lo abre (mantiene SheetJS fuera del bundle hasta
// que se necesita).
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
