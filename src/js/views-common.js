"use strict";

// Recursos compartilhados pelas telas: filtros de período/escopo e gráficos.
Frotas.views = {};

Frotas.common = (() => {
  const { todayISO, addDays, esc } = Frotas.util;

  const COLORS = {
    fuel: "#2a282f",
    maintenance: "#c9a227",
    other: "#a09ca8",
    line: "#1b1a1f",
    success: "#537561",
    danger: "#a45148",
    palette: ["#1b1a1f", "#c9a227", "#7a7683", "#e3c766", "#4a4650", "#a09ca8", "#8a6d10", "#d9d7dd", "#2a282f", "#efe0a8"],
  };

  const PERIODS = [
    { value: "30d", label: "Últimos 30 dias" },
    { value: "mes", label: "Mês atual" },
    { value: "mes-anterior", label: "Mês anterior" },
    { value: "90d", label: "Últimos 90 dias" },
    { value: "ano", label: "Ano atual" },
    { value: "12m", label: "Últimos 12 meses" },
    { value: "tudo", label: "Todo o histórico" },
  ];

  const SCOPES = [
    { value: "frota", label: "Frota própria" },
    { value: "autorizado", label: "Veículos autorizados" },
    { value: "todos", label: "Frota + autorizados" },
  ];

  // Filtros lembrados entre as telas durante a sessão.
  const filters = { period: "12m", scope: "frota" };

  function periodRange(period = filters.period) {
    const today = todayISO();
    const [year, month] = today.split("-");
    switch (period) {
      case "30d": return [addDays(today, -29), today];
      case "90d": return [addDays(today, -89), today];
      case "mes": return [`${year}-${month}-01`, today];
      case "mes-anterior": {
        const first = new Date(Number(year), Number(month) - 2, 1);
        const last = new Date(Number(year), Number(month) - 1, 0);
        const iso = (date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
        return [iso(first), iso(last)];
      }
      case "ano": return [`${year}-01-01`, today];
      case "12m": return [addDays(today, -364), today];
      default: return ["0000-01-01", "9999-12-31"];
    }
  }

  // Período anterior de mesma duração, para comparação.
  function previousRange([start, end]) {
    if (start === "0000-01-01") return null;
    const length = Frotas.util.daysBetween(start, end) + 1;
    return [addDays(start, -length), addDays(start, -1)];
  }

  function inRange(date, [start, end]) {
    return date >= start && date <= end;
  }

  function matchScope(scope, item) {
    return scope === "todos" || item.scope === scope;
  }

  function periodLabel(period = filters.period) {
    return PERIODS.find((item) => item.value === period)?.label || "";
  }

  function filterBar({ period = true, scope = true, extra = "" } = {}) {
    return `
      <div class="filter-bar">
        ${period ? `<label>Período<select data-filter="period">${Frotas.ui.optionList(PERIODS, filters.period)}</select></label>` : ""}
        ${scope ? `<label>Veículos<select data-filter="scope">${Frotas.ui.optionList(SCOPES, filters.scope)}</select></label>` : ""}
        ${extra}
      </div>`;
  }

  // ---------- Gráficos ----------

  const charts = [];

  function destroyCharts() {
    while (charts.length) charts.pop().destroy();
  }

  function moneyTicks(value) {
    return Frotas.util.moneyShort(value);
  }

  function chart(canvasId, config) {
    const canvas = document.getElementById(canvasId);
    if (!canvas || typeof Chart === "undefined") return null;
    Chart.defaults.font.family = '"Segoe UI", Inter, Arial, sans-serif';
    Chart.defaults.color = "#6b6872";
    const instance = new Chart(canvas, config);
    charts.push(instance);
    return instance;
  }

  function barOptions({ stacked = false, money = true, horizontal = false, legend = false } = {}) {
    const valueAxis = {
      beginAtZero: true,
      stacked,
      grid: { color: "#ebe9ee" },
      ticks: { callback: money ? moneyTicks : undefined },
    };
    const categoryAxis = { stacked, grid: { display: false } };
    return {
      responsive: true,
      maintainAspectRatio: false,
      indexAxis: horizontal ? "y" : "x",
      plugins: {
        legend: { display: legend, position: "bottom", labels: { boxWidth: 12, boxHeight: 12 } },
        tooltip: {
          callbacks: {
            label: (context) => `${context.dataset.label ? `${context.dataset.label}: ` : ""}${money ? Frotas.util.money(context.raw) : Frotas.util.number(context.raw, 1)}`,
          },
        },
      },
      scales: horizontal ? { x: valueAxis, y: categoryAxis } : { x: categoryAxis, y: valueAxis },
    };
  }

  // Meses (AAAA-MM) cobrindo um intervalo, para eixos sem buracos.
  function monthsBetween(start, end) {
    const months = [];
    let [year, month] = start.split("-").map(Number);
    const [endYear, endMonth] = end.split("-").map(Number);
    while (year < endYear || (year === endYear && month <= endMonth)) {
      months.push(`${year}-${String(month).padStart(2, "0")}`);
      month += 1;
      if (month > 12) {
        month = 1;
        year += 1;
      }
    }
    return months;
  }

  function metric({ label, icon = "", value, note = "", accent = false, trend = null }) {
    let trendHtml = "";
    if (trend !== null && Number.isFinite(trend)) {
      const up = trend > 0;
      trendHtml = `<span class="trend ${up ? "up" : "down"}">${up ? "▲" : "▼"} ${Frotas.util.number(Math.abs(trend), 1)}%</span>`;
    }
    return `
      <article class="metric-card${accent ? " accent" : ""}">
        <div class="metric-label">${esc(label)} <span>${esc(icon)}</span></div>
        <strong class="metric-value">${value}</strong>
        <small class="metric-note">${trendHtml}${note}</small>
      </article>`;
  }

  function vehicleOptions({ includeInactive = false, scope = "todos" } = {}) {
    return Frotas.store.list("vehicles")
      .filter((vehicle) => (includeInactive || vehicle.status !== "inativo") && (scope === "todos" || vehicle.scope === scope))
      .sort((a, b) => (a.scope === b.scope ? a.name.localeCompare(b.name, "pt-BR") : a.scope === "frota" ? -1 : 1))
      .map((vehicle) => ({ value: vehicle.id, label: `${Frotas.store.vehicleLabel(vehicle)}${vehicle.scope === "autorizado" ? " (autorizado)" : ""}` }));
  }

  function driverOptions() {
    return Frotas.store.list("drivers").filter((driver) => driver.active !== false)
      .sort((a, b) => a.name.localeCompare(b.name, "pt-BR"))
      .map((driver) => ({ value: driver.id, label: driver.name }));
  }

  function knownSuppliers() {
    const names = new Set();
    Frotas.store.list("fuel").forEach((entry) => entry.supplier && names.add(entry.supplier));
    Frotas.store.list("expenses").forEach((entry) => entry.supplier && names.add(entry.supplier));
    return [...names].sort((a, b) => a.localeCompare(b, "pt-BR"));
  }

  function pageIntro(title, description, actions = "") {
    return `
      <div class="page-intro">
        <div><h3>${esc(title)}</h3><p>${esc(description)}</p></div>
        <div class="toolbar-group">${actions || `<span class="date-chip">${esc(Frotas.util.longToday())}</span>`}</div>
      </div>`;
  }

  return {
    COLORS, PERIODS, SCOPES, filters, periodRange, previousRange, inRange, matchScope, periodLabel, filterBar,
    chart, destroyCharts, barOptions, monthsBetween, metric, vehicleOptions, driverOptions, knownSuppliers, pageIntro,
  };
})();
