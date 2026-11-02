// Leitura automática de notas e cupons fiscais por inteligência artificial (Claude, da Anthropic).
// Recebe a foto (ou PDF) e devolve os campos para preencher o lançamento. Nada é salvo sozinho:
// a pessoa sempre confere os dados na tela antes de gravar.
const Anthropic = require('@anthropic-ai/sdk');

const MODEL = 'claude-opus-5-5';

const CATEGORIES = ['Abastecimento', 'Oficina', 'Peças', 'Borracharia', 'Lava Jato', 'Produtos', 'Documentação', 'Seguro', 'Multa', 'Pedágio', 'Diversos'];

const nullable = (schema) => ({ anyOf: [schema, { type: 'null' }] });

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'legivel', 'tipo_documento', 'categoria', 'data', 'fornecedor', 'cnpj_fornecedor', 'valor_total',
    'combustivel', 'litros', 'preco_por_litro', 'placa', 'quilometragem', 'descricao', 'chave_acesso', 'confianca', 'observacoes',
  ],
  properties: {
    legivel: { type: 'boolean', description: 'false se a imagem não for uma nota/recibo ou estiver ilegível' },
    tipo_documento: { type: 'string', enum: ['cupom_nfce', 'nota_fiscal', 'recibo', 'orcamento', 'outro'] },
    categoria: { type: 'string', enum: CATEGORIES },
    data: nullable({ type: 'string', description: 'Data da compra no formato AAAA-MM-DD' }),
    fornecedor: nullable({ type: 'string', description: 'Nome do posto, oficina ou loja' }),
    cnpj_fornecedor: nullable({ type: 'string', description: 'Somente os 14 dígitos' }),
    valor_total: nullable({ type: 'number', description: 'Valor total pago, em reais' }),
    combustivel: nullable({ type: 'string', enum: ['Gasolina', 'Etanol', 'Diesel', 'GNV'] }),
    litros: nullable({ type: 'number' }),
    preco_por_litro: nullable({ type: 'number' }),
    placa: nullable({ type: 'string', description: 'Placa do veículo, se estiver impressa ou escrita na nota' }),
    quilometragem: nullable({ type: 'integer', description: 'Km do veículo, se estiver impresso ou escrito na nota' }),
    descricao: { type: 'string', description: 'Resumo curto dos itens ou serviços, em português' },
    chave_acesso: nullable({ type: 'string', description: 'Chave de acesso da NF-e/NFC-e: somente os 44 dígitos' }),
    confianca: { type: 'string', enum: ['alta', 'media', 'baixa'] },
    observacoes: { type: 'string', description: 'O que ficou duvidoso ou ilegível; vazio se nada' },
  },
};

const INSTRUCTIONS = `Você lê comprovantes de despesas da frota de veículos de uma empresa (cupons de posto, notas fiscais de oficina, peças, borracharia, lava-jato, recibos simples, inclusive escritos à mão).

Extraia os campos pedidos exatamente como aparecem no documento.
- Não invente: se um campo não aparece ou não dá para ler com segurança, use null e explique em "observacoes".
- Valores em reais como número (ex.: 289.9). Use o valor total efetivamente pago (após descontos).
- Para combustível: litros, preço por litro e tipo de combustível. Categoria "Abastecimento".
- Para outros gastos, escolha a categoria mais adequada: Oficina (serviços mecânicos), Peças, Borracharia (pneus), Lava Jato, Produtos (óleo, aditivos e itens avulsos), Documentação, Seguro, Multa, Pedágio ou Diversos.
- Datas no formato AAAA-MM-DD. Em cupons brasileiros a data aparece como DD/MM/AAAA.
- Placa e quilometragem só se estiverem escritas no documento.
- "confianca" baixa quando a foto estiver borrada, cortada ou com campos importantes duvidosos.`;

async function readReceipt({ apiKey, base64, mediaType }) {
  if (!apiKey) throw new Error('A leitura automática ainda não foi configurada (falta a chave da API em Configurações).');
  const client = new Anthropic({ apiKey, timeout: 120000, maxRetries: 2 });

  const source = mediaType === 'application/pdf'
    ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64 } }
    : { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } };

  const response = await client.beta.messages.create({
    model: MODEL,
    max_tokens: 16000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    system: INSTRUCTIONS,
    output_config: { effort: 'medium', format: { type: 'json_schema', schema: SCHEMA } },
    messages: [{ role: 'user', content: [source, { type: 'text', text: 'Leia este comprovante e preencha os campos.' }] }],
  });

  if (response.stop_reason === 'refusal') throw new Error('O serviço de leitura recusou esta imagem. Preencha os dados manualmente.');
  if (response.stop_reason === 'max_tokens') throw new Error('A leitura foi interrompida. Tente novamente.');
  const text = response.content.filter((block) => block.type === 'text').map((block) => block.text).join('');
  const data = JSON.parse(text);
  return { ...data, modelo: response.model, tokens: response.usage };
}

// Mensagens claras para os erros mais comuns (do mais específico para o mais geral).
function friendlyError(error) {
  if (error instanceof Anthropic.AuthenticationError) return 'A chave da API de leitura é inválida ou foi revogada. Confira em Configurações.';
  if (error instanceof Anthropic.PermissionDeniedError) return 'A chave da API não tem permissão para este modelo. Confira a conta na Anthropic.';
  if (error instanceof Anthropic.RateLimitError) return 'Muitas leituras ao mesmo tempo ou crédito esgotado na conta da Anthropic. Aguarde um pouco e tente de novo.';
  if (error instanceof Anthropic.BadRequestError) return `A imagem não pôde ser lida pelo serviço (${error.message}). Tente outra foto.`;
  if (error instanceof Anthropic.APIConnectionError) return 'Sem conexão com a internet para fazer a leitura automática.';
  if (error instanceof Anthropic.APIError) return `O serviço de leitura está indisponível no momento (erro ${error.status ?? '?'}). Tente novamente.`;
  return error.message || String(error);
}

module.exports = { readReceipt, friendlyError, MODEL };
