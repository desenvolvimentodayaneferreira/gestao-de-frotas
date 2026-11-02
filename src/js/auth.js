"use strict";

// Autenticação local: senhas guardadas apenas como hash PBKDF2 com sal individual.
Frotas.auth = (() => {
  const MAX_ATTEMPTS = 5;
  const ITERATIONS = 150000;

  const ROLES = {
    colaborador: { label: "Colaborador", description: "Lança abastecimentos e despesas" },
    gerencia: { label: "Gerência", description: "Gestão completa, relatórios e usuários" },
    administrador: { label: "Administrador", description: "Acesso total, integrações e backups" },
  };

  // O que cada perfil pode fazer.
  const PERMISSIONS = {
    colaborador: ["lancar"],
    gerencia: ["lancar", "editar", "excluir", "cadastros", "usuarios", "relatorios", "auditoria", "backup"],
    administrador: ["lancar", "editar", "excluir", "cadastros", "usuarios", "relatorios", "auditoria", "backup", "config"],
  };

  let current = null;

  function toHex(buffer) {
    return [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  }

  function fromHex(hex) {
    return new Uint8Array(hex.match(/.{2}/g).map((pair) => parseInt(pair, 16)));
  }

  async function hashPassword(password, saltHex) {
    const salt = saltHex ? fromHex(saltHex) : crypto.getRandomValues(new Uint8Array(16));
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
    const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt, iterations: ITERATIONS, hash: "SHA-256" }, key, 256);
    return { hash: toHex(bits), salt: toHex(salt) };
  }

  function passwordProblem(password) {
    if (!password || password.length < 8) return "A senha deve ter pelo menos 8 caracteres.";
    if (!/[A-Za-z]/.test(password) || !/\d/.test(password)) return "A senha deve combinar letras e números.";
    return "";
  }

  function users() {
    return Frotas.store.get().users;
  }

  function needsSetup() {
    return users().length === 0;
  }

  async function createUser({ name, username, role, password, mustChangePassword = false }) {
    const login = String(username).trim().toLowerCase();
    if (!/^[a-z0-9._-]{3,30}$/.test(login)) throw new Error("O login deve ter de 3 a 30 caracteres: letras, números, ponto, hífen ou sublinhado.");
    if (users().some((user) => user.username === login)) throw new Error("Já existe um usuário com este login.");
    const problem = passwordProblem(password);
    if (problem) throw new Error(problem);
    const { hash, salt } = await hashPassword(password);
    return Frotas.store.create("users", {
      name: String(name).trim(),
      username: login,
      role,
      passwordHash: hash,
      salt,
      active: true,
      locked: false,
      failedAttempts: 0,
      mustChangePassword,
      lastLoginAt: null,
    }, `${name} (${ROLES[role].label})`);
  }

  async function login(username, password) {
    const login = String(username).trim().toLowerCase();
    const user = users().find((item) => item.username === login);
    if (!user) throw new Error("Login ou senha inválidos.");
    if (!user.active) throw new Error("Este usuário está desativado. Procure a Gerência.");
    if (user.locked) throw new Error("Acesso bloqueado após tentativas incorretas. Somente a Gerência pode desbloquear.");

    const { hash } = await hashPassword(password, user.salt);
    if (hash !== user.passwordHash) {
      user.failedAttempts = (user.failedAttempts || 0) + 1;
      const remaining = MAX_ATTEMPTS - user.failedAttempts;
      if (remaining <= 0) {
        user.locked = true;
        Frotas.store.audit("Bloqueio", "Usuário", `${user.name} bloqueado após ${MAX_ATTEMPTS} tentativas`, "Sistema");
        await Frotas.store.flush();
        throw new Error("Acesso bloqueado após 5 tentativas. Somente a Gerência pode desbloquear.");
      }
      await Frotas.store.flush();
      throw new Error(`Login ou senha inválidos. Restam ${remaining} tentativa${remaining === 1 ? "" : "s"}.`);
    }

    user.failedAttempts = 0;
    user.lastLoginAt = Date.now();
    current = user;
    Frotas.store.audit("Acesso", "Sessão", "Entrou no sistema");
    await Frotas.store.flush();
    return user;
  }

  function logout(reason = "Saiu do sistema") {
    if (current) {
      Frotas.store.audit("Acesso", "Sessão", reason);
      Frotas.store.flush();
    }
    current = null;
  }

  async function changePassword(user, newPassword) {
    const problem = passwordProblem(newPassword);
    if (problem) throw new Error(problem);
    const { hash, salt } = await hashPassword(newPassword);
    Frotas.store.update("users", user.id, { passwordHash: hash, salt, mustChangePassword: false, failedAttempts: 0, locked: false }, `Senha alterada · ${user.name}`);
  }

  function currentUser() {
    return current;
  }

  function can(permission) {
    return Boolean(current && PERMISSIONS[current.role]?.includes(permission));
  }

  return { ROLES, MAX_ATTEMPTS, needsSetup, createUser, login, logout, changePassword, currentUser, can, passwordProblem };
})();
