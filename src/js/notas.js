"use strict";

// Notas fiscais: leitura automática (câmera, arquivo ou imagem colada) e caixa de notas enviadas pelo celular.
// A leitura nunca salva sozinha: abre o lançamento preenchido para a pessoa conferir.
(() => {
  const { esc, money, number, dateBR, dateTimeBR, relativeTime, formatPlate, extractPlate, todayISO, fileToBase64 } = Frotas.util;
  const C = Frotas.common;
  const store = Frotas.store;
  const desktop = () => window.frotasDesktop;

  const SYNC_INTERVAL_MS = 2 * 60 * 1000;
  const STATUS_LABEL = { pendente: "Aguardando conferência", lancada: "Lançada", recusada: "Recusada" };
  const CONFIDENCE = { alta: ["Leitura confiável", "success"], media: ["Confira com atenção", "warning"], baixa: ["Leitura incerta: confira tudo", "danger"] };

  let integration = { aiConfigured: false, cloudConfigured: false };
  let syncing = false;
  let lastSync = null;
  let lastSyncError = "";
  let cameraStream = null;
  let inboxTab = "pendente";

  async function refreshIntegration() {
    if (!desktop()) return integration;
    integration = await desktop().notesStatus();
    return integration;
  }

  // ---------- Preparação da imagem ----------

  // Reduz fotos grandes (celular/câmera) para no máximo 2000 px, mantendo a nota legível.
  async function prepareFile(blob) {
    if (blob.type === "application/pdf") {
      if (blob.size > 20 * 1024 * 1024) throw new Error("O PDF deve ter no máximo 20 MB.");
      return { base64: await fileToBase64(blob), mediaType: "application/pdf", preview: "" };
    }
    if (!/^image\//.test(blob.type)) throw new Error("Escolha uma foto (JPG, PNG) ou um PDF da nota.");
    const bitmap = await createImageBitmap(blob, { imageOrientation: "from-image" });
    const scale = Math.min(1, 2000 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const dataUrl = canvas.toDataURL("image/jpeg", 0.88);
    return { base64: dataUrl.split(",")[1], mediaType: "image/jpeg", preview: dataUrl };
  }

  // ---------- Janela "Ler nota" ----------

  function dialog() {
    let element = document.querySelector("#note-dialog");
    if (!element) {
      element = document.createElement("dialog");
      element.id = "note-dialog";
      element.className = "app-dialog note-dialog";
      element.addEventListener("close", stopCamera);
      document.body.appendChild(element);
    }
    return element;
  }

  function stopCamera() {
    cameraStream?.getTracks().forEach((track) => track.stop());
    cameraStream = null;
  }

  async function openReader() {
    if (!desktop()) {
      Frotas.ui.toast("A leitura de notas funciona no programa instalado no computador.", "warning");
      return;
    }
    await refreshIntegration();
    const element = dialog();
    element.innerHTML = `
      <div class="dialog-heading">
        <div><span class="eyebrow">Leitura automática</span><h3>Ler nota fiscal</h3></div>
        <button type="button" class="dialog-close" data-note-close aria-label="Fechar">×</button>
      </div>
      ${integration.aiConfigured ? "" : `<div class="dialog-intro warning-intro"><p><strong>Leitura automática desligada.</strong> A foto será anexada e você preenche os dados. ${Frotas.auth.can("config") ? "Para ligar, informe a chave da API em Configurações." : "Peça ao administrador para ligar em Configurações."}</p></div>`}
      <div class="note-reader" data-step="choose">
        <div class="note-drop" tabindex="0">
          <span class="note-drop-icon">🧾</span>
          <strong>Arraste a foto da nota para cá</strong>
          <small>ou cole uma imagem copiada (Ctrl+V), por exemplo do WhatsApp Web</small>
        </div>
        <div class="note-choices">
          <button type="button" class="primary-button" data-note-camera>📷 Tirar foto com a câmera</button>
          <label class="secondary-button note-file-button">📁 Escolher foto ou PDF<input type="file" accept="image/*,.pdf" hidden data-note-file /></label>
        </div>
        <div class="note-camera is-hidden">
          <video autoplay playsinline muted></video>
          <p class="footnote">Aproxime a nota da câmera, com boa luz, até os números ficarem nítidos.</p>
          <div class="button-row">
            <button type="button" class="secondary-button" data-note-camera-cancel>Voltar</button>
            <button type="button" class="primary-button" data-note-capture>Capturar foto</button>
          </div>
        </div>
        <div class="note-progress is-hidden">
          <img alt="Foto da nota" />
          <div><span class="spinner"></span><strong>Lendo a nota…</strong><small>Isso leva alguns segundos.</small></div>
        </div>
        <p class="form-error" role="alert"></p>
      </div>`;
    const error = element.querySelector(".form-error");
    const fail = (problem) => {
      error.textContent = problem.message || String(problem);
      element.querySelector(".note-progress").classList.add("is-hidden");
      element.querySelector(".note-choices").classList.remove("is-hidden");
      element.querySelector(".note-drop").classList.remove("is-hidden");
    };
    const handle = (blob) => process(blob, element).catch(fail);

    element.querySelector("[data-note-close]").addEventListener("click", () => element.close());
    element.querySelector("[data-note-file]").addEventListener("change", (event) => event.target.files[0] && handle(event.target.files[0]));
    const drop = element.querySelector(".note-drop");
    drop.addEventListener("dragover", (event) => { event.preventDefault(); drop.classList.add("over"); });
    drop.addEventListener("dragleave", () => drop.classList.remove("over"));
    drop.addEventListener("drop", (event) => {
      event.preventDefault();
      drop.classList.remove("over");
      const file = event.dataTransfer.files[0];
      if (file) handle(file);
    });
    element.addEventListener("paste", (event) => {
      const item = [...(event.clipboardData?.items || [])].find((entry) => entry.type.startsWith("image/"));
      if (item) handle(item.getAsFile());
    });
    element.querySelector("[data-note-camera]").addEventListener("click", () => startCamera(element).catch(fail));
    element.querySelector("[data-note-camera-cancel]").addEventListener("click", () => {
      stopCamera();
      element.querySelector(".note-camera").classList.add("is-hidden");
      element.querySelector(".note-choices").classList.remove("is-hidden");
      drop.classList.remove("is-hidden");
    });
    element.querySelector("[data-note-capture]").addEventListener("click", () => {
      const video = element.querySelector("video");
      const canvas = document.createElement("canvas");
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      canvas.getContext("2d").drawImage(video, 0, 0);
      stopCamera();
      element.querySelector(".note-camera").classList.add("is-hidden");
      canvas.toBlob((blob) => handle(blob), "image/jpeg", 0.92);
    });
    element.showModal();
    drop.focus();
  }

  async function startCamera(element) {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error("Este computador não oferece acesso à câmera.");
    try {
      cameraStream = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 1920 }, height: { ideal: 1080 }, facingMode: "environment" }, audio: false });
    } catch (problem) {
      throw new Error(problem.name === "NotFoundError" ? "Nenhuma câmera encontrada neste computador. Use \"Escolher foto\" ou o aplicativo do celular." : "Não foi possível abrir a câmera. Verifique se outro programa está usando a câmera.");
    }
    element.querySelector("video").srcObject = cameraStream;
    element.querySelector(".note-choices").classList.add("is-hidden");
    element.querySelector(".note-drop").classList.add("is-hidden");
    element.querySelector(".note-camera").classList.remove("is-hidden");
  }

  async function process(blob, element) {
    element.querySelector(".form-error").textContent = "";
    const prepared = await prepareFile(blob);
    element.querySelector(".note-choices").classList.add("is-hidden");
    element.querySelector(".note-drop").classList.add("is-hidden");
    const progress = element.querySelector(".note-progress");
    progress.classList.remove("is-hidden");
    progress.querySelector("img").src = prepared.preview || "";
    progress.querySelector("img").classList.toggle("is-hidden", !prepared.preview);
    if (!integration.aiConfigured) progress.querySelector("strong").textContent = "Anexando a foto…";
    const result = await desktop().readReceipt(prepared.base64, prepared.mediaType);
    element.close();
    openLaunch({ dados: result.dados, erro: result.erro, attachment: result.attachment, preview: prepared.preview, origin: "leitura" });
  }

  // ---------- Lançamento a partir da nota lida ----------

  function decimal(value, digits = 2) {
    return Number.isFinite(value) && value > 0 ? value.toFixed(digits).replace(".", ",") : "";
  }

  function validDate(value) {
    return /^\d{4}-\d{2}-\d{2}$/.test(value || "") && value <= todayISO() && value >= "2020-01-01" ? value : todayISO();
  }

  function matchVehicle(plate) {
    const wanted = extractPlate(plate || "");
    if (!wanted) return "";
    return store.list("vehicles").find((vehicle) => vehicle.plate === wanted)?.id || "";
  }

  function matchSupplier(name) {
    if (!name) return { supplier: "", newSupplier: "" };
    const normalized = Frotas.util.normalizeText(name);
    const known = C.knownSuppliers().find((item) => {
      const option = Frotas.util.normalizeText(typeof item === "string" ? item : item.value);
      return option && (option.includes(normalized) || normalized.includes(option));
    });
    const value = typeof known === "string" ? known : known?.value;
    return value ? { supplier: value, newSupplier: "" } : { supplier: "", newSupplier: name };
  }

  function summaryHtml(item, preview) {
    const d = item.dados;
    const [confidenceLabel, confidenceType] = CONFIDENCE[d?.confianca] || CONFIDENCE.baixa;
    const duplicate = d?.chave_acesso ? Frotas.forms.duplicateByKey(d.chave_acesso) : null;
    const facts = d ? [
      d.fornecedor && `<div><dt>Emitente</dt><dd>${esc(d.fornecedor)}</dd></div>`,
      d.data && `<div><dt>Data</dt><dd>${dateBR(d.data)}</dd></div>`,
      d.valor_total && `<div><dt>Valor total</dt><dd>${money(d.valor_total)}</dd></div>`,
      d.litros && `<div><dt>Litros</dt><dd>${number(d.litros, 2)} L${d.preco_por_litro ? ` · ${money(d.preco_por_litro)}/L` : ""}</dd></div>`,
      d.placa && `<div><dt>Placa na nota</dt><dd>${esc(formatPlate(extractPlate(d.placa) || d.placa))}</dd></div>`,
      d.descricao && `<div><dt>Itens</dt><dd>${esc(d.descricao)}</dd></div>`,
    ].filter(Boolean).join("") : "";
    const note = item.note;
    return `
      <div class="note-review">
        ${preview ? `<button type="button" class="note-thumb" data-note-open-photo title="Abrir a foto em tamanho real"><img src="${esc(preview)}" alt="Foto da nota" /></button>` : ""}
        <div>
          ${note ? `<p class="note-origin">Enviada pelo celular por <strong>${esc(note.advisor || "assessor")}</strong> · ${esc(dateTimeBR(Date.parse(note.sentAt)))}${note.note ? ` · “${esc(note.note)}”` : ""}</p>` : ""}
          ${d ? `<p>${Frotas.ui.status(confidenceLabel, confidenceType)} ${d.legivel === false ? Frotas.ui.status("Não parece uma nota legível", "danger") : ""}</p><dl class="detail-list compact">${facts}</dl>` : ""}
          ${d?.observacoes ? `<p class="footnote">Observação da leitura: ${esc(d.observacoes)}</p>` : ""}
          ${item.erro ? `<p class="form-error">${esc(item.erro)} Preencha os campos olhando a foto.</p>` : ""}
          ${duplicate ? `<p class="form-error">Atenção: esta nota fiscal já foi lançada em ${dateBR(duplicate.date)} (${money(duplicate.value)}).</p>` : ""}
          <p class="footnote"><strong>Confira os campos abaixo antes de salvar.</strong> A foto já fica anexada como comprovante.</p>
        </div>
      </div>`;
  }

  async function openLaunch(item) {
    const d = item.dados || {};
    const note = item.note;
    let preview = item.preview;
    if (!preview && item.attachment && desktop()) preview = await desktop().readAttachment(item.attachment);
    const isFuel = note ? note.type === "abastecimento" : d.categoria === "Abastecimento" || d.tipo_documento === "cupom_nfce" && d.litros > 0;
    const vehicleId = note?.vehicleId && store.vehicleById(note.vehicleId) ? note.vehicleId : matchVehicle(d.placa);
    const reading = d.confianca ? `Lido automaticamente da nota (confiança ${d.confianca}).` : "";
    const sentBy = note ? `Enviada pelo celular por ${note.advisor || "assessor"}.` : "";
    const common = {
      vehicleId,
      date: validDate(d.data),
      value: decimal(d.valor_total),
      note: [sentBy, note?.note, reading].filter(Boolean).join(" "),
    };
    const opts = {
      attachment: item.attachment,
      nfceKey: /^\d{44}$/.test(d.chave_acesso || "") ? d.chave_acesso : "",
      origin: note ? "celular" : "leitura",
      intro: summaryHtml(item, preview),
      onSaved: (record, collection) => {
        if (note) markInbox(note, "lancada", { recordId: record.id, recordCollection: collection });
      },
    };
    if (isFuel) {
      const fuelType = { Gasolina: "Gasolina", Etanol: "Etanol", Diesel: "Diesel" }[d.combustivel] || "";
      opts.values = { ...common, km: note?.km || d.quilometragem || "", liters: decimal(d.litros, 3), fuelType, ...matchSupplier(d.fornecedor) };
      Frotas.forms.fuelForm(null, vehicleId, opts);
    } else {
      const category = store.EXPENSE_CATEGORIES.includes(d.categoria) ? d.categoria : "Diversos";
      opts.values = { ...common, category, description: d.descricao || "", supplier: d.fornecedor || "" };
      Frotas.forms.expenseForm(null, vehicleId, opts);
    }
    document.querySelector("#form-dialog [data-note-open-photo]")?.addEventListener("click", () => Frotas.forms.openAttachment(item.attachment));
  }

  // ---------- Caixa de notas do celular ----------

  function inbox() {
    return store.list("inbox") || [];
  }

  function pending() {
    return inbox().filter((item) => item.status === "pendente");
  }

  async function pushStatus(item, status, reason = "") {
    try {
      await desktop()?.setNoteStatus(item.cloudId, status, reason);
      return true;
    } catch {
      store.update("inbox", item.id, { cloudStatusPending: status, reason }, `Nota do celular · ${item.advisor} · aguardando envio do status`);
      return false;
    }
  }

  async function markInbox(item, status, extra = {}) {
    const user = Frotas.auth.currentUser()?.name || "";
    store.update("inbox", item.id, { status, ...extra, handledAt: Date.now(), handledBy: user }, `Nota do celular · ${item.advisor || "assessor"} · ${STATUS_LABEL[status]}`);
    await pushStatus(item, status, extra.reason || "");
  }

  function vehiclePayload() {
    return store.list("vehicles")
      .filter((vehicle) => vehicle.status !== "inativo")
      .map((vehicle) => ({ id: vehicle.id, nome: vehicle.scope === "autorizado" ? `${vehicle.name} (autorizado)` : vehicle.name, placa: vehicle.plate || null, tipo: vehicle.type || null }));
  }

  async function sync({ silent = true } = {}) {
    if (!desktop() || syncing || !Frotas.auth.currentUser()) return;
    syncing = true; // antes de qualquer espera: impede duas atualizações ao mesmo tempo
    try {
      await refreshIntegration();
      if (!integration.cloudConfigured) return;
      // Status que não chegaram à nuvem por falta de internet.
      for (const item of inbox().filter((entry) => entry.cloudStatusPending)) {
        await desktop().setNoteStatus(item.cloudId, item.cloudStatusPending, item.reason || "")
          .then(() => store.update("inbox", item.id, { cloudStatusPending: null }, `Nota do celular · ${item.advisor} · status enviado`))
          .catch(() => {});
      }
      const { received, failures } = await desktop().syncNotes(vehiclePayload(), inbox().map((item) => item.cloudId));
      for (const note of received) {
        if (inbox().some((entry) => entry.cloudId === note.id)) continue; // já recebida
        const item = store.create("inbox", {
          cloudId: note.id, sentAt: note.criado_em, advisor: note.assessor_nome || "Assessor", type: note.tipo,
          vehicleId: note.veiculo_id || "", km: note.km || null, note: note.observacao || "",
          attachment: note.attachment, dados: note.dados, erro: note.erro, status: "pendente",
        }, `Nota recebida do celular · ${note.assessor_nome || "assessor"}`);
        await pushStatus(item, "recebida");
      }
      lastSync = Date.now();
      lastSyncError = failures.length ? `${failures.length} nota(s) não puderam ser baixadas agora; nova tentativa em instantes.` : "";
      if (received.length) Frotas.ui.toast(`${received.length} nota(s) nova(s) recebida(s) do celular.`);
      else if (!silent) Frotas.ui.toast("Nenhuma nota nova no celular.");
    } catch (problem) {
      lastSyncError = problem.message || String(problem);
      if (!silent) Frotas.ui.toast(lastSyncError, "warning");
    } finally {
      syncing = false;
      updateBadge();
    }
  }

  function updateBadge() {
    const badge = document.querySelector("#inbox-count");
    if (!badge) return;
    const count = pending().length;
    badge.textContent = count;
    badge.classList.toggle("is-hidden", count === 0);
  }

  function rejectNote(item) {
    Frotas.ui.openForm({
      eyebrow: "Nota do celular",
      title: "Recusar nota",
      fields: [{ name: "reason", label: "Motivo (o assessor verá no celular)", type: "textarea", required: true, full: true, placeholder: "Ex.: foto ilegível, envie novamente" }],
      submitLabel: "Recusar nota",
      async onSubmit(data) {
        await markInbox(item, "recusada", { reason: data.reason });
        Frotas.ui.toast("Nota recusada.");
      },
    });
  }

  function inboxLine(item, compact = false) {
    const d = item.dados || {};
    const vehicle = store.vehicleById(item.vehicleId);
    const value = d.valor_total ? money(d.valor_total) : "valor não lido";
    return `
      <div class="inbox-row">
        <span class="inbox-type">${item.type === "abastecimento" ? "⛽" : "🧾"}</span>
        <div class="inbox-text">
          <strong>${esc(vehicle ? store.vehicleLabel(vehicle) : "Veículo não informado")} · ${esc(value)}</strong>
          <small>${esc(item.advisor || "Assessor")} · ${esc(relativeTime(Date.parse(item.sentAt)))}${d.fornecedor ? ` · ${esc(d.fornecedor)}` : ""}${item.erro ? " · leitura com problema" : ""}</small>
        </div>
        ${item.status === "pendente" ? `
          <div class="row-actions">
            ${compact ? "" : `<button class="icon-action danger" data-action="nota-recusar" data-id="${esc(item.id)}" title="Recusar">✕</button>`}
            <button class="primary-button small" data-action="nota-conferir" data-id="${esc(item.id)}">Conferir</button>
          </div>` : `<span>${Frotas.ui.status(STATUS_LABEL[item.status], item.status === "lancada" ? "success" : "danger")}</span>`}
      </div>`;
  }

  function syncStatusText() {
    if (!desktop()) return "Disponível no programa instalado.";
    if (!integration.cloudConfigured) return "Celular ainda não conectado.";
    if (syncing) return "Atualizando…";
    if (lastSyncError) return lastSyncError;
    return lastSync ? `Atualizado ${relativeTime(lastSync)}` : "Aguardando a primeira atualização.";
  }

  // Bloco do Painel principal: botão de leitura e notas que chegaram do celular.
  function dashboardPanel() {
    const waiting = pending();
    return `
      <section class="notes-hero panel">
        <div class="notes-hero-main">
          <span class="notes-hero-icon">📷</span>
          <div>
            <h4>Ler nota fiscal</h4>
            <p>Tire uma foto, escolha um arquivo ou cole a imagem: o sistema lê a nota e preenche o lançamento para você conferir.</p>
          </div>
          <button class="primary-button" data-action="nota-ler">Ler nota</button>
        </div>
        <div class="notes-hero-inbox">
          <div class="notes-hero-inbox-head">
            <strong>Notas do celular ${waiting.length ? `<span class="nav-badge">${waiting.length}</span>` : ""}</strong>
            <span class="muted-text">${esc(syncStatusText())}</span>
            ${integration.cloudConfigured ? `<button class="text-button" data-action="nota-sincronizar">Atualizar</button>` : Frotas.auth.can("config") && desktop() ? `<button class="text-button" data-action="go" data-view="configuracoes">Conectar</button>` : ""}
          </div>
          ${waiting.length ? waiting.slice(0, 3).map((item) => inboxLine(item, true)).join("") + (waiting.length > 3 ? `<button class="text-button" data-action="go" data-view="notas">Ver todas (${waiting.length})</button>` : "")
            : `<p class="muted-text">${integration.cloudConfigured ? "Nenhuma nota aguardando conferência." : "Os assessores enviam as fotos pelo aplicativo do celular e elas aparecem aqui."}</p>`}
        </div>
      </section>`;
  }

  Frotas.views.notas = {
    title: "Notas do celular",
    section: "Operação",
    render() {
      const all = inbox().slice().sort((a, b) => String(b.sentAt).localeCompare(String(a.sentAt)));
      const tabs = [["pendente", "Aguardando"], ["lancada", "Lançadas"], ["recusada", "Recusadas"]];
      const list = all.filter((item) => item.status === inboxTab);
      return `
        ${C.pageIntro("Notas do celular", "Fotos de notas enviadas pelos assessores. Confira cada uma e lance com um clique.", `
          <button class="secondary-button" data-action="nota-sincronizar">Atualizar agora</button>
          <button class="primary-button" data-action="nota-ler">Ler nota</button>`)}
        <div class="tab-bar standalone">${tabs.map(([key, label]) => `<button class="tab${inboxTab === key ? " active" : ""}" data-action="nota-aba" data-value="${key}">${label} <span>${all.filter((item) => item.status === key).length}</span></button>`).join("")}</div>
        <section class="panel">
          <div class="panel-heading"><div><h4>${tabs.find(([key]) => key === inboxTab)[1]}</h4><p>${esc(syncStatusText())}</p></div></div>
          <div class="panel-body inbox-list">
            ${list.length ? list.map((item) => inboxLine(item)).join("") : Frotas.ui.empty("Nada por aqui", inboxTab === "pendente" ? "Nenhuma nota aguardando conferência." : "Nenhuma nota nesta situação.")}
          </div>
        </section>`;
    },
    mount() {
      if (!lastSync || Date.now() - lastSync > 30000) sync();
    },
  };

  Frotas.actions = Object.assign(Frotas.actions || {}, {
    "nota-ler": () => openReader().catch((problem) => Frotas.ui.toast(problem.message, "warning")),
    "nota-sincronizar": async () => {
      Frotas.ui.toast("Buscando notas do celular…");
      await sync({ silent: false });
      Frotas.app.refresh();
    },
    "nota-conferir": (button) => {
      const item = store.find("inbox", button.dataset.id);
      if (item) openLaunch({ dados: item.dados, erro: item.erro, attachment: item.attachment, note: item });
    },
    "nota-recusar": (button) => {
      const item = store.find("inbox", button.dataset.id);
      if (item) rejectNote(item);
    },
    "notas-config-ia": configureAi,
    "notas-config-nuvem": configureCloud,
    "notas-app-url": configureAppUrl,
    "notas-qr": showQr,
    "notas-assessores": () => showAdvisors().catch((problem) => Frotas.ui.toast(problem.message, "warning")),
    "nota-aba": (button) => {
      inboxTab = button.dataset.value;
      Frotas.app.refresh();
    },
  });

  // ---------- Configurações: leitura automática, nuvem e aplicativo do celular ----------

  function settingsHtml() {
    const notes = store.get().settings.notes;
    const isAdmin = Frotas.auth.can("config");
    if (!desktop()) {
      return `<div class="panel-heading"><div><h4>Notas pelo celular e leitura automática</h4></div></div>
        <div class="panel-body"><p class="muted-text">Disponível no programa instalado no computador.</p></div>`;
    }
    const appLink = notes.phoneAppUrl ? `<a href="${esc(notes.phoneAppUrl)}" target="_blank" rel="noopener">${esc(notes.phoneAppUrl)}</a>` : "Não definido";
    return `
      <div class="panel-heading"><div><h4>Notas pelo celular e leitura automática</h4><p>Fotos de notas lidas por inteligência artificial e enviadas pelos assessores</p></div></div>
      <div class="panel-body">
        <dl class="detail-list">
          <div><dt>Leitura automática</dt><dd>${integration.aiConfigured ? `Ligada · ${esc(integration.aiModel)}` : "Desligada (falta a chave da API)"}</dd></div>
          <div><dt>Nuvem (celular)</dt><dd>${integration.cloudConfigured ? `Conectada · ${esc(integration.cloudEmail)}` : "Não conectada"}</dd></div>
          <div><dt>Aplicativo do celular</dt><dd>${appLink}</dd></div>
          <div><dt>Última atualização</dt><dd>${lastSync ? dateTimeBR(lastSync) : "—"}</dd></div>
        </dl>
        ${lastSyncError ? `<p class="form-error">${esc(lastSyncError)}</p>` : ""}
        ${isAdmin ? `<div class="button-row">
          <button class="secondary-button" data-action="notas-config-ia">${integration.aiConfigured ? "Trocar chave da leitura" : "Ligar leitura automática"}</button>
          <button class="secondary-button" data-action="notas-config-nuvem">${integration.cloudConfigured ? "Alterar conexão da nuvem" : "Conectar nuvem"}</button>
          <button class="secondary-button" data-action="notas-app-url">Endereço do aplicativo</button>
          ${integration.cloudConfigured && notes.phoneAppUrl ? '<button class="primary-button" data-action="notas-qr">QR Code para o celular</button>' : ""}
          ${integration.cloudConfigured ? '<button class="secondary-button" data-action="notas-assessores">Assessores</button>' : ""}
        </div>` : '<p class="footnote">Somente o administrador altera estas configurações.</p>'}
        <p class="footnote">As senhas e chaves ficam criptografadas neste computador e não entram nas cópias de segurança. O passo a passo está no arquivo GUIA-NOTAS-PELO-CELULAR.md.</p>
      </div>`;
  }

  function mountSettings() {
    const fill = () => {
      const slot = document.querySelector("#notes-settings-slot");
      if (slot) slot.innerHTML = settingsHtml();
    };
    fill();
    refreshIntegration().then(fill);
  }

  function configureAi() {
    Frotas.ui.openForm({
      eyebrow: "Leitura automática",
      title: "Chave da API de leitura",
      intro: "<p>Crie a chave em <strong>console.anthropic.com</strong> → API Keys, com crédito na conta. Cada nota lida custa em torno de R$ 0,10 a R$ 0,25. A chave fica criptografada neste computador.</p>",
      fields: [
        { name: "apiKey", label: "Chave da API (começa com sk-ant-)", type: "password", required: !integration.aiConfigured, full: true, autocomplete: "off", help: integration.aiConfigured ? "Deixe em branco para manter a chave atual." : "" },
        ...(integration.aiConfigured ? [{ name: "remove", label: "Desligar a leitura automática e apagar a chave", type: "checkbox", full: true }] : []),
      ],
      submitLabel: "Salvar",
      async onSubmit(data) {
        if (data.remove) await desktop().configureAi("");
        else if (data.apiKey) {
          if (!/^sk-ant-/.test(data.apiKey)) throw new Error("A chave da Anthropic começa com sk-ant-. Confira se copiou a chave inteira.");
          await desktop().configureAi(data.apiKey);
        }
        store.audit("Configuração", "Leitura de notas", data.remove ? "Leitura automática desligada" : "Chave da API de leitura atualizada");
        await refreshIntegration();
        mountSettings();
        Frotas.ui.toast(data.remove ? "Leitura automática desligada." : "Leitura automática ligada.");
      },
    });
  }

  function configureCloud() {
    const configured = integration.cloudConfigured;
    Frotas.ui.openForm({
      eyebrow: "Notas pelo celular",
      title: "Conexão com a nuvem (Supabase)",
      intro: "<p>Dados do projeto no Supabase: <strong>Project Settings → API</strong> (endereço e chave pública) e o login do escritório criado em <strong>Authentication → Users</strong>. O sistema testa a conexão antes de salvar.</p>",
      values: { url: integration.cloudUrl, email: integration.cloudEmail },
      fields: [
        { name: "url", label: "Endereço do projeto (Project URL)", required: true, full: true, placeholder: "https://xxxxxxxx.supabase.co" },
        { name: "anonKey", label: "Chave pública (anon / publishable)", type: "password", required: !configured, full: true, autocomplete: "off", help: configured ? "Deixe em branco para manter a atual." : "" },
        { name: "email", label: "E-mail do login do escritório", type: "email", required: true },
        { name: "password", label: "Senha do login do escritório", type: "password", required: !configured, autocomplete: "off", help: configured ? "Deixe em branco para manter a atual." : "" },
        ...(configured ? [{ name: "disconnect", label: "Desconectar a nuvem neste computador", type: "checkbox", full: true }] : []),
      ],
      submitLabel: "Testar e salvar",
      async onSubmit(data) {
        if (data.disconnect) {
          await desktop().disconnectCloud();
          store.audit("Configuração", "Notas pelo celular", "Nuvem desconectada");
        } else {
          await desktop().configureCloud({ url: data.url, email: data.email, anonKey: data.anonKey, password: data.password });
          store.audit("Configuração", "Notas pelo celular", `Nuvem conectada · ${data.email}`);
        }
        await refreshIntegration();
        mountSettings();
        Frotas.ui.toast(data.disconnect ? "Nuvem desconectada." : "Nuvem conectada com sucesso.");
        if (!data.disconnect) sync({ silent: false }).then(mountSettings);
      },
    });
  }

  function configureAppUrl() {
    Frotas.ui.openForm({
      eyebrow: "Notas pelo celular",
      title: "Endereço do aplicativo do celular",
      intro: "<p>Endereço onde a pasta <strong>celular</strong> foi publicada (por exemplo, no Netlify). Os assessores abrem esse endereço lendo o QR Code.</p>",
      values: { phoneAppUrl: store.get().settings.notes.phoneAppUrl },
      fields: [{ name: "phoneAppUrl", label: "Endereço (https://…)", type: "url", required: true, full: true, placeholder: "https://gestao-frotas.netlify.app" }],
      async onSubmit(data) {
        if (!/^https:\/\//i.test(data.phoneAppUrl)) throw new Error("O endereço precisa começar com https:// (a câmera do celular só funciona em endereço seguro).");
        store.updateSettings({ notes: { ...store.get().settings.notes, phoneAppUrl: data.phoneAppUrl.replace(/\/+$/, "") } }, "Endereço do aplicativo do celular atualizado");
        mountSettings();
      },
    });
  }

  function showQr() {
    const base = store.get().settings.notes.phoneAppUrl;
    const link = `${base}/#u=${encodeURIComponent(integration.cloudUrl)}&k=${encodeURIComponent(integration.cloudAnonKey)}`;
    const qr = qrcode(0, "M");
    qr.addData(link);
    qr.make();
    const element = dialog();
    element.innerHTML = `
      <div class="dialog-heading">
        <div><span class="eyebrow">Notas pelo celular</span><h3>Instalar no celular do assessor</h3></div>
        <button type="button" class="dialog-close" data-note-close aria-label="Fechar">×</button>
      </div>
      <div class="qr-layout">
        <div class="qr-box">${qr.createSvgTag({ cellSize: 5, margin: 2, scalable: true })}</div>
        <ol class="qr-steps">
          <li>Abra a câmera do celular e aponte para o código.</li>
          <li>Toque no link que aparecer.</li>
          <li>Entre com o usuário e a senha do assessor.</li>
          <li>No menu do navegador, toque em <strong>Adicionar à tela inicial</strong> para ficar com o ícone do sistema.</li>
        </ol>
      </div>
      <p class="footnote">O código só contém o endereço do aplicativo e a chave pública da nuvem; o acesso depende do usuário e da senha de cada assessor.</p>`;
    element.querySelector("[data-note-close]").addEventListener("click", () => element.close());
    element.showModal();
  }

  async function showAdvisors() {
    const people = await desktop().listAdvisors();
    const element = dialog();
    element.innerHTML = `
      <div class="dialog-heading">
        <div><span class="eyebrow">Notas pelo celular</span><h3>Pessoas com acesso ao aplicativo</h3></div>
        <button type="button" class="dialog-close" data-note-close aria-label="Fechar">×</button>
      </div>
      <div class="inbox-list">${people.map((person) => `<div class="inbox-row"><span class="inbox-type">${person.papel === "escritorio" ? "🏢" : "👤"}</span><div class="inbox-text"><strong>${esc(person.nome)}</strong><small>${person.papel === "escritorio" ? "Escritório" : "Assessor"} · desde ${dateBR(String(person.criado_em).slice(0, 10))}</small></div></div>`).join("") || "<p class='muted-text'>Nenhuma pessoa cadastrada.</p>"}</div>
      <p class="footnote">Para incluir um assessor: Supabase → Authentication → Users → Add user (e-mail no formato nome@frotas.local e senha, com "Auto Confirm User" marcado). O assessor entra no celular só com o nome antes do @.</p>`;
    element.querySelector("[data-note-close]").addEventListener("click", () => element.close());
    element.showModal();
  }

  // Atualização automática enquanto alguém está conectado.
  setInterval(() => sync(), SYNC_INTERVAL_MS);

  // Painel principal: mostra o bloco na hora e atualiza quando a situação da integração chega.
  function mountDashboard() {
    const fill = () => {
      const slot = document.querySelector("#notes-hero-slot");
      if (slot) slot.innerHTML = dashboardPanel();
    };
    refreshIntegration().then(() => {
      fill();
      if (integration.cloudConfigured && (!lastSync || Date.now() - lastSync > 60000)) sync().then(fill);
    });
  }

  Frotas.notas = { openReader, dashboardPanel, mountDashboard, mountSettings, sync, refreshIntegration, updateBadge, integration: () => integration, pending };
})();
