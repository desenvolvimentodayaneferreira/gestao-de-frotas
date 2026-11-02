"use strict";

// Camada de dados: guarda, carrega e calcula tudo o que o sistema exibe.
Frotas.store = (() => {
  const { uid, extractPlate, formatPlate, todayISO, daysBetween, groupBy, sum, median, normalizeText } = Frotas.util;

  const SCHEMA_VERSION = 1;
  const LOCAL_KEY = "gestao-frotas:v1";

  const EXPENSE_CATEGORIES = [
    "Oficina", "Peças", "Borracharia", "Lava Jato", "Produtos", "Documentação", "Seguro", "Multa", "Pedágio", "Diversos",
  ];
  const MAINTENANCE_CATEGORIES = new Set(["Oficina", "Peças", "Borracharia"]);
  const VEHICLE_TYPES = ["Carro", "Utilitário", "Moto", "Caminhão", "Outro"];
  const FUEL_TYPES = ["Gasolina", "Etanol", "Diesel", "Flex", "Elétrico"];

  let db = null;
  let saveTimer = null;
  let lastSaveError = null;
  const listeners = new Set();

  function emptyDb() {
    return {
      version: SCHEMA_VERSION,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      settings: {
        company: "Minha Empresa",
        city: "Surubim - PE",
        base: { lat: -7.8331, lng: -35.7548 },
        areaRadiusKm: 40,
        fuelPriceMin: 4.5,
        fuelPriceMax: 8.5,
        alertDays: 30,
        serviceIntervalKm: 10000,
        gps: { mode: "off", provider: "", portalUrl: "", url: "", token: "", intervalSec: 60, lastSync: null, lastError: "" },
        // Endereço do aplicativo do celular (hospedado na internet); as chaves ficam no cofre do computador.
        notes: { phoneAppUrl: "", lastSync: null, lastError: "" },
      },
      users: [],
      vehicles: [],
      drivers: [],
      fuel: [],
      expenses: [],
      maintenance: [],
      inbox: [], // notas recebidas do celular aguardando conferência
      audit: [],
      reviewedIssues: [],
      importInfo: null,
    };
  }

  // ---------- Importação inicial da planilha "Gestão de Dados" ----------

  function prettifyName(label) {
    return String(label || "")
      .replace(/\(?\s*\b[A-Z]{3}-?\d[A-Z0-9]\d{2}\b\s*\)?/g, "")
      .replace(/\s+-\s*$/, "")
      .replace(/([a-zà-ú])([A-Z])/g, "$1 $2")
      .replace(/\s{2,}/g, " ")
      .replace(/[\s-]+$/, "")
      .trim();
  }

  function guessType(label) {
    const text = normalizeText(label);
    if (/\bmoto\b/.test(text)) return "Moto";
    if (/iveco|caminh/.test(text)) return "Caminhão";
    if (/fiorino|saveiro|montana|s10|strada|furg|toro|hilux/.test(text)) return "Utilitário";
    return "Carro";
  }

  function importSpreadsheet(target, source) {
    const records = source?.records || [];
    const vehiclesByKey = new Map();

    const vehicleFor = (record) => {
      const label = record.vehicle || "Veículo não informado";
      const plate = extractPlate(label);
      const key = plate || `${record.scope}:${normalizeText(prettifyName(label))}`;
      if (!vehiclesByKey.has(key)) {
        const name = prettifyName(label) || label;
        const isAuthorized = record.scope === "autorizado";
        const motoOwner = name.match(/^moto\s+(.+)$/i);
        vehiclesByKey.set(key, {
          id: uid("vei"),
          name: isAuthorized ? `Veículo de ${name}` : name,
          plate,
          type: guessType(label),
          scope: isAuthorized ? "autorizado" : "frota",
          responsible: isAuthorized ? name : motoOwner ? motoOwner[1] : "",
          year: "",
          fuelType: guessType(label) === "Moto" ? "Gasolina" : "Flex",
          tankLiters: null,
          status: "ativo",
          licensingDue: "",
          insuranceDue: "",
          nextServiceKm: null,
          nextServiceDate: "",
          notes: "",
          aliases: [label],
          createdAt: Date.now(),
        });
      }
      const vehicle = vehiclesByKey.get(key);
      if (!vehicle.aliases.includes(label)) vehicle.aliases.push(label);
      if (vehicle.scope === "autorizado") {
        const person = prettifyName(label);
        const people = new Set(vehicle.responsible.split(", ").filter(Boolean));
        people.add(person);
        vehicle.responsible = [...people].join(", ");
      }
      return vehicle;
    };

    records.forEach((record) => {
      const vehicle = vehicleFor(record);
      const base = {
        id: uid(record.type === "abastecimento" ? "abs" : "dsp"),
        vehicleId: vehicle.id,
        date: record.date,
        value: Number(record.value) || 0,
        supplier: record.supplier || "",
        note: record.note || "",
        attachment: "",
        source: "planilha",
        sourceRef: `${record.source} · linha ${record.sourceRow}`,
        createdBy: "Importação da planilha",
        createdAt: Date.now(),
      };
      if (record.type === "abastecimento") {
        target.fuel.push({ ...base, km: record.km ?? null, liters: record.liters ?? null, driverId: "", fuelType: "" });
      } else {
        target.expenses.push({
          ...base,
          category: EXPENSE_CATEGORIES.includes(record.category) ? record.category : "Diversos",
          description: record.service || record.note || record.category || "Despesa",
        });
      }
    });

    target.vehicles = [...vehiclesByKey.values()];
    target.importInfo = {
      file: source?.metadata?.sourceFile || "planilha",
      importedAt: Date.now(),
      records: records.length,
      period: [source?.metadata?.dateStart, source?.metadata?.dateEnd],
    };
  }

  // ---------- Persistência ----------

  async function load() {
    let raw = null;
    try {
      raw = window.frotasDesktop ? await window.frotasDesktop.load() : localStorage.getItem(LOCAL_KEY);
    } catch (error) {
      console.error(error);
    }

    if (raw) {
      db = migrate(JSON.parse(raw));
    } else {
      db = emptyDb();
      if (window.FROTAS_FLEET_DATA) {
        importSpreadsheet(db, window.FROTAS_FLEET_DATA);
        audit("Importação", "Planilha", `${db.importInfo.records} lançamentos importados de ${db.importInfo.file}`, "Sistema");
      } else {
        // Instalador sem dados reais: os dados entram por "Restaurar cópia".
        audit("Início", "Sistema", "Sistema iniciado sem dados. Restaure uma cópia em Configurações.", "Sistema");
      }
      await persist();
    }
    return db;
  }

  function migrate(data) {
    const base = emptyDb();
    const merged = { ...base, ...data, settings: { ...base.settings, ...data.settings, gps: { ...base.settings.gps, ...(data.settings?.gps || {}) }, notes: { ...base.settings.notes, ...(data.settings?.notes || {}) } } };
    merged.version = SCHEMA_VERSION;
    return merged;
  }

  async function persist() {
    db.updatedAt = Date.now();
    const json = JSON.stringify(db);
    try {
      if (window.frotasDesktop) await window.frotasDesktop.save(json);
      else localStorage.setItem(LOCAL_KEY, json);
      lastSaveError = null;
    } catch (error) {
      lastSaveError = error;
      console.error(error);
      Frotas.ui?.toast("Atenção: não foi possível salvar os dados. Verifique o espaço em disco.", "danger");
    }
  }

  function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(persist, 250);
  }

  async function flush() {
    clearTimeout(saveTimer);
    await persist();
  }

  function changed() {
    invalidateCache();
    scheduleSave();
    listeners.forEach((listener) => listener());
  }

  function onChange(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  function replaceAll(data) {
    db = migrate(data);
    changed();
  }

  function exportJSON() {
    return JSON.stringify(db, null, 2);
  }

  // ---------- Auditoria ----------

  function audit(action, entity, details, userName) {
    const user = userName || Frotas.auth?.currentUser()?.name || "Sistema";
    db.audit.unshift({ id: uid("aud"), ts: Date.now(), user, action, entity, details });
    if (db.audit.length > 5000) db.audit.length = 5000;
  }

  // ---------- CRUD genérico ----------

  const LABELS = { vehicles: "Veículo", drivers: "Motorista", fuel: "Abastecimento", expenses: "Despesa", maintenance: "Manutenção", users: "Usuário", inbox: "Nota do celular" };

  function list(collection) {
    return db[collection];
  }

  function find(collection, id) {
    return db[collection].find((item) => item.id === id) || null;
  }

  function create(collection, data, description) {
    const user = Frotas.auth?.currentUser();
    const item = { id: uid(collection.slice(0, 3)), createdAt: Date.now(), createdBy: user?.name || "Sistema", source: "sistema", ...data };
    db[collection].push(item);
    audit("Cadastro", LABELS[collection] || collection, description || item.name || item.id);
    changed();
    return item;
  }

  function update(collection, id, data, description) {
    const item = find(collection, id);
    if (!item) return null;
    Object.assign(item, data, { updatedAt: Date.now(), updatedBy: Frotas.auth?.currentUser()?.name || "Sistema" });
    audit("Alteração", LABELS[collection] || collection, description || item.name || id);
    changed();
    return item;
  }

  function remove(collection, id, description) {
    const index = db[collection].findIndex((item) => item.id === id);
    if (index < 0) return false;
    const [item] = db[collection].splice(index, 1);
    audit("Exclusão", LABELS[collection] || collection, description || item.name || id);
    changed();
    return true;
  }

  // ---------- Consultas e cálculos ----------

  let cache = null;
  function invalidateCache() {
    cache = null;
  }

  function vehicleLabel(vehicle) {
    if (!vehicle) return "Veículo removido";
    return vehicle.plate ? `${vehicle.name} · ${formatPlate(vehicle.plate)}` : vehicle.name;
  }

  function vehicleById(id) {
    return computed().vehicleMap.get(id) || null;
  }

  function costCategory(expense) {
    return MAINTENANCE_CATEGORIES.has(expense.category) ? "Manutenção" : "Outras despesas";
  }

  // Lançamentos financeiros unificados (abastecimentos + despesas).
  function movements() {
    return computed().movements;
  }

  // Faixas plausíveis de consumo (km/L) por tipo; fora delas o par de leituras é descartado do cálculo.
  const EFFICIENCY_RANGE = { Moto: [15, 70], Carro: [5, 22], "Utilitário": [4, 20], "Caminhão": [1.5, 10], Outro: [1, 40] };

  function tankCapacity(vehicle) {
    return Number(vehicle?.tankLiters) || (vehicle?.type === "Moto" ? 20 : vehicle?.type === "Caminhão" ? 300 : 90);
  }

  function analyzeFuel(vehicle, entries) {
    const [minEfficiency, maxEfficiency] = EFFICIENCY_RANGE[vehicle.type] || EFFICIENCY_RANGE.Outro;
    const tank = tankCapacity(vehicle);
    const sorted = [...entries].sort((a, b) => a.date.localeCompare(b.date) || (a.km || 0) - (b.km || 0));
    const withKm = sorted.filter((entry) => Number(entry.km) > 0);
    const outliers = new Set();

    // Quilometragem muito diferente das leituras vizinhas indica erro de digitação.
    withKm.forEach((entry, index) => {
      const neighbors = withKm.slice(Math.max(0, index - 3), index).concat(withKm.slice(index + 1, index + 4)).map((item) => item.km);
      const reference = median(neighbors);
      if (reference !== null && neighbors.length >= 2 && Math.abs(entry.km - reference) > 5000) outliers.add(entry.id);
    });

    const valid = withKm.filter((entry) => !outliers.has(entry.id));
    const regressions = new Set();
    let totalKm = 0;
    let litersForKm = 0;
    let valueForKm = 0;
    const efficiencySeries = [];

    for (let index = 1; index < valid.length; index += 1) {
      const previous = valid[index - 1];
      const current = valid[index];
      const delta = current.km - previous.km;
      if (delta < 0) {
        regressions.add(current.id);
        continue;
      }
      const liters = Number(current.liters);
      const efficiency = liters > 0 ? delta / liters : 0;
      if (delta > 0 && delta <= 2500 && liters > 0 && liters <= tank && efficiency >= minEfficiency && efficiency <= maxEfficiency) {
        totalKm += delta;
        litersForKm += Number(current.liters);
        valueForKm += Number(current.value) || 0;
        efficiencySeries.push({ date: current.date, kmPerLiter: delta / Number(current.liters) });
      }
    }

    const lastValid = valid.length ? valid.reduce((best, entry) => (entry.km > best.km ? entry : best), valid[0]) : null;
    return {
      outliers,
      regressions,
      kmCovered: totalKm,
      kmPerLiter: litersForKm > 0 ? totalKm / litersForKm : null,
      costPerKm: totalKm > 0 ? valueForKm / totalKm : null,
      currentKm: lastValid?.km ?? null,
      currentKmDate: lastValid?.date ?? "",
      lastFuel: sorted[sorted.length - 1] || null,
      efficiencySeries,
    };
  }

  function computed() {
    if (cache) return cache;
    const vehicleMap = new Map(db.vehicles.map((vehicle) => [vehicle.id, vehicle]));
    const driverMap = new Map(db.drivers.map((driver) => [driver.id, driver]));

    const fuelByVehicle = groupBy(db.fuel, (entry) => entry.vehicleId);
    const vehicleStats = new Map();
    db.vehicles.forEach((vehicle) => {
      const fuel = fuelByVehicle.get(vehicle.id) || [];
      const expenses = db.expenses.filter((expense) => expense.vehicleId === vehicle.id);
      const analysis = analyzeFuel(vehicle, fuel);
      const fuelTotal = sum(fuel, (entry) => entry.value);
      const expenseTotal = sum(expenses, (entry) => entry.value);
      const maintenanceTotal = sum(expenses.filter((expense) => MAINTENANCE_CATEGORIES.has(expense.category)), (entry) => entry.value);
      vehicleStats.set(vehicle.id, {
        ...analysis,
        fuelCount: fuel.length,
        liters: sum(fuel, (entry) => entry.liters),
        fuelTotal,
        expenseTotal,
        maintenanceTotal,
        total: fuelTotal + expenseTotal,
        lastActivity: [...fuel, ...expenses].map((entry) => entry.date).sort().pop() || "",
      });
    });

    const movementList = [
      ...db.fuel.map((entry) => ({
        id: entry.id, kind: "fuel", date: entry.date, vehicleId: entry.vehicleId, value: Number(entry.value) || 0,
        category: "Abastecimento", group: "Abastecimento", description: entry.liters ? `${Frotas.util.number(entry.liters, 2)} L` : "Abastecimento",
        supplier: entry.supplier, source: entry.source,
      })),
      ...db.expenses.map((entry) => ({
        id: entry.id, kind: "expense", date: entry.date, vehicleId: entry.vehicleId, value: Number(entry.value) || 0,
        category: entry.category, group: costCategory(entry), description: entry.description, supplier: entry.supplier, source: entry.source,
      })),
    ].map((movement) => ({ ...movement, scope: vehicleMap.get(movement.vehicleId)?.scope || "frota" }))
      .sort((a, b) => b.date.localeCompare(a.date));

    cache = { vehicleMap, driverMap, vehicleStats, movements: movementList };
    cache.issues = buildIssues(cache);
    cache.alerts = buildAlerts(cache);
    return cache;
  }

  function stats(vehicleId) {
    return computed().vehicleStats.get(vehicleId) || null;
  }

  // ---------- Qualidade dos dados ----------

  function buildIssues({ vehicleMap, vehicleStats }) {
    const issues = [];
    const reviewed = new Set(db.reviewedIssues);
    const { fuelPriceMin, fuelPriceMax } = db.settings;
    const push = (issue) => {
      if (!reviewed.has(issue.id)) issues.push(issue);
    };

    const seen = new Map();
    db.fuel.forEach((entry) => {
      const vehicle = vehicleMap.get(entry.vehicleId);
      const label = vehicleLabel(vehicle);
      const key = [entry.vehicleId, entry.date, entry.km, entry.liters, entry.value].join("|");
      if (seen.has(key)) {
        push({ id: `dup:${entry.id}`, recordId: entry.id, kind: "fuel", severity: "danger", type: "Possível duplicidade", vehicle: label, date: entry.date, value: entry.value,
          detail: "Mesmo veículo, data, quilometragem, litros e valor de outro lançamento." });
      } else seen.set(key, entry.id);

      if (!entry.km) push({ id: `nokm:${entry.id}`, recordId: entry.id, kind: "fuel", severity: "warning", type: "Quilometragem não informada", vehicle: label, date: entry.date, value: entry.value, detail: "Sem km não é possível calcular o consumo." });
      if (!entry.liters) push({ id: `noliters:${entry.id}`, recordId: entry.id, kind: "fuel", severity: "warning", type: "Litros não informados", vehicle: label, date: entry.date, value: entry.value, detail: "Sem litros não é possível calcular preço por litro e consumo." });

      if (entry.liters > 0 && entry.value > 0) {
        const price = entry.value / entry.liters;
        if (price < fuelPriceMin || price > fuelPriceMax) {
          push({ id: `price:${entry.id}`, recordId: entry.id, kind: "fuel", severity: "warning", type: "Preço por litro fora do padrão", vehicle: label, date: entry.date, value: entry.value,
            detail: `${Frotas.util.money(price)}/L (faixa esperada: ${Frotas.util.money(fuelPriceMin)} a ${Frotas.util.money(fuelPriceMax)}). Confira litros e valor.` });
        }
      }

      const tank = tankCapacity(vehicle);
      if (entry.liters > tank) {
        push({ id: `tank:${entry.id}`, recordId: entry.id, kind: "fuel", severity: "warning", type: "Litros acima da capacidade", vehicle: label, date: entry.date, value: entry.value,
          detail: `${Frotas.util.number(entry.liters, 2)} L para um tanque estimado de ${tank} L.` });
      }

      const vehicleAnalysis = vehicleStats.get(entry.vehicleId);
      if (vehicleAnalysis?.outliers.has(entry.id)) {
        push({ id: `kmout:${entry.id}`, recordId: entry.id, kind: "fuel", severity: "danger", type: "Quilometragem incompatível", vehicle: label, date: entry.date, value: entry.value,
          detail: `${Frotas.util.number(entry.km)} km está muito distante das leituras próximas deste veículo (provável erro de digitação).` });
      } else if (vehicleAnalysis?.regressions.has(entry.id)) {
        push({ id: `kmback:${entry.id}`, recordId: entry.id, kind: "fuel", severity: "warning", type: "Quilometragem regrediu", vehicle: label, date: entry.date, value: entry.value,
          detail: `${Frotas.util.number(entry.km)} km é menor que a leitura anterior do veículo.` });
      }
    });

    const order = { danger: 0, warning: 1 };
    return issues.sort((a, b) => order[a.severity] - order[b.severity] || b.date.localeCompare(a.date));
  }

  function issues() {
    return computed().issues;
  }

  function markReviewed(issueIds) {
    issueIds.forEach((id) => {
      if (!db.reviewedIssues.includes(id)) db.reviewedIssues.push(id);
    });
    audit("Conferência", "Qualidade dos dados", `${issueIds.length} apontamento(s) marcado(s) como conferido(s)`);
    changed();
  }

  // ---------- Alertas operacionais ----------

  function dueAlert(alerts, { id, date, label, subject, view, entityId }) {
    if (!date) return;
    const today = todayISO();
    const days = daysBetween(today, date);
    const warningDays = db.settings.alertDays;
    if (days < 0) alerts.push({ id, severity: "danger", title: `${label} vencido(a)`, subject, detail: `Venceu em ${Frotas.util.dateBR(date)} (${Math.abs(days)} dia(s) atrás).`, view, entityId, sort: days });
    else if (days <= warningDays) alerts.push({ id, severity: "warning", title: `${label} vence em ${days} dia(s)`, subject, detail: `Vencimento em ${Frotas.util.dateBR(date)}.`, view, entityId, sort: days });
  }

  function buildAlerts({ vehicleStats, vehicleMap }) {
    const alerts = [];
    const today = todayISO();

    db.vehicles.filter((vehicle) => vehicle.status !== "inativo").forEach((vehicle) => {
      const label = vehicleLabel(vehicle);
      dueAlert(alerts, { id: `lic:${vehicle.id}`, date: vehicle.licensingDue, label: "Licenciamento", subject: label, view: "veiculos", entityId: vehicle.id });
      dueAlert(alerts, { id: `seg:${vehicle.id}`, date: vehicle.insuranceDue, label: "Seguro", subject: label, view: "veiculos", entityId: vehicle.id });
      dueAlert(alerts, { id: `rev:${vehicle.id}`, date: vehicle.nextServiceDate, label: "Revisão programada", subject: label, view: "manutencoes", entityId: vehicle.id });

      const currentKm = vehicleStats.get(vehicle.id)?.currentKm;
      if (vehicle.nextServiceKm && currentKm) {
        const remaining = vehicle.nextServiceKm - currentKm;
        if (remaining <= 0) alerts.push({ id: `revkm:${vehicle.id}`, severity: "danger", title: "Revisão por quilometragem atrasada", subject: label, detail: `Prevista para ${Frotas.util.number(vehicle.nextServiceKm)} km; último registro em ${Frotas.util.number(currentKm)} km.`, view: "manutencoes", entityId: vehicle.id, sort: -1 });
        else if (remaining <= 1000) alerts.push({ id: `revkm:${vehicle.id}`, severity: "warning", title: `Revisão em ${Frotas.util.number(remaining)} km`, subject: label, detail: `Prevista para ${Frotas.util.number(vehicle.nextServiceKm)} km.`, view: "manutencoes", entityId: vehicle.id, sort: 5 });
      }
    });

    db.drivers.filter((driver) => driver.active !== false).forEach((driver) => {
      dueAlert(alerts, { id: `cnh:${driver.id}`, date: driver.cnhDue, label: "CNH", subject: driver.name, view: "motoristas", entityId: driver.id });
    });

    db.maintenance.filter((item) => item.status === "agendada" && item.scheduledDate).forEach((item) => {
      const vehicle = vehicleMap.get(item.vehicleId);
      const days = daysBetween(today, item.scheduledDate);
      if (days < 0) alerts.push({ id: `man:${item.id}`, severity: "danger", title: "Manutenção agendada em atraso", subject: vehicleLabel(vehicle), detail: `${item.service} · prevista para ${Frotas.util.dateBR(item.scheduledDate)}.`, view: "manutencoes", entityId: item.id, sort: days });
      else if (days <= 7) alerts.push({ id: `man:${item.id}`, severity: "warning", title: `Manutenção em ${days} dia(s)`, subject: vehicleLabel(vehicle), detail: `${item.service} · ${Frotas.util.dateBR(item.scheduledDate)}.`, view: "manutencoes", entityId: item.id, sort: days });
    });

    const incomplete = db.vehicles.filter((vehicle) => vehicle.scope === "frota" && vehicle.status !== "inativo" && (!vehicle.licensingDue || !vehicle.plate));
    if (incomplete.length) {
      alerts.push({ id: "cad:veiculos", severity: "info", title: `${incomplete.length} veículo(s) com cadastro incompleto`, subject: "Frota própria", detail: "Informe placa e vencimento do licenciamento para ativar os alertas de documentação.", view: "veiculos", sort: 90 });
    }
    if (!db.drivers.length) {
      alerts.push({ id: "cad:motoristas", severity: "info", title: "Nenhum motorista cadastrado", subject: "Motoristas", detail: "Cadastre os condutores e a validade da CNH para receber alertas de vencimento.", view: "motoristas", sort: 91 });
    }

    const order = { danger: 0, warning: 1, info: 2 };
    return alerts.sort((a, b) => order[a.severity] - order[b.severity] || a.sort - b.sort);
  }

  function alerts() {
    return computed().alerts;
  }

  function get() {
    return db;
  }

  function updateSettings(patch, description) {
    Object.assign(db.settings, patch);
    audit("Configuração", "Parâmetros", description);
    changed();
  }

  return {
    load, flush, onChange, replaceAll, exportJSON, get, audit, updateSettings,
    list, find, create, update, remove,
    vehicleById, vehicleLabel, stats, movements, issues, markReviewed, alerts, costCategory,
    lastSaveError: () => lastSaveError,
    EXPENSE_CATEGORIES, MAINTENANCE_CATEGORIES, VEHICLE_TYPES, FUEL_TYPES,
  };
})();
