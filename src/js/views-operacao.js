"use strict";

// Telas de operação: veículos, motoristas, abastecimentos, despesas e manutenções.
(() => {
  const { esc, money, number, dateBR, formatPlate, extractPlate, todayISO, sum, daysBetween, addDays } = Frotas.util;
  const C = Frotas.common;
  const { status, vehicleCell, personCell, table, openForm, confirm, toast, empty } = Frotas.ui;
  const store = Frotas.store;

  // ---------- Comprovantes ----------

  async function storeAttachment(file, previous = "") {
    if (!file) return previous;
    if (file.size > 15 * 1024 * 1024) throw new Error("O comprovante deve ter no máximo 15 MB.");
    const base64 = await Frotas.util.fileToBase64(file);
    if (window.frotasDesktop) return window.frotasDesktop.saveAttachment(file.name, base64);
    if (file.size > 400 * 1024) throw new Error("No modo navegador, o comprovante deve ter até 400 KB.");
    return `data:${file.type};base64,${base64}`;
  }

  function openAttachment(name) {
    if (!name) return;
    if (name.startsWith("data:")) {
      const win = window.open();
      if (win) win.document.write(`<iframe src="${name}" style="border:0;width:100%;height:100%"></iframe>`);
    } else window.frotasDesktop?.openAttachment(name);
  }

  function attachmentButton(item) {
    return item.attachment ? `<button class="icon-action" data-action="open-attachment" data-id="${esc(item.id)}" title="Ver comprovante">📎</button>` : "";
  }

  function rowActions(collection, item, { edit = true, remove = true } = {}) {
    const canEdit = Frotas.auth.can("editar") || (item.createdBy === Frotas.auth.currentUser()?.name && item.source === "sistema");
    const canRemove = Frotas.auth.can("excluir");
    return `<div class="row-actions">
      ${attachmentButton(item)}
      ${edit && canEdit ? `<button class="icon-action" data-action="edit-${collection}" data-id="${esc(item.id)}" title="Editar">✎</button>` : ""}
      ${remove && canRemove ? `<button class="icon-action danger" data-action="delete-${collection}" data-id="${esc(item.id)}" title="Excluir">🗑</button>` : ""}
    </div>`;
  }

  function sourceBadge(item) {
    return item.source === "planilha" ? `<span class="source-tag" title="${esc(item.sourceRef || "")}">planilha</span>` : "";
  }

  // ---------- Formulário de abastecimento ----------

  function lastKm(vehicleId, ignoreId) {
    const stats = store.stats(vehicleId);
    if (!stats) return null;
    const entries = store.list("fuel").filter((entry) => entry.vehicleId === vehicleId && entry.id !== ignoreId && entry.km > 0);
    return stats.currentKm && entries.length ? stats.currentKm : null;
  }

  // Chave de acesso de NF-e/NFC-e já usada em outro lançamento (nota lançada duas vezes).
  function duplicateByKey(nfceKey, ignoreId) {
    if (!nfceKey) return null;
    return [...store.list("fuel"), ...store.list("expenses")].find((item) => item.nfceKey === nfceKey && item.id !== ignoreId) || null;
  }

  // opts (leitura de nota): values pré-preenchidos, attachment já salvo, intro com a foto, nfceKey, origin e onSaved.
  function fuelForm(entry = null, presetVehicleId = "", opts = {}) {
    const settings = store.get().settings;
    const values = entry ? { ...entry } : { date: todayISO(), vehicleId: presetVehicleId, ...(opts.values || {}) };
    openForm({
      eyebrow: entry ? "Editar lançamento" : opts.values ? "Nota lida automaticamente" : "Novo lançamento",
      title: entry ? "Editar abastecimento" : "Registrar abastecimento",
      values,
      wide: Boolean(opts.intro),
      intro: opts.intro || `<p>O sistema confere a quilometragem e o preço por litro antes de salvar, para evitar erros de digitação.</p>`,
      fields: [
        { name: "vehicleId", label: "Veículo", type: "select", required: true, options: C.vehicleOptions(), full: true },
        { name: "date", label: "Data", type: "date", required: true, max: todayISO() },
        { name: "km", label: "Quilometragem no painel", type: "number", min: 0, placeholder: "Ex.: 58420", required: !entry },
        { name: "liters", label: "Litros", type: "decimal", required: true, placeholder: "Ex.: 42,5" },
        { name: "value", label: "Valor total (R$)", type: "decimal", required: true, placeholder: "Ex.: 289,90" },
        { name: "supplier", label: "Posto / fornecedor", type: "select", options: C.knownSuppliers(), placeholder: "Selecione ou deixe em branco" },
        { name: "newSupplier", label: "Outro posto (se não estiver na lista)", placeholder: "Nome do posto" },
        { name: "driverId", label: "Motorista", type: "select", options: C.driverOptions(), placeholder: "Não informado" },
        { name: "fuelType", label: "Combustível", type: "select", options: store.FUEL_TYPES, placeholder: "Não informado" },
        { name: "attachmentFile", label: "Comprovante (foto ou PDF)", type: "file", accept: "image/*,.pdf" },
        { name: "note", label: "Observação", type: "textarea", full: true },
        { name: "override", label: "Confirmo que os valores estão corretos mesmo fora do padrão", type: "checkbox", full: true },
      ],
      submitLabel: entry ? "Salvar alterações" : "Registrar abastecimento",
      async onSubmit(data) {
        if (!(data.liters > 0)) throw new Error("Informe a quantidade de litros.");
        if (!(data.value > 0)) throw new Error("Informe o valor total.");
        const vehicle = store.vehicleById(data.vehicleId);
        const price = data.value / data.liters;
        const duplicate = duplicateByKey(opts.nfceKey, entry?.id);
        if (duplicate) throw new Error(`Esta nota fiscal já foi lançada em ${dateBR(duplicate.date)} (${money(duplicate.value)}). Lançamento bloqueado para não pagar duas vezes.`);
        if (!data.override) {
          const previousKm = lastKm(data.vehicleId, entry?.id);
          if (data.km && previousKm && data.km < previousKm - 50 && !entry) {
            throw new Error(`A quilometragem informada (${number(data.km)} km) é menor que a última registrada para este veículo (${number(previousKm)} km). Confira o painel ou marque a confirmação abaixo.`);
          }
          if (data.km && previousKm && data.km - previousKm > 3000 && !entry) {
            throw new Error(`Diferença de ${number(data.km - previousKm)} km desde o último abastecimento. Confira a quilometragem ou marque a confirmação abaixo.`);
          }
          if (price < settings.fuelPriceMin || price > settings.fuelPriceMax) {
            throw new Error(`Preço calculado de ${money(price)}/L está fora da faixa esperada (${money(settings.fuelPriceMin)} a ${money(settings.fuelPriceMax)}). Confira litros e valor ou marque a confirmação abaixo.`);
          }
          const tank = Number(vehicle?.tankLiters) || (vehicle?.type === "Moto" ? 20 : 90);
          if (data.liters > tank) throw new Error(`${number(data.liters, 2)} L é mais do que o tanque estimado do veículo (${tank} L). Confira ou marque a confirmação abaixo.`);
        }
        const attachment = await storeAttachment(data.attachmentFile, entry?.attachment || opts.attachment);
        const record = {
          vehicleId: data.vehicleId, date: data.date, km: data.km || null, liters: data.liters, value: data.value,
          supplier: data.newSupplier || data.supplier || "", driverId: data.driverId, fuelType: data.fuelType, note: data.note, attachment,
          ...(opts.nfceKey ? { nfceKey: opts.nfceKey } : {}), ...(opts.origin ? { origin: opts.origin } : {}),
        };
        const description = `${store.vehicleLabel(vehicle)} · ${dateBR(data.date)} · ${money(data.value)}`;
        const saved = entry ? store.update("fuel", entry.id, record, description) : store.create("fuel", record, description);
        toast(entry ? "Abastecimento atualizado." : "Abastecimento registrado com sucesso.");
        opts.onSaved?.(saved, "fuel");
      },
    });
  }

  // ---------- Formulário de despesa ----------

  function expenseForm(entry = null, presetVehicleId = "", opts = {}) {
    const values = entry ? { ...entry } : { date: todayISO(), vehicleId: presetVehicleId, ...(opts.values || {}) };
    openForm({
      eyebrow: entry ? "Editar lançamento" : opts.values ? "Nota lida automaticamente" : "Novo lançamento",
      title: entry ? "Editar despesa" : "Lançar despesa",
      values,
      wide: Boolean(opts.intro),
      intro: opts.intro || "",
      fields: [
        { name: "vehicleId", label: "Veículo", type: "select", required: true, options: C.vehicleOptions(), full: true },
        { name: "date", label: "Data", type: "date", required: true, max: todayISO() },
        { name: "category", label: "Categoria", type: "select", required: true, options: store.EXPENSE_CATEGORIES },
        { name: "description", label: "Descrição do serviço ou item", required: true, full: true, placeholder: "Ex.: Troca de óleo e filtro" },
        { name: "supplier", label: "Fornecedor", placeholder: "Oficina, loja, órgão..." },
        { name: "value", label: "Valor (R$)", type: "decimal", required: true },
        { name: "attachmentFile", label: "Comprovante (foto ou PDF)", type: "file", accept: "image/*,.pdf" },
        { name: "note", label: "Observação", type: "textarea", full: true },
      ],
      submitLabel: entry ? "Salvar alterações" : "Lançar despesa",
      async onSubmit(data) {
        if (!(data.value > 0)) throw new Error("Informe o valor da despesa.");
        const duplicate = duplicateByKey(opts.nfceKey, entry?.id);
        if (duplicate) throw new Error(`Esta nota fiscal já foi lançada em ${dateBR(duplicate.date)} (${money(duplicate.value)}). Lançamento bloqueado para não pagar duas vezes.`);
        const attachment = await storeAttachment(data.attachmentFile, entry?.attachment || opts.attachment);
        const record = {
          vehicleId: data.vehicleId, date: data.date, category: data.category, description: data.description, supplier: data.supplier, value: data.value, note: data.note, attachment,
          ...(opts.nfceKey ? { nfceKey: opts.nfceKey } : {}), ...(opts.origin ? { origin: opts.origin } : {}),
        };
        const description = `${data.category} · ${store.vehicleLabel(store.vehicleById(data.vehicleId))} · ${money(data.value)}`;
        const saved = entry ? store.update("expenses", entry.id, record, description) : store.create("expenses", record, description);
        toast(entry ? "Despesa atualizada." : "Despesa lançada com sucesso.");
        opts.onSaved?.(saved, "expenses");
      },
    });
  }

  // ---------- Formulário de veículo ----------

  function vehicleForm(vehicle = null) {
    openForm({
      eyebrow: vehicle ? "Editar cadastro" : "Novo cadastro",
      title: vehicle ? `Editar ${vehicle.name}` : "Cadastrar veículo",
      wide: true,
      values: vehicle ? { ...vehicle, plate: formatPlate(vehicle.plate) } : { type: "Carro", scope: "frota", status: "ativo", fuelType: "Flex" },
      fields: [
        { name: "name", label: "Modelo / identificação", required: true, placeholder: "Ex.: Fiat Fiorino" },
        { name: "plate", label: "Placa", placeholder: "ABC-1D23" },
        { name: "type", label: "Tipo", type: "select", required: true, options: store.VEHICLE_TYPES, placeholder: false },
        { name: "scope", label: "Vínculo", type: "select", required: true, placeholder: false, options: [{ value: "frota", label: "Frota própria" }, { value: "autorizado", label: "Veículo autorizado (de colaborador)" }] },
        { name: "responsible", label: "Responsável", placeholder: "Setor ou pessoa" },
        { name: "year", label: "Ano", type: "number", min: 1980, max: new Date().getFullYear() + 1 },
        { name: "fuelType", label: "Combustível", type: "select", options: store.FUEL_TYPES, placeholder: false },
        { name: "tankLiters", label: "Capacidade do tanque (L)", type: "number", min: 1, help: "Usado para detectar lançamentos impossíveis." },
        { name: "licensingDue", label: "Vencimento do licenciamento", type: "date" },
        { name: "insuranceDue", label: "Vencimento do seguro", type: "date" },
        { name: "nextServiceKm", label: "Próxima revisão (km)", type: "number", min: 0 },
        { name: "nextServiceDate", label: "Próxima revisão (data)", type: "date" },
        { name: "status", label: "Situação", type: "select", placeholder: false, options: [{ value: "ativo", label: "Ativo" }, { value: "manutencao", label: "Em manutenção" }, { value: "inativo", label: "Inativo / vendido" }] },
        { name: "notes", label: "Observações", type: "textarea", full: true },
      ],
      submitLabel: vehicle ? "Salvar alterações" : "Cadastrar veículo",
      async onSubmit(data) {
        const plate = data.plate ? extractPlate(data.plate) : "";
        if (data.plate && !plate) throw new Error("Placa inválida. Use o formato ABC-1234 ou ABC-1D23.");
        const duplicate = plate && store.list("vehicles").find((item) => item.plate === plate && item.id !== vehicle?.id);
        if (duplicate) throw new Error(`A placa ${formatPlate(plate)} já está cadastrada (${duplicate.name}).`);
        const record = { ...data, plate, year: data.year || "", tankLiters: data.tankLiters || null, nextServiceKm: data.nextServiceKm || null };
        if (vehicle) store.update("vehicles", vehicle.id, record, `${data.name} ${formatPlate(plate)}`);
        else store.create("vehicles", { ...record, aliases: [] }, `${data.name} ${formatPlate(plate)}`);
        toast(vehicle ? "Cadastro do veículo atualizado." : "Veículo cadastrado.");
      },
    });
  }

  function documentStatus(vehicle) {
    const today = todayISO();
    const dues = [["Licenciamento", vehicle.licensingDue], ["Seguro", vehicle.insuranceDue]].filter(([, date]) => date);
    if (!dues.length) return vehicle.scope === "frota" ? status("Não informado", "neutral") : `<span class="muted-text">—</span>`;
    const worst = dues.map(([label, date]) => ({ label, days: daysBetween(today, date) })).sort((a, b) => a.days - b.days)[0];
    if (worst.days < 0) return status(`${worst.label} vencido`, "danger");
    if (worst.days <= store.get().settings.alertDays) return status(`${worst.label} em ${worst.days} d`, "warning");
    return status("Em dia");
  }

  function vehicleStatus(vehicle) {
    if (vehicle.status === "inativo") return status("Inativo", "neutral");
    if (vehicle.status === "manutencao") return status("Em manutenção", "warning");
    return status("Ativo");
  }

  let vehicleFilter = "frota";

  Frotas.views.veiculos = {
    title: "Veículos",
    section: "Operação",
    render() {
      const all = store.list("vehicles");
      const list = all.filter((vehicle) => (vehicleFilter === "inativo" ? vehicle.status === "inativo" : vehicle.status !== "inativo" && (vehicleFilter === "todos" || vehicle.scope === vehicleFilter)));
      const own = all.filter((vehicle) => vehicle.scope === "frota" && vehicle.status !== "inativo");
      const efficiencies = own.map((vehicle) => store.stats(vehicle.id)?.kmPerLiter).filter(Boolean);
      const tabs = [["frota", "Frota própria"], ["autorizado", "Autorizados"], ["todos", "Todos ativos"], ["inativo", "Inativos"]];
      return `
        ${C.pageIntro("Veículos", "Cadastro, documentação, quilometragem e custos de cada veículo.", Frotas.auth.can("cadastros") ? `<button class="primary-button" data-action="new-vehicle">Cadastrar veículo</button>` : "")}
        <section class="panel module-panel">
          <div class="summary-strip summary-4">
            <div class="summary-item"><span>Frota própria ativa</span><strong>${own.length}</strong></div>
            <div class="summary-item"><span>Veículos autorizados</span><strong>${all.filter((vehicle) => vehicle.scope === "autorizado" && vehicle.status !== "inativo").length}</strong></div>
            <div class="summary-item"><span>Em manutenção</span><strong>${all.filter((vehicle) => vehicle.status === "manutencao").length}</strong></div>
            <div class="summary-item"><span>Consumo mediano da frota</span><strong>${efficiencies.length ? `${number(Frotas.util.median(efficiencies), 1)} km/L` : "—"}</strong></div>
          </div>
          <div class="tab-bar">${tabs.map(([value, label]) => `<button class="tab${vehicleFilter === value ? " active" : ""}" data-action="vehicle-tab" data-value="${value}">${label}</button>`).join("")}</div>
          ${table({
            id: "vehicles",
            rows: list,
            pageSize: 25,
            rowAttrs: (vehicle) => `class="clickable-row" data-action="open-vehicle" data-id="${esc(vehicle.id)}"`,
            columns: [
              { label: "Veículo", render: (vehicle) => vehicleCell(vehicle), sortValue: (vehicle) => vehicle.name },
              { label: "Responsável", render: (vehicle) => esc(vehicle.responsible || "—") },
              { label: "Km atual", align: "right", render: (vehicle) => { const stat = store.stats(vehicle.id); return stat?.currentKm ? `${number(stat.currentKm)}<small class="cell-sub">${dateBR(stat.currentKmDate)}</small>` : "—"; }, sortValue: (vehicle) => store.stats(vehicle.id)?.currentKm || 0 },
              { label: "Consumo", align: "right", render: (vehicle) => { const value = store.stats(vehicle.id)?.kmPerLiter; return value ? `${number(value, 1)} km/L` : "—"; }, sortValue: (vehicle) => store.stats(vehicle.id)?.kmPerLiter || 0 },
              { label: "Custo/km", align: "right", render: (vehicle) => { const value = store.stats(vehicle.id)?.costPerKm; return value ? money(value) : "—"; }, sortValue: (vehicle) => store.stats(vehicle.id)?.costPerKm || 0 },
              { label: "Gasto total", align: "right", render: (vehicle) => money(store.stats(vehicle.id)?.total), sortValue: (vehicle) => store.stats(vehicle.id)?.total || 0 },
              { label: "Documentos", render: documentStatus, sortable: false },
              { label: "Situação", render: vehicleStatus },
            ],
          })}
        </section>`;
    },
  };

  // ---------- Ficha do veículo ----------

  Frotas.views.veiculo = {
    title: "Ficha do veículo",
    section: "Operação · Veículos",
    hidden: true,
    render(params) {
      const vehicle = store.vehicleById(params?.id);
      if (!vehicle) return empty("Veículo não encontrado", "Ele pode ter sido removido.", `<button class="secondary-button" data-action="go" data-view="veiculos">Voltar</button>`);
      const stat = store.stats(vehicle.id);
      const movements = store.movements().filter((movement) => movement.vehicleId === vehicle.id);
      const maintenance = store.list("maintenance").filter((item) => item.vehicleId === vehicle.id);
      const vehicleIssues = store.issues().filter((issue) => issue.vehicle === store.vehicleLabel(vehicle));
      const can = Frotas.auth.can("cadastros");
      return `
        <div class="page-intro">
          <div class="vehicle-header">
            ${vehicleCell(vehicle)}
            <div class="vehicle-tags">${vehicleStatus(vehicle)} ${documentStatus(vehicle)}</div>
          </div>
          <div class="toolbar-group">
            <button class="secondary-button" data-action="go" data-view="veiculos">Voltar</button>
            ${Frotas.auth.can("lancar") ? `<button class="secondary-button" data-action="new-expense" data-vehicle="${esc(vehicle.id)}">Lançar despesa</button><button class="primary-button" data-action="new-fuel" data-vehicle="${esc(vehicle.id)}">Novo abastecimento</button>` : ""}
          </div>
        </div>
        <section class="metric-grid">
          ${C.metric({ label: "Gasto total registrado", icon: "R$", value: money(stat.total), note: `${movements.length} lançamentos`, accent: true })}
          ${C.metric({ label: "Combustível", icon: "⛽", value: money(stat.fuelTotal), note: `${stat.fuelCount} abastecimentos · ${number(stat.liters, 0)} L` })}
          ${C.metric({ label: "Consumo médio", icon: "km/L", value: stat.kmPerLiter ? `${number(stat.kmPerLiter, 1)} km/L` : "—", note: stat.costPerKm ? `${money(stat.costPerKm)} por km` : "Leituras de km insuficientes" })}
          ${C.metric({ label: "Quilometragem atual", icon: "km", value: stat.currentKm ? number(stat.currentKm) : "—", note: stat.currentKmDate ? `Último registro em ${dateBR(stat.currentKmDate)}` : "Sem registro" })}
        </section>
        <section class="dashboard-grid">
          <article class="panel">
            <div class="panel-heading"><div><h4>Consumo ao longo do tempo</h4><p>km/L calculado entre abastecimentos consecutivos com leituras válidas</p></div></div>
            <div class="chart-box">${stat.efficiencySeries.length > 1 ? `<canvas id="chart-efficiency"></canvas>` : empty("Dados insuficientes", "São necessários pelo menos dois abastecimentos com quilometragem válida.")}</div>
          </article>
          <aside class="panel">
            <div class="panel-heading"><div><h4>Cadastro</h4><p>Dados e prazos</p></div>${can ? `<button class="text-button" data-action="edit-vehicles" data-id="${esc(vehicle.id)}">Editar</button>` : ""}</div>
            <dl class="detail-list">
              <div><dt>Tipo</dt><dd>${esc(vehicle.type)} · ${esc(vehicle.fuelType || "—")}</dd></div>
              <div><dt>Vínculo</dt><dd>${vehicle.scope === "frota" ? "Frota própria" : "Autorizado"}</dd></div>
              <div><dt>Responsável</dt><dd>${esc(vehicle.responsible || "—")}</dd></div>
              <div><dt>Ano</dt><dd>${esc(vehicle.year || "—")}</dd></div>
              <div><dt>Licenciamento</dt><dd>${dateBR(vehicle.licensingDue)}</dd></div>
              <div><dt>Seguro</dt><dd>${dateBR(vehicle.insuranceDue)}</dd></div>
              <div><dt>Próxima revisão</dt><dd>${vehicle.nextServiceKm ? `${number(vehicle.nextServiceKm)} km` : "—"}${vehicle.nextServiceDate ? ` · ${dateBR(vehicle.nextServiceDate)}` : ""}</dd></div>
              <div><dt>Manutenção</dt><dd>${money(stat.maintenanceTotal)}</dd></div>
            </dl>
            ${vehicleIssues.length ? `<button class="issue-callout" data-action="go" data-view="qualidade">${vehicleIssues.length} inconsistência(s) nos lançamentos deste veículo ›</button>` : ""}
          </aside>
        </section>
        <section class="panel spaced">
          <div class="panel-heading"><div><h4>Histórico de lançamentos</h4><p>Abastecimentos e despesas</p></div></div>
          ${table({
            id: `vehicle-history`,
            rows: movements,
            pageSize: 12,
            columns: [
              { label: "Data", render: (item) => dateBR(item.date), sortValue: (item) => item.date },
              { label: "Tipo", render: (item) => esc(item.category) },
              { label: "Descrição", render: (item) => `${esc(item.description || "—")} ${item.source === "planilha" ? `<span class="source-tag">planilha</span>` : ""}` },
              { label: "Fornecedor", render: (item) => esc(item.supplier || "—") },
              { label: "Valor", align: "right", render: (item) => money(item.value), sortValue: (item) => item.value },
            ],
          })}
        </section>
        ${maintenance.length ? `
        <section class="panel spaced">
          <div class="panel-heading"><div><h4>Manutenções programadas</h4></div></div>
          <div class="table-wrap"><table class="data-table"><thead><tr><th>Serviço</th><th>Previsão</th><th>Situação</th></tr></thead><tbody>
            ${maintenance.map((item) => `<tr><td>${esc(item.service)}</td><td>${dateBR(item.scheduledDate)}${item.scheduledKm ? ` · ${number(item.scheduledKm)} km` : ""}</td><td>${maintenanceStatus(item)}</td></tr>`).join("")}
          </tbody></table></div>
        </section>` : ""}`;
    },
    mount(params) {
      const stat = store.stats(params?.id);
      if (!stat || stat.efficiencySeries.length < 2) return;
      // Abastecimentos parciais fazem o km/L oscilar; a média móvel de 4 leituras mostra a tendência real.
      const series = stat.efficiencySeries;
      const smoothed = series.map((_, index) => {
        const window = series.slice(Math.max(0, index - 3), index + 1);
        return sum(window, (point) => point.kmPerLiter) / window.length;
      });
      C.chart("chart-efficiency", {
        type: "line",
        data: {
          labels: series.map((point) => dateBR(point.date).slice(0, 5)),
          datasets: [
            { label: "Média móvel (km/L)", data: smoothed, borderColor: C.COLORS.line, backgroundColor: "rgba(74,70,80,.14)", fill: true, tension: 0.35, pointRadius: 0, borderWidth: 3 },
            { label: "Leitura individual", data: series.map((point) => point.kmPerLiter), borderColor: "transparent", backgroundColor: C.COLORS.other, pointRadius: 3, showLine: false },
          ],
        },
        options: { ...C.barOptions({ money: false, legend: true }), scales: { x: { grid: { display: false } }, y: { grid: { color: "#ebe9ee" }, title: { display: true, text: "km/L" } } } },
      });
    },
  };

  // ---------- Motoristas ----------

  const CNH_CATEGORIES = ["A", "B", "AB", "C", "D", "E", "AC", "AD", "AE"];

  function maskCpf(cpf) {
    const digits = String(cpf || "").replace(/\D/g, "");
    return digits.length === 11 ? `${digits.slice(0, 3)}.***.***-${digits.slice(9)}` : "—";
  }

  function validCpf(cpf) {
    const digits = String(cpf || "").replace(/\D/g, "");
    if (digits.length !== 11 || /^(\d)\1{10}$/.test(digits)) return false;
    const check = (length) => {
      const total = digits.slice(0, length).split("").reduce((acc, digit, index) => acc + Number(digit) * (length + 1 - index), 0);
      const rest = (total * 10) % 11;
      return rest === 10 ? 0 : rest;
    };
    return check(9) === Number(digits[9]) && check(10) === Number(digits[10]);
  }

  function cnhStatus(driver) {
    if (!driver.cnhDue) return status("Validade não informada", "neutral");
    const days = daysBetween(todayISO(), driver.cnhDue);
    if (days < 0) return status("CNH vencida", "danger");
    if (days <= store.get().settings.alertDays) return status(`Vence em ${days} d`, "warning");
    return status("Regular");
  }

  function driverForm(driver = null) {
    openForm({
      eyebrow: driver ? "Editar cadastro" : "Novo cadastro",
      title: driver ? `Editar ${driver.name}` : "Cadastrar motorista",
      values: driver ? { ...driver } : { active: true },
      fields: [
        { name: "name", label: "Nome completo", required: true, full: true },
        { name: "cpf", label: "CPF", placeholder: "000.000.000-00" },
        { name: "phone", label: "Telefone", placeholder: "(81) 90000-0000" },
        { name: "cnhNumber", label: "Número da CNH" },
        { name: "cnhCategory", label: "Categoria", type: "select", options: CNH_CATEGORIES },
        { name: "cnhDue", label: "Validade da CNH", type: "date", required: true },
        { name: "vehicleId", label: "Veículo habitual", type: "select", options: C.vehicleOptions(), placeholder: "Nenhum" },
        { name: "notes", label: "Observações", type: "textarea", full: true },
        { name: "active", label: "Motorista ativo", type: "checkbox", full: true },
      ],
      async onSubmit(data) {
        if (data.cpf && !validCpf(data.cpf)) throw new Error("CPF inválido. Confira os números.");
        if (data.cpf) {
          const digits = data.cpf.replace(/\D/g, "");
          const duplicate = store.list("drivers").find((item) => item.cpf === digits && item.id !== driver?.id);
          if (duplicate) throw new Error(`Este CPF já está cadastrado (${duplicate.name}).`);
          data.cpf = digits;
        }
        if (driver) store.update("drivers", driver.id, data, data.name);
        else store.create("drivers", data, data.name);
        toast(driver ? "Cadastro atualizado." : "Motorista cadastrado.");
      },
    });
  }

  Frotas.views.motoristas = {
    title: "Motoristas",
    section: "Operação",
    render() {
      const drivers = store.list("drivers");
      const active = drivers.filter((driver) => driver.active !== false);
      const expiring = active.filter((driver) => driver.cnhDue && daysBetween(todayISO(), driver.cnhDue) <= store.get().settings.alertDays);
      return `
        ${C.pageIntro("Motoristas", "Condutores autorizados e validade da CNH.", Frotas.auth.can("cadastros") ? `<button class="primary-button" data-action="new-driver">Cadastrar motorista</button>` : "")}
        <section class="panel module-panel">
          <div class="summary-strip">
            <div class="summary-item"><span>Motoristas ativos</span><strong>${active.length}</strong></div>
            <div class="summary-item"><span>CNH vencida ou a vencer</span><strong class="${expiring.length ? "text-warning" : ""}">${expiring.length}</strong></div>
            <div class="summary-item"><span>Sem validade informada</span><strong>${active.filter((driver) => !driver.cnhDue).length}</strong></div>
          </div>
          ${drivers.length ? table({
            id: "drivers",
            rows: drivers,
            columns: [
              { label: "Motorista", render: (driver) => personCell(driver.name, driver.phone || "Sem telefone"), sortValue: (driver) => driver.name },
              { label: "CPF", render: (driver) => maskCpf(driver.cpf), sortable: false },
              { label: "Categoria", render: (driver) => esc(driver.cnhCategory || "—") },
              { label: "Validade CNH", render: (driver) => dateBR(driver.cnhDue), sortValue: (driver) => driver.cnhDue || "9999" },
              { label: "Veículo habitual", render: (driver) => esc(driver.vehicleId ? store.vehicleLabel(store.vehicleById(driver.vehicleId)) : "—") },
              { label: "Situação", render: (driver) => (driver.active === false ? status("Inativo", "neutral") : cnhStatus(driver)) },
              { label: "", sortable: false, render: (driver) => rowActions("drivers", driver) },
            ],
          }) : empty("Nenhum motorista cadastrado", "Cadastre os condutores com a validade da CNH para receber alertas automáticos de vencimento.", Frotas.auth.can("cadastros") ? `<button class="primary-button" data-action="new-driver">Cadastrar o primeiro motorista</button>` : "")}
        </section>`;
    },
  };

  // ---------- Abastecimentos ----------

  let fuelVehicleFilter = "";

  function flaggedIds() {
    return new Map(store.issues().map((issue) => [issue.recordId, issue]));
  }

  Frotas.views.abastecimentos = {
    title: "Abastecimentos",
    section: "Operação",
    render() {
      const range = C.periodRange();
      const scope = C.filters.scope;
      const flags = flaggedIds();
      const entries = store.list("fuel")
        .filter((entry) => C.inRange(entry.date, range))
        .filter((entry) => C.matchScope(scope, store.vehicleById(entry.vehicleId) || {}))
        .filter((entry) => !fuelVehicleFilter || entry.vehicleId === fuelVehicleFilter)
        .sort((a, b) => b.date.localeCompare(a.date));
      const validLiters = entries.filter((entry) => entry.liters > 0 && entry.liters < 400);
      const liters = sum(validLiters, (entry) => entry.liters);
      const vehicleSelect = `<label>Veículo<select data-action-change="fuel-vehicle"><option value="">Todos</option>${Frotas.ui.optionList(C.vehicleOptions({ includeInactive: true, scope }), fuelVehicleFilter)}</select></label>`;
      return `
        ${C.pageIntro("Abastecimentos", "Registro de consumo com conferência automática de quilometragem e preço por litro.", Frotas.auth.can("lancar") ? `<button class="primary-button" data-action="new-fuel">Novo abastecimento</button>` : "")}
        ${C.filterBar({ extra: vehicleSelect })}
        <section class="panel module-panel">
          <div class="summary-strip summary-4">
            <div class="summary-item"><span>Lançamentos</span><strong>${entries.length}</strong></div>
            <div class="summary-item"><span>Litros</span><strong>${number(liters, 1)} L</strong></div>
            <div class="summary-item"><span>Valor</span><strong>${money(sum(entries, (entry) => entry.value))}</strong></div>
            <div class="summary-item"><span>Preço médio</span><strong>${liters ? `${money(sum(validLiters, (entry) => entry.value) / liters)}/L` : "—"}</strong></div>
          </div>
          ${table({
            id: "fuel",
            rows: entries,
            columns: [
              { label: "Data", render: (entry) => dateBR(entry.date), sortValue: (entry) => entry.date },
              { label: "Veículo", render: (entry) => vehicleCell(store.vehicleById(entry.vehicleId)), sortValue: (entry) => store.vehicleById(entry.vehicleId)?.name || "" },
              { label: "Km", align: "right", render: (entry) => (entry.km ? number(entry.km) : "—"), sortValue: (entry) => entry.km || 0 },
              { label: "Litros", align: "right", render: (entry) => (entry.liters ? number(entry.liters, 2) : "—"), sortValue: (entry) => entry.liters || 0 },
              { label: "R$/L", align: "right", render: (entry) => (entry.liters > 0 ? money(entry.value / entry.liters) : "—"), sortValue: (entry) => (entry.liters > 0 ? entry.value / entry.liters : 0) },
              { label: "Valor", align: "right", render: (entry) => money(entry.value), sortValue: (entry) => entry.value },
              { label: "Posto", render: (entry) => `${esc(entry.supplier || "—")} ${sourceBadge(entry)}` },
              { label: "Conferência", render: (entry) => { const issue = flags.get(entry.id); return issue ? `<button class="status ${issue.severity} as-button" data-action="go" data-view="qualidade" title="${esc(issue.detail)}">${esc(issue.type)}</button>` : status("OK"); }, sortValue: (entry) => (flags.has(entry.id) ? 0 : 1) },
              { label: "", sortable: false, render: (entry) => rowActions("fuel", entry) },
            ],
          })}
        </section>`;
    },
  };

  // ---------- Despesas ----------

  let expenseCategoryFilter = "";

  Frotas.views.despesas = {
    title: "Despesas",
    section: "Operação",
    render() {
      const range = C.periodRange();
      const scope = C.filters.scope;
      const entries = store.list("expenses")
        .filter((entry) => C.inRange(entry.date, range))
        .filter((entry) => C.matchScope(scope, store.vehicleById(entry.vehicleId) || {}))
        .filter((entry) => !expenseCategoryFilter || entry.category === expenseCategoryFilter)
        .sort((a, b) => b.date.localeCompare(a.date));
      const maintenance = entries.filter((entry) => store.MAINTENANCE_CATEGORIES.has(entry.category));
      const categorySelect = `<label>Categoria<select data-action-change="expense-category"><option value="">Todas</option>${Frotas.ui.optionList(store.EXPENSE_CATEGORIES, expenseCategoryFilter)}</select></label>`;
      return `
        ${C.pageIntro("Despesas", "Oficina, peças, documentação, lavagem e demais custos por veículo.", Frotas.auth.can("lancar") ? `<button class="primary-button" data-action="new-expense">Lançar despesa</button>` : "")}
        ${C.filterBar({ extra: categorySelect })}
        <section class="panel module-panel">
          <div class="summary-strip summary-4">
            <div class="summary-item"><span>Despesas</span><strong>${entries.length}</strong></div>
            <div class="summary-item"><span>Total</span><strong>${money(sum(entries, (entry) => entry.value))}</strong></div>
            <div class="summary-item"><span>Manutenção (oficina, peças, pneus)</span><strong>${money(sum(maintenance, (entry) => entry.value))}</strong></div>
            <div class="summary-item"><span>Maior despesa</span><strong>${entries.length ? money(Math.max(...entries.map((entry) => entry.value))) : "—"}</strong></div>
          </div>
          ${table({
            id: "expenses",
            rows: entries,
            columns: [
              { label: "Data", render: (entry) => dateBR(entry.date), sortValue: (entry) => entry.date },
              { label: "Veículo", render: (entry) => vehicleCell(store.vehicleById(entry.vehicleId)), sortValue: (entry) => store.vehicleById(entry.vehicleId)?.name || "" },
              { label: "Categoria", render: (entry) => esc(entry.category) },
              { label: "Descrição", render: (entry) => `${esc(entry.description || "—")} ${sourceBadge(entry)}` },
              { label: "Fornecedor", render: (entry) => esc(entry.supplier || "—") },
              { label: "Valor", align: "right", render: (entry) => money(entry.value), sortValue: (entry) => entry.value },
              { label: "", sortable: false, render: (entry) => rowActions("expenses", entry) },
            ],
          })}
        </section>`;
    },
  };

  // ---------- Manutenções ----------

  const MAINTENANCE_STATUS = {
    agendada: ["Agendada", "neutral"],
    em_execucao: ["Em execução", "warning"],
    concluida: ["Concluída", "success"],
    cancelada: ["Cancelada", "neutral"],
  };

  function maintenanceStatus(item) {
    if (item.status === "agendada" && item.scheduledDate && item.scheduledDate < todayISO()) return status("Atrasada", "danger");
    const [label, type] = MAINTENANCE_STATUS[item.status] || ["—", "neutral"];
    return status(label, type);
  }

  function maintenanceForm(item = null, presetVehicleId = "") {
    openForm({
      eyebrow: item ? "Editar agendamento" : "Agenda de manutenção",
      title: item ? "Editar manutenção" : "Agendar manutenção",
      values: item ? { ...item } : { type: "preventiva", vehicleId: presetVehicleId, scheduledDate: addDays(todayISO(), 7) },
      fields: [
        { name: "vehicleId", label: "Veículo", type: "select", required: true, options: C.vehicleOptions({ scope: "frota" }), full: true },
        { name: "type", label: "Tipo", type: "select", placeholder: false, options: [{ value: "preventiva", label: "Preventiva (revisão programada)" }, { value: "corretiva", label: "Corretiva (conserto)" }] },
        { name: "service", label: "Serviço", required: true, placeholder: "Ex.: Revisão de 10.000 km" },
        { name: "scheduledDate", label: "Data prevista", type: "date", required: true },
        { name: "scheduledKm", label: "Quilometragem prevista", type: "number", min: 0 },
        { name: "supplier", label: "Oficina / fornecedor", full: true },
        { name: "notes", label: "Observações", type: "textarea", full: true },
      ],
      submitLabel: item ? "Salvar" : "Agendar",
      async onSubmit(data) {
        const record = { ...data, scheduledKm: data.scheduledKm || null };
        const description = `${data.service} · ${store.vehicleLabel(store.vehicleById(data.vehicleId))}`;
        if (item) store.update("maintenance", item.id, record, description);
        else store.create("maintenance", { ...record, status: "agendada" }, description);
        toast(item ? "Manutenção atualizada." : "Manutenção agendada.");
      },
    });
  }

  function completeMaintenanceForm(item) {
    const vehicle = store.vehicleById(item.vehicleId);
    const interval = store.get().settings.serviceIntervalKm;
    openForm({
      eyebrow: "Concluir manutenção",
      title: item.service,
      intro: `<p>${esc(store.vehicleLabel(vehicle))}. O valor informado é lançado automaticamente em Despesas.</p>`,
      values: { doneDate: todayISO(), supplier: item.supplier, doneKm: store.stats(item.vehicleId)?.currentKm || "" },
      fields: [
        { name: "doneDate", label: "Data de conclusão", type: "date", required: true, max: todayISO() },
        { name: "doneKm", label: "Quilometragem na conclusão", type: "number", min: 0 },
        { name: "cost", label: "Custo total (R$)", type: "decimal", required: true },
        { name: "category", label: "Categoria da despesa", type: "select", placeholder: false, options: ["Oficina", "Peças", "Borracharia"] },
        { name: "supplier", label: "Oficina / fornecedor" },
        { name: "scheduleNext", label: `Programar próxima revisão (+${number(interval)} km e +6 meses)`, type: "checkbox", full: true },
      ],
      submitLabel: "Concluir e lançar despesa",
      async onSubmit(data) {
        const expense = store.create("expenses", {
          vehicleId: item.vehicleId, date: data.doneDate, category: data.category || "Oficina", description: item.service,
          supplier: data.supplier, value: data.cost || 0, note: `Manutenção ${item.type}`, attachment: "", maintenanceId: item.id,
        }, `${item.service} · ${money(data.cost || 0)}`);
        store.update("maintenance", item.id, { status: "concluida", doneDate: data.doneDate, doneKm: data.doneKm || null, cost: data.cost || 0, supplier: data.supplier, expenseId: expense.id }, `Concluída · ${item.service}`);
        if (vehicle && (data.scheduleNext || vehicle.status === "manutencao")) {
          const changes = vehicle.status === "manutencao" ? { status: "ativo" } : {};
          if (data.scheduleNext) {
            changes.nextServiceKm = data.doneKm ? data.doneKm + interval : vehicle.nextServiceKm;
            changes.nextServiceDate = addDays(data.doneDate, 182);
          }
          store.update("vehicles", vehicle.id, changes, `Pós-manutenção · ${vehicle.name}`);
        }
        toast("Manutenção concluída e despesa lançada.");
      },
    });
  }

  Frotas.views.manutencoes = {
    title: "Manutenções",
    section: "Operação",
    render() {
      const items = store.list("maintenance");
      const open = items.filter((item) => item.status === "agendada" || item.status === "em_execucao").sort((a, b) => (a.scheduledDate || "").localeCompare(b.scheduledDate || ""));
      const done = items.filter((item) => item.status === "concluida" || item.status === "cancelada").sort((a, b) => (b.doneDate || "").localeCompare(a.doneDate || ""));
      const workshopHistory = store.list("expenses").filter((entry) => store.MAINTENANCE_CATEGORIES.has(entry.category)).sort((a, b) => b.date.localeCompare(a.date));
      const plan = store.list("vehicles").filter((vehicle) => vehicle.scope === "frota" && vehicle.status !== "inativo");
      const can = Frotas.auth.can("cadastros");
      return `
        ${C.pageIntro("Manutenções", "Agenda preventiva, serviços em andamento e histórico de oficina.", can ? `<button class="primary-button" data-action="new-maintenance">Agendar manutenção</button>` : "")}
        <section class="metric-grid">
          ${C.metric({ label: "Agendadas", icon: "📅", value: String(open.filter((item) => item.status === "agendada").length), note: `${open.filter((item) => item.status === "agendada" && item.scheduledDate < todayISO()).length} em atraso` })}
          ${C.metric({ label: "Em execução", icon: "⚙", value: String(open.filter((item) => item.status === "em_execucao").length), note: "Veículos na oficina" })}
          ${C.metric({ label: "Gasto com oficina (12 meses)", icon: "R$", value: money(sum(workshopHistory.filter((entry) => C.inRange(entry.date, C.periodRange("12m"))), (entry) => entry.value)), note: `${workshopHistory.length} serviços no histórico`, accent: true })}
          ${C.metric({ label: "Revisões por km programadas", icon: "km", value: String(plan.filter((vehicle) => vehicle.nextServiceKm).length), note: `de ${plan.length} veículos da frota` })}
        </section>
        <section class="panel spaced">
          <div class="panel-heading"><div><h4>Agenda</h4><p>Manutenções agendadas e em execução</p></div></div>
          ${open.length ? table({
            id: "maintenance-open",
            rows: open,
            columns: [
              { label: "Veículo", render: (item) => vehicleCell(store.vehicleById(item.vehicleId)) },
              { label: "Serviço", render: (item) => `${esc(item.service)}<small class="cell-sub">${item.type === "preventiva" ? "Preventiva" : "Corretiva"}</small>` },
              { label: "Previsão", render: (item) => `${dateBR(item.scheduledDate)}${item.scheduledKm ? `<small class="cell-sub">${number(item.scheduledKm)} km</small>` : ""}`, sortValue: (item) => item.scheduledDate },
              { label: "Oficina", render: (item) => esc(item.supplier || "—") },
              { label: "Situação", render: maintenanceStatus },
              { label: "", sortable: false, render: (item) => can ? `<div class="row-actions">
                  ${item.status === "agendada" ? `<button class="secondary-button small" data-action="start-maintenance" data-id="${esc(item.id)}">Iniciar</button>` : ""}
                  <button class="primary-button small" data-action="complete-maintenance" data-id="${esc(item.id)}">Concluir</button>
                  <button class="icon-action" data-action="edit-maintenance" data-id="${esc(item.id)}" title="Editar">✎</button>
                  <button class="icon-action danger" data-action="cancel-maintenance" data-id="${esc(item.id)}" title="Cancelar">✕</button>
                </div>` : "" },
            ],
          }) : empty("Nenhuma manutenção agendada", "Agende revisões preventivas para receber alertas antes do prazo.")}
        </section>
        <section class="panel spaced">
          <div class="panel-heading"><div><h4>Plano de revisões por quilometragem</h4><p>Compara a próxima revisão cadastrada com o último km registrado</p></div></div>
          ${table({
            id: "maintenance-plan",
            rows: plan,
            pageSize: 25,
            columns: [
              { label: "Veículo", render: (vehicle) => vehicleCell(vehicle), sortValue: (vehicle) => vehicle.name },
              { label: "Km atual", align: "right", render: (vehicle) => number(store.stats(vehicle.id)?.currentKm), sortValue: (vehicle) => store.stats(vehicle.id)?.currentKm || 0 },
              { label: "Próxima revisão", align: "right", render: (vehicle) => (vehicle.nextServiceKm ? `${number(vehicle.nextServiceKm)} km` : "—") },
              { label: "Faltam", align: "right", render: (vehicle) => { const current = store.stats(vehicle.id)?.currentKm; if (!vehicle.nextServiceKm || !current) return "—"; const remaining = vehicle.nextServiceKm - current; return remaining <= 0 ? status(`Atrasada ${number(-remaining)} km`, "danger") : remaining <= 1000 ? status(`${number(remaining)} km`, "warning") : `${number(remaining)} km`; }, sortValue: (vehicle) => { const current = store.stats(vehicle.id)?.currentKm; return vehicle.nextServiceKm && current ? vehicle.nextServiceKm - current : 999999; } },
              { label: "Data prevista", render: (vehicle) => dateBR(vehicle.nextServiceDate) },
              { label: "", sortable: false, render: (vehicle) => can ? `<button class="text-button" data-action="edit-vehicles" data-id="${esc(vehicle.id)}">Definir revisão</button>` : "" },
            ],
          })}
        </section>
        <section class="panel spaced">
          <div class="panel-heading"><div><h4>Histórico de oficina, peças e borracharia</h4><p>Inclui os serviços importados da planilha</p></div></div>
          ${table({
            id: "maintenance-history",
            rows: workshopHistory,
            pageSize: 15,
            columns: [
              { label: "Data", render: (entry) => dateBR(entry.date), sortValue: (entry) => entry.date },
              { label: "Veículo", render: (entry) => vehicleCell(store.vehicleById(entry.vehicleId)), sortValue: (entry) => store.vehicleById(entry.vehicleId)?.name || "" },
              { label: "Serviço", render: (entry) => esc(entry.description) },
              { label: "Categoria", render: (entry) => esc(entry.category) },
              { label: "Valor", align: "right", render: (entry) => money(entry.value), sortValue: (entry) => entry.value },
            ],
          })}
        </section>
        ${done.length ? `<p class="footnote">${done.length} manutenção(ões) concluída(s) ou cancelada(s) pelo sistema.</p>` : ""}`;
    },
  };

  // ---------- Ações das telas de operação ----------

  const COLLECTION_FORMS = { fuel: fuelForm, expenses: expenseForm, vehicles: vehicleForm, drivers: driverForm, maintenance: maintenanceForm };
  const COLLECTION_NAMES = { fuel: "abastecimento", expenses: "despesa", vehicles: "veículo", drivers: "motorista", maintenance: "manutenção" };

  async function deleteRecord(collection, id) {
    const item = store.find(collection, id);
    if (!item) return;
    if (collection === "vehicles") {
      const used = store.movements().some((movement) => movement.vehicleId === id);
      if (used) {
        toast("Este veículo possui lançamentos. Para preservar o histórico, altere a situação para Inativo.", "warning");
        return;
      }
    }
    const ok = await confirm(`Excluir este ${COLLECTION_NAMES[collection]}? A exclusão fica registrada na auditoria.`, { title: "Excluir registro", confirmLabel: "Excluir", danger: true });
    if (!ok) return;
    const label = collection === "fuel" || collection === "expenses"
      ? `${store.vehicleLabel(store.vehicleById(item.vehicleId))} · ${dateBR(item.date)} · ${money(item.value)}`
      : item.name || item.service || id;
    store.remove(collection, id, label);
    toast("Registro excluído.");
  }

  Frotas.actions = Object.assign(Frotas.actions || {}, {
    "new-fuel": (button) => fuelForm(null, button.dataset.vehicle || ""),
    "new-expense": (button) => expenseForm(null, button.dataset.vehicle || ""),
    "new-vehicle": () => vehicleForm(),
    "new-driver": () => driverForm(),
    "new-maintenance": (button) => maintenanceForm(null, button.dataset.vehicle || ""),
    "open-vehicle": (button) => Frotas.app.go("veiculo", { id: button.dataset.id }),
    "vehicle-tab": (button) => { vehicleFilter = button.dataset.value; Frotas.ui.resetPages(); Frotas.app.refresh(); },
    "open-attachment": (button) => {
      const item = store.find("fuel", button.dataset.id) || store.find("expenses", button.dataset.id);
      openAttachment(item?.attachment);
    },
    "start-maintenance": (button) => {
      const item = store.find("maintenance", button.dataset.id);
      store.update("maintenance", item.id, { status: "em_execucao", startedAt: todayISO() }, `Iniciada · ${item.service}`);
      const vehicle = store.vehicleById(item.vehicleId);
      if (vehicle && vehicle.status === "ativo") store.update("vehicles", vehicle.id, { status: "manutencao" }, `${vehicle.name} em manutenção`);
      toast("Manutenção iniciada. O veículo foi marcado como em manutenção.");
    },
    "complete-maintenance": (button) => {
      completeMaintenanceForm(store.find("maintenance", button.dataset.id));
    },
    "cancel-maintenance": async (button) => {
      const item = store.find("maintenance", button.dataset.id);
      if (await confirm(`Cancelar "${item.service}"?`, { title: "Cancelar manutenção", confirmLabel: "Cancelar manutenção", danger: true })) {
        store.update("maintenance", item.id, { status: "cancelada", doneDate: todayISO() }, `Cancelada · ${item.service}`);
      }
    },
  });

  Object.keys(COLLECTION_FORMS).forEach((collection) => {
    Frotas.actions[`edit-${collection}`] = (button) => COLLECTION_FORMS[collection](store.find(collection, button.dataset.id));
    Frotas.actions[`delete-${collection}`] = (button) => deleteRecord(collection, button.dataset.id);
  });

  Frotas.changeActions = Object.assign(Frotas.changeActions || {}, {
    "fuel-vehicle": (select) => { fuelVehicleFilter = select.value; Frotas.ui.resetPages(); Frotas.app.refresh(); },
    "expense-category": (select) => { expenseCategoryFilter = select.value; Frotas.ui.resetPages(); Frotas.app.refresh(); },
  });

  Frotas.forms = { fuelForm, expenseForm, vehicleForm, driverForm, maintenanceForm, duplicateByKey, openAttachment };
})();
