const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const sheetsPrincipal = require('./sheets');

// Abas usadas pelo recebimento
const ABA_AGENDA      = 'Agenda';
const ABA_FORNECEDOR  = 'Fornecedor';
const ABA_OBSERVACAO  = 'Observação';
const ABA_RECEBIMENTO = 'Recebimento';

const HEADERS_RECEBIMENTO = [
  'Data', 'Nota Fiscal', 'Fornecedor', 'Hora Início', 'Hora Fim',
  'Conferente', 'Observação', 'Status', 'Usuário', 'Registrado em'
];

const STATUS_AGENDADO   = 'Agendado';
const STATUS_SEM_AGENDA = 'Sem agenda';

// Normaliza texto para comparação: sem acento, minúsculo, espaços simples
function normalizar(valor) {
  return String(valor || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Normaliza número de nota fiscal (só dígitos, sem zeros à esquerda)
function normalizarNF(valor) {
  const digitos = String(valor || '').replace(/\D/g, '').replace(/^0+/, '');
  return digitos || normalizar(valor);
}

function separarNotas(texto) {
  return String(texto || '')
    .split(/[,;\n]/)
    .map(n => n.trim())
    .filter(Boolean);
}

// Encontra o índice da primeira coluna cujo header contém algum dos termos
function acharColuna(headers, termos) {
  const norm = headers.map(normalizar);
  for (const termo of termos) {
    const idx = norm.findIndex(h => h.includes(termo));
    if (idx !== -1) return idx;
  }
  return -1;
}

function agoraManaus(opcoes) {
  return new Date().toLocaleString('pt-BR', { timeZone: 'America/Manaus', ...opcoes });
}

class SheetsRecebimentoService {
  constructor() {
    this.doc = null;
    this.initialized = false;
    this.cache = {};
    this.cacheTTL = 5 * 60 * 1000;
  }

  async init() {
    if (this.initialized) return this.doc;
    try {
      const serviceAccountAuth = new JWT({
        email: process.env.GOOGLE_SHEETS_CLIENT_EMAIL,
        key: (() => {
        const key = process.env.GOOGLE_SHEETS_PRIVATE_KEY || '';
        // Remove aspas extras que o Netlify às vezes adiciona
        const cleaned = key.replace(/^"|"$/g, '');
        // Substitui \n literais por quebras de linha reais
        return cleaned.includes('\\n')
          ? cleaned.replace(/\\n/g, '\n')
          : cleaned;
      })(),
        scopes: ['https://www.googleapis.com/auth/spreadsheets'],
      });
      // Usa planilha própria do recebimento se configurada; senão a planilha principal
      const sheetId = process.env.GOOGLE_SHEETS_ID_RECEBIMENTO || process.env.GOOGLE_SHEETS_ID;
      this.doc = new GoogleSpreadsheet(sheetId, serviceAccountAuth);
      await this.doc.loadInfo();
      this.initialized = true;
      console.log(`[RECEBIMENTO] ✓ Conectado: ${this.doc.title}`);
      return this.doc;
    } catch (error) {
      console.error('[RECEBIMENTO] Erro na conexão:', error);
      throw new Error('Falha na conexão com planilha de recebimento: ' + error.message);
    }
  }

  getCached(key) {
    const item = this.cache[key];
    if (item && Date.now() - item.timestamp < this.cacheTTL) return item.data;
    delete this.cache[key];
    return null;
  }

  setCache(key, data) {
    this.cache[key] = { data, timestamp: Date.now() };
  }

  // Lê uma lista simples (uma coluna) de uma aba, priorizando o header que casar com os termos
  async lerLista(titulo, termos) {
    const cached = this.getCached(titulo);
    if (cached) return cached;

    await this.init();
    const sheet = this.doc.sheetsByTitle[titulo];
    if (!sheet) {
      console.warn(`[RECEBIMENTO] Aba "${titulo}" não encontrada`);
      return [];
    }

    await sheet.loadHeaderRow();
    const headers = sheet.headerValues;
    let idx = acharColuna(headers, termos);
    if (idx === -1) idx = 0;

    const rows = await sheet.getRows();
    const vistos = new Set();
    const lista = [];
    rows.forEach(row => {
      const valor = String(row.get(headers[idx]) || '').trim();
      const chave = normalizar(valor);
      if (valor && !vistos.has(chave)) {
        vistos.add(chave);
        lista.push(valor);
      }
    });
    lista.sort((a, b) => a.localeCompare(b, 'pt-BR'));

    this.setCache(titulo, lista);
    return lista;
  }

  async obterOpcoes() {
    const [fornecedores, observacoes, quadro] = await Promise.all([
      this.lerLista(ABA_FORNECEDOR, ['fornecedor', 'razao social', 'nome']),
      this.lerLista(ABA_OBSERVACAO, ['observacao', 'obs']),
      sheetsPrincipal.buscarColaboradores(''),
    ]);

    const conferentes = quadro
      .map(c => ({ matricula: c.matricula, nome: c.nome, funcao: c.funcao }))
      .sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'));

    return { ok: true, fornecedores, observacoes, conferentes };
  }

  // ===== AGENDA (upload do Excel do portal) =====

  async lerAgenda() {
    await this.init();
    const sheet = this.doc.sheetsByTitle[ABA_AGENDA];
    if (!sheet) return { headers: [], linhas: [] };

    try {
      await sheet.loadHeaderRow();
    } catch (e) {
      return { headers: [], linhas: [] }; // aba vazia
    }
    const headers = sheet.headerValues;
    const rows = await sheet.getRows();
    const linhas = rows.map(row => headers.map(h => String(row.get(h) ?? '').trim()));
    return { headers, linhas };
  }

  async obterAgenda() {
    try {
      const { headers, linhas } = await this.lerAgenda();
      return {
        ok: true,
        headers,
        linhas,
        total: linhas.length,
        colunaFornecedor: headers[acharColuna(headers, ['fornecedor', 'razao social', 'emitente', 'transportadora'])] || null,
      };
    } catch (error) {
      console.error('[RECEBIMENTO] Erro ao ler agenda:', error);
      return { ok: false, msg: error.message };
    }
  }

  /**
   * Grava as linhas do Excel do portal na aba Agenda.
   * @param {string[]} headers - cabeçalho do arquivo
   * @param {Array<Array>} linhas - linhas de dados
   * @param {boolean} acrescentar - true mantém os dados existentes
   */
  async importarAgenda(headers, linhas, acrescentar = false) {
    try {
      headers = (headers || []).map((h, i) => String(h || '').trim() || `Coluna ${i + 1}`);
      // Evita headers duplicados (a lib exige nomes únicos)
      const contagem = {};
      headers = headers.map(h => {
        contagem[h] = (contagem[h] || 0) + 1;
        return contagem[h] > 1 ? `${h} (${contagem[h]})` : h;
      });

      linhas = (linhas || []).filter(l => Array.isArray(l) && l.some(v => String(v ?? '').trim()));
      if (!headers.length || !linhas.length) {
        return { ok: false, msg: 'Arquivo sem dados para importar' };
      }

      await this.init();
      let sheet = this.doc.sheetsByTitle[ABA_AGENDA];
      if (!sheet) {
        sheet = await this.doc.addSheet({
          title: ABA_AGENDA,
          gridProperties: { rowCount: linhas.length + 10, columnCount: headers.length },
        });
      }

      let headersFinais = headers;
      if (acrescentar) {
        let existentes = [];
        try {
          await sheet.loadHeaderRow();
          existentes = sheet.headerValues;
        } catch (e) { /* aba vazia */ }
        headersFinais = [...existentes, ...headers.filter(h => !existentes.includes(h))];
      } else {
        await sheet.clear();
      }

      // addRows estende as linhas sozinho; colunas precisam caber no header
      if (sheet.columnCount < headersFinais.length) {
        await sheet.resize({ rowCount: sheet.rowCount, columnCount: headersFinais.length });
      }
      await sheet.setHeaderRow(headersFinais);

      const objetos = linhas.map(linha => {
        const obj = {};
        headers.forEach((h, i) => { obj[h] = String(linha[i] ?? '').trim(); });
        return obj;
      });

      const lote = 500;
      for (let i = 0; i < objetos.length; i += lote) {
        await sheet.addRows(objetos.slice(i, i + lote), { raw: true });
      }

      console.log(`[RECEBIMENTO] ✓ Agenda importada: ${objetos.length} linhas (acrescentar=${acrescentar})`);
      return {
        ok: true,
        msg: `${objetos.length} linha(s) importada(s) na aba Agenda`,
        total: objetos.length,
      };
    } catch (error) {
      console.error('[RECEBIMENTO] Erro ao importar agenda:', error);
      return { ok: false, msg: 'Erro ao importar agenda: ' + error.message };
    }
  }

  /**
   * Cruza fornecedor e notas com a aba Agenda.
   * Se o fornecedor não for localizado na agenda, o status é "Sem agenda".
   */
  async cruzarComAgenda(fornecedor, notas = []) {
    const { headers, linhas } = await this.lerAgenda();
    const idxFornecedor = acharColuna(headers, ['fornecedor', 'razao social', 'emitente']);
    const idxNF = acharColuna(headers, ['nota fiscal', 'nf', 'nota', 'documento']);

    const alvo = normalizar(fornecedor);
    const notasAlvo = new Set(notas.map(normalizarNF));

    let linhaEncontrada = null;
    let porNF = false;

    if (alvo) {
      for (const linha of linhas) {
        // Sem coluna identificada de fornecedor, procura em todas as células da linha
        const celulas = idxFornecedor !== -1 ? [linha[idxFornecedor]] : linha;
        const casou = celulas.some(c => {
          const n = normalizar(c);
          return n && (n === alvo || n.includes(alvo) || (alvo.includes(n) && n.length >= 4));
        });
        if (casou) {
          linhaEncontrada = linha;
          if (idxNF !== -1 && notasAlvo.size) {
            porNF = separarNotas(linha[idxNF]).some(n => notasAlvo.has(normalizarNF(n)));
            if (porNF) break; // melhor casamento: fornecedor + NF
          } else {
            break;
          }
        }
      }
    }

    const agenda = linhaEncontrada
      ? Object.fromEntries(headers.map((h, i) => [h, linhaEncontrada[i]]))
      : null;

    return {
      status: linhaEncontrada ? STATUS_AGENDADO : STATUS_SEM_AGENDA,
      notaNaAgenda: porNF,
      agenda,
    };
  }

  // ===== RECEBIMENTO =====

  async salvarRecebimento(dados) {
    try {
      const notas = separarNotas(dados.notaFiscal);
      const fornecedor = String(dados.fornecedor || '').trim();

      if (!notas.length) return { ok: false, msg: 'Informe ao menos uma nota fiscal' };
      if (!fornecedor) return { ok: false, msg: 'Informe o fornecedor' };
      if (!dados.horaInicio) return { ok: false, msg: 'Informe a hora de início' };
      if (!dados.conferente) return { ok: false, msg: 'Informe o conferente' };
      if (dados.horaFim && dados.horaFim < dados.horaInicio) {
        return { ok: false, msg: 'Hora fim não pode ser menor que a hora de início' };
      }

      await this.init();
      const cruzamento = await this.cruzarComAgenda(fornecedor, notas);

      let sheet = this.doc.sheetsByTitle[ABA_RECEBIMENTO];
      if (!sheet) {
        console.log('[RECEBIMENTO] Criando aba Recebimento...');
        sheet = await this.doc.addSheet({ title: ABA_RECEBIMENTO, headerValues: HEADERS_RECEBIMENTO });
      }

      const registro = {
        'Data':          agoraManaus({ day: '2-digit', month: '2-digit', year: 'numeric' }),
        'Nota Fiscal':   notas.join(', '),
        'Fornecedor':    fornecedor,
        'Hora Início':   dados.horaInicio,
        'Hora Fim':      dados.horaFim || '',
        'Conferente':    String(dados.conferente).trim(),
        'Observação':    String(dados.observacao || '').trim(),
        'Status':        cruzamento.status,
        'Usuário':       String(dados.usuario || '').trim(),
        'Registrado em': agoraManaus({
          day: '2-digit', month: '2-digit', year: 'numeric',
          hour: '2-digit', minute: '2-digit', second: '2-digit',
        }),
      };

      await sheet.addRow(registro, { raw: true });
      console.log(`[RECEBIMENTO] ✓ ${fornecedor} - NF ${registro['Nota Fiscal']} - ${cruzamento.status}`);

      return {
        ok: true,
        msg: `Recebimento salvo — status: ${cruzamento.status}`,
        status: cruzamento.status,
        notaNaAgenda: cruzamento.notaNaAgenda,
        agenda: cruzamento.agenda,
        registro,
      };
    } catch (error) {
      console.error('[RECEBIMENTO] Erro ao salvar:', error);
      return { ok: false, msg: 'Erro ao salvar: ' + error.message };
    }
  }

  async obterRecebimentos(filtros = {}) {
    try {
      await this.init();
      const sheet = this.doc.sheetsByTitle[ABA_RECEBIMENTO];
      if (!sheet) return { ok: true, dados: [] };

      const rows = await sheet.getRows();
      let dados = rows.map(row => {
        const obj = {};
        HEADERS_RECEBIMENTO.forEach(h => { obj[h] = String(row.get(h) ?? ''); });
        return obj;
      });

      const data = filtros.data || agoraManaus({ day: '2-digit', month: '2-digit', year: 'numeric' });
      if (data !== 'todas') dados = dados.filter(d => d['Data'] === data);

      return { ok: true, dados: dados.reverse(), data };
    } catch (error) {
      console.error('[RECEBIMENTO] Erro ao buscar recebimentos:', error);
      return { ok: false, msg: error.message };
    }
  }
}

const service = new SheetsRecebimentoService();
service.separarNotas = separarNotas;

module.exports = service;
