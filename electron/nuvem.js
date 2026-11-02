// Conexão com a nuvem (Supabase) usada pelas notas enviadas pelo celular.
// Toda a comunicação com o provedor fica neste arquivo: se a empresa escolher outro serviço
// de nuvem, basta reescrever estas funções mantendo os mesmos nomes.
const { createClient } = require('@supabase/supabase-js');

const BUCKET = 'notas';
let client = null;
let clientKey = '';

function normalizeUrl(url) {
  const value = String(url || '').trim().replace(/\/+$/, '');
  if (!/^https?:\/\/[^\s]+$/i.test(value)) throw new Error('Endereço do projeto na nuvem inválido (ex.: https://abcdefgh.supabase.co).');
  return value;
}

// Abre (ou reaproveita) a sessão do escritório. As credenciais vêm do cofre local.
async function connect({ url, anonKey, email, password }) {
  if (!url || !anonKey || !email || !password) throw new Error('A conexão com a nuvem ainda não foi configurada em Configurações.');
  const key = `${url}|${email}|${anonKey.slice(-12)}|${password.length}`;
  if (client && clientKey === key) {
    const { data } = await client.auth.getSession();
    if (data.session) return client;
  }
  client = createClient(normalizeUrl(url), anonKey, { auth: { persistSession: false, autoRefreshToken: true } });
  clientKey = key;
  const { error } = await client.auth.signInWithPassword({ email, password });
  if (error) {
    client = null;
    throw new Error(error.message === 'Invalid login credentials' ? 'Login ou senha do escritório incorretos na nuvem.' : `Falha ao entrar na nuvem: ${error.message}`);
  }
  const { data: perfil, error: perfilError } = await client.from('perfis').select('nome, papel').eq('user_id', (await client.auth.getUser()).data.user.id).maybeSingle();
  if (perfilError) throw new Error(`A estrutura da nuvem não foi criada (rode o arquivo nuvem/estrutura.sql). Detalhe: ${perfilError.message}`);
  if (perfil?.papel !== 'escritorio') {
    client = null;
    throw new Error('Este login não é do escritório. No Supabase, marque o perfil dele como "escritorio" (veja o guia de configuração).');
  }
  return client;
}

function reset() {
  client = null;
  clientKey = '';
}

function check(result, action) {
  if (result.error) throw new Error(`Nuvem: falha ao ${action} (${result.error.message}).`);
  return result.data;
}

// Publica a lista de veículos para o celular (veículos fora da lista ficam inativos).
async function publishVehicles(credentials, vehicles) {
  const db = await connect(credentials);
  const rows = vehicles.map((vehicle) => ({ id: vehicle.id, nome: vehicle.nome, placa: vehicle.placa || null, tipo: vehicle.tipo || null, ativo: true, atualizado_em: new Date().toISOString() }));
  if (rows.length) check(await db.from('veiculos').upsert(rows), 'publicar os veículos');
  const ids = rows.map((row) => row.id);
  const existing = check(await db.from('veiculos').select('id').eq('ativo', true), 'ler os veículos');
  const removed = existing.map((row) => row.id).filter((id) => !ids.includes(id));
  if (removed.length) check(await db.from('veiculos').update({ ativo: false }).in('id', removed), 'atualizar os veículos');
  return rows.length;
}

// Notas que chegaram e ainda não foram recebidas por este computador.
async function pendingNotes(credentials) {
  const db = await connect(credentials);
  return check(await db.from('notas').select('*').eq('status', 'enviada').order('criado_em', { ascending: true }).limit(50), 'buscar as notas');
}

async function downloadPhoto(credentials, path) {
  const db = await connect(credentials);
  const { data, error } = await db.storage.from(BUCKET).download(path);
  if (error) throw new Error(`Nuvem: falha ao baixar a foto (${error.message}).`);
  return { buffer: Buffer.from(await data.arrayBuffer()), mediaType: data.type || 'image/jpeg' };
}

async function setStatus(credentials, id, status, motivo = null) {
  const db = await connect(credentials);
  check(await db.from('notas').update({ status, motivo, atualizado_em: new Date().toISOString() }).eq('id', id), 'atualizar a nota');
}

async function listPeople(credentials) {
  const db = await connect(credentials);
  return check(await db.from('perfis').select('nome, papel, criado_em').order('nome'), 'listar os assessores');
}

module.exports = { connect, reset, publishVehicles, pendingNotes, downloadPhoto, setStatus, listPeople };
