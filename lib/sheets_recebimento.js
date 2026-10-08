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

// Encontra a coluna pelo header: primeiro nome exato, depois começo, depois contém
// (assim "Fornecedor" tem prioridade sobre "CNPJ Fornecedor")
function acharColuna(headers, termos) {
  const norm = headers.map(normalizar);
  const testes = [
    (h, t) => h === t,
    (h, t) => h.startsWith(t + ' '),
    (h, t) => h.includes(t),
  ];
  for (const teste of testes) {
    for (const termo of termos) {
      const idx = norm.findIndex(h => teste(h, termo));
      if (idx !== -1) return idx;
    }
  }
  return -1;
}

const TERMOS_FORNECEDOR = ['fornecedor', 'razao social', 'emitente'];
const TERMOS_NF         = ['n nota', 'no nota', 'numero nota', 'nota fiscal', 'nf', 'nota'];
const TERMOS_DATA_REC   = ['data recebimento', 'data agenda', 'data agendamento'];
const TERMOS_TICKET     = ['ticket', 'agenda', 'agendamento'];
const TERMOS_CNPJ_FORN  = ['cnpj fornecedor', 'cnpj emitente'];

// Coluna adicionada pelo sistema com o dia/hora em que a linha subiu
const COL_DATA_UPLOAD = 'Data Upload';

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
        colunaFornecedor: headers[acharColuna(headers, TERMOS_FORNECEDOR)] || null,
      };
    } catch (error) {
      console.error('[RECEBIMENTO] Erro ao ler agenda:', error);
      return { ok: false, msg: error.message };
    }
  }

  /**
   * Chave que identifica uma linha da agenda: Ticket + Nº Nota + CNPJ/Fornecedor.
   * Sem essas colunas, usa a linha inteira.
   */
  chaveLinha(headers, valores) {
    const indices = [
      acharColuna(headers, TERMOS_TICKET),
      acharColuna(headers, TERMOS_NF),
      acharColuna(headers, TERMOS_CNPJ_FORN),
      acharColuna(headers, TERMOS_FORNECEDOR),
    ].filter(idx => idx !== -1);

    const campos = indices.length >= 2
      ? indices.map(idx => valores[idx])
      : headers.map((h, idx) => (h === COL_DATA_UPLOAD ? '' : valores[idx]));

    return campos.map(v => normalizar(v)).join('|');
  }

  /**
   * Acrescenta as linhas do Excel do portal na aba Agenda.
   * Linhas que já existem (mesma chave) são ignoradas; as novas entram
   * abaixo das existentes com a coluna "Data Upload".
   * @param {string[]} headers - cabeçalho do arquivo
   * @param {Array<Array>} linhas - linhas de dados
   */
  async importarAgenda(headers, linhas) {
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
          gridProperties: { rowCount: linhas.length + 10, columnCount: headers.length + 1 },
        });
      }

      // Chaves das linhas que já estão na Agenda
      const existente = await this.lerAgenda();
      const chaves = new Set(existente.linhas.map(l => this.chaveLinha(existente.headers, l)));

      const headersArquivo = [...headers.filter(h => h !== COL_DATA_UPLOAD), COL_DATA_UPLOAD];
      const headersFinais = [
        ...existente.headers,
        ...headersArquivo.filter(h => !existente.headers.includes(h)),
      ];

      const dataUpload = agoraManaus({
        day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
      });

      const novas = [];
      let duplicadas = 0;
      linhas.forEach(linha => {
        const valores = headers.map((_, i) => String(linha[i] ?? '').trim());
        // Calcula a chave com o header final para comparar no mesmo formato da Agenda
        const valoresFinais = headersFinais.map(h => {
          const idx = headers.indexOf(h);
          return idx === -1 ? '' : valores[idx];
        });
        const chave = this.chaveLinha(headersFinais, valoresFinais);
        if (chaves.has(chave)) {
          duplicadas++;
          return;
        }
        chaves.add(chave); // evita duplicadas dentro do próprio arquivo
        const obj = { [COL_DATA_UPLOAD]: dataUpload };
        headers.forEach((h, i) => { if (h !== COL_DATA_UPLOAD) obj[h] = valores[i]; });
        novas.push(obj);
      });

      if (!novas.length) {
        return {
          ok: true,
          msg: `Nenhuma linha nova — ${duplicadas} linha(s) já estavam na Agenda`,
          novas: 0,
          duplicadas,
        };
      }

      // addRows estende as linhas sozinho; colunas precisam caber no header
      if (sheet.columnCount < headersFinais.length) {
        await sheet.resize({ rowCount: sheet.rowCount, columnCount: headersFinais.length });
      }
      if (headersFinais.length !== existente.headers.length) {
        await sheet.setHeaderRow(headersFinais);
      }

      const lote = 500;
      for (let i = 0; i < novas.length; i += lote) {
        await sheet.addRows(novas.slice(i, i + lote), { raw: true });
      }

      console.log(`[RECEBIMENTO] ✓ Agenda: ${novas.length} nova(s), ${duplicadas} duplicada(s) ignorada(s)`);
      return {
        ok: true,
        msg: `${novas.length} linha(s) nova(s) adicionada(s) na Agenda` +
          (duplicadas ? ` — ${duplicadas} já existiam e foram ignoradas` : ''),
        novas: novas.length,
        duplicadas,
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
    const idxFornecedor = acharColuna(headers, TERMOS_FORNECEDOR);
    const idxNF = acharColuna(headers, TERMOS_NF);
    const idxData = acharColuna(headers, TERMOS_DATA_REC);

    // A Agenda acumula vários dias: considera só o agendamento do dia do recebimento
    const hoje = agoraManaus({ day: '2-digit', month: '2-digit', year: 'numeric' });
    const linhasDoDia = idxData === -1
      ? linhas
      : linhas.filter(l => String(l[idxData] || '').startsWith(hoje));

    const alvo = normalizar(fornecedor);
    const notasAlvo = new Set(notas.map(normalizarNF));

    let linhaEncontrada = null;
    let porNF = false;

    if (alvo) {
      for (const linha of linhasDoDia) {
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
