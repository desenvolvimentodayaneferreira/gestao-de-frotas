"use strict";

// Administração: usuários, parâmetros, backups e integração de rastreamento.
(() => {
  const { esc, dateBR, dateTimeBR, number, todayISO, money } = Frotas.util;
  const C = Frotas.common;
  const { status, personCell, table, openForm, confirm, toast } = Frotas.ui;
  const store = Frotas.store;
  const auth = Frotas.auth;

  const roleOptions = () => Object.entries(auth.ROLES)
    .filter(([key]) => key !== "administrador" || auth.currentUser().role === "administrador")
    .map(([value, role]) => ({ value, label: `${role.label} — ${role.description}` }));

  function userStatus(user) {
    if (!user.active) return status("Desativado", "neutral");
    if (user.locked) return status("Bloqueado", "danger");
    if (user.mustChangePassword) return status("Trocar senha", "warning");
    return status("Ativo");
  }

  function activeAdmins() {
    return store.list("users").filter((user) => user.role === "administrador" && user.active);
  }

  Frotas.views.usuarios = {
    title: "Usuários e acessos",
    section: "Administração",
    permission: "usuarios",
    render() {
      const users = store.list("users");
      return `
        ${C.pageIntro("Usuários e acessos", "Cada pessoa tem login próprio. Senhas são guardadas criptografadas e ninguém consegue vê-las.", `<button class="primary-button" data-action="new-user">Novo usuário</button>`)}
        <section class="panel module-panel">
          <div class="summary-strip summary-4">
            <div class="summary-item"><span>Usuários ativos</span><strong>${users.filter((user) => user.active).length}</strong></div>
            <div class="summary-item"><span>Bloqueados</span><strong class="${users.some((user) => user.locked) ? "text-danger" : ""}">${users.filter((user) => user.locked).length}</strong></div>
            <div class="summary-item"><span>Gerência / administradores</span><strong>${users.filter((user) => user.role !== "colaborador").length}</strong></div>
            <div class="summary-item"><span>Política de senha</span><strong class="small-strong">Mínimo de 8 caracteres, letras e números · bloqueio após ${auth.MAX_ATTEMPTS} erros</strong></div>
          </div>
          ${table({
            id: "users",
            rows: users,
            columns: [
              { label: "Usuário", render: (user) => personCell(user.name, `login: ${user.username}`), sortValue: (user) => user.name },
              { label: "Perfil", render: (user) => esc(auth.ROLES[user.role]?.label || user.role) },
              { label: "Último acesso", render: (user) => dateTimeBR(user.lastLoginAt), sortValue: (user) => user.lastLoginAt || 0 },
              { label: "Situação", render: userStatus },
              { label: "", sortable: false, render: (user) => `<div class="row-actions">
                  ${user.locked ? `<button class="secondary-button small" data-action="unlock-user" data-id="${esc(user.id)}">Desbloquear</button>` : ""}
                  <button class="secondary-button small" data-action="reset-password" data-id="${esc(user.id)}">Redefinir senha</button>
                  <button class="icon-action" data-action="edit-user" data-id="${esc(user.id)}" title="Editar">✎</button>
                </div>` },
            ],
          })}
        </section>
        <section class="panel spaced permissions-panel">
          <div class="panel-heading"><div><h4>O que cada perfil pode fazer</h4></div></div>
          <div class="permission-grid">
            <div><strong>Colaborador</strong><p>Consulta painel, GPS e cadastros. Lança abastecimentos e despesas e corrige os próprios lançamentos.</p></div>
            <div><strong>Gerência</strong><p>Tudo do colaborador, mais cadastros de veículos e motoristas, edição e exclusão de lançamentos, relatórios, auditoria, usuários e backups.</p></div>
            <div><strong>Administrador</strong><p>Acesso total, incluindo parâmetros do sistema, integração do rastreador e restauração de cópias de segurança.</p></div>
          </div>
        </section>`;
    },
  };

  function userForm(user = null) {
    openForm({
      eyebrow: user ? "Editar usuário" : "Novo usuário",
      title: user ? user.name : "Cadastrar usuário",
      values: user ? { ...user } : { role: "colaborador", active: true },
      fields: [
        { name: "name", label: "Nome completo", required: true, full: true },
        ...(user ? [] : [{ name: "username", label: "Login", required: true, placeholder: "ex.: maria.silva", autocomplete: "off" }]),
        { name: "role", label: "Perfil", type: "select", required: true, options: roleOptions(), placeholder: false, full: !user },
        ...(user ? [{ name: "active", label: "Usuário ativo", type: "checkbox", full: true }] : [
          { name: "password", label: "Senha provisória", type: "password", required: true, autocomplete: "new-password", help: "A pessoa será obrigada a trocar no primeiro acesso." },
        ]),
      ],
      async onSubmit(data) {
        if (user) {
          const removingAdmin = user.role === "administrador" && (data.role !== "administrador" || !data.active);
          if (removingAdmin && activeAdmins().length <= 1) throw new Error("É preciso manter pelo menos um administrador ativo.");
          if (user.id === auth.currentUser().id && !data.active) throw new Error("Você não pode desativar o próprio usuário.");
          store.update("users", user.id, { name: data.name, role: data.role, active: data.active }, `${data.name} (${auth.ROLES[data.role].label})`);
          toast("Usuário atualizado.");
        } else {
          await auth.createUser({ ...data, mustChangePassword: true });
          toast("Usuário criado. Informe o login e a senha provisória à pessoa.");
        }
      },
    });
  }

  // ---------- Configurações ----------

  let storageInfo = null;

  async function loadStorageInfo() {
    if (!window.frotasDesktop) return;
    storageInfo = await window.frotasDesktop.info();
    const target = document.querySelector("#storage-info");
    if (target) target.innerHTML = storageInfoHtml();
  }

  function storageInfoHtml() {
    if (!window.frotasDesktop) return `<p class="muted-text">Modo navegador: os dados ficam guardados neste navegador. Use “Exportar cópia” regularmente.</p>`;
    if (!storageInfo) return `<p class="muted-text">Carregando…</p>`;
    return `
      <dl class="detail-list single">
        <div><dt>Arquivo de dados</dt><dd class="mono">${esc(storageInfo.dataFile)}</dd></div>
        <div><dt>Proteção</dt><dd>${storageInfo.protegido ? "Criptografado pelo Windows" : "Sem criptografia"}</dd></div>
        <div><dt>Tamanho</dt><dd>${number(storageInfo.size / 1024, 0)} KB</dd></div>
        <div><dt>Cópias automáticas</dt><dd>${storageInfo.backupCount} (uma por dia, mantidas por 60 dias)</dd></div>
        <div><dt>Última cópia</dt><dd>${esc(storageInfo.backups[0] || "ainda não criada")}</dd></div>
      </dl>`;
  }

  Frotas.views.configuracoes = {
    title: "Configurações",
    section: "Administração",
    permission: "backup",
    render() {
      const db = store.get();
      const settings = db.settings;
      const gps = settings.gps;
      const isAdmin = auth.can("config");
      return `
        ${C.pageIntro("Configurações", "Cópias de segurança, parâmetros de alertas e integração do rastreador.")}
        <section class="settings-grid">
          <article class="panel">
            <div class="panel-heading"><div><h4>Dados e cópias de segurança</h4><p>O sistema salva automaticamente a cada alteração</p></div></div>
            <div class="panel-body">
              <div id="storage-info">${storageInfoHtml()}</div>
              <div class="button-row">
                ${window.frotasDesktop ? `<button class="secondary-button" data-action="backup-now">Fazer cópia agora</button><button class="secondary-button" data-action="open-data-folder">Abrir pasta dos dados</button>` : ""}
                <button class="secondary-button" data-action="export-data">Exportar cópia</button>
                ${isAdmin ? `<button class="danger-button" data-action="import-data">Restaurar cópia</button>` : ""}
              </div>
              <p class="footnote">Os dados e as cópias automáticas ficam protegidos pelo Windows e só abrem neste computador. A cópia exportada abre em qualquer computador e não tem proteção: exporte uma por semana e guarde em local seguro (pendrive ou nuvem da empresa).</p>
            </div>
          </article>

          <article class="panel">
            <div class="panel-heading"><div><h4>Parâmetros</h4><p>Regras usadas nos alertas e na conferência dos lançamentos</p></div>${isAdmin ? `<button class="text-button" data-action="edit-settings">Editar</button>` : ""}</div>
            <div class="panel-body">
              <dl class="detail-list">
                <div><dt>Empresa</dt><dd>${esc(settings.company)}</dd></div>
                <div><dt>Cidade-base</dt><dd>${esc(settings.city)}</dd></div>
                <div><dt>Antecedência dos alertas</dt><dd>${settings.alertDays} dias</dd></div>
                <div><dt>Intervalo de revisão</dt><dd>${number(settings.serviceIntervalKm)} km</dd></div>
                <div><dt>Faixa de preço do combustível</dt><dd>${money(settings.fuelPriceMin)} a ${money(settings.fuelPriceMax)} por litro</dd></div>
                <div><dt>Raio da área de atuação</dt><dd>${settings.areaRadiusKm} km</dd></div>
              </dl>
            </div>
          </article>

          <article class="panel">
            <div class="panel-heading"><div><h4>Integração do rastreador (GPS)</h4><p>Conexão com a plataforma de rastreamento da empresa</p></div>${isAdmin ? `<button class="text-button" data-action="edit-gps">Configurar</button>` : ""}</div>
            <div class="panel-body">
              <dl class="detail-list">
                <div><dt>Modo</dt><dd>${{ off: "Desligado", demo: "Demonstração (posições simuladas)", api: "Conectado ao provedor" }[gps.mode]}</dd></div>
                <div><dt>Provedor</dt><dd>${esc(gps.provider || "—")}</dd></div>
                <div><dt>Atualização</dt><dd>a cada ${gps.intervalSec} s</dd></div>
                <div><dt>Última sincronização</dt><dd>${gps.lastSync ? dateTimeBR(gps.lastSync) : "—"}</dd></div>
              </dl>
              ${gps.lastError ? `<p class="form-error">${esc(gps.lastError)}</p>` : ""}
              <p class="footnote">Para conectar, solicite à empresa de rastreamento o endereço da API de posições e a chave de acesso. O sistema reconhece listas com placa, latitude, longitude, velocidade, ignição e data/hora.</p>
            </div>
          </article>

          <article class="panel" id="notes-settings-slot"></article>

          <article class="panel">
            <div class="panel-heading"><div><h4>Sobre</h4></div></div>
            <div class="panel-body">
              <dl class="detail-list">
                <div><dt>Sistema</dt><dd>Gestão de Frotas</dd></div>
                <div><dt>Versão</dt><dd>1.0.0</dd></div>
                <div><dt>Desenvolvimento</dt><dd>Dayane Ferreira · desenvolvimento.dayaneferreira@gmail.com</dd></div>
                <div><dt>Base inicial</dt><dd>${db.importInfo ? `${esc(db.importInfo.file)} · ${db.importInfo.records} lançamentos (${dateBR(db.importInfo.period[0])} a ${dateBR(db.importInfo.period[1])})` : "—"}</dd></div>
                <div><dt>Registros</dt><dd>${db.vehicles.length} veículos · ${db.fuel.length} abastecimentos · ${db.expenses.length} despesas</dd></div>
                <div><dt>Auditoria</dt><dd>${db.audit.length} eventos registrados</dd></div>
              </dl>
            </div>
          </article>
        </section>`;
    },
    mount() {
      loadStorageInfo();
      Frotas.notas.mountSettings();
    },
  };

  function settingsForm() {
    const settings = store.get().settings;
    openForm({
      eyebrow: "Configurações",
      title: "Parâmetros do sistema",
      values: settings,
      fields: [
        { name: "company", label: "Empresa", required: true },
        { name: "city", label: "Cidade-base", required: true },
        { name: "alertDays", label: "Avisar vencimentos com antecedência de (dias)", type: "number", min: 1, max: 180, required: true },
        { name: "serviceIntervalKm", label: "Intervalo padrão entre revisões (km)", type: "number", min: 1000, required: true },
        { name: "fuelPriceMin", label: "Preço mínimo aceitável por litro (R$)", type: "decimal", required: true },
        { name: "fuelPriceMax", label: "Preço máximo aceitável por litro (R$)", type: "decimal", required: true },
        { name: "areaRadiusKm", label: "Raio da área de atuação (km)", type: "number", min: 1, required: true },
      ],
      async onSubmit(data) {
        if (data.fuelPriceMin >= data.fuelPriceMax) throw new Error("O preço mínimo deve ser menor que o máximo.");
        store.updateSettings(data, "Parâmetros do sistema alterados");
        toast("Parâmetros salvos.");
      },
    });
  }

  function gpsForm() {
    const gps = store.get().settings.gps;
    openForm({
      eyebrow: "Rastreamento",
      title: "Integração do rastreador",
      values: gps,
      intro: `<p>Use <strong>Demonstração</strong> apenas em apresentações: as posições são simuladas e a tela informa isso claramente.</p>`,
      fields: [
        { name: "mode", label: "Modo", type: "select", placeholder: false, full: true, options: [{ value: "off", label: "Desligado" }, { value: "demo", label: "Demonstração (posições simuladas)" }, { value: "api", label: "Conectado à API do provedor" }] },
        { name: "provider", label: "Nome do provedor" },
        { name: "portalUrl", label: "Site da plataforma de rastreamento", placeholder: "https://rastreador.exemplo.com/", help: "Abre pelo botão na Visão GPS." },
        { name: "intervalSec", label: "Atualizar a cada (segundos)", type: "number", min: 15, max: 3600 },
        { name: "url", label: "Endereço da API de posições", full: true, placeholder: "https://api.provedor.com.br/v1/posicoes" },
        { name: "token", label: "Chave de acesso (token)", type: "password", full: true, autocomplete: "off" },
      ],
      submitLabel: "Salvar e testar",
      async onSubmit(data) {
        if (data.mode === "api" && !/^https:\/\//i.test(data.url)) throw new Error("Informe um endereço de API começando com https://");
        if (data.portalUrl && !/^https?:\/\//i.test(data.portalUrl)) throw new Error("O site da plataforma deve começar com https://");
        const next = { ...gps, ...data, intervalSec: data.intervalSec || 60, lastError: "" };
        if (data.mode === "api") {
          const previous = store.get().settings.gps;
          store.get().settings.gps = next;
          try {
            const positions = await Frotas.gps.fetchProvider();
            next.lastSync = Date.now();
            toast(`Conexão bem-sucedida: ${positions.length} posição(ões) recebida(s).`);
          } catch (error) {
            store.get().settings.gps = previous;
            throw new Error(`Não foi possível conectar: ${error.message}`);
          }
        }
        store.updateSettings({ gps: next }, `Rastreamento: modo ${data.mode}`);
        if (data.mode !== "api") toast("Configuração do rastreamento salva.");
      },
    });
  }

  function changeOwnPasswordForm(forced = false) {
    const user = auth.currentUser();
    openForm({
      eyebrow: forced ? "Primeiro acesso" : "Minha conta",
      title: "Alterar senha",
      intro: forced ? `<p>Por segurança, defina uma senha pessoal antes de continuar.</p>` : "",
      fields: [
        { name: "password", label: "Nova senha", type: "password", required: true, autocomplete: "new-password", help: "Mínimo de 8 caracteres, com letras e números." },
        { name: "confirmPassword", label: "Repita a nova senha", type: "password", required: true, autocomplete: "new-password" },
      ],
      submitLabel: "Salvar nova senha",
      async onSubmit(data) {
        if (data.password !== data.confirmPassword) throw new Error("As senhas não conferem.");
        await auth.changePassword(user, data.password);
        toast("Senha alterada com sucesso.");
      },
    });
  }

  Frotas.actions = Object.assign(Frotas.actions || {}, {
    "new-user": () => userForm(),
    "edit-user": (button) => userForm(store.find("users", button.dataset.id)),
    "unlock-user": (button) => {
      const user = store.find("users", button.dataset.id);
      store.update("users", user.id, { locked: false, failedAttempts: 0 }, `Desbloqueio · ${user.name}`);
      toast(`${user.name} desbloqueado(a).`);
    },
    "reset-password": (button) => {
      const user = store.find("users", button.dataset.id);
      openForm({
        eyebrow: "Redefinir senha",
        title: user.name,
        fields: [{ name: "password", label: "Senha provisória", type: "password", required: true, autocomplete: "new-password", help: "A pessoa deverá trocar no próximo acesso." }],
        async onSubmit(data) {
          await auth.changePassword(user, data.password);
          store.update("users", user.id, { mustChangePassword: user.id !== auth.currentUser().id }, `Senha redefinida · ${user.name}`);
          toast("Senha provisória definida.");
        },
      });
    },
    "change-own-password": () => changeOwnPasswordForm(false),
    "edit-settings": () => settingsForm(),
    "edit-gps": () => gpsForm(),
    "backup-now": async () => {
      await store.flush();
      const file = await window.frotasDesktop.backupNow();
      toast(file ? "Cópia de segurança criada." : "Ainda não há dados para copiar.");
      store.audit("Backup", "Dados", "Cópia manual criada");
      loadStorageInfo();
    },
    "open-data-folder": () => window.frotasDesktop?.openDataFolder(),
    "export-data": async () => {
      await store.flush();
      const name = `gestao-frotas-copia-${todayISO()}.json`;
      const saved = window.frotasDesktop ? await window.frotasDesktop.exportData(store.exportJSON(), name) : await Frotas.util.downloadText(store.exportJSON(), name, "json");
      if (saved) {
        store.audit("Backup", "Dados", "Cópia exportada");
        toast("Cópia exportada. Ela não tem proteção: guarde em local seguro.");
      }
    },
    "import-data": async () => {
      const ok = await confirm("Restaurar uma cópia substitui TODOS os dados atuais pelos da cópia escolhida. Uma cópia do estado atual é feita antes. Continuar?", { title: "Restaurar cópia de segurança", confirmLabel: "Escolher arquivo", danger: true });
      if (!ok) return;
      let text = null;
      if (window.frotasDesktop) {
        await window.frotasDesktop.backupNow();
        text = await window.frotasDesktop.importData();
      } else {
        text = await new Promise((resolve) => {
          const input = document.createElement("input");
          input.type = "file";
          input.accept = ".json,application/json";
          input.onchange = () => input.files[0] ? input.files[0].text().then(resolve) : resolve(null);
          input.click();
        });
      }
      if (!text) return;
      if (text.erro) {
        toast(text.erro, "danger");
        return;
      }
      try {
        const data = JSON.parse(text);
        if (!Array.isArray(data.vehicles) || !Array.isArray(data.users) || !data.users.length) throw new Error("Arquivo não é uma cópia válida do Gestão de Frotas.");
        const user = auth.currentUser();
        store.replaceAll(data);
        store.audit("Restauração", "Dados", `Cópia restaurada por ${user.name}`, user.name);
        await store.flush();
        toast("Cópia restaurada. Entre novamente.");
        Frotas.app.logout("Dados restaurados. Entre novamente.");
      } catch (error) {
        toast(error.message, "danger");
      }
    },
  });

  Frotas.adminForms = { changeOwnPasswordForm };
})();
