"use strict";

// Relatórios gerenciais e auditoria de qualidade dos dados.
(() => {
  const { esc, money, number, dateBR, dateTimeBR, sum, groupBy, monthLabel, percent, toCSV, downloadText, todayISO } = Frotas.util;
  const C = Frotas.common;
  const { status, vehicleCell, table, toast, confirm } = Frotas.ui;
  const store = Frotas.store;

  const REPORTS = [
    { id: "custos", label: "Custos por veículo" },
    { id: "consumo", label: "Consumo e eficiência" },
    { id: "categorias", label: "Por categoria" },
    { id: "fornecedores", label: "Fornecedores" },
    { id: "autorizados", label: "Autorizados" },
    { id: "auditoria", label: "Auditoria", permission: "auditoria" },
  ];

  let activeReport = "custos";

  // Nome + placa nos gráficos, para distinguir veículos de mesmo modelo.
  function chartLabel(vehicle) {
    if (!vehicle) return "—";
    return vehicle.plate ? `${vehicle.name} (${Frotas.util.formatPlate(vehicle.plate)})` : vehicle.name;
  }

  function filtered() {
    const range = C.periodRange();
    return store.movements().filter((movement) => C.inRange(movement.date, range) && C.matchScope(C.filters.scope, movement));
  }

  function byVehicle(movements) {
    return [...groupBy(movements, (movement) => movement.vehicleId).entries()].map(([vehicleId, items]) => ({
      vehicle: store.vehicleById(vehicleId),
      vehicleId,
      fuel: sum(items.filter((item) => item.group === "Abastecimento"), (item) => item.value),
      maintenance: sum(items.filter((item) => item.group === "Manutenção"), (item) => item.value),
      other: sum(items.filter((item) => item.group === "Outras despesas"), (item) => item.value),
      total: sum(items, (item) => item.value),
      count: items.length,
    })).sort((a, b) => b.total - a.total);
  }

  // Cada relatório devolve { html, mount, csv }.
  const builders = {
    custos() {
      const movements = filtered();
      const rows = byVehicle(movements);
      const total = sum(rows, (row) => row.total);
      return {
        html: `
          <section class="metric-grid">
            ${C.metric({ label: "Custo total", icon: "R$", value: money(total), note: `${movements.length} lançamentos`, accent: true })}
            ${C.metric({ label: "Combustível", icon: "⛽", value: money(sum(rows, (row) => row.fuel)), note: `${percent(sum(rows, (row) => row.fuel), total)} do total` })}
            ${C.metric({ label: "Manutenção", icon: "⚙", value: money(sum(rows, (row) => row.maintenance)), note: `${percent(sum(rows, (row) => row.maintenance), total)} do total` })}
            ${C.metric({ label: "Outras despesas", icon: "+", value: money(sum(rows, (row) => row.other)), note: `${percent(sum(rows, (row) => row.other), total)} do total` })}
          </section>
          <section class="dashboard-grid even">
            <article class="panel"><div class="panel-heading"><div><h4>Custo por veículo</h4><p>Dez maiores no período</p></div></div><div class="chart-box tall"><canvas id="report-vehicles"></canvas></div></article>
            <article class="panel"><div class="panel-heading"><div><h4>Evolução mensal</h4><p>Total de custos por mês</p></div></div><div class="chart-box tall"><canvas id="report-evolution"></canvas></div></article>
          </section>
          <section class="panel spaced">
            ${table({
              id: "report-costs",
              rows,
              pageSize: 50,
              columns: [
                { label: "Veículo", render: (row) => vehicleCell(row.vehicle), sortValue: (row) => row.vehicle?.name || "" },
                { label: "Lançamentos", align: "right", render: (row) => row.count, sortValue: (row) => row.count },
                { label: "Combustível", align: "right", render: (row) => money(row.fuel), sortValue: (row) => row.fuel },
                { label: "Manutenção", align: "right", render: (row) => money(row.maintenance), sortValue: (row) => row.maintenance },
                { label: "Outras", align: "right", render: (row) => money(row.other), sortValue: (row) => row.other },
                { label: "Total", align: "right", render: (row) => `<strong>${money(row.total)}</strong>`, sortValue: (row) => row.total },
                { label: "% do total", align: "right", render: (row) => percent(row.total, total), sortValue: (row) => row.total },
              ],
            })}
          </section>`,
        mount() {
          const top = rows.slice(0, 10);
          C.chart("report-vehicles", {
            type: "bar",
            data: {
              labels: top.map((row) => chartLabel(row.vehicle)),
              datasets: [
                { label: "Combustível", data: top.map((row) => row.fuel), backgroundColor: C.COLORS.fuel, borderRadius: 5 },
                { label: "Manutenção", data: top.map((row) => row.maintenance), backgroundColor: C.COLORS.maintenance, borderRadius: 5 },
                { label: "Outras", data: top.map((row) => row.other), backgroundColor: C.COLORS.other, borderRadius: 5 },
              ],
            },
            options: C.barOptions({ stacked: true, horizontal: true, legend: true }),
          });
          const months = movements.length ? C.monthsBetween(movements[movements.length - 1].date, movements[0].date) : [];
          C.chart("report-evolution", {
            type: "line",
            data: {
              labels: months.map(monthLabel),
              datasets: [{ label: "Custos", data: months.map((month) => sum(movements.filter((item) => item.date.startsWith(month)), (item) => item.value)), borderColor: C.COLORS.line, backgroundColor: "rgba(74,70,80,.15)", fill: true, tension: 0.3, pointRadius: 4 }],
            },
            options: C.barOptions(),
          });
        },
        csv: () => toCSV(["Veículo", "Placa", "Vínculo", "Lançamentos", "Combustível", "Manutenção", "Outras", "Total"],
          rows.map((row) => [row.vehicle?.name, row.vehicle?.plate, row.vehicle?.scope, row.count, row.fuel.toFixed(2), row.maintenance.toFixed(2), row.other.toFixed(2), row.total.toFixed(2)])),
      };
    },

    consumo() {
      const vehicles = store.list("vehicles").filter((vehicle) => C.matchScope(C.filters.scope, vehicle));
      const rows = vehicles.map((vehicle) => ({ vehicle, stat: store.stats(vehicle.id) })).filter((row) => row.stat?.kmPerLiter);
      const byType = groupBy(rows, (row) => row.vehicle.type);
      return {
        html: `
          <p class="report-note">O consumo é calculado entre abastecimentos consecutivos com quilometragem válida. Leituras com erro de digitação são descartadas automaticamente (veja Qualidade dos dados). Considera todo o histórico do veículo.</p>
          <section class="metric-grid">
            ${[...byType.entries()].slice(0, 4).map(([type, items]) => C.metric({ label: `Consumo mediano · ${type}`, icon: "km/L", value: `${number(Frotas.util.median(items.map((item) => item.stat.kmPerLiter)), 1)} km/L`, note: `${items.length} veículo(s)` })).join("")}
          </section>
          <section class="dashboard-grid even">
            <article class="panel"><div class="panel-heading"><div><h4>km por litro</h4><p>Quanto maior, melhor</p></div></div><div class="chart-box tall"><canvas id="report-kml"></canvas></div></article>
            <article class="panel"><div class="panel-heading"><div><h4>Custo por km</h4><p>Combustível ÷ km rodados</p></div></div><div class="chart-box tall"><canvas id="report-costkm"></canvas></div></article>
          </section>
          <section class="panel spaced">
            ${table({
              id: "report-efficiency",
              rows,
              pageSize: 50,
              columns: [
                { label: "Veículo", render: (row) => vehicleCell(row.vehicle), sortValue: (row) => row.vehicle.name },
                { label: "Tipo", render: (row) => esc(row.vehicle.type) },
                { label: "Km com leitura válida", align: "right", render: (row) => number(row.stat.kmCovered), sortValue: (row) => row.stat.kmCovered },
                { label: "Consumo", align: "right", render: (row) => `${number(row.stat.kmPerLiter, 1)} km/L`, sortValue: (row) => row.stat.kmPerLiter },
                { label: "Custo/km", align: "right", render: (row) => money(row.stat.costPerKm), sortValue: (row) => row.stat.costPerKm },
                { label: "Comparação com o tipo", render: (row) => {
                  const reference = Frotas.util.median(byType.get(row.vehicle.type).map((item) => item.stat.kmPerLiter));
                  const diff = ((row.stat.kmPerLiter - reference) / reference) * 100;
                  if (Math.abs(diff) < 10) return status("Na média", "neutral");
                  return diff > 0 ? status(`${number(diff, 0)}% melhor`) : status(`${number(-diff, 0)}% pior`, "danger");
                }, sortable: false },
              ],
            })}
          </section>`,
        mount() {
          const sorted = [...rows].sort((a, b) => b.stat.kmPerLiter - a.stat.kmPerLiter);
          C.chart("report-kml", { type: "bar", data: { labels: sorted.map((row) => chartLabel(row.vehicle)), datasets: [{ label: "km/L", data: sorted.map((row) => row.stat.kmPerLiter), backgroundColor: sorted.map((row) => (row.vehicle.type === "Moto" ? C.COLORS.success : C.COLORS.fuel)), borderRadius: 5 }] }, options: C.barOptions({ horizontal: true, money: false }) });
          const byCost = [...rows].sort((a, b) => b.stat.costPerKm - a.stat.costPerKm);
          C.chart("report-costkm", { type: "bar", data: { labels: byCost.map((row) => chartLabel(row.vehicle)), datasets: [{ label: "R$/km", data: byCost.map((row) => row.stat.costPerKm), backgroundColor: C.COLORS.maintenance, borderRadius: 5 }] }, options: C.barOptions({ horizontal: true }) });
        },
        csv: () => toCSV(["Veículo", "Placa", "Tipo", "Km válidos", "km/L", "Custo por km"], rows.map((row) => [row.vehicle.name, row.vehicle.plate, row.vehicle.type, row.stat.kmCovered, row.stat.kmPerLiter.toFixed(2), row.stat.costPerKm.toFixed(2)])),
      };
    },

    categorias() {
      const movements = filtered();
      const rows = [...groupBy(movements, (movement) => movement.category).entries()]
        .map(([category, items]) => ({ category, count: items.length, total: sum(items, (item) => item.value), average: sum(items, (item) => item.value) / items.length }))
        .sort((a, b) => b.total - a.total);
      const total = sum(rows, (row) => row.total);
      return {
        html: `
          <section class="dashboard-grid even">
            <article class="panel"><div class="panel-heading"><div><h4>Distribuição dos custos</h4><p>${esc(C.periodLabel())}</p></div></div><div class="chart-box tall"><canvas id="report-categories"></canvas></div></article>
            <article class="panel">
              ${table({
                id: "report-categories-table",
                rows,
                columns: [
                  { label: "Categoria", render: (row) => esc(row.category) },
                  { label: "Lançamentos", align: "right", render: (row) => row.count, sortValue: (row) => row.count },
                  { label: "Média", align: "right", render: (row) => money(row.average), sortValue: (row) => row.average },
                  { label: "Total", align: "right", render: (row) => money(row.total), sortValue: (row) => row.total },
                  { label: "%", align: "right", render: (row) => percent(row.total, total), sortValue: (row) => row.total },
                ],
              })}
            </article>
          </section>`,
        mount() {
          C.chart("report-categories", {
            type: "doughnut",
            data: { labels: rows.map((row) => row.category), datasets: [{ data: rows.map((row) => row.total), backgroundColor: C.COLORS.palette, borderWidth: 2, borderColor: "#fff" }] },
            options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: "right" }, tooltip: { callbacks: { label: (context) => `${context.label}: ${money(context.raw)} (${percent(context.raw, total)})` } } } },
          });
        },
        csv: () => toCSV(["Categoria", "Lançamentos", "Média", "Total"], rows.map((row) => [row.category, row.count, row.average.toFixed(2), row.total.toFixed(2)])),
      };
    },

    fornecedores() {
      const range = C.periodRange();
      const fuel = store.list("fuel").filter((entry) => C.inRange(entry.date, range) && C.matchScope(C.filters.scope, store.vehicleById(entry.vehicleId) || {}));
      const movements = filtered();
      const rows = [...groupBy(movements, (movement) => movement.supplier || "Não informado").entries()].map(([supplier, items]) => {
        const supplierFuel = fuel.filter((entry) => (entry.supplier || "Não informado") === supplier && entry.liters > 0 && entry.liters < 400);
        const liters = sum(supplierFuel, (entry) => entry.liters);
        return { supplier, count: items.length, total: sum(items, (item) => item.value), liters, price: liters ? sum(supplierFuel, (entry) => entry.value) / liters : null };
      }).sort((a, b) => b.total - a.total);
      return {
        html: `
          <p class="report-note">O preço médio por litro permite comparar postos. Fornecedores sem litros são oficinas, lojas e prestadores.</p>
          <section class="panel spaced">
            ${table({
              id: "report-suppliers",
              rows,
              pageSize: 50,
              columns: [
                { label: "Fornecedor", render: (row) => esc(row.supplier) },
                { label: "Lançamentos", align: "right", render: (row) => row.count, sortValue: (row) => row.count },
                { label: "Litros", align: "right", render: (row) => (row.liters ? number(row.liters, 1) : "—"), sortValue: (row) => row.liters },
                { label: "Preço médio/L", align: "right", render: (row) => (row.price ? money(row.price) : "—"), sortValue: (row) => row.price || 0 },
                { label: "Total", align: "right", render: (row) => money(row.total), sortValue: (row) => row.total },
              ],
            })}
          </section>`,
        csv: () => toCSV(["Fornecedor", "Lançamentos", "Litros", "Preço médio por litro", "Total"], rows.map((row) => [row.supplier, row.count, row.liters.toFixed(2), row.price ? row.price.toFixed(3) : "", row.total.toFixed(2)])),
      };
    },

    autorizados() {
      const range = C.periodRange();
      const movements = store.movements().filter((movement) => movement.scope === "autorizado" && C.inRange(movement.date, range));
      const rows = byVehicle(movements);
      return {
        html: `
          <p class="report-note">Veículos de colaboradores autorizados a abastecer ou ter despesas pagas pela empresa. Use para conferência de reembolsos.</p>
          <section class="metric-grid three">
            ${C.metric({ label: "Total pago a autorizados", icon: "R$", value: money(sum(rows, (row) => row.total)), note: C.periodLabel(), accent: true })}
            ${C.metric({ label: "Veículos autorizados com lançamentos", icon: "V", value: String(rows.length), note: "No período" })}
            ${C.metric({ label: "Lançamentos", icon: "#", value: String(movements.length), note: "Abastecimentos e despesas" })}
          </section>
          <section class="panel spaced">
            ${table({
              id: "report-authorized",
              rows,
              pageSize: 50,
              columns: [
                { label: "Veículo", render: (row) => vehicleCell(row.vehicle), sortValue: (row) => row.vehicle?.name || "" },
                { label: "Responsável(is)", render: (row) => esc(row.vehicle?.responsible || "—") },
                { label: "Lançamentos", align: "right", render: (row) => row.count, sortValue: (row) => row.count },
                { label: "Combustível", align: "right", render: (row) => money(row.fuel), sortValue: (row) => row.fuel },
                { label: "Outras", align: "right", render: (row) => money(row.maintenance + row.other), sortValue: (row) => row.maintenance + row.other },
                { label: "Total", align: "right", render: (row) => `<strong>${money(row.total)}</strong>`, sortValue: (row) => row.total },
              ],
            })}
          </section>`,
        csv: () => toCSV(["Veículo", "Placa", "Responsáveis", "Lançamentos", "Combustível", "Outras", "Total"], rows.map((row) => [row.vehicle?.name, row.vehicle?.plate, row.vehicle?.responsible, row.count, row.fuel.toFixed(2), (row.maintenance + row.other).toFixed(2), row.total.toFixed(2)])),
      };
    },

    auditoria() {
      const range = C.periodRange();
      const rows = store.get().audit.filter((entry) => C.inRange(new Date(entry.ts).toISOString().slice(0, 10), range));
      return {
        html: `
          <p class="report-note">Toda inclusão, alteração, exclusão, acesso e bloqueio fica registrado com usuário, data e hora. O registro não pode ser editado pela interface.</p>
          <section class="panel spaced">
            ${table({
              id: "report-audit",
              rows,
              pageSize: 30,
              columns: [
                { label: "Data e hora", render: (entry) => dateTimeBR(entry.ts), sortValue: (entry) => entry.ts },
                { label: "Usuário", render: (entry) => esc(entry.user) },
                { label: "Ação", render: (entry) => esc(entry.action) },
                { label: "Módulo", render: (entry) => esc(entry.entity) },
                { label: "Detalhes", render: (entry) => esc(entry.details) },
              ],
            })}
          </section>`,
        csv: () => toCSV(["Data e hora", "Usuário", "Ação", "Módulo", "Detalhes"], rows.map((entry) => [dateTimeBR(entry.ts), entry.user, entry.action, entry.entity, entry.details])),
      };
    },
  };

  let current = null;

  Frotas.views.relatorios = {
    title: "Relatórios",
    section: "Análises",
    render() {
      const available = REPORTS.filter((report) => !report.permission || Frotas.auth.can(report.permission));
      if (!available.some((report) => report.id === activeReport)) activeReport = "custos";
      current = builders[activeReport]();
      const showScope = !["autorizados", "auditoria"].includes(activeReport);
      const showPeriod = activeReport !== "consumo";
      return `
        ${C.pageIntro("Relatórios", "Análises gerenciais com exportação para Excel (CSV) e impressão.", `
          <button class="secondary-button" data-action="print">Imprimir</button>
          <button class="primary-button" data-action="export-report">Exportar para Excel</button>`)}
        <div class="tab-bar standalone">${available.map((report) => `<button class="tab${report.id === activeReport ? " active" : ""}" data-action="report-tab" data-value="${report.id}">${esc(report.label)}</button>`).join("")}</div>
        ${C.filterBar({ period: showPeriod, scope: showScope })}
        <div class="print-header"><strong>Gestão de Frotas</strong> — ${esc(REPORTS.find((report) => report.id === activeReport).label)} · ${esc(showPeriod ? C.periodLabel() : "Todo o histórico")} · emitido em ${dateBR(todayISO())}</div>
        ${current.html}`;
    },
    mount() {
      current?.mount?.();
    },
  };

  // ---------- Qualidade dos dados ----------

  let issueTypeFilter = "";

  Frotas.views.qualidade = {
    title: "Qualidade dos dados",
    section: "Análises",
    render() {
      const all = store.issues();
      const types = [...groupBy(all, (issue) => issue.type).entries()].sort((a, b) => b[1].length - a[1].length);
      const visible = issueTypeFilter ? all.filter((issue) => issue.type === issueTypeFilter) : all;
      const canReview = Frotas.auth.can("editar");
      return `
        ${C.pageIntro("Qualidade dos dados", "Conferência automática dos lançamentos: duplicidades, quilometragem e valores fora do padrão.", canReview && visible.length ? `<button class="secondary-button" data-action="review-visible">Marcar ${visible.length} como conferido(s)</button>` : "")}
        <section class="quality-hero panel">
          <div>
            <span class="eyebrow">Auditoria automática</span>
            <h4>${all.length ? `${all.length} lançamento(s) precisam de conferência` : "Nenhuma inconsistência encontrada"}</h4>
            <p>Erros de digitação distorcem o consumo, o custo por km e os relatórios. Corrija o lançamento (ícone de lápis) ou marque como conferido quando o valor estiver correto. Leituras incompatíveis já são ignoradas nos cálculos de consumo.</p>
          </div>
          <div class="quality-chips">
            <button class="chip${issueTypeFilter ? "" : " active"}" data-action="issue-filter" data-value="">Todos <b>${all.length}</b></button>
            ${types.map(([type, items]) => `<button class="chip${issueTypeFilter === type ? " active" : ""}" data-action="issue-filter" data-value="${esc(type)}">${esc(type)} <b>${items.length}</b></button>`).join("")}
          </div>
        </section>
        <section class="panel spaced">
          ${table({
            id: "issues",
            rows: visible,
            pageSize: 25,
            emptyText: "Nenhum apontamento pendente.",
            columns: [
              { label: "Gravidade", render: (issue) => status(issue.severity === "danger" ? "Alta" : "Média", issue.severity), sortValue: (issue) => issue.severity },
              { label: "Apontamento", render: (issue) => `<strong>${esc(issue.type)}</strong><small class="cell-sub">${esc(issue.detail)}</small>` },
              { label: "Veículo", render: (issue) => esc(issue.vehicle) },
              { label: "Data", render: (issue) => dateBR(issue.date), sortValue: (issue) => issue.date },
              { label: "Valor", align: "right", render: (issue) => money(issue.value), sortValue: (issue) => issue.value },
              { label: "", sortable: false, render: (issue) => `<div class="row-actions">
                  ${Frotas.auth.can("editar") ? `<button class="icon-action" data-action="edit-fuel" data-id="${esc(issue.recordId)}" title="Corrigir lançamento">✎</button>` : ""}
                  ${canReview ? `<button class="icon-action success" data-action="review-issue" data-id="${esc(issue.id)}" title="Marcar como conferido (valor correto)">✓</button>` : ""}
                </div>` },
            ],
          })}
        </section>`;
    },
  };

  Frotas.actions = Object.assign(Frotas.actions || {}, {
    "report-tab": (button) => { activeReport = button.dataset.value; Frotas.ui.resetPages(); Frotas.app.refresh(); },
    "export-report": async () => {
      if (!current?.csv) return;
      const saved = await downloadText(current.csv(), `frotas-relatorio-${activeReport}-${todayISO()}.csv`, "csv");
      if (saved) toast("Relatório exportado. Abra o arquivo no Excel.");
    },
    print: () => window.print(),
    "issue-filter": (button) => { issueTypeFilter = button.dataset.value; Frotas.ui.resetPages(); Frotas.app.refresh(); },
    "review-issue": (button) => { store.markReviewed([button.dataset.id]); toast("Apontamento marcado como conferido."); },
    "review-visible": async () => {
      const visible = issueTypeFilter ? store.issues().filter((issue) => issue.type === issueTypeFilter) : store.issues();
      if (await confirm(`Marcar ${visible.length} apontamento(s) como conferido(s)? Eles deixarão de aparecer nesta lista.`, { confirmLabel: "Marcar como conferidos" })) {
        store.markReviewed(visible.map((issue) => issue.id));
        toast("Apontamentos marcados como conferidos.");
      }
    },
  });
})();
