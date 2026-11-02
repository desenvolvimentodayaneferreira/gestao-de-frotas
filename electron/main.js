const { app, BrowserWindow, ipcMain, dialog, shell, session, safeStorage } = require('electron');
const fs = require('fs');
const path = require('path');
const { fileURLToPath } = require('url');
const { autoUpdater } = require('electron-updater');
const { createVault } = require('./segredos');
const leitura = require('./leitura-nota');
const nuvem = require('./nuvem');

// Autoteste (npm run smoke): usa uma pasta temporária para nunca tocar nos dados reais.
const SMOKE_TEST = process.env.FROTAS_SMOKE_TEST;
if (SMOKE_TEST) app.setPath('userData', path.join(app.getPath('temp'), 'gestao-frotas-smoke'));

// Pasta de dados: fica fora da pasta do programa, para que atualizações não apaguem nada.
const dataDir = path.join(app.getPath('userData'), 'dados');
const backupDir = path.join(dataDir, 'backups');
const attachmentsDir = path.join(dataDir, 'comprovantes');
const dataFile = path.join(dataDir, 'gestao-frotas.json');
const MAX_DAILY_BACKUPS = 60;
// Senhas e chaves ficam fora da pasta de dados (não vão para backups nem exportações).
const vault = createVault(path.join(app.getPath('userData'), 'segredos.bin'));

// Ferramentas de desenvolvedor (Ctrl+Shift+I) ficam desligadas: por elas qualquer usuário
// logado poderia ver todos os dados e mudar o próprio perfil. Para desenvolver, abra o
// sistema com a variável FROTAS_DEVTOOLS=1.
const DEVTOOLS = process.env.FROTAS_DEVTOOLS === '1';

// Pasta das telas do sistema: a janela nunca pode sair dela.
const screensDir = path.join(__dirname, '..', 'src');

function isOwnScreen(url) {
  if (!String(url).startsWith('file:')) return false;
  const file = path.resolve(fileURLToPath(url)).toLowerCase();
  return file.startsWith(screensDir.toLowerCase() + path.sep);
}

let mainWindow;

function ensureDirs() {
  [dataDir, backupDir, attachmentsDir].forEach((dir) => fs.mkdirSync(dir, { recursive: true }));
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

// Grava em arquivo temporário e renomeia: se o computador desligar no meio, o arquivo anterior continua íntegro.
function atomicWrite(file, content) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, content, 'utf8');
  fs.renameSync(tmp, file);
}

// ---------- Proteção dos dados no computador ----------
// O arquivo de dados e as cópias automáticas ficam criptografados pelo Windows (DPAPI),
// atrelados ao usuário do computador: copiados para outro lugar, não podem ser lidos.
// A "Exportar cópia" continua gerando um arquivo comum, para restaurar em outro computador.

// Arquivos antigos (antes da proteção) são JSON comum e começam com "{".
function isPlainJson(buffer) {
  const start = buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf ? 3 : 0; // ignora BOM
  for (let i = start; i < buffer.length; i++) {
    if (![0x20, 0x09, 0x0a, 0x0d].includes(buffer[i])) return buffer[i] === 0x7b;
  }
  return false;
}

function protect(json) {
  return safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(json) : json;
}

function readProtected(file) {
  const raw = fs.readFileSync(file);
  return isPlainJson(raw) ? raw.toString('utf8').replace(/^﻿/, '') : safeStorage.decryptString(raw);
}

// Protege arquivos que ainda estão sem criptografia (dados e cópias de antes desta versão).
function protectOldFiles() {
  if (!safeStorage.isEncryptionAvailable()) return;
  const files = [dataFile, ...fs.readdirSync(backupDir).filter((name) => name.endsWith('.json')).map((name) => path.join(backupDir, name))];
  for (const file of files) {
    try {
      if (!fs.existsSync(file)) continue;
      const raw = fs.readFileSync(file);
      if (!isPlainJson(raw)) continue;
      const json = raw.toString('utf8').replace(/^﻿/, '');
      JSON.parse(json); // só protege arquivos válidos; os demais ficam como estão
      atomicWrite(file, protect(json));
    } catch (error) {
      console.error(`Não foi possível proteger ${path.basename(file)}:`, error.message);
    }
  }
}

function dailyBackup() {
  if (!fs.existsSync(dataFile)) return null;
  const target = path.join(backupDir, `gestao-frotas-${today()}.json`);
  if (!fs.existsSync(target)) {
    fs.copyFileSync(dataFile, target);
    const backups = fs.readdirSync(backupDir).filter((name) => /^gestao-frotas-\d{4}-\d{2}-\d{2}\.json$/.test(name)).sort();
    backups.slice(0, Math.max(0, backups.length - MAX_DAILY_BACKUPS))
      .forEach((name) => fs.unlinkSync(path.join(backupDir, name)));
  }
  return target;
}

function cloudCredentials() {
  const config = vault.get('cloudConfig');
  const parsed = config ? JSON.parse(config) : {};
  return { url: parsed.url || '', email: parsed.email || '', anonKey: vault.get('cloudAnonKey'), password: vault.get('cloudPassword') };
}

function saveAttachmentBuffer(buffer, ext) {
  ensureDirs();
  const name = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`;
  fs.writeFileSync(path.join(attachmentsDir, name), buffer);
  return name;
}

const MEDIA_EXT = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'application/pdf': '.pdf' };

function registerNotesIpc() {
  // Situação das integrações (nunca devolve as chaves, só se estão configuradas).
  ipcMain.handle('notas:status', () => {
    const cloud = cloudCredentials();
    return {
      aiConfigured: vault.has('anthropicKey'),
      aiModel: leitura.MODEL,
      cloudConfigured: Boolean(cloud.url && cloud.anonKey && cloud.email && cloud.password),
      cloudUrl: cloud.url,
      cloudEmail: cloud.email,
      cloudAnonKey: cloud.anonKey, // chave pública: vai no QR Code do celular
    };
  });

  ipcMain.handle('notas:configurar-ia', (_event, apiKey) => {
    vault.set({ anthropicKey: apiKey === '' ? null : apiKey });
    return true;
  });

  ipcMain.handle('notas:configurar-nuvem', async (_event, { url, email, anonKey, password }) => {
    const current = cloudCredentials();
    const next = {
      url: url || current.url,
      email: email || current.email,
      anonKey: anonKey || current.anonKey,
      password: password || current.password,
    };
    nuvem.reset();
    await nuvem.connect(next); // testa antes de guardar
    vault.set({ cloudConfig: JSON.stringify({ url: next.url, email: next.email }), cloudAnonKey: next.anonKey, cloudPassword: next.password });
    return true;
  });

  ipcMain.handle('notas:desconectar-nuvem', () => {
    nuvem.reset();
    vault.set({ cloudConfig: null, cloudAnonKey: null, cloudPassword: null });
    return true;
  });

  // Lê uma foto/PDF escolhido no computador. A imagem é guardada como comprovante.
  ipcMain.handle('notas:ler', async (_event, base64, mediaType) => {
    const attachment = saveAttachmentBuffer(Buffer.from(base64, 'base64'), MEDIA_EXT[mediaType] || '.bin');
    try {
      const dados = await leitura.readReceipt({ apiKey: vault.get('anthropicKey'), base64, mediaType });
      return { attachment, dados, erro: '' };
    } catch (error) {
      return { attachment, dados: null, erro: leitura.friendlyError(error) };
    }
  });

  // Sincroniza com a nuvem: publica veículos, baixa as notas novas e faz a leitura de cada uma.
  // A nota só é marcada como "recebida" depois que a tela a guarda no banco local (notas:atualizar-status).
  ipcMain.handle('notas:sincronizar', async (_event, vehicles, knownIds = []) => {
    const credentials = cloudCredentials();
    await nuvem.publishVehicles(credentials, vehicles);
    const pending = (await nuvem.pendingNotes(credentials)).filter((note) => !knownIds.includes(note.id));
    const apiKey = vault.get('anthropicKey');
    const received = [];
    const failures = [];
    for (const note of pending) {
      try {
        const { buffer, mediaType } = await nuvem.downloadPhoto(credentials, note.foto_path);
        const attachment = saveAttachmentBuffer(buffer, MEDIA_EXT[mediaType] || '.jpg');
        let dados = null;
        let erro = '';
        if (apiKey) {
          try {
            dados = await leitura.readReceipt({ apiKey, base64: buffer.toString('base64'), mediaType });
          } catch (error) {
            erro = leitura.friendlyError(error);
          }
        } else erro = 'Leitura automática não configurada.';
        received.push({ ...note, attachment, dados, erro });
      } catch (error) {
        failures.push(error.message); // a nota continua "enviada" e é tentada de novo na próxima sincronização
      }
    }
    return { received, failures };
  });

  ipcMain.handle('notas:atualizar-status', (_event, id, status, motivo) => nuvem.setStatus(cloudCredentials(), id, status, motivo || null));

  ipcMain.handle('notas:assessores', () => nuvem.listPeople(cloudCredentials()));

  ipcMain.handle('attachment:read', (_event, name) => {
    const file = path.join(attachmentsDir, path.basename(String(name)));
    if (!fs.existsSync(file)) return null;
    const ext = path.extname(file).toLowerCase();
    const type = Object.entries(MEDIA_EXT).find(([, value]) => value === ext)?.[0] || 'application/octet-stream';
    return `data:${type};base64,${fs.readFileSync(file).toString('base64')}`;
  });
}

function registerIpc() {
  registerNotesIpc();
  ipcMain.handle('storage:load', () => {
    ensureDirs();
    return fs.existsSync(dataFile) ? readProtected(dataFile) : null;
  });

  ipcMain.handle('storage:save', (_event, json) => {
    ensureDirs();
    JSON.parse(json); // nunca grava conteúdo inválido
    dailyBackup();
    atomicWrite(dataFile, protect(json));
    return true;
  });

  ipcMain.handle('storage:backup-now', () => {
    ensureDirs();
    if (!fs.existsSync(dataFile)) return null;
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const target = path.join(backupDir, `gestao-frotas-manual-${stamp}.json`);
    fs.copyFileSync(dataFile, target);
    return target;
  });

  ipcMain.handle('storage:info', () => {
    ensureDirs();
    const backups = fs.readdirSync(backupDir).filter((name) => name.endsWith('.json')).sort().reverse();
    return {
      dataFile,
      dataDir,
      protegido: fs.existsSync(dataFile) && !isPlainJson(fs.readFileSync(dataFile)),
      size: fs.existsSync(dataFile) ? fs.statSync(dataFile).size : 0,
      backups: backups.slice(0, 10),
      backupCount: backups.length,
    };
  });

  ipcMain.handle('storage:open-folder', () => shell.openPath(dataDir));

  ipcMain.handle('storage:export', async (_event, json, suggestedName) => {
    const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
      title: 'Exportar cópia dos dados',
      defaultPath: path.join(app.getPath('documents'), suggestedName || `gestao-frotas-${today()}.json`),
      filters: [{ name: 'Cópia de segurança', extensions: ['json'] }],
    });
    if (canceled || !filePath) return null;
    fs.writeFileSync(filePath, json, 'utf8');
    return filePath;
  });

  ipcMain.handle('storage:import', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
      title: 'Restaurar cópia dos dados',
      properties: ['openFile'],
      filters: [{ name: 'Cópia de segurança', extensions: ['json'] }],
    });
    if (canceled || !filePaths.length) return null;
    try {
      // Aceita a cópia exportada (arquivo comum) e as cópias automáticas protegidas deste computador.
      return readProtected(filePaths[0]);
    } catch {
      return { erro: 'Esta cópia está protegida e só abre no computador e usuário do Windows onde foi feita. Use uma cópia criada com "Exportar cópia".' };
    }
  });

  ipcMain.handle('file:save-text', async (_event, content, suggestedName, extension) => {
    const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
      defaultPath: path.join(app.getPath('documents'), suggestedName),
      filters: [{ name: extension.toUpperCase(), extensions: [extension] }],
    });
    if (canceled || !filePath) return null;
    fs.writeFileSync(filePath, content, 'utf8');
    return filePath;
  });

  ipcMain.handle('attachment:save', (_event, originalName, base64) => {
    ensureDirs();
    const ext = path.extname(originalName || '').toLowerCase().replace(/[^.a-z0-9]/g, '') || '.bin';
    const name = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`;
    fs.writeFileSync(path.join(attachmentsDir, name), Buffer.from(base64, 'base64'));
    return name;
  });

  ipcMain.handle('attachment:open', (_event, name) => {
    const file = path.join(attachmentsDir, path.basename(String(name)));
    if (!fs.existsSync(file)) return false;
    shell.openPath(file);
    return true;
  });

  // Consulta ao provedor de rastreamento feita pelo processo principal (evita bloqueios de CORS).
  ipcMain.handle('gps:fetch', async (_event, url, token) => {
    if (!/^https?:\/\//i.test(String(url))) throw new Error('Endereço da integração inválido.');
    const headers = { Accept: 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch(url, { headers, signal: controller.signal });
      if (!response.ok) throw new Error(`O provedor respondeu com erro ${response.status}.`);
      return await response.text();
    } finally {
      clearTimeout(timer);
    }
  });
}

function runSmokeTest() {
  const errors = [];
  mainWindow.webContents.on('console-message', (_event, level, message) => {
    if (level >= 2) errors.push(message);
  });
  mainWindow.webContents.once('did-finish-load', async () => {
    try {
      await new Promise((resolve) => setTimeout(resolve, 2500));
      const result = await mainWindow.webContents.executeJavaScript(`(async () => {
        const db = Frotas.store.get();
        if (Frotas.auth.needsSetup()) {
          await Frotas.auth.createUser({ name: 'Autoteste', username: 'autoteste', role: 'administrador', password: 'Autoteste2026' });
        }
        await Frotas.auth.login('autoteste', 'Autoteste2026');
        document.querySelector('#login-screen').classList.add('is-hidden');
        document.querySelector('#app-shell').classList.remove('is-hidden');
        Frotas.app.go('dashboard');
        await Frotas.store.flush();
        const info = await window.frotasDesktop.info();
        return { desktopBridge: !!window.frotasDesktop, seed: !!window.FROTAS_FLEET_DATA, vehicles: db.vehicles.length, fuel: db.fuel.length, savedBytes: info.size, chartJs: typeof Chart, leaflet: typeof L };
      })()`);
      // Roteiro extra opcional (testes de funcionalidades), executado na tela já conectada.
      const extraScript = process.env.FROTAS_SMOKE_SCRIPT;
      if (extraScript) result.extra = await mainWindow.webContents.executeJavaScript(fs.readFileSync(extraScript, 'utf8'));
      await new Promise((resolve) => setTimeout(resolve, 1500));
      const image = await mainWindow.webContents.capturePage();
      const shot = path.join(app.getPath('temp'), 'gestao-frotas-smoke.png');
      fs.writeFileSync(shot, image.toPNG());
      console.log(`SMOKE_RESULT ${JSON.stringify({ ...result, errors, screenshot: shot })}`);
    } catch (error) {
      console.log(`SMOKE_RESULT ${JSON.stringify({ failed: error.message, errors })}`);
    }
    app.quit();
  });
}

// ---------- Atualização automática ----------
// O programa instalado procura versões novas nas Releases do GitHub (configuradas em
// package.json → build.publish), baixa em segundo plano e pergunta se pode reiniciar.
// Se a pessoa escolher "Depois", a atualização é instalada quando o programa for fechado.
const UPDATE_CHECK_INTERVAL = 4 * 60 * 60 * 1000; // a cada 4 horas

function setupAutoUpdate() {
  if (!app.isPackaged || SMOKE_TEST) return; // só no programa instalado, nunca no autoteste
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('update-downloaded', async (info) => {
    if (!mainWindow) return;
    const { response } = await dialog.showMessageBox(mainWindow, {
      type: 'info',
      title: 'Atualização pronta',
      message: `A versão ${info.version} do sistema já foi baixada.`,
      detail: 'Reiniciar agora para instalar? Seus dados são mantidos. Se escolher "Depois", ela será instalada quando o sistema for fechado.',
      buttons: ['Reiniciar agora', 'Depois'],
      defaultId: 0,
      cancelId: 1,
    });
    if (response !== 0) return;
    try {
      await mainWindow.webContents.executeJavaScript('window.Frotas && Frotas.store.flush()'); // grava o último lançamento antes de fechar
    } catch {
      /* a tela já salva a cada alteração; segue com a instalação */
    }
    autoUpdater.quitAndInstall();
  });

  // Sem internet ou sem versão publicada, o sistema continua funcionando normalmente.
  autoUpdater.on('error', (error) => console.error('Atualização automática:', error.message));

  const check = () => autoUpdater.checkForUpdates().catch((error) => console.error('Atualização automática:', error.message));
  check();
  setInterval(check, UPDATE_CHECK_INTERVAL);
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1180,
    minHeight: 720,
    show: false,
    title: 'Gestão de Frotas',
    backgroundColor: '#f2f1f4',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      devTools: DEVTOOLS,
    },
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'src', 'index.html'));

  // Links externos abrem no navegador padrão, nunca dentro do sistema.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow.maximize();
    mainWindow.show();
  });

  if (SMOKE_TEST) runSmokeTest();

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  // A janela só mostra as telas do próprio sistema. Um link para fora (mesmo que alguém
  // consiga inserir um) abre no navegador, sem acesso aos dados e às chaves do sistema.
  app.on('web-contents-created', (_event, contents) => {
    contents.on('will-navigate', (event, url) => {
      if (isOwnScreen(url)) return;
      event.preventDefault();
      if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    });
    contents.on('will-redirect', (event, url) => {
      if (!isOwnScreen(url)) event.preventDefault();
    });
    contents.on('will-attach-webview', (event) => event.preventDefault());
  });

  app.whenReady().then(() => {
    // Câmera liberada só para as telas do próprio sistema (foto da nota).
    session.defaultSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
      const own = (details.requestingUrl || webContents.getURL()).startsWith('file://');
      callback(own && (permission === 'media' || permission === 'clipboard-read'));
    });
    session.defaultSession.setPermissionCheckHandler((_webContents, permission, origin) => (permission === 'media' && String(origin).startsWith('file://')));
    ensureDirs();
    try {
      protectOldFiles();
    } catch (error) {
      console.error('Não foi possível proteger os arquivos antigos:', error.message);
    }
    registerIpc();
    createWindow();
    setupAutoUpdate();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
