// financeSummary — derivado puro a partir de `data`. Se consume desde:
//   - FinanceDashboard (KPIs, alertas, top gastos, series cash-flow)
//   - callGonzaloDirect / financeContext de Héctor (resumen para prompts)
//
// IMPORTANTE: este módulo NO importa React. Es lógica pura para que se
// pueda invocar desde cualquier sitio (componentes, agentes, servidor).
//
// Convenciones:
//   - companyId === "all" → consolidado, sin filtrar por empresa.
//   - Los movimientos/facturas legacy con companyId:null se incluyen
//     siempre (igual que en Bancos/Facturación).
//   - amount > 0 = ingreso, amount < 0 = gasto.

const todayISO = () => new Date().toISOString().slice(0, 10);
const isSameMonth = (date, ref) => {
  const d = new Date(date);
  return d.getFullYear() === ref.getFullYear() && d.getMonth() === ref.getMonth();
};
const monthShort = (d) => d.toLocaleDateString("es-ES", { month: "short" });
const fmtEur = (n) => new Intl.NumberFormat("es-ES", { style: "currency", currency: "EUR", maximumFractionDigits: 0 }).format(Number(n)||0);
const fmtEur2 = (n) => new Intl.NumberFormat("es-ES", { style: "currency", currency: "EUR", maximumFractionDigits: 2 }).format(Number(n)||0);

// Filtros base por empresa (incluye legacy companyId:null).
function filterByCompany(list, companyId, key = "companyId") {
  if (companyId === "all" || !companyId) return list;
  return list.filter(x => !x[key] || x[key] === companyId);
}

// Calcula próximas obligaciones fiscales. Si data.governance.fiscalCalendar
// existe (formato libre con dueDate iso y label), se usa. En caso contrario
// generamos las fechas estándar del Modelo 303 trimestral (20 abr/jul/oct/ene).
function computeFiscalUpcoming(data) {
  // 1) Si hay fiscalCalendar custom, devolvemos las próximas 3 con dueDate>=hoy.
  const today = todayISO();
  const custom = (data?.governance?.fiscalCalendar) || (data?.governance?.obligations) || [];
  if (Array.isArray(custom) && custom.length > 0) {
    const upcoming = custom
      .filter(o => o.dueDate && o.dueDate >= today && o.status !== "filed")
      .sort((a, b) => a.dueDate.localeCompare(b.dueDate))
      .slice(0, 3)
      .map(o => ({
        dueDate: o.dueDate,
        model: o.model || o.label || "(modelo)",
        concept: o.concept || o.description || "",
        source: "custom",
      }));
    if (upcoming.length > 0) return upcoming;
  }
  // 2) Fallback: Modelo 303 trimestral. Fechas: 20 abr / 20 jul / 20 oct / 30 ene.
  // Generamos las dos próximas a partir de hoy.
  const now = new Date();
  const presets = [
    { month: 0, day: 30, label: "Modelo 303 4T (año anterior)" },
    { month: 3, day: 20, label: "Modelo 303 1T" },
    { month: 6, day: 20, label: "Modelo 303 2T" },
    { month: 9, day: 20, label: "Modelo 303 3T" },
  ];
  const out = [];
  for (let yearOffset = 0; yearOffset <= 1 && out.length < 2; yearOffset++) {
    for (const p of presets) {
      const d = new Date(now.getFullYear() + yearOffset, p.month, p.day);
      if (d >= now) {
        out.push({
          dueDate: d.toISOString().slice(0, 10),
          model: "Mod 303",
          concept: p.label,
          source: "auto",
        });
        if (out.length >= 2) break;
      }
    }
  }
  return out;
}

export function buildFinanceSummary(data, companyId = "all") {
  const today = new Date();
  const todayStr = todayISO();
  const allMovs = data?.bankMovements || [];
  const allAccounts = data?.bankAccounts || [];
  const allInvoices = data?.invoices || [];
  const categories = data?.movementCategories || [];
  const companies = data?.governance?.companies || [];

  const movs = filterByCompany(allMovs, companyId);
  const invoices = filterByCompany(allInvoices, companyId);
  const accounts = (companyId === "all"
    ? allAccounts.filter(a => a.isActive !== false)
    : allAccounts.filter(a => a.isActive !== false && a.companyId === companyId));

  const company = companyId === "all" ? null : companies.find(c => c.id === companyId);

  // ── Saldo total = suma currentBalance de cuentas activas ──
  const saldo = accounts.reduce((s, a) => s + (Number(a.currentBalance) || 0), 0);

  // ── Mes actual ──
  let ingresosMes = 0, gastosMes = 0;
  for (const m of movs) {
    if (!isSameMonth(m.date, today)) continue;
    const amt = Number(m.amount) || 0;
    if (amt >= 0) ingresosMes += amt;
    else          gastosMes += Math.abs(amt);
  }
  const netoMes = ingresosMes - gastosMes;

  // ── Burn rate medio últimos 3 meses cerrados (no incluye actual) ──
  let burnSum = 0, burnCount = 0;
  for (let i = 1; i <= 3; i++) {
    const ref = new Date(today.getFullYear(), today.getMonth() - i, 1);
    const exp = movs.filter(m => isSameMonth(m.date, ref) && (Number(m.amount)||0) < 0)
                    .reduce((a, m) => a + Math.abs(Number(m.amount)||0), 0);
    burnSum += exp;
    burnCount++;
  }
  const burnRate = burnCount > 0 ? burnSum / burnCount : 0;
  const runway = burnRate > 0 ? Number((saldo / burnRate).toFixed(1)) : null;

  // ── Facturas pendientes (cobro / pago) ──
  let factCobroCount = 0, factCobroEur = 0;
  let factPagoCount = 0,  factPagoEur = 0;
  let facturasVencidas = 0;
  const vencidasList = [];
  for (const inv of invoices) {
    const isPagada = inv.status === "pagada";
    if (isPagada) continue;
    const eur = Number(inv.total) || 0;
    const isVencida = inv.dueDate && inv.dueDate < todayStr;
    if (inv.type === "emitida") { factCobroCount++; factCobroEur += eur; }
    if (inv.type === "recibida") { factPagoCount++; factPagoEur += eur; }
    if (isVencida) {
      facturasVencidas++;
      vencidasList.push({ id: inv.id, number: inv.number, type: inv.type, total: eur, dueDate: inv.dueDate, name: inv.counterparty?.name || "" });
    }
  }

  // ── IVA trimestre actual ──
  const q = Math.floor(today.getMonth() / 3) + 1;
  const qStart = new Date(today.getFullYear(), (q - 1) * 3, 1);
  const qEnd   = new Date(today.getFullYear(), q * 3, 0);
  let ivaRep = 0, ivaSop = 0;
  for (const inv of invoices) {
    const d = new Date(inv.date);
    if (isNaN(d.getTime()) || d < qStart || d > qEnd) continue;
    if (inv.type === "emitida")  ivaRep += Number(inv.vatAmount) || 0;
    else                          ivaSop += Number(inv.vatAmount) || 0;
  }
  const ivaSaldo = ivaRep - ivaSop;
  const ivaTrimestreActual = {
    quarter: `${q}T-${today.getFullYear()}`,
    repercutido: Math.round(ivaRep * 100) / 100,
    soportado: Math.round(ivaSop * 100) / 100,
    saldo: Math.round(ivaSaldo * 100) / 100,
    resultado: ivaSaldo > 0.005 ? "a_ingresar" : ivaSaldo < -0.005 ? "a_devolver" : "neutro",
  };

  // ── Movimientos sin categorizar ──
  const sinCategorizar = movs.filter(m => !m.category).length;

  // ── Series cash-flow últimos 6 meses (mes actual + 5 anteriores) ──
  const series = [];
  let saldoAcum = saldo; // partimos del saldo actual y vamos retrocediendo
  // Calculamos primero ingresos/gastos por mes (de más antiguo a más reciente).
  const buckets = [];
  for (let i = 5; i >= 0; i--) {
    const ref = new Date(today.getFullYear(), today.getMonth() - i, 1);
    let inc = 0, exp = 0;
    for (const m of movs) {
      if (!isSameMonth(m.date, ref)) continue;
      const amt = Number(m.amount) || 0;
      if (amt >= 0) inc += amt;
      else          exp += Math.abs(amt);
    }
    buckets.push({ ref, ingresos: inc, gastos: exp });
  }
  // Saldo acumulado: partiendo del saldo actual, restamos hacia atrás
  // (saldo del cierre de cada mes). Luego invertimos para que el más reciente
  // sea el saldo "actual" tras el flujo del mes.
  const balances = new Array(buckets.length).fill(0);
  balances[buckets.length - 1] = saldo;
  for (let i = buckets.length - 2; i >= 0; i--) {
    const flujoMesPosterior = buckets[i + 1].ingresos - buckets[i + 1].gastos;
    balances[i] = balances[i + 1] - flujoMesPosterior;
  }
  for (let i = 0; i < buckets.length; i++) {
    series.push({
      label: monthShort(buckets[i].ref),
      monthKey: `${buckets[i].ref.getFullYear()}-${String(buckets[i].ref.getMonth()+1).padStart(2,"0")}`,
      ingresos: Math.round(buckets[i].ingresos),
      gastos: Math.round(buckets[i].gastos),
      saldo: Math.round(balances[i]),
    });
  }

  // ── Top 5 categorías de gasto del mes actual ──
  const topGastosMap = new Map();
  let totalGastoCategorizado = 0;
  for (const m of movs) {
    if (!isSameMonth(m.date, today)) continue;
    const amt = Number(m.amount) || 0;
    if (amt >= 0) continue;
    const key = m.category || "_uncat";
    const cur = topGastosMap.get(key) || { total: 0, count: 0 };
    cur.total += Math.abs(amt);
    cur.count++;
    topGastosMap.set(key, cur);
    totalGastoCategorizado += Math.abs(amt);
  }
  const topGastos = Array.from(topGastosMap.entries())
    .sort((a, b) => b[1].total - a[1].total)
    .slice(0, 5)
    .map(([k, v]) => {
      const cat = categories.find(c => c.id === k);
      return {
        id: k,
        name: k === "_uncat" ? "❓ Sin categorizar" : (cat?.name || k),
        pgc: cat?.pgc || null,
        total: Math.round(v.total),
        count: v.count,
        percent: totalGastoCategorizado > 0 ? Math.round((v.total / totalGastoCategorizado) * 100) : 0,
      };
    });

  // ── Próximas obligaciones fiscales ──
  const fiscalUpcoming = computeFiscalUpcoming(data);

  // ── Alertas (clickables; cada una con `nav` para ir a una pestaña) ──
  const alertas = [];
  if (facturasVencidas > 0) {
    const totalVenc = vencidasList.reduce((s, v) => s + v.total, 0);
    alertas.push({
      key: "facturas_vencidas",
      level: "critical",
      icon: "🔴",
      title: `${facturasVencidas} factura${facturasVencidas!==1?"s":""} vencida${facturasVencidas!==1?"s":""}`,
      detail: `Total: ${fmtEur2(totalVenc)}`,
      nav: { tab: "facturacion", filter: "vencida" },
    });
  }
  if (sinCategorizar > 0) {
    alertas.push({
      key: "sin_categorizar",
      level: "warning",
      icon: "🟡",
      title: `${sinCategorizar} movimiento${sinCategorizar!==1?"s":""} sin categorizar`,
      detail: "Categoriza en Bancos para presentar correctamente IVA",
      nav: { tab: "bancos", filter: "uncategorized" },
    });
  }
  if (runway != null && runway < 2) {
    alertas.push({
      key: "saldo_bajo",
      level: "critical",
      icon: "🔴",
      title: `Runway crítico: ${runway} meses`,
      detail: `A ritmo actual (${fmtEur(burnRate)}/mes) el saldo (${fmtEur(saldo)}) cubre <2 meses`,
      nav: { tab: "tesoreria" },
    });
  } else if (runway != null && runway < 4) {
    alertas.push({
      key: "saldo_atento",
      level: "warning",
      icon: "🟡",
      title: `Runway ${runway} meses`,
      detail: "Vigila el cash flow. Acelera cobros o reduce gastos.",
      nav: { tab: "tesoreria" },
    });
  }
  if (fiscalUpcoming.length > 0) {
    const next = fiscalUpcoming[0];
    const daysTo = Math.floor((new Date(next.dueDate) - today) / 86400000);
    let extraIvaTxt = "";
    if (next.model && next.model.includes("303") && ivaTrimestreActual.resultado === "a_ingresar") {
      extraIvaTxt = ` — IVA a ingresar: ${fmtEur2(ivaTrimestreActual.saldo)}`;
    }
    alertas.push({
      key: "obligacion_proxima",
      level: daysTo <= 7 ? "warning" : "info",
      icon: "📅",
      title: `${next.model} ${next.concept} vence el ${next.dueDate}`,
      detail: `${daysTo >= 0 ? `Quedan ${daysTo} día${daysTo!==1?"s":""}` : "Vencida"}${extraIvaTxt}`,
      nav: { tab: "gobernanza" },
    });
  }

  return {
    companyId,
    companyName: company?.name || (companyId === "all" ? "consolidado" : "(empresa borrada)"),
    saldo: Math.round(saldo * 100) / 100,
    ingresosMes: Math.round(ingresosMes * 100) / 100,
    gastosMes: Math.round(gastosMes * 100) / 100,
    netoMes: Math.round(netoMes * 100) / 100,
    burnRate: Math.round(burnRate * 100) / 100,
    runway,
    facturasPendientesCobro: { count: factCobroCount, total: Math.round(factCobroEur * 100) / 100 },
    facturasPendientesPago:  { count: factPagoCount,  total: Math.round(factPagoEur * 100) / 100  },
    facturasVencidas: vencidasList,
    movsSinCategorizar: sinCategorizar,
    ivaTrimestreActual,
    fiscalUpcoming,
    alertas,
    series,
    topGastos,
  };
}

// Render compacto del summary para inyectar en system prompts de agentes.
// ≤1500 chars típicos. Línea 1 es siempre el header con la empresa.
export function renderFinanceSummaryForPrompt(summary) {
  if (!summary) return "";
  const fmt = (n) => new Intl.NumberFormat("es-ES", { style: "currency", currency: "EUR", maximumFractionDigits: 0 }).format(Number(n)||0);
  const lines = [];
  lines.push(`DATOS FINANCIEROS DE ${summary.companyName.toUpperCase()}:`);
  lines.push(`- Saldo actual: ${fmt(summary.saldo)}${summary.runway != null ? ` · runway ${summary.runway} meses` : ""}`);
  lines.push(`- Mes actual: ingresos ${fmt(summary.ingresosMes)}, gastos ${fmt(summary.gastosMes)}, neto ${fmt(summary.netoMes)}`);
  if (summary.facturasPendientesCobro.count > 0) {
    lines.push(`- Facturas pendientes de cobro: ${summary.facturasPendientesCobro.count} (${fmt(summary.facturasPendientesCobro.total)})`);
  }
  if (summary.facturasPendientesPago.count > 0) {
    lines.push(`- Facturas pendientes de pago: ${summary.facturasPendientesPago.count} (${fmt(summary.facturasPendientesPago.total)})`);
  }
  if (summary.facturasVencidas.length > 0) {
    const totalV = summary.facturasVencidas.reduce((s, v) => s + v.total, 0);
    lines.push(`- ⚠️ FACTURAS VENCIDAS: ${summary.facturasVencidas.length} (${fmt(totalV)})`);
  }
  if (summary.movsSinCategorizar > 0) {
    lines.push(`- Movimientos sin categorizar: ${summary.movsSinCategorizar}`);
  }
  const iva = summary.ivaTrimestreActual;
  lines.push(`- IVA ${iva.quarter}: repercutido ${fmt(iva.repercutido)}, soportado ${fmt(iva.soportado)}, ${
    iva.resultado === "a_ingresar" ? `A INGRESAR ${fmt(iva.saldo)}` :
    iva.resultado === "a_devolver" ? `a devolver ${fmt(Math.abs(iva.saldo))}` :
    "neutro"
  }`);
  if (summary.fiscalUpcoming.length > 0) {
    const next = summary.fiscalUpcoming[0];
    lines.push(`- Próxima obligación: ${next.model} ${next.concept} (${next.dueDate})`);
  }
  if (summary.alertas.length > 0) {
    lines.push(`- Alertas activas: ${summary.alertas.map(a => a.title).join(" · ")}`);
  }
  return lines.join("\n");
}
