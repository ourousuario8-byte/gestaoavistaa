// lib/sheets_2.js - VERSÃO COMPLETA COM COLETORES E CHAVES
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');

class SheetsColetorService {
  constructor() {
    this.docHistorico = null;
    this.docAtual = null;
    this.initialized = false;
  }

  async init() {
    if (this.initialized) return { docHistorico: this.docHistorico, docAtual: this.docAtual };
    
    try {
      console.log('[SHEETS_COLETOR] Iniciando conexão...');
      
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
      
      // PLANILHA HISTÓRICO
      const sheetIdHistorico = process.env.GOOGLE_SHEETS_ID_COLETOR;
      if (!sheetIdHistorico) {
        throw new Error('GOOGLE_SHEETS_ID_COLETOR não configurado');
      }
      
      this.docHistorico = new GoogleSpreadsheet(sheetIdHistorico, serviceAccountAuth);
      await this.docHistorico.loadInfo();
      console.log(`[SHEETS_COLETOR] ✓ Histórico: ${this.docHistorico.title}`);
      
      // PLANILHA ATUAL
      const sheetIdAtual = process.env.GOOGLE_SHEETS_ID;
      if (!sheetIdAtual) {
        throw new Error('GOOGLE_SHEETS_ID não configurado');
      }
      
      this.docAtual = new GoogleSpreadsheet(sheetIdAtual, serviceAccountAuth);
      await this.docAtual.loadInfo();
      console.log(`[SHEETS_COLETOR] ✓ Atual: ${this.docAtual.title}`);
      
      this.initialized = true;
      return { docHistorico: this.docHistorico, docAtual: this.docAtual };
    } catch (error) {
      console.error('[SHEETS_COLETOR] Erro:', error);
      throw new Error('Falha na conexão: ' + error.message);
    }
  }

  async obterDados() {
    try {
      await this.init();
      console.log('[SHEETS_COLETOR] Buscando Quadro...');
      
      const sheet = this.docAtual.sheetsByTitle['Quadro'];
      if (!sheet) {
        console.error('[SHEETS_COLETOR] Aba Quadro não encontrada');
        return [];
      }
      
      const rows = await sheet.getRows();
      const dados = [];
      
      rows.forEach(row => {
        const chapa = String(row.get('Coluna 1') || '').trim();
        const nome = String(row.get('NOME') || '').trim();
        const funcao = String(row.get('Função que atua') || row.get('FUNÇÃO NO RM') || '').trim();
        
        if (chapa && nome) {
          dados.push({ chapa, nome, funcao });
        }
      });
      
      console.log(`[SHEETS_COLETOR] ✓ ${dados.length} colaboradores`);
      return dados;
      
    } catch (error) {
      console.error('[SHEETS_COLETOR] Erro:', error);
      return [];
    }
  }

  async salvarRegistro(chapa, nome, funcao, numeroColetor, tipoOperacao, situacoes) {
    try {
      await this.init();
      console.log('[SHEETS_COLETOR] Salvando:', { chapa, numeroColetor, tipoOperacao });
      
      if (!chapa || !numeroColetor || !situacoes || situacoes.length === 0) {
        return { ok: false, msg: 'Campos obrigatórios faltando' };
      }
      
      const agora = new Date();
      const situacoesTexto = situacoes.join(', ');
      const dataFormatada = this.formatarDataBR(agora);
      const horaFormatada = this.formatarHora(agora);
      
      const { supervisor, turno } = await this.buscarSupervisorETurnoNaBase(chapa);
      
      // ===== 1. SALVA NO HISTÓRICO (GOOGLE_SHEETS_ID_COLETOR - ABA "Historico") =====
      try {
        await this.salvarNoHistorico({
          data: dataFormatada,
          hora: horaFormatada,
          chapa,
          nome,
          funcao,
          numeroColetor,
          tipoOperacao,
          situacao: situacoesTexto,
          supervisor,
          turno
        });
        console.log('[SHEETS_COLETOR] ✓ Salvo no histórico');
      } catch (errorHistorico) {
        console.error('[SHEETS_COLETOR] Erro no histórico:', errorHistorico);
        throw new Error('Erro ao salvar histórico: ' + errorHistorico.message);
      }
      
      // ===== 2. EMPILHA NA ABA COLETOR (GOOGLE_SHEETS_ID - EMPILHAMENTO) =====
      try {
        await this.empilharNaAbaColetor({
          chapa,
          nome,
          funcao,
          numeroColetor,
          tipoOperacao,
          situacao: situacoesTexto,
          supervisor,
          turno,
          data: dataFormatada,
          hora: horaFormatada
        });
        console.log('[SHEETS_COLETOR] ✓ Empilhado na aba Coletor');
      } catch (errorColetor) {
        console.error('[SHEETS_COLETOR] Erro ao empilhar:', errorColetor);
        console.log('[SHEETS_COLETOR] ⚠ Continuando apesar do erro');
      }
      
      return { ok: true, msg: 'Dados salvos com sucesso!' };
      
    } catch (error) {
      console.error('[SHEETS_COLETOR] Erro geral:', error);
      return { ok: false, msg: error.message };
    }
  }

  async salvarNoHistorico(dados) {
    try {
      console.log('[SHEETS_COLETOR] Salvando no histórico (aba Historico)...');
      
      // ===== BUSCA OU CRIA ABA "Historico" NA PLANILHA DE HISTÓRICO =====
      let sheetHistorico = this.docHistorico.sheetsByTitle['Historico'];
      
      if (!sheetHistorico) {
        console.log('[SHEETS_COLETOR] Criando aba Historico no histórico...');
        sheetHistorico = await this.docHistorico.addSheet({
          title: 'Historico',
          headerValues: ['Data', 'Hora', 'Chapa', 'Nome', 'Funcao', 'NumeroColetor', 'TipoOperacao', 'Situacao', 'Supervisor', 'Turno']
        });
      }
      
      const rows = await sheetHistorico.getRows();
      
      // ===== VALIDAÇÃO ANTI-DUPLICAÇÃO =====
      if (rows.length > 0) {
        const ultima = rows[rows.length - 1];
        const ultimaData = ultima.get('Data');
        const ultimaHora = ultima.get('Hora');
        const ultimaChapa = String(ultima.get('Chapa') || '').trim();
        const ultimoColetor = String(ultima.get('NumeroColetor') || '').trim();
        const ultimoTipo = String(ultima.get('TipoOperacao') || '').trim();
        
        if (ultimaChapa === dados.chapa && 
            ultimoColetor === String(dados.numeroColetor) && 
            ultimoTipo === dados.tipoOperacao &&
            ultimaData === dados.data) {
          
          try {
            const [ultH, ultM] = ultimaHora.split(':').map(Number);
            const [novoH, novoM] = dados.hora.split(':').map(Number);
            
            const ultMinutos = ultH * 60 + ultM;
            const novoMinutos = novoH * 60 + novoM;
            
            if (Math.abs(novoMinutos - ultMinutos) < 2) {
              throw new Error('Registro duplicado (menos de 2 minutos)');
            }
          } catch (timeError) {
            console.error('[SHEETS_COLETOR] Erro ao validar tempo:', timeError);
          }
        }
      }
      
      // ===== ADICIONA NOVO REGISTRO =====
      await sheetHistorico.addRow({
        'Data': dados.data,
        'Hora': dados.hora,
        'Chapa': dados.chapa,
        'Nome': dados.nome,
        'Funcao': dados.funcao,
        'NumeroColetor': String(dados.numeroColetor),
        'TipoOperacao': dados.tipoOperacao,
        'Situacao': dados.situacao,
        'Supervisor': dados.supervisor,
        'Turno': dados.turno
      });
      
      console.log('[SHEETS_COLETOR] ✓ Adicionado ao histórico (aba Historico)');
      
    } catch (error) {
      console.error('[SHEETS_COLETOR] Erro ao salvar no histórico:', error);
      throw error;
    }
  }

  async empilharNaAbaColetor(dados) {
    try {
      console.log('[SHEETS_COLETOR] Processando aba Coletor (GOOGLE_SHEETS_ID)...');
      
      // ===== BUSCA OU CRIA ABA "Coletor" NA PLANILHA ATUAL =====
      let sheetColetor = this.docAtual.sheetsByTitle['Coletor'];
      
      if (!sheetColetor) {
        console.log('[SHEETS_COLETOR] Criando aba Coletor...');
        
        try {
          sheetColetor = await this.docAtual.addSheet({
            title: 'Coletor',
            headerValues: ['Data', 'Hora', 'Chapa', 'Nome', 'Funcao', 'NumeroColetor', 'TipoOperacao', 'Situacao', 'Supervisor', 'Turno']
          });
          console.log('[SHEETS_COLETOR] ✓ Aba Coletor criada');
        } catch (createError) {
          console.error('[SHEETS_COLETOR] Erro ao criar aba:', createError);
          throw new Error('Falha ao criar aba Coletor: ' + createError.message);
        }
      }
      
      // ===== CARREGA REGISTROS EXISTENTES =====
      let rows;
      try {
        await sheetColetor.loadHeaderRow();
        rows = await sheetColetor.getRows();
        console.log(`[SHEETS_COLETOR] ${rows.length} registros existentes na aba Coletor`);
      } catch (loadError) {
        console.error('[SHEETS_COLETOR] Erro ao carregar linhas:', loadError);
        throw new Error('Falha ao carregar dados: ' + loadError.message);
      }
      
      // ===== BUSCA REGISTRO EXISTENTE (MESMA DATA + MESMA CHAPA + MESMO COLETOR) =====
      let registroExistente = null;
      
      for (const row of rows) {
        const dataRow = String(row.get('Data') || '').trim();
        const chapaRow = String(row.get('Chapa') || '').trim();
        const coletorRow = String(row.get('NumeroColetor') || '').trim();
        
        if (dataRow === dados.data && 
            chapaRow === dados.chapa && 
            coletorRow === String(dados.numeroColetor)) {
          registroExistente = row;
          console.log('[SHEETS_COLETOR] Registro encontrado para sobrepor TipoOperacao');
          break;
        }
      }
      
      // ===== SOBREPÕE OU EMPILHA =====
      if (registroExistente) {
        // SOBREPÕE APENAS TipoOperacao (mantém o restante)
        console.log(`[SHEETS_COLETOR] Sobrepondo TipoOperacao de "${registroExistente.get('TipoOperacao')}" para "${dados.tipoOperacao}"`);
        
        try {
          registroExistente.set('TipoOperacao', dados.tipoOperacao);
          registroExistente.set('Hora', dados.hora); // Atualiza hora também
          await registroExistente.save();
          console.log('[SHEETS_COLETOR] ✓ TipoOperacao sobreposto');
        } catch (updateError) {
          console.error('[SHEETS_COLETOR] Erro ao sobrepor:', updateError);
          throw new Error('Falha ao sobrepor TipoOperacao: ' + updateError.message);
        }
        
      } else {
        // EMPILHA (adiciona nova linha)
        console.log('[SHEETS_COLETOR] Nenhum registro encontrado, empilhando nova linha');
        
        try {
          await sheetColetor.addRow({
            'Data': dados.data,
            'Hora': dados.hora,
            'Chapa': dados.chapa,
            'Nome': dados.nome,
            'Funcao': dados.funcao,
            'NumeroColetor': String(dados.numeroColetor),
            'TipoOperacao': dados.tipoOperacao,
            'Situacao': dados.situacao,
            'Supervisor': dados.supervisor,
            'Turno': dados.turno
          });
          console.log('[SHEETS_COLETOR] ✓ Registro empilhado');
        } catch (addError) {
          console.error('[SHEETS_COLETOR] Erro ao empilhar:', addError);
          throw new Error('Falha ao empilhar: ' + addError.message);
        }
      }
      
    } catch (error) {
      console.error('[SHEETS_COLETOR] Erro em empilharNaAbaColetor:', error);
      throw error;
    }
  }

  async buscarSupervisorETurnoNaBase(chapa) {
    try {
      const sheetBase = this.docAtual.sheetsByTitle['Base'];
      if (!sheetBase) {
        console.log('[SHEETS_COLETOR] Aba Base não encontrada');
        return { supervisor: 'Sem Supervisor', turno: 'Não informado' };
      }
      
      const rows = await sheetBase.getRows();
      
      // ===== BUSCA O ÚLTIMO REGISTRO DA CHAPA (INDEPENDENTE DA DATA) =====
      for (let i = rows.length - 1; i >= 0; i--) {
        const row = rows[i];
        const matricula = String(row.get('Matricula') || '').trim();
        
        if (matricula === chapa) {
          const supervisor = String(row.get('Supervisor') || '').trim();
          const turno = String(row.get('Turno') || '').trim();
          
          console.log(`[SHEETS_COLETOR] Encontrado - Supervisor: ${supervisor}, Turno: ${turno}`);
          
          return {
            supervisor: supervisor || 'Sem Supervisor',
            turno: turno || 'Não informado'
          };
        }
      }
      
      console.log('[SHEETS_COLETOR] Chapa não encontrada na Base');
      return { supervisor: 'Sem Supervisor', turno: 'Não informado' };
      
    } catch (error) {
      console.error('[SHEETS_COLETOR] Erro ao buscar na Base:', error);
      return { supervisor: 'Sem Supervisor', turno: 'Não informado' };
    }
  }

  async obterColetorStatus() {
    try {
      await this.init();
      console.log('[SHEETS_COLETOR] Obtendo status da aba Historico...');
      
      // ===== BUSCA NA ABA "Historico" DA PLANILHA DE HISTÓRICO =====
      const sheetHistorico = this.docHistorico.sheetsByTitle['Historico'];
      if (!sheetHistorico) {
        console.log('[SHEETS_COLETOR] Aba Historico não existe ainda');
        return {};
      }
      
      const rows = await sheetHistorico.getRows();
      const mapa = {};
      
      // ===== PROCESSA TODOS OS REGISTROS E MANTÉM APENAS O MAIS RECENTE DE CADA COLETOR =====
      rows.forEach(row => {
        const chapa = String(row.get('Chapa') || '').trim();
        const nome = String(row.get('Nome') || '').trim();
        const funcao = String(row.get('Funcao') || '').trim();
        const coletor = String(row.get('NumeroColetor') || '').trim();
        const tipo = String(row.get('TipoOperacao') || '').trim();
        const situacao = String(row.get('Situacao') || '').trim();
        const supervisor = String(row.get('Supervisor') || '').trim();
        const turno = String(row.get('Turno') || '').trim();
        const data = String(row.get('Data') || '').trim();
        const hora = String(row.get('Hora') || '').trim();
        
        if (coletor) {
          // Sobrescreve com o registro mais recente (última linha do coletor)
          mapa[coletor] = {
            chapa, nome, funcao, tipo, situacao, supervisor, turno,
            data: data,
            hora: hora
          };
        }
      });
      
      console.log(`[SHEETS_COLETOR] ✓ ${Object.keys(mapa).length} coletores no status`);
      return mapa;
      
    } catch (error) {
      console.error('[SHEETS_COLETOR] Erro:', error);
      return {};
    }
  }

  async gerarResumoColetores() {
    try {
      const statusMap = await this.obterColetorStatus();
      
      let disponiveis = 0, indisponiveis = 0, quebrados = 0;
      
      for (const coletor in statusMap) {
        const s = statusMap[coletor];
        if (s.tipo === "Entrega" && s.situacao === "OK") disponiveis++;
        else if (s.tipo === "Retirada") indisponiveis++;
        if (s.situacao !== "OK") quebrados++;
      }
      
      return { disponiveis, indisponiveis, quebrados, total: Object.keys(statusMap).length };
    } catch (error) {
      console.error('[SHEETS_COLETOR] Erro:', error);
      return { disponiveis: 0, indisponiveis: 0, quebrados: 0, total: 0 };
    }
  }

  async gerarResumoPorSupervisor() {
    try {
      await this.init();
      
      // ===== BUSCA NA ABA "Historico" =====
      const sheetHistorico = this.docHistorico.sheetsByTitle['Historico'];
      if (!sheetHistorico) return {};
      
      const rows = await sheetHistorico.getRows();
      const resumo = {};
      
      // ===== CONTA RETIRADAS POR SUPERVISOR =====
      const coletoresContados = new Set();
      
      // Percorre de trás para frente para pegar o status mais recente de cada coletor
      for (let i = rows.length - 1; i >= 0; i--) {
        const row = rows[i];
        const coletor = String(row.get('NumeroColetor') || '').trim();
        const sup = String(row.get('Supervisor') || 'Sem Supervisor').trim();
        const tipo = String(row.get('TipoOperacao') || '').trim();
        
        if (!coletor || coletoresContados.has(coletor)) continue;
        
        coletoresContados.add(coletor);
        
        if (!resumo[sup]) resumo[sup] = { retiradaContada: 0 };
        if (tipo === 'Retirada') resumo[sup].retiradaContada++;
      }
      
      return resumo;
    } catch (error) {
      console.error('[SHEETS_COLETOR] Erro:', error);
      return {};
    }
  }

  // ==================== FUNÇÕES PARA CHAVES ====================
  
  async salvarRegistroChave(chapa, nome, funcao, numeroChave, tipoOperacao, situacoes) {
    try {
      await this.init();
      console.log('[SHEETS_CHAVE] Salvando:', { chapa, numeroChave, tipoOperacao });
      
      if (!chapa || !numeroChave || !situacoes || situacoes.length === 0) {
        return { ok: false, msg: 'Campos obrigatórios faltando' };
      }
      
      const agora = new Date();
      const situacoesTexto = situacoes.join(', ');
      const dataFormatada = this.formatarDataBR(agora);
      const horaFormatada = this.formatarHora(agora);
      
      const { supervisor, turno } = await this.buscarSupervisorETurnoNaBase(chapa);
      
      // ===== IMPORTANTE: Garante que numeroChave é NUMBER =====
      const numChaveInt = parseInt(numeroChave);
      console.log('[SHEETS_CHAVE] Número da chave validado:', numChaveInt);
      
      try {
        await this.salvarNoHistoricoChaves({
          data: dataFormatada,
          hora: horaFormatada,
          chapa,
          nome,
          funcao,
          numeroChave: numChaveInt,  // ← Passa como número
          tipoOperacao,
          situacao: situacoesTexto,
          supervisor,
          turno
        });
        console.log('[SHEETS_CHAVE] ✓ Salvo no histórico de chaves');
      } catch (errorHistorico) {
        console.error('[SHEETS_CHAVE] Erro no histórico:', errorHistorico);
        throw new Error('Erro ao salvar histórico: ' + errorHistorico.message);
      }
      
      try {
        await this.empilharNaAbaChaves({
          chapa,
          nome,
          funcao,
          numeroChave: numChaveInt,  // ← Passa como número
          tipoOperacao,
          situacao: situacoesTexto,
          supervisor,
          turno,
          data: dataFormatada,
          hora: horaFormatada
        });
        console.log('[SHEETS_CHAVE] ✓ Empilhado na aba Chaves');
      } catch (errorChave) {
        console.error('[SHEETS_CHAVE] Erro ao empilhar:', errorChave);
        console.log('[SHEETS_CHAVE] ⚠ Continuando apesar do erro');
      }
      
      return { ok: true, msg: 'Chave registrada com sucesso!' };
      
    } catch (error) {
      console.error('[SHEETS_CHAVE] Erro geral:', error);
      return { ok: false, msg: error.message };
    }
  }
  async salvarNoHistoricoChaves(dados) {
    try {
      console.log('[SHEETS_CHAVE] Salvando no histórico (aba Historico_chaves)...');
      console.log('[SHEETS_CHAVE] Dados recebidos:', dados);
      
      let sheetHistorico = this.docHistorico.sheetsByTitle['Historico_chaves'];
      
      if (!sheetHistorico) {
        console.log('[SHEETS_CHAVE] Criando aba Historico_chaves...');
        sheetHistorico = await this.docHistorico.addSheet({
          title: 'Historico_chaves',
          headerValues: ['Data', 'Hora', 'Chapa', 'Nome', 'Funcao', 'numeroChave', 'TipoOperacao', 'Situacao', 'Supervisor', 'Turno']
        });
      }
      
      const rows = await sheetHistorico.getRows();
      
      // Validação anti-duplicação
      if (rows.length > 0) {
        const ultima = rows[rows.length - 1];
        const ultimaData = ultima.get('Data');
        const ultimaHora = ultima.get('Hora');
        const ultimaChapa = String(ultima.get('Chapa') || '').trim();
        const ultimaChave = String(ultima.get('numeroChave') || '').trim();
        const ultimoTipo = String(ultima.get('TipoOperacao') || '').trim();
        
        if (ultimaChapa === dados.chapa && 
            ultimaChave === String(dados.numeroChave) && 
            ultimoTipo === dados.tipoOperacao &&
            ultimaData === dados.data) {
          
          try {
            const [ultH, ultM] = ultimaHora.split(':').map(Number);
            const [novoH, novoM] = dados.hora.split(':').map(Number);
            
            const ultMinutos = ultH * 60 + ultM;
            const novoMinutos = novoH * 60 + novoM;
            
            if (Math.abs(novoMinutos - ultMinutos) < 2) {
              throw new Error('Registro duplicado (menos de 2 minutos)');
            }
          } catch (timeError) {
            console.error('[SHEETS_CHAVE] Erro ao validar tempo:', timeError);
          }
        }
      }
      
      // ===== CORREÇÃO: Garante que numeroChave seja salvo como STRING =====
      const numeroChaveString = String(dados.numeroChave);
      console.log('[SHEETS_CHAVE] numeroChave sendo salvo:', numeroChaveString);
      
      await sheetHistorico.addRow({
        'Data': dados.data,
        'Hora': dados.hora,
        'Chapa': dados.chapa,
        'Nome': dados.nome,
        'Funcao': dados.funcao,
        'numeroChave': numeroChaveString,  // ← CORREÇÃO AQUI
        'TipoOperacao': dados.tipoOperacao,
        'Situacao': dados.situacao,
        'Supervisor': dados.supervisor,
        'Turno': dados.turno
      });
      
      console.log('[SHEETS_CHAVE] ✓ Adicionado ao histórico com numeroChave:', numeroChaveString);
      
    } catch (error) {
      console.error('[SHEETS_CHAVE] Erro ao salvar no histórico:', error);
      throw error;
    }
  }
  
  async empilharNaAbaChaves(dados) {
    try {
      console.log('[SHEETS_CHAVE] Processando aba Chaves (GOOGLE_SHEETS_ID)...');
      console.log('[SHEETS_CHAVE] Dados recebidos:', dados);
      
      let sheetChaves = this.docAtual.sheetsByTitle['Chaves'];
      
      if (!sheetChaves) {
        console.log('[SHEETS_CHAVE] Criando aba Chaves...');
        
        try {
          sheetChaves = await this.docAtual.addSheet({
            title: 'Chaves',
            headerValues: ['Data', 'Hora', 'Chapa', 'Nome', 'Funcao', 'numeroChave', 'TipoOperacao', 'Situacao', 'Supervisor', 'Turno']
          });
          console.log('[SHEETS_CHAVE] ✓ Aba Chaves criada');
        } catch (createError) {
          console.error('[SHEETS_CHAVE] Erro ao criar aba:', createError);
          throw new Error('Falha ao criar aba Chaves: ' + createError.message);
        }
      }
      
      let rows;
      try {
        await sheetChaves.loadHeaderRow();
        rows = await sheetChaves.getRows();
        console.log(`[SHEETS_CHAVE] ${rows.length} registros existentes na aba Chaves`);
      } catch (loadError) {
        console.error('[SHEETS_CHAVE] Erro ao carregar linhas:', loadError);
        throw new Error('Falha ao carregar dados: ' + loadError.message);
      }
      
      // ===== CORREÇÃO: Converte numeroChave para STRING antes de buscar =====
      const numeroChaveString = String(dados.numeroChave);
      console.log('[SHEETS_CHAVE] Buscando registro existente para numeroChave:', numeroChaveString);
      
      let registroExistente = null;
      
      for (const row of rows) {
        const dataRow = String(row.get('Data') || '').trim();
        const chapaRow = String(row.get('Chapa') || '').trim();
        const chaveRow = String(row.get('numeroChave') || '').trim();
        
        console.log('[SHEETS_CHAVE] Comparando:', {
          dataRow,
          dataEsperada: dados.data,
          chapaRow,
          chapaEsperada: dados.chapa,
          chaveRow,
          chaveEsperada: numeroChaveString
        });
        
        if (dataRow === dados.data && 
            chapaRow === dados.chapa && 
            chaveRow === numeroChaveString) {
          registroExistente = row;
          console.log('[SHEETS_CHAVE] Registro encontrado para sobrepor TipoOperacao');
          break;
        }
      }
      
      if (registroExistente) {
        console.log(`[SHEETS_CHAVE] Sobrepondo TipoOperacao de "${registroExistente.get('TipoOperacao')}" para "${dados.tipoOperacao}"`);
        
        try {
          registroExistente.set('TipoOperacao', dados.tipoOperacao);
          registroExistente.set('Hora', dados.hora);
          await registroExistente.save();
          console.log('[SHEETS_CHAVE] ✓ TipoOperacao sobreposto');
        } catch (updateError) {
          console.error('[SHEETS_CHAVE] Erro ao sobrepor:', updateError);
          throw new Error('Falha ao sobrepor TipoOperacao: ' + updateError.message);
        }
        
      } else {
        console.log('[SHEETS_CHAVE] Nenhum registro encontrado, empilhando nova linha');
        console.log('[SHEETS_CHAVE] numeroChave que será salvo:', numeroChaveString);
        
        try {
          await sheetChaves.addRow({
            'Data': dados.data,
            'Hora': dados.hora,
            'Chapa': dados.chapa,
            'Nome': dados.nome,
            'Funcao': dados.funcao,
            'numeroChave': numeroChaveString,  // ← CORREÇÃO AQUI
            'TipoOperacao': dados.tipoOperacao,
            'Situacao': dados.situacao,
            'Supervisor': dados.supervisor,
            'Turno': dados.turno
          });
          console.log('[SHEETS_CHAVE] ✓ Registro empilhado com numeroChave:', numeroChaveString);
        } catch (addError) {
          console.error('[SHEETS_CHAVE] Erro ao empilhar:', addError);
          throw new Error('Falha ao empilhar: ' + addError.message);
        }
      }
      
    } catch (error) {
      console.error('[SHEETS_CHAVE] Erro em empilharNaAbaChaves:', error);
      throw error;
    }
  }
  async obterChaveStatus() {
    try {
      await this.init();
      console.log('[SHEETS_CHAVE] Obtendo status da aba Historico_chaves...');
      
      const sheetHistorico = this.docHistorico.sheetsByTitle['Historico_chaves'];
      if (!sheetHistorico) {
        console.log('[SHEETS_CHAVE] Aba Historico_chaves não existe ainda');
        return {};
      }
      
      const rows = await sheetHistorico.getRows();
      const mapa = {};
      
      rows.forEach(row => {
        const chapa = String(row.get('Chapa') || '').trim();
        const nome = String(row.get('Nome') || '').trim();
        const funcao = String(row.get('Funcao') || '').trim();
        const chave = String(row.get('numeroChave') || '').trim();
        const tipo = String(row.get('TipoOperacao') || '').trim();
        const situacao = String(row.get('Situacao') || '').trim();
        const supervisor = String(row.get('Supervisor') || '').trim();
        const turno = String(row.get('Turno') || '').trim();
        const data = String(row.get('Data') || '').trim();
        const hora = String(row.get('Hora') || '').trim();
        
        if (chave) {
          mapa[chave] = {
            chapa, nome, funcao, tipo, situacao, supervisor, turno,
            data: data,
            hora: hora
          };
        }
      });
      
      console.log(`[SHEETS_CHAVE] ✓ ${Object.keys(mapa).length} chaves no status`);
      return mapa;
      
    } catch (error) {
      console.error('[SHEETS_CHAVE] Erro:', error);
      return {};
    }
  }

  async gerarResumoChaves() {
    try {
      const statusMap = await this.obterChaveStatus();
      
      let disponiveis = 0, indisponiveis = 0, problemas = 0;
      
      for (const chave in statusMap) {
        const s = statusMap[chave];
        if (s.tipo === "Entrega" && s.situacao === "OK") disponiveis++;
        else if (s.tipo === "Retirada") indisponiveis++;
        if (s.situacao !== "OK") problemas++;
      }
      
      return { disponiveis, indisponiveis, problemas, total: Object.keys(statusMap).length };
    } catch (error) {
      console.error('[SHEETS_CHAVE] Erro:', error);
      return { disponiveis: 0, indisponiveis: 0, problemas: 0, total: 0 };
    }
  }

  async gerarResumoPorSupervisorChaves() {
    try {
      await this.init();
      
      const sheetHistorico = this.docHistorico.sheetsByTitle['Historico_chaves'];
      if (!sheetHistorico) return {};
      
      const rows = await sheetHistorico.getRows();
      const resumo = {};
      
      const chavesContadas = new Set();
      
      for (let i = rows.length - 1; i >= 0; i--) {
        const row = rows[i];
        const chave = String(row.get('numeroChave') || '').trim();
        const sup = String(row.get('Supervisor') || 'Sem Supervisor').trim();
        const tipo = String(row.get('TipoOperacao') || '').trim();
        
        if (!chave || chavesContadas.has(chave)) continue;
        
        chavesContadas.add(chave);
        
        if (!resumo[sup]) resumo[sup] = { retiradaContada: 0 };
        if (tipo === 'Retirada') resumo[sup].retiradaContada++;
      }
      
      return resumo;
    } catch (error) {
      console.error('[SHEETS_CHAVE] Erro:', error);
      return {};
    }
  }

  formatarDataBR(data) {
    if (!data || !(data instanceof Date)) return '';
    try {
      const d = String(data.getDate()).padStart(2, '0');
      const m = String(data.getMonth() + 1).padStart(2, '0');
      const a = data.getFullYear();
      return `${d}/${m}/${a}`;
    } catch (e) {
      return '';
    }
  }
  
  formatarHora(data) {
    if (!data || !(data instanceof Date)) return '';
    try {
      const h = String(data.getHours()).padStart(2, '0');
      const m = String(data.getMinutes()).padStart(2, '0');
      return `${h}:${m}`;
    } catch (e) {
      return '';
    }
  }
}

module.exports = new SheetsColetorService();
