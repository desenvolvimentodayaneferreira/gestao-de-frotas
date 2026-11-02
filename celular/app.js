"use strict";

// Notas da Frota · aplicativo do celular dos assessores.
// Fotografa a nota, informa veículo e km e envia para a nuvem; o escritório confere e lança no sistema.
(() => {
  const CONFIG_KEY = "frotas-notas:config";
  const VEHICLE_KEY = "frotas-notas:ultimo-veiculo";
  const LOGIN_DOMAIN = "frotas.local";
  const STATUS = {
    enviada: ["Enviada", "sent"],
    recebida: ["Recebida no escritório", "received"],
    lancada: ["Lançada", "done"],
    recusada: ["Recusada", "rejected"],
  };

  const $ = (selector) => document.querySelector(selector);
  let db = null;
  let profile = null;
  let photo = null; // { blob, url }
  let vehicles = [];

  // ---------- Configuração (vem do QR Code: #u=<endereço>&k=<chave pública>) ----------

  function readConfig() {
    const hash = new URLSearchParams(location.hash.slice(1));
    if (hash.get("u") && hash.get("k")) {
      localStorage.setItem(CONFIG_KEY, JSON.stringify({ url: hash.get("u"), key: hash.get("k") }));
      history.replaceState(null, "", location.pathname);
    }
    try {
      return JSON.parse(localStorage.getItem(CONFIG_KEY) || "null");
    } catch {
      return null;
    }
  }

  function show(id) {
    document.querySelectorAll(".screen").forEach((screen) => screen.classList.toggle("is-hidden", screen.id !== id));
    window.scrollTo(0, 0);
  }

  function esc(text) {
    return String(text ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
  }

  function friendly(error) {
    const message = error?.message || String(error);
    if (!navigator.onLine || /Failed to fetch|NetworkError|network/i.test(message)) return "Sem internet agora. Tente de novo quando tiver sinal; a foto continua aqui.";
    if (/Invalid login credentials/i.test(message)) return "Usuário ou senha incorretos.";
    if (/JWT|expired|session/i.test(message)) return "Sua sessão expirou. Entre novamente.";
    return message;
  }

  // ---------- Login ----------

  async function start() {
    const config = readConfig();
    if (!config) return show("screen-setup");
    db = supabase.createClient(config.url, config.key, { auth: { persistSession: true, autoRefreshToken: true } });
    const { data } = await db.auth.getSession();
    if (data.session) await enter();
    else show("screen-login");
  }

  async function enter() {
    const { data: userData } = await db.auth.getUser();
    if (!userData.user) return show("screen-login");
    const { data } = await db.from("perfis").select("nome").eq("user_id", userData.user.id).maybeSingle();
    profile = { id: userData.user.id, nome: data?.nome || userData.user.email.split("@")[0] };
    $("#who").textContent = profile.nome;
    $("#logout").classList.remove("is-hidden");
    show("screen-home");
    loadVehicles();
    loadMyNotes();
  }

  $("#login-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.target;
    const error = form.querySelector(".error");
    const button = form.querySelector("button");
    error.textContent = "";
    button.disabled = true;
    const user = form.user.value.trim().toLowerCase();
    const email = user.includes("@") ? user : `${user}@${LOGIN_DOMAIN}`;
    try {
      const { error: problem } = await db.auth.signInWithPassword({ email, password: form.password.value });
      if (problem) throw problem;
      form.reset();
      await enter();
    } catch (problem) {
      error.textContent = friendly(problem);
    } finally {
      button.disabled = false;
    }
  });

  $("#logout").addEventListener("click", async () => {
    await db.auth.signOut();
    profile = null;
    $("#who").textContent = "";
    $("#logout").classList.add("is-hidden");
    show("screen-login");
  });

  // ---------- Veículos e minhas notas ----------

  async function loadVehicles() {
    const { data, error } = await db.from("veiculos").select("id, nome, placa").eq("ativo", true).order("nome");
    if (error) return;
    vehicles = data;
    const select = $("#send-form").veiculo;
    const last = localStorage.getItem(VEHICLE_KEY);
    select.innerHTML = `<option value="">Selecione o veículo</option>${vehicles.map((vehicle) => `<option value="${esc(vehicle.id)}"${vehicle.id === last ? " selected" : ""}>${esc(vehicle.nome)}${vehicle.placa ? ` · ${esc(vehicle.placa)}` : ""}</option>`).join("")}`;
  }

  async function loadMyNotes() {
    const list = $("#my-notes");
    const { data, error } = await db.from("notas").select("id, criado_em, tipo, veiculo_id, status, motivo").order("criado_em", { ascending: false }).limit(30);
    if (error) {
      list.innerHTML = `<li class="muted">${esc(friendly(error))}</li>`;
      return;
    }
    if (!data.length) {
      list.innerHTML = `<li class="muted">Nenhuma nota enviada ainda.</li>`;
      return;
    }
    list.innerHTML = data.map((note) => {
      const [label, type] = STATUS[note.status] || [note.status, "sent"];
      const vehicle = vehicles.find((item) => item.id === note.veiculo_id);
      const when = new Date(note.criado_em).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
      return `<li>
        <span class="note-icon">${note.tipo === "abastecimento" ? "⛽" : "🧾"}</span>
        <div><strong>${esc(vehicle?.nome || "Veículo")}</strong><small>${when}</small>${note.motivo ? `<small class="reason">Motivo: ${esc(note.motivo)}</small>` : ""}</div>
        <span class="status ${type}">${label}</span>
      </li>`;
    }).join("");
  }

  $("#reload-list").addEventListener("click", () => {
    loadVehicles();
    loadMyNotes();
  });

  // ---------- Foto ----------

  // Reduz a foto para no máximo 1800 px (envio rápido no 4G, nota ainda legível).
  async function compress(file) {
    const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
    const scale = Math.min(1, 1800 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    return new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.85));
  }

  async function onPhoto(event) {
    const file = event.target.files[0];
    event.target.value = "";
    if (!file) return;
    const blob = await compress(file).catch(() => file);
    if (photo) URL.revokeObjectURL(photo.url);
    photo = { blob, url: URL.createObjectURL(blob) };
    $("#preview").src = photo.url;
    $("#send-form .error").textContent = "";
    show("screen-send");
  }

  $("#camera-input").addEventListener("change", onPhoto);
  $("#gallery-input").addEventListener("change", onPhoto);
  $("#retake").addEventListener("click", () => $("#camera-input").click());
  $("#cancel-send").addEventListener("click", () => show("screen-home"));

  const kmField = $("#km-field");
  document.querySelectorAll('input[name="tipo"]').forEach((radio) => radio.addEventListener("change", () => {
    const fuel = $("#send-form").tipo.value === "abastecimento";
    kmField.classList.toggle("is-hidden", !fuel);
    $("#send-form").km.required = fuel;
  }));
  $("#send-form").km.required = true;

  // ---------- Envio ----------

  $("#send-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.target;
    const error = form.querySelector(".error");
    error.textContent = "";
    if (!photo) return show("screen-home");
    const tipo = form.tipo.value;
    const km = tipo === "abastecimento" ? Number(form.km.value) : null;
    if (tipo === "abastecimento" && !(km > 0)) {
      error.textContent = "Informe a quilometragem do painel.";
      return;
    }
    show("screen-done");
    $("#done-icon").textContent = "⏳";
    $("#done-title").textContent = "Enviando…";
    $("#done-text").textContent = "Não feche o aplicativo.";
    $("#done-ok").classList.add("is-hidden");
    const path = `${profile.id}/${crypto.randomUUID()}.jpg`;
    try {
      const upload = await db.storage.from("notas").upload(path, photo.blob, { contentType: "image/jpeg", upsert: false });
      if (upload.error) throw upload.error;
      const insert = await db.from("notas").insert({
        tipo, veiculo_id: form.veiculo.value, km, observacao: form.obs.value.trim() || null, foto_path: path, assessor_nome: profile.nome,
      });
      if (insert.error) {
        await db.storage.from("notas").remove([path]);
        throw insert.error;
      }
      localStorage.setItem(VEHICLE_KEY, form.veiculo.value);
      URL.revokeObjectURL(photo.url);
      photo = null;
      form.km.value = "";
      form.obs.value = "";
      $("#done-icon").textContent = "✅";
      $("#done-title").textContent = "Nota enviada!";
      $("#done-text").textContent = "O escritório vai conferir e lançar. Acompanhe em \"Minhas notas\".";
      $("#done-ok").classList.remove("is-hidden");
    } catch (problem) {
      show("screen-send");
      error.textContent = friendly(problem);
    }
  });

  $("#done-ok").addEventListener("click", () => {
    show("screen-home");
    loadMyNotes();
  });

  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
  start().catch((problem) => {
    show("screen-login");
    $("#login-form .error").textContent = friendly(problem);
  });
})();
