const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const sheetsPrincipal = require('./sheets');

// Abas usadas pelo recebimento
const ABA_AGENDA      = 'Agenda';
const ABA_FORNECEDOR  = 'Fornecedor';
const ABA_OBSERVACAO  = 'Observação';
const ABA_RECEBIMENTO = 'Recebimento';
const ABA_DIVERGENCIA = 'Divergência';
const ABA_SITUACOES   = 'Situações';

// Usadas quando a aba Situações não existe
const SITUACOES_PADRAO = ['Tudo OK', 'Com problema'];

// Uma linha por recebimento, atualizada a cada etapa
const HEADERS_RECEBIMENTO = [
  'ID', 'Data', 'Fornecedor', 'Nota Fiscal', 'Status Agenda',
  'Hora Chegada', 'Situação', 'Problema', 'Observação', 'Carga',
  'Hora Início', 'Conferente',
  'Hora Fim', 'Divergência', 'Qual Divergência',
  'Etapa', 'Usuário', 'Atualizado em',
];

// Colunas do relatório do portal (a agenda acrescenta outras que vierem no arquivo)
const HEADERS_AGENDA = [
  'Ticket', 'Data Cadastro Agenda', 'Data Recebimento', 'Hora Recebimento',
  'Data Emissão Nota (Horário Local)', 'Data Emissão Nota (Horário Original)', 'Nº Nota',
  'Lead Time', 'Volumes', 'SKUs', 'Valor Total Produtos', 'Valor Total Nota',
  'CNPJ Fornecedor', 'Fornecedor', 'CNPJ Destinatário', 'Destinatário', 'Estado Origem',
  'CNPJ Transportadora', 'Transportadora', 'Status Nfe', 'Status Recebimento Nfe',
  'Vencimento Duplicata 1', 'Valor Duplicata 1', 'Vencimento Duplicata 2', 'Valor Duplicata 2',
  'Vencimento Duplicata 3', 'Valor Duplicata 3', 'Vencimento Duplicata 4', 'Valor Duplicata 4',
  'Data Upload',
];

// Situação "OK" (ex.: "OK", "Tudo OK") libera a carga; as demais são problema
function situacaoOk(situacao) {
  return /(^|\s)ok(\s|$)/.test(normalizar(situacao));
}

// Etapas do recebimento
const ETAPA_AGUARDANDO = 'Aguardando início';
const ETAPA_CONFERENCIA = 'Em conferência';
const ETAPA_FINALIZADO = 'Finalizado';

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
      // Recebimento usa a mesma planilha principal do sistema (GOOGLE_SHEETS_ID)
      this.doc = new GoogleSpreadsheet(process.env.GOOGLE_SHEETS_ID, serviceAccountAuth);
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
  async lerLista(titulo, termos, ordenar = true) {
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
    if (ordenar) lista.sort((a, b) => a.localeCompare(b, 'pt-BR'));

    this.setCache(titulo, lista);
    return lista;
  }

  async obterOpcoes() {
    await this.init();

    // Na primeira abertura da tela, cria as abas que faltam (Situações, Divergência...)
    let avisoAbas = null;
    if (!this.abasVerificadas) {
      const r = await this.criarAbas();
      if (r.ok) this.abasVerificadas = true;
      else avisoAbas = r.msg;
    }

    const temAbaDivergencia = !!this.doc.sheetsByTitle[ABA_DIVERGENCIA];
    const temAbaSituacoes = !!this.doc.sheetsByTitle[ABA_SITUACOES];

    const [fornecedores, observacoes, divergencias, situacoesAba, quadro, agendaDia] = await Promise.all([
      this.lerLista(ABA_FORNECEDOR, ['fornecedor', 'razao social', 'nome']),
      this.lerLista(ABA_OBSERVACAO, ['observacao', 'obs']),
      temAbaDivergencia ? this.lerLista(ABA_DIVERGENCIA, ['divergencia', 'motivo']) : Promise.resolve(null),
      temAbaSituacoes ? this.lerLista(ABA_SITUACOES, ['situacao', 'situacoes'], false) : Promise.resolve(null),
      this.lerConferentes(),
      this.agendaDoDia(),
    ]);

    const conferentes = quadro;

    return {
      ok: true,
      avisoAbas,
      fornecedores,
      observacoes,
      // Sem aba "Divergência", usa a lista de observações
      divergencias: divergencias && divergencias.length ? divergencias : observacoes,
      // Situações da chegada; cada uma indica se é OK (libera carga) ou problema
      situacoes: (situacoesAba && situacoesAba.length ? situacoesAba : SITUACOES_PADRAO)
        .map(nome => ({ nome, ok: situacaoOk(nome) })),
      conferentes,
      agendaDia,
    };
  }

  /**
   * Conferentes da aba Quadro (planilha principal): nome na coluna B,
   * matrícula na coluna A. Lê por posição de coluna, sem depender do título.
   */
  async lerConferentes() {
    const cached = this.getCached('quadro');
    if (cached) return cached;

    const doc = await sheetsPrincipal.init();
    const sheet = doc.sheetsByTitle['Quadro'];
    if (!sheet) {
      console.warn('[RECEBIMENTO] Aba "Quadro" não encontrada');
      return [];
    }

    const valores = (await sheet.getCellsInRange('A:Z')) || [];
    if (!valores.length) return [];

    // Primeira linha é cabeçalho quando a coluna B diz "Nome" (ou A diz matrícula/chapa)
    const cab = valores[0].map(normalizar);
    const temCabecalho = (cab[1] || '').includes('nome') || /coluna|matricula|chapa/.test(cab[0] || '');
    const idxFuncao = temCabecalho ? acharColuna(valores[0], ['funcao que atua', 'funcao']) : -1;

    const vistos = new Set();
    const lista = [];
    valores.slice(temCabecalho ? 1 : 0).forEach(linha => {
      const nome = String(linha[1] || '').trim();
      const chave = normalizar(nome);
      if (!nome || vistos.has(chave)) return;
      vistos.add(chave);
      lista.push({
        matricula: String(linha[0] || '').trim(),
        nome,
        funcao: idxFuncao === -1 ? '' : String(linha[idxFuncao] || '').trim(),
      });
    });
    lista.sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'));

    console.log(`[RECEBIMENTO] ${lista.length} conferente(s) da aba Quadro (coluna B)`);
    this.setCache('quadro', lista);
    return lista;
  }

  // Fornecedores agendados para hoje, com as notas da agenda
  async agendaDoDia() {
    const { headers, linhas } = await this.lerAgenda();
    const idxFornecedor = acharColuna(headers, TERMOS_FORNECEDOR);
    if (idxFornecedor === -1) return [];
    const idxNF = acharColuna(headers, TERMOS_NF);
    const idxData = acharColuna(headers, TERMOS_DATA_REC);
    const idxHora = acharColuna(headers, ['hora recebimento', 'hora agenda', 'hora']);
    const hoje = agoraManaus({ day: '2-digit', month: '2-digit', year: 'numeric' });

    const mapa = new Map();
    linhas
      .filter(l => idxData === -1 || String(l[idxData] || '').startsWith(hoje))
      .forEach(l => {
        const fornecedor = String(l[idxFornecedor] || '').trim();
        if (!fornecedor) return;
        if (!mapa.has(fornecedor)) {
          mapa.set(fornecedor, { fornecedor, hora: idxHora === -1 ? '' : l[idxHora], notas: [] });
        }
        if (idxNF !== -1) {
          separarNotas(l[idxNF]).forEach(n => {
            if (!mapa.get(fornecedor).notas.includes(n)) mapa.get(fornecedor).notas.push(n);
          });
        }
      });

    return [...mapa.values()].sort((a, b) => String(a.hora).localeCompare(String(b.hora)) || a.fornecedor.localeCompare(b.fornecedor));
  }

  /**
   * Cria as abas do recebimento que não existem, com os cabeçalhos necessários.
   * Abas existentes não são alteradas, exceto quando estão sem cabeçalho
   * (recebe o cabeçalho) ou quando a aba Recebimento não tem todas as colunas.
   */
  async criarAbas() {
    try {
      await this.init();
      // Recarrega a lista de abas: o servidor pode estar com a lista antiga em memória
      await this.doc.loadInfo();
    } catch (error) {
      return { ok: false, msg: 'Não foi possível abrir a planilha: ' + error.message };
    }

    const abas = [
      { titulo: ABA_AGENDA,      headers: HEADERS_AGENDA },
      { titulo: ABA_FORNECEDOR,  headers: ['Fornecedor'] },
      { titulo: ABA_OBSERVACAO,  headers: ['Observação'] },
      { titulo: ABA_SITUACOES,   headers: ['Situações'], valores: SITUACOES_PADRAO },
      { titulo: ABA_DIVERGENCIA, headers: ['Divergência'] },
      { titulo: ABA_RECEBIMENTO, headers: HEADERS_RECEBIMENTO },
    ];

    const resultado = [];
    for (const aba of abas) {
      try {
        let sheet = this.doc.sheetsByTitle[aba.titulo];

        if (!sheet) {
          sheet = await this.doc.addSheet({
            title: aba.titulo,
            headerValues: aba.headers,
            gridProperties: { rowCount: 1000, columnCount: Math.max(aba.headers.length, 5) },
          });
          if (aba.valores) {
            await sheet.addRows(aba.valores.map(v => ({ [aba.headers[0]]: v })), { raw: true });
          }
          resultado.push({ aba: aba.titulo, acao: 'criada', colunas: aba.headers });
          continue;
        }

        let existentes = [];
        try {
          await sheet.loadHeaderRow();
          existentes = sheet.headerValues.filter(Boolean);
        } catch (e) { /* aba sem cabeçalho */ }

        if (!existentes.length) {
          if (sheet.columnCount < aba.headers.length) {
            await sheet.resize({ rowCount: sheet.rowCount, columnCount: aba.headers.length });
          }
          await sheet.setHeaderRow(aba.headers);
          resultado.push({ aba: aba.titulo, acao: 'cabeçalho incluído', colunas: aba.headers });
        } else if (aba.titulo === ABA_RECEBIMENTO) {
          const faltando = HEADERS_RECEBIMENTO.filter(h => !existentes.includes(h));
          await this.sheetRecebimento(); // acrescenta as colunas que faltam
          resultado.push({ aba: aba.titulo, acao: faltando.length ? 'colunas incluídas' : 'já existe', colunas: faltando });
        } else {
          resultado.push({ aba: aba.titulo, acao: 'já existe', colunas: [] });
        }
      } catch (error) {
        console.error(`[RECEBIMENTO] criarAbas: erro na aba ${aba.titulo}:`, error);
        resultado.push({ aba: aba.titulo, acao: 'erro', erro: error.message });
      }
    }

    this.cache = {};
    const erros = resultado.filter(r => r.acao === 'erro');
    const alteradas = resultado.filter(r => !['já existe', 'erro'].includes(r.acao)).length;
    console.log(`[RECEBIMENTO] criarAbas: ${alteradas} criada(s)/ajustada(s), ${erros.length} erro(s)`);

    return {
      ok: erros.length === 0,
      msg: erros.length
        ? `${erros.length} aba(s) com erro: ${erros.map(e => `${e.aba} (${e.erro})`).join('; ')}`
        : alteradas ? `${alteradas} aba(s) criada(s) ou ajustada(s)` : 'Todas as abas já existem',
      planilha: this.doc.title,
      link: `https://docs.google.com/spreadsheets/d/${this.doc.spreadsheetId}`,
      abas: resultado,
      abasNaPlanilha: Object.keys(this.doc.sheetsByTitle),
    };
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

  // ===== RECEBIMENTO (etapas) =====

  async sheetRecebimento() {
    await this.init();
    let sheet = this.doc.sheetsByTitle[ABA_RECEBIMENTO];
    if (!sheet) {
      console.log('[RECEBIMENTO] Criando aba Recebimento...');
      return this.doc.addSheet({ title: ABA_RECEBIMENTO, headerValues: HEADERS_RECEBIMENTO });
    }

    // Aba já existe: garante que todas as colunas estejam no cabeçalho
    let existentes = [];
    try {
      await sheet.loadHeaderRow();
      existentes = sheet.headerValues;
    } catch (e) { /* aba vazia */ }
    const faltando = HEADERS_RECEBIMENTO.filter(h => !existentes.includes(h));
    if (faltando.length) {
      const headers = [...existentes, ...faltando];
      if (sheet.columnCount < headers.length) {
        await sheet.resize({ rowCount: sheet.rowCount, columnCount: headers.length });
      }
      await sheet.setHeaderRow(headers);
    }
    return sheet;
  }

  async buscarLinha(id) {
    const sheet = await this.sheetRecebimento();
    const rows = await sheet.getRows();
    return rows.find(r => String(r.get('ID') || '') === String(id || '')) || null;
  }

  linhaParaObjeto(row) {
    const obj = {};
    HEADERS_RECEBIMENTO.forEach(h => { obj[h] = String(row.get(h) ?? ''); });
    return obj;
  }

  carimbo() {
    return agoraManaus({
      day: '2-digit', month: '2-digit', year: 'numeric',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
  }

  // Etapa 2 — chegada do fornecedor com as notas
  async registrarChegada(dados) {
    try {
      const notas = separarNotas(dados.notaFiscal);
      const fornecedor = String(dados.fornecedor || '').trim();
      const observacoes = (dados.observacoes || []).map(o => String(o).trim()).filter(Boolean);
      const situacao = String(dados.situacao || '').trim();
      const problema = !situacaoOk(situacao);

      if (!fornecedor) return { ok: false, msg: 'Selecione o fornecedor' };
      if (!notas.length) return { ok: false, msg: 'Informe ao menos uma nota fiscal' };
      if (!situacao) return { ok: false, msg: 'Selecione a situação' };

      const cruzamento = await this.cruzarComAgenda(fornecedor, notas);
      const sheet = await this.sheetRecebimento();

      const registro = {
        'ID':            (Date.now().toString(36) + Math.random().toString(36).slice(2, 5)).toUpperCase(),
        'Data':          agoraManaus({ day: '2-digit', month: '2-digit', year: 'numeric' }),
        'Fornecedor':    fornecedor,
        'Nota Fiscal':   notas.join(', '),
        'Status Agenda': cruzamento.status,
        'Hora Chegada':  dados.horaChegada || agoraManaus({ hour: '2-digit', minute: '2-digit' }),
        'Situação':      situacao,
        'Problema':      problema ? 'Sim' : 'Não',
        'Observação':    problema ? observacoes.join(', ') : '',
        'Carga':         problema ? '' : String(dados.carga || '').trim(),
        'Etapa':         ETAPA_AGUARDANDO,
        'Usuário':       String(dados.usuario || '').trim(),
        'Atualizado em': this.carimbo(),
      };

      await sheet.addRow(registro, { raw: true });
      console.log(`[RECEBIMENTO] ✓ Chegada ${registro.ID} ${fornecedor} - ${cruzamento.status}`);

      return {
        ok: true,
        msg: `Chegada registrada — ${cruzamento.status}`,
        status: cruzamento.status,
        registro,
      };
    } catch (error) {
      console.error('[RECEBIMENTO] Erro na chegada:', error);
      return { ok: false, msg: 'Erro ao registrar chegada: ' + error.message };
    }
  }

  // Atualiza campos de um recebimento existente
  async atualizar(id, campos, usuario) {
    const row = await this.buscarLinha(id);
    if (!row) return { ok: false, msg: 'Recebimento não encontrado' };

    Object.entries(campos).forEach(([k, v]) => row.set(k, v));
    if (usuario) row.set('Usuário', String(usuario).trim());
    row.set('Atualizado em', this.carimbo());
    await row.save({ raw: true });
    return { ok: true, registro: this.linhaParaObjeto(row) };
  }

  // Etapa 3 — início da conferência
  async registrarInicio(dados) {
    try {
      if (!dados.horaInicio) return { ok: false, msg: 'Informe a hora de início' };
      if (!dados.conferente) return { ok: false, msg: 'Selecione o conferente' };

      const atual = await this.buscarLinha(dados.id);
      if (!atual) return { ok: false, msg: 'Recebimento não encontrado' };
      if (atual.get('Etapa') === ETAPA_FINALIZADO) return { ok: false, msg: 'Este recebimento já foi finalizado' };

      const r = await this.atualizar(dados.id, {
        'Hora Início': dados.horaInicio,
        'Conferente':  String(dados.conferente).trim(),
        'Etapa':       ETAPA_CONFERENCIA,
      }, dados.usuario);
      if (r.ok) r.msg = 'Início da conferência registrado';
      return r;
    } catch (error) {
      console.error('[RECEBIMENTO] Erro no início:', error);
      return { ok: false, msg: 'Erro ao registrar início: ' + error.message };
    }
  }

  // Etapa 4 — fim da conferência
  async registrarFim(dados) {
    try {
      if (!dados.horaFim) return { ok: false, msg: 'Informe a hora de fim' };
      const divergencia = !!dados.divergencia;
      const qual = (dados.qualDivergencia || []).map(o => String(o).trim()).filter(Boolean);
      if (divergencia && !qual.length) return { ok: false, msg: 'Informe qual divergência' };

      const atual = await this.buscarLinha(dados.id);
      if (!atual) return { ok: false, msg: 'Recebimento não encontrado' };
      const inicio = String(atual.get('Hora Início') || '');
      if (!inicio) return { ok: false, msg: 'Registre o início antes de finalizar' };
      if (dados.horaFim < inicio) return { ok: false, msg: 'Hora fim não pode ser menor que a hora de início' };

      const r = await this.atualizar(dados.id, {
        'Hora Fim':         dados.horaFim,
        'Divergência':      divergencia ? 'Sim' : 'Não',
        'Qual Divergência': divergencia ? qual.join(', ') : '',
        'Etapa':            ETAPA_FINALIZADO,
      }, dados.usuario);
      if (r.ok) r.msg = divergencia ? 'Recebimento finalizado com divergência' : 'Recebimento finalizado sem divergência';
      return r;
    } catch (error) {
      console.error('[RECEBIMENTO] Erro no fim:', error);
      return { ok: false, msg: 'Erro ao registrar fim: ' + error.message };
    }
  }

  // Número da carga pode ser incluído ou alterado a qualquer momento
  async atualizarCarga(dados) {
    try {
      const r = await this.atualizar(dados.id, { 'Carga': String(dados.carga || '').trim() }, dados.usuario);
      if (r.ok) r.msg = 'Carga atualizada';
      return r;
    } catch (error) {
      console.error('[RECEBIMENTO] Erro ao atualizar carga:', error);
      return { ok: false, msg: 'Erro ao atualizar carga: ' + error.message };
    }
  }

  async obterRecebimentos(filtros = {}) {
    try {
      await this.init();
      const sheet = this.doc.sheetsByTitle[ABA_RECEBIMENTO];
      if (!sheet) return { ok: true, dados: [] };

      const rows = await sheet.getRows();
      let dados = rows.map(row => this.linhaParaObjeto(row)).filter(d => d['ID']);

      const data = filtros.data || agoraManaus({ day: '2-digit', month: '2-digit', year: 'numeric' });
      // Recebimentos em aberto de outros dias continuam aparecendo
      if (data !== 'todas') dados = dados.filter(d => d['Data'] === data || d['Etapa'] !== ETAPA_FINALIZADO);

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
