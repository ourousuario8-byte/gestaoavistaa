const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const { fusoAtual } = require('./fuso');

// "d/m/aaaa" ou "aaaa-mm-dd" → "dd/mm/aaaa"
function normalizarDataBR(valor) {
  const t = String(valor || '').trim();
  let m = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return `${m[3].padStart(2, '0')}/${m[2].padStart(2, '0')}/${m[1]}`;
  m = t.match(/^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{4})/);
  if (m) return `${m[1].padStart(2, '0')}/${m[2].padStart(2, '0')}/${m[3]}`;
  return t;
}

// Título de coluna comparável: sem acento, minúsculo, só letras e números
function chaveColuna(valor) {
  return String(valor || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

// Nomes alternativos aceitos para as colunas
// (Nunca "Grupo" ↔ "Aba": na aba Usuarios, "Aba" são as permissões do usuário)
const ALIAS_COLUNAS = {
  matricula: ['chapa', 'mat'],
  funcao:    ['cargo'],
};

const COLUNAS_LISTA = ['Supervisor', 'Grupo', 'matricula', 'Nome', 'Função', 'status', 'desvio'];
const COLUNAS_BASE  = ['Supervisor', 'Aba', 'Matricula', 'Nome', 'Função', 'Status', 'Desvio', 'Data', 'Turno', 'Departamento', 'Corrigido em'];

// 1 → A, 27 → AA
function letraColuna(n) {
  let s = '';
  for (; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

// Matrícula comparável: "1-000013" e "13" são a mesma chapa
function chaveMatricula(valor) {
  const texto = String(valor || '').trim();
  const semPrefixo = texto.includes('-') ? texto.split('-').pop() : texto;
  const digitos = semPrefixo.replace(/\D/g, '');
  return (digitos.replace(/^0+/, '') || digitos || texto).toLowerCase();
}

class SheetsService {
  constructor() {
    this.doc = null;
    this.initialized = false;

    this.cache = {};
    this.cacheTTL = {
      default:      60  * 1000,
      quadro:       5  * 60 * 1000,
      qlp:          5  * 60 * 1000,
      mapaCarga:    60 * 1000,
      buffer:       10 * 1000,
      base:         30 * 1000,
      usuarios:     10 * 60 * 1000,
    };
  }

  // ===== HELPERS DE CACHE =====

  getCached(key) {
    const item = this.cache[key];
    if (!item) return null;
    const ttl = this.cacheTTL[key.split(':')[0]] || this.cacheTTL.default;
    if (Date.now() - item.timestamp < ttl) {
      console.log(`[CACHE HIT] ${key}`);
      return item.data;
    }
    delete this.cache[key];
    return null;
  }

  setCache(key, data) {
    this.cache[key] = { data, timestamp: Date.now() };
    console.log(`[CACHE SET] ${key}`);
  }

  invalidateCache(key) {
    if (key) {
      Object.keys(this.cache).forEach(k => {
        if (k.startsWith(key)) delete this.cache[k];
      });
      console.log(`[CACHE INVALIDADO] ${key}*`);
    } else {
      this.cache = {};
      console.log('[CACHE LIMPO] Total');
    }
  }

  // ===== CONEXÃO =====

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
      this.doc = new GoogleSpreadsheet(process.env.GOOGLE_SHEETS_ID, serviceAccountAuth);
      await this.doc.loadInfo();
      this.initialized = true;
      return this.doc;
    } catch (error) {
      throw new Error('Falha na conexão: ' + error.message);
    }
  }

  // ===== HELPER: Data no fuso de Manaus (GMT-4) =====
  // CORREÇÃO BUG 4: O servidor Vercel roda em UTC. Sem ajuste de fuso,
  // meia-noite UTC é ainda 20h do dia anterior em Manaus, gerando datas erradas.
  getDataHojeBR() {
    const agora = new Date();
    // Fuso do usuário que fez a ação (padrão: Manaus)
    return agora.toLocaleDateString('pt-BR', { timeZone: fusoAtual() });
  }

  // ===== AUTH =====

  async lerUsuarios() {
    await this.init();
    const sheet = this.doc.sheetsByTitle['Usuarios'];
    if (!sheet) return null;
    const rows = await sheet.getRows();
    return rows.map(r => ({
      usuario: String(r.get('Usuario') || '').trim(),
      senha:   String(r.get('Senha')   || '').trim(),
      aba:     String(r.get('Aba')     || '').trim(),
    }));
  }

  // Áreas atuais do usuário (sem senha: usado com o token de sessão)
  async areasDoUsuario(usuario) {
    const rows = (await this.lerUsuarios()) || [];
    return [...new Set(rows.filter(r => r.usuario === usuario && r.aba).map(r => r.aba))];
  }

  async validarLogin(usuario, senha) {
    try {
      await this.init();

      // Lê a aba Usuarios a cada login: permissões alteradas valem na hora
      const rowsData = await this.lerUsuarios();
      if (!rowsData) return { ok: false, msg: 'Aba Usuarios não encontrada' };
      const abas = rowsData
        .filter(r => r.usuario === usuario && r.senha === senha && r.aba)
        .map(r => r.aba);

      const unicas = [...new Set(abas)];
      return unicas.length > 0
        ? { ok: true, usuario, abas: unicas }
        : { ok: false, msg: 'Login inválido' };

    } catch (error) {
      return { ok: false, msg: error.message };
    }
  }

  // ===== COLABORADORES =====

  /**
   * Lê a aba Quadro por posição: A = matrícula, B = nome (não depende do título
   * das colunas). A função vem da coluna "Função que atua" (ou "Função no RM").
   */
  async lerQuadro(sheet) {
    // Lê todas as colunas da aba (a função pode estar depois da coluna Z)
    const valores = (await sheet.getCellsInRange(`A:${letraColuna(Math.max(sheet.columnCount || 26, 26))}`)) || [];
    if (!valores.length) return [];

    const norm = v => String(v || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
    const cab = valores[0].map(norm);
    const temCabecalho = (cab[1] || '').includes('nome') || /coluna|matricula|chapa/.test(cab[0] || '');
    let idxFuncao = -1;
    if (temCabecalho) {
      idxFuncao = cab.findIndex(h => h.includes('funcao que atua'));
      if (idxFuncao === -1) idxFuncao = cab.findIndex(h => h.includes('funcao no rm'));
      if (idxFuncao === -1) idxFuncao = cab.findIndex(h => h.includes('funcao') || h === 'cargo');
    }

    return valores.slice(temCabecalho ? 1 : 0)
      .map(linha => ({
        matricula: String(linha[0] || '').trim(),
        nome:      String(linha[1] || '').trim(),
        funcao:    idxFuncao === -1 ? '' : String(linha[idxFuncao] || '').trim(),
      }))
      .filter(c => c.nome);
  }

  /**
   * Colaboradores do QLP (aba "QLP RM"): matrícula (COD_CHAPA ou CHAPA), nome, função,
   * departamento e situação. Sem o QLP importado, usa a aba Quadro (A = matrícula, B = nome).
   */
  async listaColaboradores() {
    await this.init();
    const cacheKey = 'quadro:todos';
    const cached = this.getCached(cacheKey);
    if (cached) return cached;

    let lista = [];
    const qlp = this.doc.sheetsByTitle['QLP RM'];
    if (qlp) {
      const valores = (await qlp.getCellsInRange(`A:${letraColuna(Math.max(qlp.columnCount || 26, 26))}`)) || [];
      if (valores.length) {
        const cab = valores[0].map(chaveColuna);
        const col = (...nomes) => { for (const n of nomes) { const i = cab.indexOf(chaveColuna(n)); if (i !== -1) return i; } return -1; };
        const c = {
          chapa: col('CHAPA'), codChapa: col('COD_CHAPA'), nome: col('NOME'), funcao: col('FUNÇÃO', 'FUNCAO'),
          departamento: col('DEPARTAMENTO'), situacao: col('SITUAÇÃO', 'SITUACAO'),
        };
        const v = (l, i) => (i === -1 ? '' : String(l[i] ?? '').trim());
        lista = valores.slice(1).map(l => ({
          matricula:    v(l, c.codChapa) || v(l, c.chapa),
          nome:         v(l, c.nome),
          funcao:       v(l, c.funcao),
          departamento: v(l, c.departamento),
          situacao:     v(l, c.situacao),
        })).filter(x => x.nome);
      }
    }
    if (!lista.length) {
      const quadro = this.doc.sheetsByTitle['Quadro'];
      if (quadro) lista = (await this.lerQuadro(quadro)).map(x => ({ ...x, departamento: '', situacao: '' }));
    }

    // Lista vazia não fica em cache: o QLP/Quadro pode ser preenchido a qualquer momento
    if (lista.length) this.setCache(cacheKey, lista);
    return lista;
  }

  // Colaborador pela matrícula ("1-000013" e "13" são a mesma chapa)
  async colaboradorPorMatricula(matricula) {
    const lista = await this.listaColaboradores();
    const completa = String(matricula || '').trim();
    return lista.find(x => x.matricula === completa) ||
      lista.find(x => chaveMatricula(x.matricula) === chaveMatricula(completa)) || null;
  }

  // Busca para a lista de presença: só colaboradores dos setores do usuário logado
  async buscarColaboradores(filtro = '') {
    try {
      const lista = await this.listaColaboradores();
      const { lista: doSetor } = await require('./setores').filtrar(lista, c => c.departamento);

      if (!filtro) return doSetor;

      const semAcento = v => String(v || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
      const f = semAcento(filtro.trim());
      return doSetor.filter(c =>
        semAcento(c.nome).includes(f) ||
        semAcento(c.matricula).includes(f)
      );

    } catch (error) {
      console.error('Erro busca:', error);
      return [];
    }
  }

  // ===== COLUNAS DA LISTA / BASE =====
  // As abas podem ter o cabeçalho escrito de outro jeito ("Status", "status", "Matrícula"...).
  // Este mapa liga o nome usado no código ao título real da coluna; colunas que
  // faltam são criadas no fim do cabeçalho (antes eram descartadas sem aviso).
  async colunas(sheet, nomes) {
    // Planilhas diferentes podem ter abas com o mesmo nome (ex.: "Base" da avaria)
    const planilha = (sheet._spreadsheet && sheet._spreadsheet.spreadsheetId) || '';
    const cacheKey = `colunas:${planilha}:${sheet.sheetId}:${sheet.title}`;
    const cached = this.getCached(cacheKey);
    if (cached && nomes.every(n => cached[n])) return cached;

    let headers = [];
    try {
      await sheet.loadHeaderRow();
      headers = sheet.headerValues;
    } catch (e) { /* aba vazia, sem cabeçalho */ }

    const mapa = {};
    const faltando = [];
    nomes.forEach(nome => {
      const real = headers.find(h => chaveColuna(h) === chaveColuna(nome)) ||
        headers.find(h => (ALIAS_COLUNAS[chaveColuna(nome)] || []).includes(chaveColuna(h)));
      if (real) mapa[nome] = real;
      else faltando.push(nome);
    });

    if (faltando.length) {
      // Mantém as colunas existentes (inclusive vazias) e acrescenta as que faltam
      const ultimo = headers.reduce((u, h, i) => (String(h || '').trim() ? i : u), -1);
      const novos = [...headers.slice(0, ultimo + 1), ...faltando];
      if (sheet.columnCount < novos.length) {
        await sheet.resize({ rowCount: sheet.rowCount, columnCount: novos.length });
      }
      await sheet.setHeaderRow(novos);
      faltando.forEach(n => { mapa[n] = n; });
      console.log(`[SHEETS] Colunas criadas na aba ${sheet.title}: ${faltando.join(', ')}`);
    }

    this.setCache(cacheKey, mapa);
    return mapa;
  }

  // Lê o valor de uma coluna pelo nome usado no código
  valor(row, mapa, nome) {
    return String(row.get(mapa[nome]) ?? '').trim();
  }

  /**
   * Insere linhas logo abaixo da última linha preenchida, numa única chamada.
   * (O "append" da API do Google às vezes desloca as colunas quando a aba tem
   * linhas em branco ou dados soltos — era isso que deixava a Base "quebrada".)
   * @param {object[]} objetos - { nomeNoCodigo: valor }
   * @param {number} ultimaLinha - número da última linha com dados (1 = só cabeçalho)
   */
  async inserirLinhas(sheet, mapa, objetos, ultimaLinha) {
    if (!objetos.length) return;
    let headers;
    try { headers = sheet.headerValues; } catch (e) { await sheet.loadHeaderRow(); headers = sheet.headerValues; }
    const porTitulo = {};
    Object.entries(mapa).forEach(([nome, titulo]) => { porTitulo[titulo] = nome; });
    const valores = objetos.map(obj => headers.map(h => {
      const nome = porTitulo[h];
      return nome && obj[nome] !== undefined ? String(obj[nome]) : '';
    }));

    // Garante espaço na grade: acrescenta as linhas no fim da aba
    await this.doc.sheetsApi.post(':batchUpdate', {
      requests: [{ appendDimension: { sheetId: sheet.sheetId, dimension: 'ROWS', length: objetos.length } }],
    });
    const inicio = ultimaLinha + 1;
    await this.doc.sheetsApi.put(`/values/${sheet.encodedA1SheetName}!A${inicio}`, {
      values: valores,
    }, { params: { valueInputOption: 'RAW' } });
  }

  // Apaga várias linhas numa única chamada (de baixo para cima)
  async apagarLinhas(sheet, numeros) {
    if (!numeros.length) return;
    const requests = [...numeros].sort((a, b) => b - a).map(n => ({
      deleteDimension: { range: { sheetId: sheet.sheetId, dimension: 'ROWS', startIndex: n - 1, endIndex: n } },
    }));
    await this.doc.sheetsApi.post(':batchUpdate', { requests });
  }

  // Função do colaborador pelo Quadro, quando não veio na lista
  async funcaoPeloQuadro(matricula) {
    const c = await this.colaboradorPorMatricula(matricula);
    return c ? c.funcao : '';
  }


  // ===== BUFFER (Lista) =====

  async sheetLista() {
    await this.init();
    const sheet = this.doc.sheetsByTitle['Lista'];
    if (!sheet) return { sheet: null };
    const mapa = await this.colunas(sheet, COLUNAS_LISTA);
    return { sheet, mapa };
  }

  async adicionarBuffer(supervisor, aba, colaborador) {
    try {
      console.log('[SHEETS] Adicionando ao buffer:', { supervisor, aba, colaborador });
      const { sheet, mapa } = await this.sheetLista();
      if (!sheet) return { ok: false, msg: 'Aba Lista não encontrada' };

      const rows = await sheet.getRows();
      const v = (row, nome) => this.valor(row, mapa, nome);
      const matricula = String(colaborador.matricula || '').trim();

      const jaExiste = rows.some(row =>
        v(row, 'Supervisor') === supervisor && v(row, 'Grupo') === aba && v(row, 'matricula') === matricula
      );
      if (jaExiste) return { ok: true, msg: 'Colaborador já está na lista' };

      // Um colaborador só pode estar na lista de um supervisor
      const deOutro = rows.find(row => v(row, 'matricula') === matricula && v(row, 'Supervisor') !== supervisor);
      if (deOutro) {
        const outroSup = v(deOutro, 'Supervisor');
        const outraAba = v(deOutro, 'Grupo');
        return {
          ok: false,
          msg: `${colaborador.nome || 'Colaborador'} já está na lista do supervisor ${outroSup}${outraAba ? ` (${outraAba})` : ''}`,
        };
      }

      const funcao = String(colaborador.funcao || '').trim() || await this.funcaoPeloQuadro(matricula);
      const ultimaLinha = rows.length ? rows[rows.length - 1].rowNumber : 1;
      await this.inserirLinhas(sheet, mapa, [{
        'Supervisor': supervisor,
        'Grupo':      aba,
        'matricula':  matricula,
        'Nome':       String(colaborador.nome || '').trim(),
        'Função':     funcao,
        'status':     '',
        'desvio':     '',
      }], ultimaLinha);

      this.invalidateCache('buffer:');
      return { ok: true };

    } catch (error) {
      console.error('[SHEETS] Erro ao adicionar:', error);
      return { ok: false, msg: error.message };
    }
  }

  async getBuffer(supervisor, aba) {
    try {
      const cacheKey = `buffer:${supervisor}:${aba}`;
      const cached = this.getCached(cacheKey);
      if (cached) return cached;

      const { sheet, mapa } = await this.sheetLista();
      if (!sheet) return [];

      const rows = await sheet.getRows();
      const v = (row, nome) => this.valor(row, mapa, nome);
      const buffer = rows
        .filter(row => v(row, 'Supervisor') === supervisor && v(row, 'Grupo') === aba)
        .map(row => ({
          matricula: v(row, 'matricula'),
          nome:      v(row, 'Nome'),
          funcao:    v(row, 'Função'),
          status:    v(row, 'status'),
          desvio:    v(row, 'desvio'),
        }))
        .filter(c => c.matricula || c.nome);

      // Linhas antigas sem função: completa pelo Quadro
      for (const c of buffer) {
        if (!c.funcao) c.funcao = await this.funcaoPeloQuadro(c.matricula);
      }

      this.setCache(cacheKey, buffer);
      return buffer;

    } catch (error) {
      console.error('[SHEETS] Erro ao buscar buffer:', error);
      return [];
    }
  }

  // Linha da Lista pelo supervisor ou grupo (chave) + matrícula
  async linhaLista(chave, matricula) {
    const { sheet, mapa } = await this.sheetLista();
    if (!sheet) return { erro: 'Aba Lista não encontrada' };
    const rows = await sheet.getRows();
    const v = (row, nome) => this.valor(row, mapa, nome);
    const row = rows.find(r =>
      (v(r, 'Supervisor') === chave || v(r, 'Grupo') === chave) && v(r, 'matricula') === String(matricula).trim()
    );
    return row ? { row, mapa, sheet } : { erro: 'Colaborador não encontrado' };
  }

  async removerBuffer(supervisor, matricula) {
    const r = await this.removerBufferPorAba(supervisor, matricula);
    return { ok: r.ok };
  }

  async atualizarStatusBuffer(supervisor, matricula, status) {
    const r = await this.atualizarStatusBufferPorAba(supervisor, matricula, status);
    return { ok: r.ok };
  }

  async removerBufferPorAba(chave, matricula) {
    try {
      const { row, sheet, erro } = await this.linhaLista(chave, matricula);
      if (erro) return { ok: false, msg: erro };
      await this.apagarLinhas(sheet, [row.rowNumber]);
      this.invalidateCache('buffer:');
      return { ok: true };
    } catch (error) {
      return { ok: false, msg: error.message };
    }
  }

  async atualizarCampoLista(chave, matricula, campo, valor) {
    try {
      const { row, mapa, sheet, erro } = await this.linhaLista(chave, matricula);
      if (erro) return { ok: false, msg: erro };
      // Grava só a célula do campo (não reescreve a linha inteira)
      const coluna = letraColuna(sheet.headerValues.indexOf(mapa[campo]) + 1);
      await this.doc.sheetsApi.put(`/values/${sheet.encodedA1SheetName}!${coluna}${row.rowNumber}`, {
        values: [[String(valor ?? '')]],
      }, { params: { valueInputOption: 'RAW' } });
      this.invalidateCache('buffer:');
      return { ok: true };
    } catch (error) {
      return { ok: false, msg: error.message };
    }
  }

  async atualizarStatusBufferPorAba(chave, matricula, status) {
    return this.atualizarCampoLista(chave, matricula, 'status', status);
  }

  async atualizarDesvioBufferPorAba(chave, matricula, desvio) {
    return this.atualizarCampoLista(chave, matricula, 'desvio', desvio);
  }

  // ===== SALVAR NA BASE =====
  // - Data no fuso de Manaus, gravada como texto
  // - Substitui os registros do supervisor/aba no dia (sem deixar órfãos)
  // - Colunas localizadas pelo título (maiúsculas/acentos não importam)
  // - Apaga e grava em lote (antes era uma chamada por linha e podia parar no meio)
  async salvarNaBase(dados) {
    try {
      await this.init();
      const sheet = this.doc.sheetsByTitle['Base'];
      if (!sheet) return { ok: false, msg: 'Aba Base não encontrada' };
      const mapa = await this.colunas(sheet, COLUNAS_BASE);
      const v = (row, nome) => this.valor(row, mapa, nome);

      const hoje = this.getDataHojeBR();

      const primeiroRegistro = (dados || []).find(d => d && d[0] && d[1]);
      if (!primeiroRegistro) {
        return { ok: false, msg: 'Nenhum dado válido para salvar' };
      }
      const supervisorChave = String(primeiroRegistro[0]).trim();
      const abaChave        = String(primeiroRegistro[1]).trim();
      console.log(`[SHEETS] Salvando para Supervisor="${supervisorChave}", Aba="${abaChave}", Data="${hoje}"`);

      // Monta e valida as linhas antes de mexer na planilha
      const novos = [];
      const vistos = new Set();
      for (const linha of dados) {
        const [sup, aba, matricula, nome, funcao, status, desvio, turno] = (linha || []).map(x => String(x ?? '').trim());
        if (!matricula && !nome) continue;
        const chave = matricula || nome;
        if (vistos.has(chave)) continue; // evita duplicar o mesmo colaborador
        vistos.add(chave);
        novos.push({
          'Supervisor': sup || supervisorChave,
          'Aba':        aba || abaChave,
          'Matricula':  matricula,
          'Nome':       nome,
          'Função':     funcao || await this.funcaoPeloQuadro(matricula),
          'Status':     status,
          'Desvio':     desvio,
          'Data':       hoje,
          'Turno':      turno,
        });
      }
      if (!novos.length) return { ok: false, msg: 'Nenhum colaborador válido para salvar' };

      // Setorização: departamento do colaborador no QLP; sem ele, o setor principal de quem salvou
      const departamentoUsuario = await require('./setores').setorParaGravar();
      for (const n of novos) {
        const c = n['Matricula'] ? await this.colaboradorPorMatricula(n['Matricula']) : null;
        n['Departamento'] = (c && c.departamento) || departamentoUsuario;
      }

      // Registros deste supervisor+aba no dia são substituídos
      const rows = await sheet.getRows();
      const remover = rows
        .filter(row =>
          v(row, 'Supervisor') === supervisorChave &&
          v(row, 'Aba') === abaChave &&
          normalizarDataBR(v(row, 'Data')) === hoje
        )
        .map(row => row.rowNumber);

      const ultimaLinha = (rows.length ? rows[rows.length - 1].rowNumber : 1) - remover.length;
      await this.apagarLinhas(sheet, remover);
      await this.inserirLinhas(sheet, mapa, novos, ultimaLinha);

      this.invalidateCache('base:');
      console.log(`[SHEETS] Concluído: ${novos.length} registros salvos, ${remover.length} substituídos`);
      return {
        ok: true,
        msg: `${novos.length} registros salvos (${remover.length} antigos substituídos)`,
        totais: { novos: novos.length, removidos: remover.length },
      };

    } catch (error) {
      console.error('[SHEETS] Erro em salvarNaBase:', error);
      return { ok: false, msg: error.message };
    }
  }

  // ===== CORREÇÕES PELO PRÓPRIO USUÁRIO (Base e Lista) =====

  // Usuário logado (token da sessão); '' sem sessão
  async usuarioLogado() {
    const acesso = await require('./setores').acessoAtual();
    return acesso.logado ? acesso.usuario : '';
  }

  // Grava células de uma linha: { nomeNoCodigo: valor }
  async gravarCelulas(sheet, mapa, rowNumber, campos) {
    const data = Object.entries(campos).map(([nome, valor]) => ({
      range: `${sheet.a1SheetName}!${letraColuna(sheet.headerValues.indexOf(mapa[nome]) + 1)}${rowNumber}`,
      values: [[String(valor ?? '')]],
    }));
    if (data.length) await this.doc.sheetsApi.post('/values:batchUpdate', { valueInputOption: 'RAW', data });
  }

  /**
   * Registros da Base gravados pelo usuário logado numa data (dd/mm/aaaa ou aaaa-mm-dd).
   */
  async minhaBase(data) {
    const usuario = await this.usuarioLogado();
    if (!usuario) return { ok: false, msg: 'Sessão expirada. Faça login novamente.' };
    await this.init();
    const sheet = this.doc.sheetsByTitle['Base'];
    if (!sheet) return { ok: true, registros: [] };
    const mapa = await this.colunas(sheet, COLUNAS_BASE);
    const v = (row, nome) => this.valor(row, mapa, nome);
    const alvo = normalizarDataBR(data) || this.getDataHojeBR();

    const registros = (await sheet.getRows())
      .filter(row => v(row, 'Supervisor') === usuario && normalizarDataBR(v(row, 'Data')) === alvo)
      .map(row => ({
        linha: row.rowNumber,
        aba: v(row, 'Aba'),
        matricula: v(row, 'Matricula'),
        nome: v(row, 'Nome'),
        funcao: v(row, 'Função'),
        status: v(row, 'Status'),
        desvio: v(row, 'Desvio'),
        turno: v(row, 'Turno'),
        corrigidoEm: v(row, 'Corrigido em'),
      }));
    return { ok: true, data: alvo, registros };
  }

  // Linha da Base do usuário logado (confere dono e matrícula: a linha pode ter mudado de posição)
  async linhaMinhaBase(linha, matricula) {
    const usuario = await this.usuarioLogado();
    if (!usuario) return { erro: 'Sessão expirada. Faça login novamente.' };
    await this.init();
    const sheet = this.doc.sheetsByTitle['Base'];
    if (!sheet) return { erro: 'Aba Base não encontrada' };
    const mapa = await this.colunas(sheet, COLUNAS_BASE);
    const row = (await sheet.getRows()).find(r => r.rowNumber === Number(linha));
    if (!row || this.valor(row, mapa, 'Matricula') !== String(matricula || '').trim()) {
      return { erro: 'Registro não encontrado (a Base mudou; recarregue)' };
    }
    if (this.valor(row, mapa, 'Supervisor') !== usuario) {
      return { erro: 'Só quem salvou este registro pode corrigi-lo' };
    }
    return { sheet, mapa, row, usuario };
  }

  // Corrige status, desvio, função ou turno de um registro da Base
  async corrigirBase({ linha, matricula, campos }) {
    try {
      const { sheet, mapa, row, erro } = await this.linhaMinhaBase(linha, matricula);
      if (erro) return { ok: false, msg: erro };
      const permitidos = { status: 'Status', desvio: 'Desvio', funcao: 'Função', turno: 'Turno' };
      const alterar = {};
      Object.entries(permitidos).forEach(([k, col]) => {
        if (campos && k in campos) alterar[col] = String(campos[k] ?? '').trim();
      });
      if (!Object.keys(alterar).length) return { ok: false, msg: 'Nada para corrigir' };
      alterar['Corrigido em'] = new Date().toLocaleString('pt-BR', { timeZone: fusoAtual() });
      await this.gravarCelulas(sheet, mapa, row.rowNumber, alterar);
      this.invalidateCache('base:');
      return { ok: true, msg: 'Registro corrigido' };
    } catch (error) {
      console.error('[SHEETS] Erro ao corrigir Base:', error);
      return { ok: false, msg: error.message };
    }
  }

  // Exclui um registro da Base lançado por engano
  async excluirDaBase({ linha, matricula }) {
    try {
      const { sheet, row, erro } = await this.linhaMinhaBase(linha, matricula);
      if (erro) return { ok: false, msg: erro };
      await this.apagarLinhas(sheet, [row.rowNumber]);
      this.invalidateCache('base:');
      return { ok: true, msg: 'Registro excluído da Base' };
    } catch (error) {
      console.error('[SHEETS] Erro ao excluir da Base:', error);
      return { ok: false, msg: error.message };
    }
  }

  // Corrige nome/função de um colaborador na lista do próprio usuário
  async corrigirLista({ matricula, campos }) {
    try {
      const usuario = await this.usuarioLogado();
      if (!usuario) return { ok: false, msg: 'Sessão expirada. Faça login novamente.' };
      const { sheet, mapa } = await this.sheetLista();
      if (!sheet) return { ok: false, msg: 'Aba Lista não encontrada' };
      const row = (await sheet.getRows()).find(r =>
        this.valor(r, mapa, 'Supervisor') === usuario && this.valor(r, mapa, 'matricula') === String(matricula || '').trim());
      if (!row) return { ok: false, msg: 'Colaborador não está na sua lista' };

      const alterar = {};
      if (campos && 'nome' in campos) {
        if (!String(campos.nome || '').trim()) return { ok: false, msg: 'Informe o nome' };
        alterar['Nome'] = String(campos.nome).trim();
      }
      if (campos && 'funcao' in campos) alterar['Função'] = String(campos.funcao || '').trim();
      if (!Object.keys(alterar).length) return { ok: false, msg: 'Nada para corrigir' };

      await this.gravarCelulas(sheet, mapa, row.rowNumber, alterar);
      this.invalidateCache('buffer:');
      return { ok: true, msg: 'Lista corrigida' };
    } catch (error) {
      console.error('[SHEETS] Erro ao corrigir Lista:', error);
      return { ok: false, msg: error.message };
    }
  }

  // ===== MAPA DE CARGA =====

  async getMapaCarga(filtros = {}) {
    try {
      await this.init();

      const cacheKey = 'mapaCarga:todos';
      const cached = this.getCached(cacheKey);
      if (cached) return this.mapaDoSetor(cached);

      console.log('[SHEETS] Carregando Mapa de Carga do Sheets...');
      const sheet = this.doc.sheetsByTitle['Mapa de Carga'];
      if (!sheet) return [];

      const rows = await sheet.getRows();
      const dados = [];

      rows.forEach(row => {
        const carga = String(row.get('Carga') || '').trim();
        if (!carga) return;

        dados.push({
          empresa:         String(row.get('Empresa')           || '').trim(),
          sm:              String(row.get('SM')                 || '').trim(),
          deposito:        String(row.get('Deposito')           || '').trim(),
          box:             String(row.get('BOX')                || '').trim(),
          carga,
          descricao:       String(row.get('Descrição')          || '').trim(),
          ton:             String(row.get('Ton')                || '0').trim(),
          m3:              parseFloat(String(row.get('M³') || row.get('Volume') || '0').replace(',', '.')) || 0,
          valor:           String(row.get('Valor')              || '0').trim(),
          rup:             String(row.get('Rup')                || '').trim(),
          visitasPendente: String(row.get('Visitas Pendente')   || '0').trim(),
          inclusao:        String(row.get('inclusão')           || '').trim(),
          roteirizacao:    String(row.get('Roteirização')       || '').trim(),
          dataRot:         String(row.get('Data Rot')           || '').trim(),
          geracaoMesa:     String(row.get('Geração Mesa')       || '').trim(),
          reposicao:       String(row.get('Reposição')          || '').trim(),
          paleteBox:       String(row.get('Palete_Box')         || '').trim(),
          baixa:           String(row.get('Baixa')              || '').trim(),
          statusSep:       String(row.get('Separação st')       || '').trim(),
          finalSeparacao:  String(row.get('Final separação')    || '').trim(),
          conferencia:     String(row.get('Conferencia')        || '').trim(),
          statusConf:      String(row.get('conf. St')           || '').trim(),
          loja:            String(row.get('Loja')               || '').trim(),
          diaOferta:       String(row.get('Dia oferta')         || '').trim(),
          prioridade:      String(row.get('Prioridade')         || '').trim(),
          totalVertical:   String(row.get('Total_Vertical')     || '').trim(),
          segmento:        String(row.get('Segmento')           || '').trim(),
          tipoLoja:        String(row.get('Tipo Loja')          || '').trim(),
          conjugada:       String(row.get('Conjugada')          || '').trim(),
          departamento:    String(row.get('Departamento')       || '').trim(),
        });
      });

      this.setCache(cacheKey, dados);
      console.log(`[SHEETS] ${dados.length} cargas carregadas e cacheadas`);
      return this.mapaDoSetor(dados);

    } catch (error) {
      console.error('[SHEETS] Erro ao carregar Mapa de Carga:', error);
      throw error;
    }
  }

  // Setorização do Mapa de Carga: cargas dos setores do usuário (sem setor = visíveis a todos)
  async mapaDoSetor(dados) {
    const regra = await require('./setores').regraDeAcesso();
    if (!regra.ok) return [];
    return dados.filter(c => regra.permite({ departamento: c.departamento, semDonoVisivel: true }));
  }

  async getCargasSemBox(filtros = {}) {
    const todas = await this.getMapaCarga(filtros);
    return todas.filter(c => !c.box || c.box === '');
  }

  async getEstadoBoxes() {
    const todas = await this.getMapaCarga();
    return todas
      .filter(c => c.box && c.box !== '')
      .map(c => ({
        box:       c.box,
        carga:     c.carga,
        descricao: c.descricao,
        loja:      c.loja,
        tipoLoja:  c.tipoLoja,
        m3:        c.m3,
        dataRot:   c.dataRot,
        valor:     c.valor,
      }));
  }

  async alocarCargaBox(boxNum, cargaId) {
    try {
      await this.init();
      const sheet = this.doc.sheetsByTitle['Mapa de Carga'];
      if (!sheet) return { ok: false, msg: 'Aba Mapa de Carga não encontrada' };

      const rows = await sheet.getRows();
      for (const row of rows) {
        if (String(row.get('Carga') || '').trim() === String(cargaId)) {
          row.set('BOX', String(boxNum));
          await row.save();
          this.invalidateCache('mapaCarga:');
          return { ok: true, msg: `Carga alocada no BOX ${boxNum}` };
        }
      }
      return { ok: false, msg: 'Carga não encontrada' };

    } catch (error) {
      console.error('[SHEETS] Erro ao alocar carga:', error);
      return { ok: false, msg: error.message };
    }
  }

  async liberarBox(boxNum) {
    try {
      await this.init();
      const sheet = this.doc.sheetsByTitle['Mapa de Carga'];
      if (!sheet) return { ok: false, msg: 'Aba Mapa de Carga não encontrada' };

      const rows = await sheet.getRows();
      let liberados = 0;
      for (const row of rows) {
        if (String(row.get('BOX') || '').trim() === String(boxNum)) {
          row.set('BOX', '');
          await row.save();
          liberados++;
        }
      }

      this.invalidateCache('mapaCarga:');
      return { ok: true, msg: `BOX ${boxNum} liberado`, cargas: liberados };

    } catch (error) {
      console.error('[SHEETS] Erro ao liberar BOX:', error);
      return { ok: false, msg: error.message };
    }
  }

  async atualizarMapaCarga(carga, campos) {
    try {
      await this.init();
      const sheet = this.doc.sheetsByTitle['Mapa de Carga'];
      if (!sheet) return { ok: false, msg: 'Aba Mapa de Carga não encontrada' };

      const rows = await sheet.getRows();
      for (const row of rows) {
        if (String(row.get('Carga') || '').trim() === String(carga)) {
          Object.keys(campos).forEach(col => row.set(col, campos[col]));
          await row.save();
          this.invalidateCache('mapaCarga:');
          return { ok: true };
        }
      }
      return { ok: false, msg: 'Carga não encontrada' };

    } catch (error) {
      return { ok: false, msg: error.message };
    }
  }

  async limparColunasMapaCarga() {
    try {
      await this.init();
      const sheet = this.doc.sheetsByTitle['Mapa de Carga'];
      if (!sheet) return { ok: false, msg: 'Aba Mapa de Carga não encontrada' };

      await sheet.loadHeaderRow();
      const headers = sheet.headerValues;

      const colunasParaLimpar = ['Empresa','SM','Deposito','BOX','Carga','Coluna 1','Descrição','sp','Ton','M³','Valor','Rup','Visita Picking','Volume','Coluna 2','inclusão','Roteirização','Geração Mesa','"','Reposição','Palete_Box','Baixa','Separação','Final separação','Conferencia','seotr'];
      const colunasProtegidas = ['Visitas Pendente','Separação st','conf. St','Loja','Dia oferta','Prioridade','Total_Vertical','Segmento','Tipo Loja','Data Rot','Conjugada'];

      const indicesColunas = [];
      colunasParaLimpar.forEach(col => {
        const idx = headers.indexOf(col);
        if (idx !== -1 && !colunasProtegidas.includes(col)) {
          indicesColunas.push(idx);
        }
      });

      if (indicesColunas.length === 0) return { ok: false, msg: 'Nenhuma coluna encontrada para limpar' };

      await sheet.loadCells();
      const totalRows = sheet.rowCount;
      let linhasLimpas = 0;

      for (let row = 1; row < totalRows; row++) {
        for (const colIndex of indicesColunas) {
          const cell = sheet.getCell(row, colIndex);
          if (cell) cell.value = '';
        }
        linhasLimpas++;
        if (linhasLimpas % 100 === 0) await sheet.saveUpdatedCells();
      }
      await sheet.saveUpdatedCells();

      this.invalidateCache('mapaCarga:');
      return {
        ok: true,
        msg: `${linhasLimpas} linhas limpas em ${indicesColunas.length} colunas!`,
        total: linhasLimpas,
        colunasLimpas: indicesColunas.length,
        colunasProtegidas: colunasProtegidas.length,
      };

    } catch (error) {
      console.error('[SHEETS] Erro ao limpar:', error);
      return { ok: false, msg: 'Erro ao limpar colunas: ' + error.message };
    }
  }

  async processarMapaCargaColado(dadosColados) {
    try {
      if (!dadosColados || dadosColados.length === 0) return { ok: false, msg: 'Nenhum dado fornecido' };

      await this.init();
      const sheet = this.doc.sheetsByTitle['Mapa de Carga'];
      if (!sheet) return { ok: false, msg: 'Aba Mapa de Carga não encontrada' };

      // Setorização: cada carga colada leva o setor principal de quem colou
      const setores = require('./setores');
      const colDepartamento = await setores.colunaDepartamento(sheet);
      const departamento = await setores.setorParaGravar();

      await sheet.loadHeaderRow();
      const headers = sheet.headerValues;
      const headerMap = {};
      headers.forEach((h, idx) => { if (h) headerMap[h.trim()] = idx; });

      const linhasProcessadas = [];

      dadosColados.forEach((linha, idx) => {
        try {
          const campos = Array.isArray(linha) ? linha : String(linha).split('\t');
          if (campos.length < 10) return;

          const carga     = String(campos[4]  || '').trim();
          const descricao = String(campos[6]  || '').trim();
          if (!carga || !descricao) return;

          const dataRot = String(campos[16] || '').trim();
          linhasProcessadas.push({
            'Empresa':        String(campos[0]  || '').trim(),
            'SM':             String(campos[1]  || '').trim(),
            'Deposito':       String(campos[2]  || '').trim(),
            'BOX':            String(campos[3]  || '').trim(),
            'Carga':          carga,
            'Coluna 1':       String(campos[5]  || '').trim(),
            'Descrição':      descricao,
            'sp':             String(campos[7]  || '').trim(),
            'Ton':            String(campos[8]  || '').trim(),
            'M³':             String(campos[9]  || '').trim(),
            'Volume':         String(campos[9]  || '').trim(),
            'Valor':          String(campos[10] || '').trim(),
            'Rup':            String(campos[11] || '').trim(),
            'Visita Picking': String(campos[12] || '').trim(),
            'Coluna 2':       String(campos[13] || '').trim(),
            'inclusão':       String(campos[14] || '').trim(),
            'Roteirização':   String(campos[15] || '').trim(),
            'Data Rot':       dataRot.includes(' ') ? dataRot.split(' ')[0] : dataRot,
            'Geração Mesa':   String(campos[17] || '').trim(),
            '"':              String(campos[18] || '').trim(),
            'Reposição':      String(campos[19] || '').trim(),
            'Palete_Box':     String(campos[20] || '').trim(),
            'Baixa':          String(campos[21] || '').trim(),
            'Separação':      String(campos[22] || '').trim(),
            'Final separação':String(campos[23] || '').trim(),
            'Conferencia':    String(campos[24] || '').trim(),
            'seotr':          String(campos[25] || '').trim(),
            [colDepartamento]: departamento,
          });
        } catch (e) {
          console.error(`[SHEETS] Erro linha ${idx + 1}:`, e);
        }
      });

      if (linhasProcessadas.length === 0) return { ok: false, msg: 'Nenhuma linha válida para processar' };

      const rows = await sheet.getRows();
      const lote = 50;

      if (rows.length === 0) {
        for (let i = 0; i < linhasProcessadas.length; i += lote) {
          await sheet.addRows(linhasProcessadas.slice(i, i + lote));
        }
      } else {
        await sheet.loadCells();
        const maxLinhas = Math.min(rows.length, linhasProcessadas.length);
        for (let i = 0; i < maxLinhas; i++) {
          Object.keys(linhasProcessadas[i]).forEach(col => {
            const colIndex = headerMap[col];
            if (colIndex !== undefined) {
              const cell = sheet.getCell(i + 1, colIndex);
              if (cell) cell.value = linhasProcessadas[i][col];
            }
          });
          if ((i + 1) % 50 === 0) await sheet.saveUpdatedCells();
        }
        await sheet.saveUpdatedCells();

        if (linhasProcessadas.length > rows.length) {
          const novas = linhasProcessadas.slice(rows.length);
          for (let i = 0; i < novas.length; i += lote) {
            await sheet.addRows(novas.slice(i, i + lote));
          }
        }
      }

      this.invalidateCache('mapaCarga:');
      return { ok: true, msg: `${linhasProcessadas.length} cargas processadas com sucesso!`, total: linhasProcessadas.length };

    } catch (error) {
      console.error('[SHEETS] Erro no processamento:', error);
      return { ok: false, msg: error.message };
    }
  }
}

const service = new SheetsService();
service.letraColuna = letraColuna;
service.chaveMatricula = chaveMatricula;

module.exports = service;
