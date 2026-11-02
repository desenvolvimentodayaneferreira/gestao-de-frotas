"use strict";

// Inicialização, login, navegação e eventos globais.
Frotas.app = (() => {
  const { esc, initials, normalizeText, debounce, dateTimeBR } = Frotas.util;
  const store = Frotas.store;
  const auth = Frotas.auth;
  const INACTIVITY_LIMIT_MS = 60 * 60 * 1000;

  const $ = (selector) => document.querySelector(selector);
  let currentView = "dashboard";
  let currentParams = null;
  let searchTerm = "";
  let inactivityTimer = null;

  // ---------- Login e primeiro acesso ----------

  function showLogin(message = "") {
    $("#app-shell").classList.add("is-hidden");
    $("#login-screen").classList.remove("is-hidden");
    const setup = auth.needsSetup();
    $("#login-form").classList.toggle("is-hidden", setup);
    $("#setup-form").classList.toggle("is-hidden", !setup);
    $("#login-error").textContent = message;
    (setup ? $("#setup-name") : $("#username")).focus();
  }

  async function enterApp() {
    const user = auth.currentUser();
    $("#login-screen").classList.add("is-hidden");
    $("#app-shell").classList.remove("is-hidden");
    $("#current-user-name").textContent = user.name;
    $("#current-role").textContent = auth.ROLES[user.role].label;
    $("#user-avatar").textContent = initials(user.name);
    document.querySelectorAll("[data-permission]").forEach((element) => {
      element.classList.toggle("is-hidden", !auth.can(element.dataset.permission));
    });
    resetInactivity();
    go("dashboard");
    if (user.mustChangePassword) Frotas.adminForms.changeOwnPasswordForm(true);
  }

  function logout(message = "Sessão encerrada com segurança.") {
    unmountCurrent();
    auth.logout(message === "Sessão encerrada com segurança." ? "Saiu do sistema" : message);
    clearTimeout(inactivityTimer);
    $("#login-form").reset();
    showLogin("");
    Frotas.ui.toast(message);
  }

  function resetInactivity() {
    if (!auth.currentUser()) return;
    clearTimeout(inactivityTimer);
    inactivityTimer = setTimeout(() => logout("Sessão encerrada após 1 hora sem uso."), INACTIVITY_LIMIT_MS);
  }

  // ---------- Navegação ----------

  function unmountCurrent() {
    Frotas.common.destroyCharts();
    Frotas.views[currentView]?.unmount?.();
  }

  function render() {
    const view = Frotas.views[currentView];
    $("#page-title").textContent = view.title;
    $("#breadcrumb").textContent = view.section;
    $("#content-area").innerHTML = view.render(currentParams);
    document.querySelectorAll(".nav-item").forEach((item) => {
      const target = currentView === "veiculo" ? "veiculos" : currentView;
      item.classList.toggle("active", item.dataset.view === target);
    });
    view.mount?.(currentParams);
    updateBadges();
  }

  function go(viewName, params = null) {
    const view = Frotas.views[viewName];
    if (!view || !auth.currentUser()) return;
    if (view.permission && !auth.can(view.permission)) {
      Frotas.ui.toast("Seu perfil não tem acesso a este módulo.", "warning");
      return;
    }
    unmountCurrent();
    currentView = viewName;
    currentParams = params;
    searchTerm = "";
    $("#global-search").value = "";
    Frotas.ui.resetPages();
    render();
    $("#content-area").scrollTop = 0;
    window.scrollTo(0, 0);
  }

  // Redesenha a tela atual mantendo filtros e posição de rolagem.
  function refresh() {
    if (!auth.currentUser()) return;
    const scroll = window.scrollY;
    unmountCurrent();
    render();
    window.scrollTo(0, scroll);
  }

  function updateBadges() {
    const alerts = store.alerts().filter((alert) => alert.severity !== "info");
    const badge = $("#alert-count");
    badge.textContent = alerts.length;
    badge.classList.toggle("is-hidden", alerts.length === 0);
    const navBadge = $("#alert-count-nav");
    navBadge.textContent = alerts.length;
    navBadge.classList.toggle("is-hidden", alerts.length === 0);
    const issues = store.issues().length;
    const issueBadge = $("#issue-count");
    issueBadge.textContent = issues;
    issueBadge.classList.toggle("is-hidden", issues === 0);
    Frotas.notas?.updateBadge();
    const saved = store.get().updatedAt;
    $("#save-status").textContent = store.lastSaveError() ? "Falha ao salvar" : `Salvo · ${dateTimeBR(saved).split(" ").pop()}`;
  }

  function toggleNotifications(force) {
    const panel = $("#notification-panel");
    const open = force ?? panel.classList.contains("is-hidden");
    if (!open) {
      panel.classList.add("is-hidden");
      return;
    }
    const alerts = store.alerts();
    panel.innerHTML = `
      <div class="notification-head"><strong>Alertas</strong><button class="text-button" data-action="go" data-view="alertas">Ver todos</button></div>
      ${alerts.length ? alerts.slice(0, 6).map((alert) => `
        <button class="notification-item" data-action="go" data-view="${esc(alert.view || "alertas")}">
          <span class="alert-dot ${alert.severity}"></span>
          <div><strong>${esc(alert.title)}</strong><small>${esc(alert.subject)}</small></div>
        </button>`).join("") : `<p class="muted-text">Nenhum alerta.</p>`}`;
    panel.classList.remove("is-hidden");
  }

  // ---------- Eventos ----------

  function bindEvents() {
    $("#login-form").addEventListener("submit", async (event) => {
      event.preventDefault();
      const button = event.submitter || $("#login-form [type=submit]");
      button.disabled = true;
      $("#login-error").textContent = "";
      try {
        await auth.login($("#username").value, $("#password").value);
        await enterApp();
      } catch (error) {
        $("#login-error").textContent = error.message;
        $("#password").select();
      } finally {
        button.disabled = false;
      }
    });

    $("#setup-form").addEventListener("submit", async (event) => {
      event.preventDefault();
      const error = $("#setup-error");
      error.textContent = "";
      const password = $("#setup-password").value;
      if (password !== $("#setup-password-confirm").value) {
        error.textContent = "As senhas não conferem.";
        return;
      }
      try {
        const user = await auth.createUser({ name: $("#setup-name").value, username: $("#setup-username").value, role: "administrador", password });
        await auth.login(user.username, password);
        await enterApp();
        Frotas.ui.toast("Administrador criado. Cadastre os demais usuários em Usuários e acessos.");
      } catch (problem) {
        error.textContent = problem.message;
      }
    });

    document.querySelectorAll("[data-toggle-password]").forEach((button) => {
      button.addEventListener("click", () => {
        const input = document.getElementById(button.dataset.togglePassword);
        input.type = input.type === "password" ? "text" : "password";
      });
    });

    $("#main-nav").addEventListener("click", (event) => {
      const item = event.target.closest("[data-view]");
      if (item) go(item.dataset.view);
    });

    $("#logout-button").addEventListener("click", () => logout());
    $("#change-password-button").addEventListener("click", () => Frotas.adminForms.changeOwnPasswordForm(false));
    $(".notification-button").addEventListener("click", (event) => {
      event.stopPropagation();
      toggleNotifications();
    });
    document.addEventListener("click", (event) => {
      if (!event.target.closest("#notification-panel")) toggleNotifications(false);
    });

    $("#global-search").addEventListener("input", debounce(() => {
      searchTerm = normalizeText($("#global-search").value).length ? $("#global-search").value.trim().toLowerCase() : "";
      Frotas.ui.resetPages();
      refresh();
      $("#global-search").focus();
    }, 300));

    // Ações declaradas nos botões via data-action (delegação de eventos).
    document.addEventListener("click", (event) => {
      if (Frotas.ui.handleTableClick(event)) {
        refresh();
        return;
      }
      const target = event.target.closest("[data-action]");
      if (!target || !auth.currentUser()) return;
      const action = target.dataset.action;
      if (action === "go") {
        toggleNotifications(false);
        go(target.dataset.view);
        return;
      }
      const handler = Frotas.actions[action];
      if (handler) {
        event.preventDefault();
        Promise.resolve(handler(target, event)).catch((error) => Frotas.ui.toast(error.message, "danger"));
      }
    });

    document.addEventListener("change", (event) => {
      const filter = event.target.closest("[data-filter]");
      if (filter) {
        Frotas.common.filters[filter.dataset.filter] = filter.value;
        Frotas.ui.resetPages();
        refresh();
        return;
      }
      const changeTarget = event.target.closest("[data-action-change]");
      if (changeTarget) Frotas.changeActions[changeTarget.dataset.actionChange]?.(changeTarget);
    });

    ["click", "keydown", "mousemove", "touchstart"].forEach((name) => document.addEventListener(name, resetInactivity, { passive: true }));
    window.addEventListener("beforeunload", () => store.flush());

    // Após qualquer gravação, a tela se atualiza (exceto enquanto um formulário está aberto).
    store.onChange(debounce(() => {
      if (!auth.currentUser()) return;
      if ($("#form-dialog").open) {
        $("#form-dialog").addEventListener("close", refresh, { once: true });
        return;
      }
      refresh();
    }, 60));
  }

  async function boot() {
    bindEvents();
    try {
      await store.load();
    } catch (error) {
      console.error(error);
      document.body.innerHTML = `<div class="fatal-error"><h1>Não foi possível abrir os dados</h1><p>${esc(error.message)}</p><p>Restaure uma cópia de segurança da pasta de dados ou contate o suporte.</p></div>`;
      return;
    }
    $("#today-label").textContent = Frotas.util.longToday();
    showLogin();
  }

  return { boot, go, refresh, logout, searchTerm: () => searchTerm, current: () => currentView };
})();

window.addEventListener("DOMContentLoaded", () => Frotas.app.boot());
