"use strict";

// Rastreamento: mapa, status dos veículos e integração com o provedor de GPS.
(() => {
  const { esc, number, formatPlate, relativeTime, normalizeText } = Frotas.util;
  const C = Frotas.common;
  const store = Frotas.store;

  const STATES = {
    moving: { label: "Em movimento", color: "#3f8f5a" },
    idle: { label: "Ligado parado", color: "#d39a2f" },
    off: { label: "Desligado", color: "#66636d" },
    nosignal: { label: "Sem sinal", color: "#a45148" },
  };
  const NO_SIGNAL_MINUTES = 30;

  let positions = [];
  let timer = null;
  let map = null;
  let markers = new Map();
  let areaCircle = null;
  let stateFilter = "";
  let listTerm = "";
  let selectedPlate = "";
  let fitted = false;

  const settings = () => store.get().settings;

  function distanceKm(a, b) {
    const rad = Math.PI / 180;
    const dLat = (b.lat - a.lat) * rad;
    const dLng = (b.lng - a.lng) * rad;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
    return 12742 * Math.asin(Math.sqrt(h));
  }

  function stateOf(position) {
    if (!position.ts || Date.now() - position.ts > NO_SIGNAL_MINUTES * 60000) return "nosignal";
    if (position.ignition && position.speed > 3) return "moving";
    if (position.ignition) return "idle";
    return "off";
  }

  function enrich(position) {
    const vehicle = store.list("vehicles").find((item) => item.plate && item.plate === position.plate) || null;
    const distance = distanceKm(settings().base, position);
    return { ...position, vehicle, state: stateOf(position), distance, outside: distance > settings().areaRadiusKm };
  }

  // ---------- Modo demonstração (posições simuladas, sempre identificado na tela) ----------

  function seeded(text) {
    let hash = 2166136261;
    for (const char of text) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
    return () => {
      hash = Math.imul(hash ^ (hash >>> 15), 2246822507);
      hash = Math.imul(hash ^ (hash >>> 13), 3266489909);
      return ((hash ^= hash >>> 16) >>> 0) / 4294967296;
    };
  }

  // Cidades usadas na demonstração.
  const DEMO_CITIES = [
    { name: "Santa Maria do Cambucá - PE", lat: -7.8367, lng: -35.8939 },
    { name: "Taquaritinga do Norte - PE", lat: -7.9030, lng: -36.0440 },
    { name: "Vertentes - PE", lat: -7.9036, lng: -35.9866 },
    { name: "Vertente do Lério - PE", lat: -7.7707, lng: -35.8495 },
    { name: "Caruaru - PE", lat: -8.2760, lng: -35.9819 },
    { name: "Recife - PE", lat: -8.0476, lng: -34.8770 },
  ];

  function demoPositions() {
    const base = settings().base;
    const vehicles = store.list("vehicles").filter((vehicle) => vehicle.scope === "frota" && vehicle.plate && vehicle.status !== "inativo");
    return vehicles.map((vehicle, index) => {
      const random = seeded(vehicle.plate);
      const city = index % 3 === 1 ? DEMO_CITIES[Math.floor(index / 3) % DEMO_CITIES.length] : null;
      const center = city || base;
      const radius = city ? 0.004 + random() * 0.02 : 0.012 + random() * 0.07;
      const angle = random() * Math.PI * 2;
      const roll = random();
      const ignition = roll < 0.55;
      return {
        plate: vehicle.plate,
        lat: center.lat + Math.sin(angle) * radius,
        lng: center.lng + Math.cos(angle) * radius * 1.1,
        speed: ignition && roll < 0.35 ? Math.round(20 + random() * 50) : 0,
        ignition,
        heading: random() * 360,
        ts: roll > 0.92 ? Date.now() - (45 + random() * 300) * 60000 : Date.now() - random() * 90000,
        address: city ? city.name : settings().city,
        simulated: true,
      };
    });
  }

  function advanceDemo() {
    positions = positions.map((position) => {
      if (!position.simulated || position.state === "nosignal") return position;
      const next = { ...position, ts: position.speed > 0 || position.ignition ? Date.now() : position.ts };
      if (position.speed > 0) {
        const heading = (position.heading + (Math.random() - 0.5) * 30) * (Math.PI / 180);
        const km = (position.speed * 5) / 3600;
        next.lat += (Math.cos(heading) * km) / 111;
        next.lng += (Math.sin(heading) * km) / 110;
        next.heading = (heading * 180) / Math.PI;
        next.speed = Math.max(15, Math.min(80, position.speed + Math.round((Math.random() - 0.5) * 10)));
      }
      return enrich(next);
    });
  }

  // ---------- Integração com o provedor ----------

  function pick(object, keys) {
    for (const key of keys) if (object[key] !== undefined && object[key] !== null && object[key] !== "") return object[key];
    return undefined;
  }

  function parseTimestamp(value) {
    if (value === undefined) return null;
    if (typeof value === "number") return value < 1e12 ? value * 1000 : value;
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : parsed;
  }

  function parseBoolean(value) {
    if (typeof value === "boolean") return value;
    return ["1", "on", "true", "ligado", "ligada", "sim", "yes"].includes(normalizeText(value));
  }

  // Aceita os formatos mais comuns de API de rastreadores (lista direta ou dentro de data/positions/veiculos).
  function parseProviderPayload(text) {
    const json = JSON.parse(text);
    const list = Array.isArray(json) ? json : json.data || json.positions || json.posicoes || json.veiculos || json.vehicles || json.result || [];
    if (!Array.isArray(list)) throw new Error("Formato de resposta não reconhecido: esperado uma lista de posições.");
    return list.map((item) => {
      const plate = Frotas.util.extractPlate(pick(item, ["placa", "plate", "license_plate", "vehicle_plate", "veiculo_placa"]) || "");
      const lat = Number(pick(item, ["lat", "latitude"]));
      const lng = Number(pick(item, ["lng", "lon", "long", "longitude"]));
      if (!plate || !Number.isFinite(lat) || !Number.isFinite(lng)) return null;
      return {
        plate, lat, lng,
        speed: Number(pick(item, ["speed", "velocidade", "speed_kmh", "vel"])) || 0,
        ignition: parseBoolean(pick(item, ["ignition", "ignicao", "ign", "engine_on", "motor"])),
        heading: Number(pick(item, ["heading", "direcao", "course"])) || 0,
        ts: parseTimestamp(pick(item, ["timestamp", "datetime", "data_hora", "dataHora", "gps_time", "updated_at", "date"])),
        address: pick(item, ["address", "endereco", "logradouro"]) || "",
        simulated: false,
      };
    }).filter(Boolean);
  }

  async function fetchProvider() {
    const { url, token } = settings().gps;
    const text = window.frotasDesktop
      ? await window.frotasDesktop.gpsFetch(url, token)
      : await fetch(url, { headers: token ? { Authorization: `Bearer ${token}` } : {} }).then((response) => {
        if (!response.ok) throw new Error(`O provedor respondeu com erro ${response.status}.`);
        return response.text();
      });
    return parseProviderPayload(text);
  }

  async function refresh() {
    const gps = settings().gps;
    try {
      if (gps.mode === "demo") {
        if (!positions.length || !positions[0]?.simulated) positions = demoPositions().map(enrich);
        else advanceDemo();
      } else if (gps.mode === "api" && gps.url) {
        positions = (await fetchProvider()).map(enrich);
        gps.lastSync = Date.now();
        gps.lastError = "";
      } else {
        positions = [];
      }
    } catch (error) {
      gps.lastError = error.message;
    }
    if (map) drawPositions();
  }

  function start() {
    stop();
    const gps = settings().gps;
    positions = [];
    refresh();
    const interval = gps.mode === "demo" ? 5000 : Math.max(15, Number(gps.intervalSec) || 60) * 1000;
    if (gps.mode !== "off") timer = setInterval(refresh, interval);
  }

  function stop() {
    clearInterval(timer);
    timer = null;
  }

  // ---------- Mapa ----------

  function markerIcon(position) {
    const state = STATES[position.state];
    const plate = position.vehicle?.plate || position.plate;
    return L.divIcon({
      className: "gps-marker-wrap",
      html: `<div class="gps-marker${selectedPlate === position.plate ? " selected" : ""}" style="--c:${state.color}">
               <span class="gps-marker-label"><b>${esc(position.state === "off" ? "Deslig." : state.label)}</b>${esc(formatPlate(plate))}${position.vehicle ? `<small>${esc(position.vehicle.name)}</small>` : ""}</span>
               <span class="gps-marker-dot">${position.state === "moving" ? "➤" : "●"}</span>
             </div>`,
      iconSize: [0, 0],
      iconAnchor: [0, 0],
    });
  }

  function popupHtml(position) {
    return `<div class="gps-popup">
      <strong>${esc(position.vehicle?.name || "Veículo não cadastrado")}</strong>
      <span>${esc(formatPlate(position.plate))}</span>
      <dl>
        <dt>Situação</dt><dd>${esc(STATES[position.state].label)}${position.outside ? " · fora da área" : ""}</dd>
        <dt>Distância da base</dt><dd>${number(position.distance)} km</dd>
        <dt>Velocidade</dt><dd>${number(position.speed)} km/h</dd>
        <dt>Última comunicação</dt><dd>${esc(relativeTime(position.ts))}</dd>
${position.address ? `<dt>${position.simulated ? "Local" : "Endereço"}</dt><dd>${esc(position.address)}</dd>` : ""}
      </dl>
      <a href="https://www.google.com/maps?q=${position.lat},${position.lng}" target="_blank" rel="noopener">Abrir no Google Maps</a>
    </div>`;
  }

  function visiblePositions() {
    return positions.filter((position) => {
      if (stateFilter === "outside" ? !position.outside : stateFilter && position.state !== stateFilter) return false;
      if (!listTerm) return true;
      return normalizeText(`${position.plate} ${position.vehicle?.name || ""} ${position.vehicle?.responsible || ""}`).includes(listTerm);
    });
  }

  function drawPositions() {
    const visible = visiblePositions();
    const plates = new Set(visible.map((position) => position.plate));
    markers.forEach((marker, plate) => {
      if (!plates.has(plate)) {
        marker.remove();
        markers.delete(plate);
      }
    });
    visible.forEach((position) => {
      let marker = markers.get(position.plate);
      if (!marker) {
        marker = L.marker([position.lat, position.lng], { icon: markerIcon(position) }).addTo(map);
        marker.on("click", () => select(position.plate));
        markers.set(position.plate, marker);
      } else {
        marker.setLatLng([position.lat, position.lng]);
        marker.setIcon(markerIcon(position));
      }
      marker.bindPopup(popupHtml(position), { offset: [0, -4] });
    });
    renderSidebar();
    // Na primeira carga, enquadra todos os veículos (podem estar em várias cidades).
    if (!fitted && visible.length) {
      fitted = true;
      fitAll(false);
    }
  }

  function fitAll(animate = true) {
    if (!map) return;
    const base = settings().base;
    const points = [[base.lat, base.lng], ...visiblePositions().map((position) => [position.lat, position.lng])];
    if (points.length === 1) map.setView(points[0], 13, { animate });
    else map.fitBounds(points, { padding: [70, 70], maxZoom: 14, animate });
  }

  function counts() {
    const result = { moving: 0, idle: 0, off: 0, nosignal: 0, outside: 0 };
    positions.forEach((position) => {
      result[position.state] += 1;
      if (position.outside) result.outside += 1;
    });
    return result;
  }

  function renderSidebar() {
    const container = document.querySelector("#gps-list");
    const strip = document.querySelector("#gps-status-strip");
    if (!container || !strip) return;
    const total = counts();
    strip.innerHTML = [
      ["", "Total", positions.length, "#1b1a1f"],
      ["moving", STATES.moving.label, total.moving, STATES.moving.color],
      ["idle", STATES.idle.label, total.idle, STATES.idle.color],
      ["off", STATES.off.label, total.off, STATES.off.color],
      ["nosignal", STATES.nosignal.label, total.nosignal, STATES.nosignal.color],
      ["outside", "Fora da área", total.outside, "#4a4650", `Veículos a mais de ${settings().areaRadiusKm} km da base (atendimentos em outras cidades)`],
    ].map(([key, label, value, color, hint]) => `<button class="gps-state-chip${stateFilter === key ? " active" : ""}" data-action="gps-filter" data-value="${key}" style="--c:${color}"${hint ? ` title="${esc(hint)}"` : ""}><span></span>${esc(label)}<strong>${value}</strong></button>`).join("");

    const visible = visiblePositions().sort((a, b) => (a.vehicle?.name || a.plate).localeCompare(b.vehicle?.name || b.plate, "pt-BR"));
    container.innerHTML = visible.length ? visible.map((position) => `
      <button class="gps-row${selectedPlate === position.plate ? " active" : ""}" data-action="gps-select" data-value="${esc(position.plate)}">
        <span class="gps-row-dot" style="--c:${STATES[position.state].color}"></span>
        <div><strong>${esc(position.vehicle?.name || "Não cadastrado")}</strong><small>${esc(formatPlate(position.plate))} · ${esc(STATES[position.state].label)}</small>${position.outside || (position.address && position.address !== settings().city && position.distance > 8) ? `<small class="gps-row-place">${esc(position.address || "Fora da área")} · ${number(position.distance)} km da base</small>` : ""}</div>
        <span class="gps-row-meta">${position.state === "moving" ? `${number(position.speed)} km/h` : esc(relativeTime(position.ts))}</span>
      </button>`).join("") : `<p class="muted-text gps-empty-list">${settings().gps.mode === "off" ? "Rastreamento não conectado." : "Nenhum veículo com este filtro."}</p>`;
  }

  function select(plate) {
    selectedPlate = plate;
    const position = positions.find((item) => item.plate === plate);
    const marker = markers.get(plate);
    if (position && marker) {
      map.setView([position.lat, position.lng], Math.max(map.getZoom(), 15), { animate: true });
      marker.setIcon(markerIcon(position));
      marker.openPopup();
    }
    markers.forEach((item, key) => {
      const current = positions.find((entry) => entry.plate === key);
      if (current) item.setIcon(markerIcon(current));
    });
    renderSidebar();
  }

  function createMap() {
    const container = document.querySelector("#gps-map");
    if (!container || typeof L === "undefined") return;
    const base = settings().base;
    map = L.map(container, { zoomControl: true, attributionControl: true }).setView([base.lat, base.lng], 13);
    const satellite = L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", {
      maxZoom: 19, attribution: "Imagens © Esri, Maxar, Earthstar Geographics",
    });
    const labels = L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}", { maxZoom: 19, opacity: 0.9 });
    const streets = L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: "© OpenStreetMap" });
    const hybrid = L.layerGroup([satellite, labels]).addTo(map);
    L.control.layers({ "Satélite": hybrid, "Mapa de ruas": streets }, null, { position: "topright" }).addTo(map);
    L.control.scale({ imperial: false }).addTo(map);

    // Atalhos de enquadramento: toda a frota (todas as cidades) ou só a base.
    const tools = L.control({ position: "topleft" });
    tools.onAdd = () => {
      const box = L.DomUtil.create("div", "leaflet-bar gps-map-tools");
      box.innerHTML = `<button type="button" data-zoom="all" title="Enquadrar todos os veículos, em qualquer cidade">Toda a frota</button>
        <button type="button" data-zoom="base" title="Voltar para a base">Base ${esc(settings().city.split(" - ")[0])}</button>`;
      L.DomEvent.disableClickPropagation(box);
      box.addEventListener("click", (event) => {
        const button = event.target.closest("button");
        if (!button) return;
        if (button.dataset.zoom === "all") fitAll();
        else map.setView([settings().base.lat, settings().base.lng], 13, { animate: true });
      });
      return box;
    };
    tools.addTo(map);

    let tileErrors = 0;
    satellite.on("tileerror", () => {
      tileErrors += 1;
      if (tileErrors === 4) document.querySelector("#gps-offline-note")?.classList.remove("is-hidden");
    });

    areaCircle = L.circle([base.lat, base.lng], { radius: settings().areaRadiusKm * 1000, color: "#c9a227", weight: 2, dashArray: "6 6", fill: false }).addTo(map);
    L.marker([base.lat, base.lng], {
      icon: L.divIcon({ className: "gps-marker-wrap", html: `<div class="gps-base">Base</div>`, iconSize: [0, 0] }),
    }).addTo(map).bindPopup(`<strong>Base · ${esc(settings().city)}</strong><br>Área de atuação: ${settings().areaRadiusKm} km`);
    setTimeout(() => map?.invalidateSize(), 50);
  }

  Frotas.views.gps = {
    title: "Visão GPS",
    section: "Visão geral",
    render() {
      const gps = settings().gps;
      const canConfigure = Frotas.auth.can("config");
      const banner = gps.mode === "demo"
        ? `<div class="gps-banner demo"><strong>Modo demonstração</strong> As posições abaixo são simuladas para apresentação e não representam a localização real dos veículos. ${canConfigure ? `<button class="text-button" data-action="go" data-view="configuracoes">Conectar rastreador</button>` : ""}</div>`
        : gps.mode === "api"
          ? `<div class="gps-banner ${gps.lastError ? "error" : "live"}"><strong>${gps.lastError ? "Falha na integração" : "Rastreamento conectado"}</strong> ${esc(gps.lastError || `${gps.provider || "Provedor"} · atualização a cada ${gps.intervalSec}s`)}</div>`
          : "";
      return `
        ${C.pageIntro("Visão GPS da frota", "Posição e situação dos veículos na cidade-base e nas demais cidades atendidas.", `
          ${gps.portalUrl ? `<a class="secondary-button link-button" href="${esc(gps.portalUrl)}" target="_blank" rel="noopener">Abrir ${esc(gps.provider || "rastreador")} ↗</a>` : ""}
          ${gps.mode !== "off" ? `<button class="secondary-button" data-action="gps-refresh">Atualizar agora</button>` : ""}`)}
        ${banner}
        <div id="gps-status-strip" class="gps-status-strip"></div>
        <section class="gps-workspace">
          <div class="gps-map-wrap">
            <div id="gps-map" class="gps-map"></div>
            <div id="gps-offline-note" class="gps-offline-note is-hidden">Sem conexão com a internet: o fundo do mapa não carregou. As posições continuam sendo exibidas.</div>
            ${gps.mode === "off" ? `
              <div class="gps-connect-card">
                <span class="eyebrow">Rastreamento</span>
                <h4>Conecte o rastreador da frota</h4>
                <p>O sistema já está pronto para receber as posições do rastreador usado pela empresa (placa, latitude, longitude, velocidade e ignição). É preciso o endereço de integração (API) e a chave de acesso fornecidos pela empresa de rastreamento.</p>
                <div class="toolbar-group">
                  ${canConfigure ? `<button class="primary-button" data-action="go" data-view="configuracoes">Configurar integração</button>` : ""}
                  ${Frotas.auth.can("usuarios") ? `<button class="secondary-button" data-action="gps-demo">Ver demonstração</button>` : ""}
                </div>
              </div>` : ""}
          </div>
          <aside class="gps-side panel">
            <div class="gps-side-head">
              <strong>Veículos</strong>
              <input id="gps-search" type="search" placeholder="Placa, modelo ou responsável" value="${esc(listTerm)}" />
            </div>
            <div id="gps-list" class="gps-list"></div>
          </aside>
        </section>`;
    },
    mount() {
      fitted = false;
      createMap();
      start();
      document.querySelector("#gps-search")?.addEventListener("input", (event) => {
        listTerm = normalizeText(event.target.value);
        drawPositions();
      });
      renderSidebar();
    },
    unmount() {
      stop();
      map?.remove();
      map = null;
      markers = new Map();
      areaCircle = null;
    },
  };

  Frotas.actions = Object.assign(Frotas.actions || {}, {
    "gps-filter": (button) => { stateFilter = button.dataset.value; drawPositions(); fitAll(); },
    "gps-select": (button) => select(button.dataset.value),
    "gps-refresh": async () => { await refresh(); Frotas.ui.toast("Posições atualizadas."); },
    "gps-demo": () => {
      store.updateSettings({ gps: { ...settings().gps, mode: "demo" } }, "Rastreamento: modo demonstração ativado");
    },
  });

  Frotas.gps = { parseProviderPayload, fetchProvider, start, stop, counts: () => counts() };
})();
