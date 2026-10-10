const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');

// "d/m/aaaa" ou "aaaa-mm-dd" → "dd/mm/aaaa"
function normalizarDataBR(valor) {
  const t = String(valor || '').trim();
  let m = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return `${m[3].padStart(2, '0')}/${m[2].padStart(2, '0')}/${m[1]}`;
  m = t.match(/^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{4})/);
  if (m) return `${m[1].padStart(2, '0')}/${m[2].padStart(2, '0')}/${m[3]}`;
  return t;
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
    // Formata no fuso de Manaus (America/Manaus = GMT-4, sem horário de verão)
    return agora.toLocaleDateString('pt-BR', { timeZone: 'America/Manaus' });
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
    const valores = (await sheet.getCellsInRange('A:Z')) || [];
    if (!valores.length) return [];

    const norm = v => String(v || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
    const cab = valores[0].map(norm);
    const temCabecalho = (cab[1] || '').includes('nome') || /coluna|matricula|chapa/.test(cab[0] || '');
    let idxFuncao = -1;
    if (temCabecalho) {
      idxFuncao = cab.findIndex(h => h.includes('funcao que atua'));
      if (idxFuncao === -1) idxFuncao = cab.findIndex(h => h.includes('funcao'));
    }

    return valores.slice(temCabecalho ? 1 : 0)
      .map(linha => ({
        matricula: String(linha[0] || '').trim(),
        nome:      String(linha[1] || '').trim(),
        funcao:    idxFuncao === -1 ? '' : String(linha[idxFuncao] || '').trim(),
      }))
      .filter(c => c.nome);
  }

  async buscarColaboradores(filtro = '') {
    try {
      await this.init();

      const cacheKey = 'quadro:todos';
      let lista = this.getCached(cacheKey);

      if (!lista) {
        const sheet = this.doc.sheetsByTitle['Quadro'];
        if (!sheet) return [];
        lista = await this.lerQuadro(sheet);
        // Lista vazia não fica em cache: o Quadro pode ser preenchido a qualquer momento
        if (lista.length) this.setCache(cacheKey, lista);
      }

      if (!filtro) return lista;

      const semAcento = v => String(v || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
      const f = semAcento(filtro.trim());
      return lista.filter(c =>
        semAcento(c.nome).includes(f) ||
        semAcento(c.matricula).includes(f)
      );

    } catch (error) {
      console.error('Erro busca:', error);
      return [];
    }
  }

  // ===== BUFFER (Lista) =====

  async adicionarBuffer(supervisor, aba, colaborador) {
    try {
      console.log('[SHEETS] Adicionando ao buffer:', { supervisor, aba, colaborador });
      await this.init();
      const sheet = this.doc.sheetsByTitle['Lista'];
      if (!sheet) return { ok: false, msg: 'Aba Lista não encontrada' };

      const rows = await sheet.getRows();
      const jaExiste = rows.some(row =>
        String(row.get('Supervisor') || '').trim() === supervisor &&
        String(row.get('Grupo')      || '').trim() === aba &&
        String(row.get('matricula')  || '').trim() === String(colaborador.matricula)
      );

      if (jaExiste) return { ok: true, msg: 'Colaborador já está na lista' };

      // Um colaborador só pode estar na lista de um supervisor
      const deOutro = rows.find(row =>
        String(row.get('matricula')  || '').trim() === String(colaborador.matricula) &&
        String(row.get('Supervisor') || '').trim() !== supervisor
      );
      if (deOutro) {
        const outroSup = String(deOutro.get('Supervisor') || '').trim();
        const outraAba = String(deOutro.get('Grupo') || '').trim();
        return {
          ok: false,
          msg: `${colaborador.nome || 'Colaborador'} já está na lista do supervisor ${outroSup}${outraAba ? ` (${outraAba})` : ''}`,
        };
      }

      await sheet.addRow({
        'Supervisor': supervisor,
        'Grupo':      aba,
        'matricula':  String(colaborador.matricula),
        'Nome':       colaborador.nome,
        'Função':     colaborador.funcao,
        'status':     '',
        'desvio':     ''
      });

      this.invalidateCache(`buffer:${supervisor}:${aba}`);
      return { ok: true };

    } catch (error) {
      console.error('[SHEETS] Erro ao adicionar:', error);
      return { ok: false, msg: error.message };
    }
  }

  async getBuffer(supervisor, aba) {
    try {
      await this.init();

      const cacheKey = `buffer:${supervisor}:${aba}`;
      const cached = this.getCached(cacheKey);
      if (cached) return cached;

      const sheet = this.doc.sheetsByTitle['Lista'];
      if (!sheet) return [];

      const rows = await sheet.getRows();
      const buffer = rows
        .filter(row =>
          String(row.get('Supervisor') || '').trim() === supervisor &&
          String(row.get('Grupo')      || '').trim() === aba
        )
        .map(row => ({
          matricula: String(row.get('matricula') || '').trim(),
          nome:      String(row.get('Nome')      || '').trim(),
          funcao:    String(row.get('Função')    || '').trim(),
          status:    String(row.get('status')    || '').trim(),
          desvio:    String(row.get('desvio')    || '').trim(),
        }));

      this.setCache(cacheKey, buffer);
      return buffer;

    } catch (error) {
      console.error('[SHEETS] Erro ao buscar buffer:', error);
      return [];
    }
  }

  async removerBuffer(supervisor, matricula) {
    try {
      await this.init();
      const sheet = this.doc.sheetsByTitle['Lista'];
      if (!sheet) return { ok: false };

      const rows = await sheet.getRows();
      for (const row of rows) {
        if (
          String(row.get('Supervisor') || '').trim() === supervisor &&
          String(row.get('matricula')  || '').trim() === String(matricula)
        ) {
          await row.delete();
          this.invalidateCache(`buffer:${supervisor}`);
          return { ok: true };
        }
      }
      return { ok: false };

    } catch (error) {
      console.error('[SHEETS] Erro ao remover:', error);
      return { ok: false };
    }
  }

  async atualizarStatusBuffer(supervisor, matricula, status) {
    try {
      await this.init();
      const sheet = this.doc.sheetsByTitle['Lista'];
      if (!sheet) return { ok: false };

      const rows = await sheet.getRows();
      for (const row of rows) {
        if (
          String(row.get('Supervisor') || '').trim() === supervisor &&
          String(row.get('matricula')  || '').trim() === String(matricula)
        ) {
          row.set('status', status);
          await row.save();
          this.invalidateCache(`buffer:${supervisor}`);
          return { ok: true };
        }
      }
      return { ok: false };

    } catch (error) {
      console.error('[SHEETS] Erro ao atualizar status:', error);
      return { ok: false };
    }
  }

  async removerBufferPorAba(chave, matricula) {
    try {
      await this.init();
      const sheet = this.doc.sheetsByTitle['Lista'];
      if (!sheet) return { ok: false, msg: 'Aba Lista não encontrada' };

      const rows = await sheet.getRows();
      for (const row of rows) {
        const supervisor = String(row.get('Supervisor') || '').trim();
        const grupo      = String(row.get('Grupo')      || '').trim();
        const mat        = String(row.get('matricula')  || '').trim();
        if ((supervisor === chave || grupo === chave) && mat === String(matricula)) {
          await row.delete();
          this.invalidateCache('buffer:');
          return { ok: true };
        }
      }
      return { ok: false, msg: 'Colaborador não encontrado' };

    } catch (error) {
      return { ok: false, msg: error.message };
    }
  }

  async atualizarStatusBufferPorAba(chave, matricula, status) {
    try {
      await this.init();
      const sheet = this.doc.sheetsByTitle['Lista'];
      if (!sheet) return { ok: false, msg: 'Aba Lista não encontrada' };

      const rows = await sheet.getRows();
      for (const row of rows) {
        const supervisor = String(row.get('Supervisor') || '').trim();
        const grupo      = String(row.get('Grupo')      || '').trim();
        const mat        = String(row.get('matricula')  || '').trim();
        if ((supervisor === chave || grupo === chave) && mat === String(matricula)) {
          row.set('status', status);
          await row.save();
          this.invalidateCache('buffer:');
          return { ok: true };
        }
      }
      return { ok: false, msg: 'Colaborador não encontrado' };

    } catch (error) {
      return { ok: false, msg: error.message };
    }
  }

  async atualizarDesvioBufferPorAba(chave, matricula, desvio) {
    try {
      await this.init();
      const sheet = this.doc.sheetsByTitle['Lista'];
      if (!sheet) return { ok: false, msg: 'Aba Lista não encontrada' };

      const rows = await sheet.getRows();
      for (const row of rows) {
        const supervisor = String(row.get('Supervisor') || '').trim();
        const grupo      = String(row.get('Grupo')      || '').trim();
        const mat        = String(row.get('matricula')  || '').trim();
        if ((supervisor === chave || grupo === chave) && mat === String(matricula)) {
          row.set('desvio', desvio);
          await row.save();
          this.invalidateCache('buffer:');
          return { ok: true };
        }
      }
      return { ok: false, msg: 'Colaborador não encontrado' };

    } catch (error) {
      return { ok: false, msg: error.message };
    }
  }

  // ===== SALVAR NA BASE =====
  // CORREÇÃO BUG 2 + BUG 4:
  // - Usa fuso de Manaus para a data (GMT-4)
  // - Remove registros órfãos do supervisor/aba de hoje antes de salvar os novos
  //   (evita que colaboradores removidos do buffer continuem na Base)
  // - Valida campos antes de processar
  async salvarNaBase(dados) {
    try {
      await this.init();
      const sheet = this.doc.sheetsByTitle['Base'];
      if (!sheet) return { ok: false, msg: 'Aba Base não encontrada' };

      // CORREÇÃO BUG 4: data no fuso correto (Manaus GMT-4)
      const hoje = this.getDataHojeBR();
      console.log(`[SHEETS] Data usada para salvar: ${hoje}`);

      // Extrai supervisor e aba do primeiro registro para usar como chave de limpeza
      // (todos os registros do mesmo envio pertencem ao mesmo supervisor+aba)
      const primeiroRegistro = dados.find(d => d[0] && d[1]);
      if (!primeiroRegistro) {
        return { ok: false, msg: 'Nenhum dado válido para salvar' };
      }
      const supervisorChave = String(primeiroRegistro[0]).trim();
      const abaChave        = String(primeiroRegistro[1]).trim();

      console.log(`[SHEETS] Salvando para Supervisor="${supervisorChave}", Aba="${abaChave}", Data="${hoje}"`);

      // CORREÇÃO BUG 2: Remove TODOS os registros deste supervisor+aba+data
      // antes de inserir os novos, para evitar registros órfãos (colaboradores
      // que foram removidos do buffer mas ainda estavam na Base).
      const rowsExistentes = await sheet.getRows();
      const rowsParaRemover = rowsExistentes.filter(row =>
        String(row.get('Supervisor') || '').trim() === supervisorChave &&
        String(row.get('Aba')        || '').trim() === abaChave &&
        normalizarDataBR(row.get('Data')) === hoje
      );

      console.log(`[SHEETS] Removendo ${rowsParaRemover.length} registros antigos do dia para ${supervisorChave}/${abaChave}`);

      // Remove em paralelo para ser mais rápido
      for (const row of rowsParaRemover) {
        await row.delete();
      }

      // Insere todos os registros novos em lote
      let totalNovos = 0;
      const rowsParaInserir = [];

      for (const linha of dados) {
        const [sup, aba, matricula, nome, funcao, status, desvio] = linha;

        // CORREÇÃO BUG 3: valida campos obrigatórios antes de inserir
        const supStr      = String(sup      || '').trim();
        const abaStr      = String(aba      || '').trim();
        const matriculaStr= String(matricula|| '').trim();
        const nomeStr     = String(nome     || '').trim();
        const funcaoStr   = String(funcao   || '').trim();
        const statusStr   = String(status   || '').trim();
        const desvioStr   = String(desvio   || '').trim();

        // Ignora linhas sem matrícula E sem nome
        if (!matriculaStr && !nomeStr) {
          console.warn('[SHEETS] Linha ignorada: sem matrícula e sem nome', linha);
          continue;
        }

        rowsParaInserir.push({
          'Supervisor': supStr,
          'Aba':        abaStr,
          'Matricula':  matriculaStr,
          'Nome':       nomeStr,
          'Função':     funcaoStr,
          'Status':     statusStr,
          'Desvio':     desvioStr,
          'Data':       hoje
        });
        totalNovos++;
      }

      // Adiciona em lote (mais eficiente)
      if (rowsParaInserir.length > 0) {
        await sheet.addRows(rowsParaInserir, { raw: true });
      }

      this.invalidateCache('base:');

      console.log(`[SHEETS] Concluído: ${totalNovos} registros salvos para ${supervisorChave}/${abaChave}`);
      return {
        ok: true,
        msg: `${totalNovos} registros salvos (${rowsParaRemover.length} antigos removidos)`,
        totais: {
          novos: totalNovos,
          removidos: rowsParaRemover.length
        }
      };

    } catch (error) {
      console.error('[SHEETS] Erro em salvarNaBase:', error);
      return { ok: false, msg: error.message };
    }
  }

  // ===== MAPA DE CARGA =====

  async getMapaCarga(filtros = {}) {
    try {
      await this.init();

      const cacheKey = 'mapaCarga:todos';
      const cached = this.getCached(cacheKey);
      if (cached) return cached;

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
        });
      });

      this.setCache(cacheKey, dados);
      console.log(`[SHEETS] ${dados.length} cargas carregadas e cacheadas`);
      return dados;

    } catch (error) {
      console.error('[SHEETS] Erro ao carregar Mapa de Carga:', error);
      throw error;
    }
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

module.exports = new SheetsService();
