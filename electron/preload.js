const { contextBridge, ipcRenderer } = require('electron');

// Ponte segura entre a tela e o computador: a interface só acessa estas funções.
contextBridge.exposeInMainWorld('frotasDesktop', {
  load: () => ipcRenderer.invoke('storage:load'),
  save: (json) => ipcRenderer.invoke('storage:save', json),
  backupNow: () => ipcRenderer.invoke('storage:backup-now'),
  info: () => ipcRenderer.invoke('storage:info'),
  openDataFolder: () => ipcRenderer.invoke('storage:open-folder'),
  exportData: (json, name) => ipcRenderer.invoke('storage:export', json, name),
  importData: () => ipcRenderer.invoke('storage:import'),
  saveTextFile: (content, name, extension) => ipcRenderer.invoke('file:save-text', content, name, extension),
  saveAttachment: (name, base64) => ipcRenderer.invoke('attachment:save', name, base64),
  openAttachment: (name) => ipcRenderer.invoke('attachment:open', name),
  gpsFetch: (url, token) => ipcRenderer.invoke('gps:fetch', url, token),
  readAttachment: (name) => ipcRenderer.invoke('attachment:read', name),
  // Notas: leitura automática e recebimento pelo celular.
  notesStatus: () => ipcRenderer.invoke('notas:status'),
  configureAi: (apiKey) => ipcRenderer.invoke('notas:configurar-ia', apiKey),
  configureCloud: (config) => ipcRenderer.invoke('notas:configurar-nuvem', config),
  disconnectCloud: () => ipcRenderer.invoke('notas:desconectar-nuvem'),
  readReceipt: (base64, mediaType) => ipcRenderer.invoke('notas:ler', base64, mediaType),
  syncNotes: (vehicles, knownIds) => ipcRenderer.invoke('notas:sincronizar', vehicles, knownIds),
  setNoteStatus: (id, status, reason) => ipcRenderer.invoke('notas:atualizar-status', id, status, reason),
  listAdvisors: () => ipcRenderer.invoke('notas:assessores'),
});
