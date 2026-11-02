"use strict";

// Painel principal e central de alertas.
(() => {
  const { esc, money, number, sum, monthLabel, dateBR } = Frotas.util;
  const C = Frotas.common;
  const { status, vehicleCell } = Frotas.ui;

  function periodMovements(range, scope) {
    return Frotas.store.movements().filter((movement) => C.inRange(movement.date, range) && C.matchScope(scope, movement));
  }

  function trend(current, previous) {
    if (!previous) return null;
    return ((current - previous) / previous) * 100;
  }

  function alertItem(alert) {
    const dot = alert.severity === "danger" ? "danger" : alert.severity === "warning" ? "warning" : "info";
    return `
      <button class="alert-item clickable" data-action="go" data-view="${esc(alert.view || "alertas")}">
        <span class="alert-dot ${dot}"></span>
        <div><strong>${esc(alert.title)}</strong><p>${esc(alert.subject)} · ${esc(alert.detail)}</p></div>
        <time>›</time>
      </button>`;
  }

  Frotas.views.dashboard = {
    title: "Painel principal",
    section: "Visão geral",

    render() {
      const range = C.periodRange();
      const scope = C.filters.scope;
      const current = periodMovements(range, scope);
      const previousRange = C.previousRange(range);
      const previous = previousRange ? periodMovements(previousRange, scope) : [];

      const total = sum(current, (item) => item.value);
      const fuel = current.filter((item) => item.group === "Abastecimento");
      const maintenance = current.filter((item) => item.group === "Manutenção");
      const fuelEntries = Frotas.store.list("fuel").filter((entry) => C.inRange(entry.date, range) && fuel.some((item) => item.id === entry.id));
      const liters = sum(fuelEntries, (entry) => (entry.liters > 0 && entry.liters < 400 ? entry.liters : 0));
      const fuelValueWithLiters = sum(fuelEntries.filter((entry) => entry.liters > 0 && entry.liters < 400), (entry) => entry.value);

      const vehicles = Frotas.store.list("vehicles").filter((vehicle) => C.matchScope(scope, vehicle) && vehicle.status !== "inativo");
      const efficiencies = vehicles.map((vehicle) => Frotas.store.stats(vehicle.id)).filter((stat) => stat?.kmPerLiter);
      const totalKm = sum(efficiencies, (stat) => stat.kmCovered);
      const fleetCostPerKm = totalKm ? sum(efficiencies, (stat) => stat.costPerKm * stat.kmCovered) / totalKm : null;

      const alerts = Frotas.store.alerts();
      const issues = Frotas.store.issues();
      const user = Frotas.auth.currentUser();

      // Ranking de custo por veículo no período.
      const byVehicle = new Map();
      current.forEach((movement) => byVehicle.set(movement.vehicleId, (byVehicle.get(movement.vehicleId) || 0) + movement.value));
      const ranking = [...byVehicle.entries()].sort((a, b) => b[1] - a[1]).slice(0, 7);
      const maxRanking = ranking[0]?.[1] || 1;

      const latest = current.slice(0, 7);

      return `
        ${C.pageIntro(`Olá, ${user.name.split(" ")[0]}`, `Indicadores de ${C.periodLabel().toLowerCase()} · ${C.SCOPES.find((item) => item.value === scope).label.toLowerCase()}.`, C.filterBar())}

        <div id="notes-hero-slot">${Frotas.notas.dashboardPanel()}</div>

        <section class="metric-grid">
          ${C.metric({ label: "Gasto total", icon: "R$", value: money(total), note: `${current.length} lançamentos`, accent: true, trend: trend(total, sum(previous, (item) => item.value)) })}
          ${C.metric({ label: "Combustível", icon: "⛽", value: money(sum(fuel, (item) => item.value)), note: `${number(liters, 0)} L · média ${liters ? money(fuelValueWithLiters / liters) : "—"}/L` })}
          ${C.metric({ label: "Manutenção", icon: "⚙", value: money(sum(maintenance, (item) => item.value)), note: `${maintenance.length} serviço(s) registrado(s)` })}
          ${C.metric({ label: "Custo por km", icon: "km", value: fleetCostPerKm ? money(fleetCostPerKm) : "—", note: totalKm ? `${number(totalKm)} km com leitura válida` : "Sem leituras de km suficientes" })}
        </section>

        <section class="dashboard-grid">
          <article class="panel">
            <div class="panel-heading"><div><h4>Gastos por mês</h4><p>Combustível, manutenção e outras despesas</p></div></div>
            <div class="chart-box"><canvas id="chart-monthly"></canvas></div>
          </article>
          <aside class="panel">
            <div class="panel-heading">
              <div><h4>Alertas</h4><p>${alerts.filter((alert) => alert.severity !== "info").length} pendência(s) com prazo</p></div>
              <button class="text-button" data-action="go" data-view="alertas">Ver todos</button>
            </div>
            <div class="alert-list">
              ${alerts.length ? alerts.slice(0, 5).map(alertItem).join("") : `<p class="muted-text">Nenhum alerta no momento.</p>`}
              ${issues.length ? `
                <button class="alert-item clickable" data-action="go" data-view="qualidade">
                  <span class="alert-dot danger"></span>
                  <div><strong>${issues.length} inconsistência(s) nos lançamentos</strong><p>Duplicidades, quilometragem e valores fora do padrão encontrados automaticamente.</p></div>
                  <time>›</time>
                </button>` : ""}
            </div>
          </aside>
        </section>

        <section class="dashboard-grid dashboard-grid-secondary">
          <article class="panel">
            <div class="panel-heading"><div><h4>Veículos com maior gasto</h4><p>${esc(C.periodLabel())}</p></div><button class="text-button" data-action="go" data-view="veiculos">Todos os veículos</button></div>
            <div class="ranking-list">
              ${ranking.length ? ranking.map(([vehicleId, value]) => {
                const vehicle = Frotas.store.vehicleById(vehicleId);
                const stat = Frotas.store.stats(vehicleId);
                return `
                  <button class="ranking-row" data-action="open-vehicle" data-id="${esc(vehicleId)}">
                    ${vehicleCell(vehicle)}
                    <div class="ranking-bar"><i style="width:${Math.max(4, (value / maxRanking) * 100)}%"></i></div>
                    <span class="ranking-meta">${stat?.kmPerLiter ? `${number(stat.kmPerLiter, 1)} km/L` : "—"}</span>
                    <strong>${money(value)}</strong>
                  </button>`;
              }).join("") : `<p class="muted-text">Sem lançamentos no período selecionado.</p>`}
            </div>
          </article>
          <aside class="panel">
            <div class="panel-heading"><div><h4>Últimos lançamentos</h4><p>Abastecimentos e despesas</p></div>${Frotas.auth.can("lancar") ? `<button class="primary-button small" data-action="new-fuel">Novo abastecimento</button>` : ""}</div>
            <div class="latest-list">
              ${latest.length ? latest.map((movement) => {
                const vehicle = Frotas.store.vehicleById(movement.vehicleId);
                return `<div class="latest-row"><div><strong>${esc(vehicle?.name || "—")}</strong><small>${esc(movement.category)} · ${dateBR(movement.date)}</small></div><span>${money(movement.value)}</span></div>`;
              }).join("") : `<p class="muted-text">Nenhum lançamento.</p>`}
            </div>
          </aside>
        </section>`;
    },

    mount() {
      Frotas.notas.mountDashboard();
      const range = C.periodRange();
      const scope = C.filters.scope;
      const movements = periodMovements(range, scope);
      const months = movements.length ? C.monthsBetween(movements[movements.length - 1].date, movements[0].date).slice(-12) : [];
      const totals = (group) => months.map((month) => sum(movements.filter((item) => item.date.startsWith(month) && item.group === group), (item) => item.value));
      C.chart("chart-monthly", {
        type: "bar",
        data: {
          labels: months.map(monthLabel),
          datasets: [
            { label: "Combustível", data: totals("Abastecimento"), backgroundColor: C.COLORS.fuel, borderRadius: 6 },
            { label: "Manutenção", data: totals("Manutenção"), backgroundColor: C.COLORS.maintenance, borderRadius: 6 },
            { label: "Outras", data: totals("Outras despesas"), backgroundColor: C.COLORS.other, borderRadius: 6 },
          ],
        },
        options: C.barOptions({ stacked: true, legend: true }),
      });
    },
  };

  Frotas.views.alertas = {
    title: "Alertas",
    section: "Visão geral",

    render() {
      const alerts = Frotas.store.alerts();
      const groups = [
        ["danger", "Vencidos ou atrasados"],
        ["warning", "Próximos do prazo"],
        ["info", "Cadastros a completar"],
      ];
      const issues = Frotas.store.issues();
      return `
        ${C.pageIntro("Central de alertas", "Documentos, CNH, revisões e manutenções que precisam de atenção.")}
        <section class="summary-strip panel summary-4">
          <div class="summary-item"><span>Vencidos / atrasados</span><strong class="text-danger">${alerts.filter((alert) => alert.severity === "danger").length}</strong></div>
          <div class="summary-item"><span>Próximos do prazo</span><strong class="text-warning">${alerts.filter((alert) => alert.severity === "warning").length}</strong></div>
          <div class="summary-item"><span>Cadastros incompletos</span><strong>${alerts.filter((alert) => alert.severity === "info").length}</strong></div>
          <div class="summary-item"><span>Inconsistências nos dados</span><strong>${issues.length}</strong></div>
        </section>
        ${groups.map(([severity, title]) => {
          const items = alerts.filter((alert) => alert.severity === severity);
          if (!items.length) return "";
          return `
            <section class="panel spaced">
              <div class="panel-heading"><div><h4>${esc(title)}</h4><p>${items.length} item(ns)</p></div></div>
              <div class="alert-list">${items.map(alertItem).join("")}</div>
            </section>`;
        }).join("")}
        ${alerts.length ? "" : `<section class="panel spaced">${Frotas.ui.empty("Tudo em dia", "Nenhum documento, CNH ou manutenção exige atenção agora.")}</section>`}
        <p class="footnote">Os alertas de prazo usam uma antecedência de ${Frotas.store.get().settings.alertDays} dias (ajustável em Configurações).</p>`;
    },
  };
})();
