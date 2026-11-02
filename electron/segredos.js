// Cofre de senhas e chaves de acesso (nuvem e leitura por IA).
// Os valores ficam criptografados pelo Windows (DPAPI), atrelados ao usuário do computador,
// e nunca são enviados para a tela: a interface só sabe se cada chave está configurada.
const { safeStorage } = require('electron');
const fs = require('fs');
const path = require('path');

function createVault(file) {
  function readAll() {
    if (!fs.existsSync(file)) return {};
    try {
      const raw = fs.readFileSync(file);
      const json = safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(raw) : raw.toString('utf8');
      return JSON.parse(json);
    } catch {
      return {};
    }
  }

  function writeAll(values) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const json = JSON.stringify(values);
    const data = safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(json) : Buffer.from(json, 'utf8');
    fs.writeFileSync(file, data);
  }

  return {
    get(name) {
      return readAll()[name] || '';
    },
    set(patch) {
      const values = readAll();
      Object.entries(patch).forEach(([key, value]) => {
        if (value === null) delete values[key];
        else if (typeof value === 'string' && value.trim()) values[key] = value.trim();
      });
      writeAll(values);
    },
    has(name) {
      return Boolean(readAll()[name]);
    },
  };
}

module.exports = { createVault };
