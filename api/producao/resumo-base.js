// api/producao/resumo-base.js - VERSÃO UNIFICADA COMPLETA
const sheetsService = require('../../lib/sheets');
const { fusoAtual } = require('../../lib/fuso');
const setores = require('../../lib/setores');

// Data no formato "dd/mm/aaaa", aceitando "d/m/aaaa", "aaaa-mm-dd" e data com hora
function normalizarData(valor) {
  const t = String(valor || '').trim();
  let m = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return `${m[3].padStart(2, '0')}/${m[2].padStart(2, '0')}/${m[1]}`;
  m = t.match(/^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{4})/);
  if (m) return `${m[1].padStart(2, '0')}/${m[2].padStart(2, '0')}/${m[3]}`;
  return t;
}

// Hoje no fuso de Manaus (o servidor roda em UTC)
function hojeManaus() {
  return new Date().toLocaleDateString('pt-BR', { timeZone: fusoAtual() });
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ 
      ok: false, 
      msg: 'Método não permitido' 
    });
  }

  try {
    console.log('[RESUMO-BASE] ========== INÍCIO ==========');
    console.log('[RESUMO-BASE] Query params:', req.query);
    
    const doc = await sheetsService.init();
    console.log(`[RESUMO-BASE] ✓ Conectado: ${doc.title}`);
    
    // ===== CARREGA BASE =====
    const sheetBase = doc.sheetsByTitle['Base'];
    if (!sheetBase) {
      return res.status(404).json({
        ok: false,
        msg: 'Aba Base não encontrada'
      });
    }
    
    // Setorizado: só os registros do departamento do usuário (ou todos, se ele vê todos os setores)
    const acesso = await setores.acessoAtual();
    if (!acesso.logado) {
      return res.status(401).json({ ok: false, msg: 'Sessão expirada. Faça login novamente.' });
    }
    const setorDe = await setores.resolvedorDeSetor();
    const rowsBase = (await sheetBase.getRows()).filter(row =>
      acesso.todos || acesso.permite(setorDe(row.get('Departamento'), row.get('Supervisor')))
    );
    console.log(`[RESUMO-BASE] ✓ ${rowsBase.length} registros na Base`);
    
    // ===== CARREGA QLP =====
    const sheetQLP = doc.sheetsByTitle['QLP'];
    const mapaQLP = {};
    
    if (sheetQLP) {
      const rowsQLP = await sheetQLP.getRows();
      rowsQLP.forEach(row => {
        const chapa = String(row.get('CHAPA1') || '').trim();
        const secao = String(row.get('SECAO') || '').trim();
        const turno = String(row.get('Turno') || '').trim();
        
        if (chapa) {
          mapaQLP[chapa] = { secao, turno };
        }
      });
      console.log(`[RESUMO-BASE] ✓ ${Object.keys(mapaQLP).length} registros no mapa QLP`);
    }
    
    // ===== CORREÇÃO DA DATA =====
    let dataFiltro;
    
    // Data do frontend (aaaa-mm-dd) ou hoje em Manaus
    dataFiltro = normalizarData(req.query.data) || hojeManaus();
    if (!/^\d{2}\/\d{2}\/\d{4}$/.test(dataFiltro)) dataFiltro = hojeManaus();
    console.log(`[RESUMO-BASE] Data: ${req.query.data || '(hoje)'} -> ${dataFiltro}`);
    
    console.log(`[RESUMO-BASE] Filtrando por data: "${dataFiltro}"`);
    
    // ===== MODO: DADOS BRUTOS (para producao.html) =====
    if (req.query.modo === 'dados') {
      console.log('[RESUMO-BASE] Modo: DADOS BRUTOS');
      
      const dados = [];
      let registrosFiltrados = 0;
      let registrosIgnorados = 0;
      
      rowsBase.forEach((row, index) => {
        const supervisor = String(row.get('Supervisor') || '').trim();
        const aba = String(row.get('Aba') || '').trim();
        const matricula = String(row.get('Matricula') || '').trim();
        const nome = String(row.get('Nome') || '').trim();
        const funcao = String(row.get('Função') || '').trim();
        const status = String(row.get('Status') || '').trim();
        const data = normalizarData(row.get('Data'));
        
        // Debug das primeiras 5 datas
        if (index < 5) {
          console.log(`[RESUMO-BASE] Linha ${index + 1} - Data: "${data}" | Match: ${data === dataFiltro}`);
        }
        
        // COMPARAÇÃO EXATA DE STRINGS
        if (data !== dataFiltro) {
          registrosIgnorados++;
          return;
        }
        
        registrosFiltrados++;
        
        // Busca seção e turno do QLP
        let secao = 'Sem Seção';
        let turno = 'Não definido';
        
        if (mapaQLP[matricula]) {
          secao = mapaQLP[matricula].secao || secao;
          turno = mapaQLP[matricula].turno || turno;
        }
        
        // Determina turno pela aba se não tiver no QLP
        if (turno === 'Não definido' && aba) {
          const abaLower = aba.toLowerCase();
          if (abaLower.includes('ta') || abaLower.includes('turno a')) turno = 'Turno A';
          else if (abaLower.includes('tb') || abaLower.includes('turno b')) turno = 'Turno B';
          else if (abaLower.includes('tc') || abaLower.includes('turno c')) turno = 'Turno C';
        }
        
        dados.push({
          supervisor,
          aba,
          matricula,
          nome,
          funcao,
          status,
          data,
          secao,
          turno
        });
      });
      
      console.log('[RESUMO-BASE] ========== ESTATÍSTICAS DADOS ==========');
      console.log(`[RESUMO-BASE] Data filtrada: ${dataFiltro}`);
      console.log(`[RESUMO-BASE] Registros processados: ${registrosFiltrados}`);
      console.log(`[RESUMO-BASE] Registros ignorados: ${registrosIgnorados}`);
      console.log(`[RESUMO-BASE] Total de linhas: ${rowsBase.length}`);
      console.log('[RESUMO-BASE] ========== FIM DADOS ==========');
      
      return res.status(200).json({
        ok: true,
        dados,
        total: dados.length,
        dataFiltro: dataFiltro,
        debug: {
          totalLinhas: rowsBase.length,
          registrosFiltrados,
          registrosIgnorados
        },
        timestamp: new Date().toISOString()
      });
    }
    
    // ===== MODO: RESUMO (padrão, para resumo-base.html) =====
    console.log('[RESUMO-BASE] Modo: RESUMO/ANÁLISE');
    
    // Estruturas para armazenar resumos
    const resumoPorSupervisor = {};
    const resumoPorFuncao = {};
    const resumoGeral = {
      total: 0,
      presente: 0,
      ausente: 0,
      atestado: 0,
      ferias: 0,
      folga: 0,
      afastado: 0,
      desvio: 0,
      outros: 0
    };
    
    let registrosFiltrados = 0;
    let registrosIgnorados = 0;
    
    // Processa cada registro
    rowsBase.forEach((row, index) => {
      const dataRegistro = normalizarData(row.get('Data'));
      
      // Debug das primeiras 5 datas
      if (index < 5) {
        console.log(`[RESUMO-BASE] Linha ${index + 1} - Data: "${dataRegistro}" | Match: ${dataRegistro === dataFiltro}`);
      }
      
      // COMPARAÇÃO EXATA DE STRINGS
      if (dataRegistro !== dataFiltro) {
        registrosIgnorados++;
        return;
      }
      
      registrosFiltrados++;
      
      const supervisor = String(row.get('Supervisor') || 'Sem supervisor').trim();
      const aba = String(row.get('Aba') || '').trim();
      const funcao = String(row.get('Função') || 'Não informada').trim();
      const status = String(row.get('Status') || 'Outro').trim();
      const desvio = String(row.get('Desvio') || '').trim();
      const nome = String(row.get('Nome') || '').trim();
      const matricula = String(row.get('Matricula') || '').trim();
      
      // Busca turno do QLP
      let turno = 'Não informado';
      if (mapaQLP[matricula]) {
        turno = mapaQLP[matricula].turno || turno;
      }
      
      // Tenta determinar turno pela aba se não encontrou no QLP
      if (turno === 'Não informado' && aba) {
        const abaLower = aba.toLowerCase();
        if (abaLower.includes('ta') || abaLower.includes('turno a')) turno = 'Turno A';
        else if (abaLower.includes('tb') || abaLower.includes('turno b')) turno = 'Turno B';
        else if (abaLower.includes('tc') || abaLower.includes('turno c')) turno = 'Turno C';
      }
      
      if (!nome) return;
      
      // ====== RESUMO POR SUPERVISOR ======
      if (!resumoPorSupervisor[supervisor]) {
        resumoPorSupervisor[supervisor] = {
          supervisor,
          total: 0,
          presente: 0,
          ausente: 0,
          atestado: 0,
          ferias: 0,
          folga: 0,
          afastado: 0,
          desvio: 0,
          outros: 0,
          porFuncao: {},
          colaboradores: []
        };
      }
      
      resumoPorSupervisor[supervisor].total++;
      resumoPorSupervisor[supervisor].colaboradores.push({
        nome,
        matricula,
        funcao,
        turno,
        status,
        desvio
      });
      
      // Conta por status no supervisor
      const statusLower = status.toLowerCase();
      if (statusLower === 'presente') {
        resumoPorSupervisor[supervisor].presente++;
      } else if (statusLower === 'ausente') {
        resumoPorSupervisor[supervisor].ausente++;
      } else if (statusLower === 'atestado') {
        resumoPorSupervisor[supervisor].atestado++;
      } else if (statusLower.includes('férias') || statusLower.includes('ferias')) {
        resumoPorSupervisor[supervisor].ferias++;
      } else if (statusLower === 'folga') {
        resumoPorSupervisor[supervisor].folga++;
      } else if (statusLower === 'afastado') {
        resumoPorSupervisor[supervisor].afastado++;
      } else {
        resumoPorSupervisor[supervisor].outros++;
      }
      
      // Conta desvios
      if (desvio && desvio.toLowerCase() === 'desvio') {
        resumoPorSupervisor[supervisor].desvio++;
      }
      
      // Conta por função dentro do supervisor
      if (!resumoPorSupervisor[supervisor].porFuncao[funcao]) {
        resumoPorSupervisor[supervisor].porFuncao[funcao] = {
          total: 0,
          presente: 0,
          ausente: 0
        };
      }
      resumoPorSupervisor[supervisor].porFuncao[funcao].total++;
      if (statusLower === 'presente') {
        resumoPorSupervisor[supervisor].porFuncao[funcao].presente++;
      } else {
        resumoPorSupervisor[supervisor].porFuncao[funcao].ausente++;
      }
      
      // ====== RESUMO POR FUNÇÃO ======
      if (!resumoPorFuncao[funcao]) {
        resumoPorFuncao[funcao] = {
          funcao,
          total: 0,
          presente: 0,
          ausente: 0,
          atestado: 0,
          ferias: 0,
          folga: 0,
          afastado: 0,
          desvio: 0,
          outros: 0,
          porSupervisor: {},
          colaboradores: []
        };
      }
      
      resumoPorFuncao[funcao].total++;
      resumoPorFuncao[funcao].colaboradores.push({
        nome,
        matricula,
        supervisor,
        turno,
        status,
        desvio
      });
      
      // Conta por status na função
      if (statusLower === 'presente') {
        resumoPorFuncao[funcao].presente++;
      } else if (statusLower === 'ausente') {
        resumoPorFuncao[funcao].ausente++;
      } else if (statusLower === 'atestado') {
        resumoPorFuncao[funcao].atestado++;
      } else if (statusLower.includes('férias') || statusLower.includes('ferias')) {
        resumoPorFuncao[funcao].ferias++;
      } else if (statusLower === 'folga') {
        resumoPorFuncao[funcao].folga++;
      } else if (statusLower === 'afastado') {
        resumoPorFuncao[funcao].afastado++;
      } else {
        resumoPorFuncao[funcao].outros++;
      }
      
      // Conta desvios
      if (desvio && desvio.toLowerCase() === 'desvio') {
        resumoPorFuncao[funcao].desvio++;
      }
      
      // Conta por supervisor dentro da função
      if (!resumoPorFuncao[funcao].porSupervisor[supervisor]) {
        resumoPorFuncao[funcao].porSupervisor[supervisor] = {
          total: 0,
          presente: 0,
          ausente: 0
        };
      }
      resumoPorFuncao[funcao].porSupervisor[supervisor].total++;
      if (statusLower === 'presente') {
        resumoPorFuncao[funcao].porSupervisor[supervisor].presente++;
      } else {
        resumoPorFuncao[funcao].porSupervisor[supervisor].ausente++;
      }
      
      // ====== RESUMO GERAL ======
      resumoGeral.total++;
      if (statusLower === 'presente') {
        resumoGeral.presente++;
      } else if (statusLower === 'ausente') {
        resumoGeral.ausente++;
      } else if (statusLower === 'atestado') {
        resumoGeral.atestado++;
      } else if (statusLower.includes('férias') || statusLower.includes('ferias')) {
        resumoGeral.ferias++;
      } else if (statusLower === 'folga') {
        resumoGeral.folga++;
      } else if (statusLower === 'afastado') {
        resumoGeral.afastado++;
      } else {
        resumoGeral.outros++;
      }
      
      // Conta desvios no geral
      if (desvio && desvio.toLowerCase() === 'desvio') {
        resumoGeral.desvio++;
      }
    });
    
    console.log('[RESUMO-BASE] ========== ESTATÍSTICAS RESUMO ==========');
    console.log(`[RESUMO-BASE] Data filtrada: ${dataFiltro}`);
    console.log(`[RESUMO-BASE] Registros processados: ${registrosFiltrados}`);
    console.log(`[RESUMO-BASE] Registros ignorados: ${registrosIgnorados}`);
    console.log(`[RESUMO-BASE] Total de linhas: ${rowsBase.length}`);
    
    // Converte objetos em arrays e ordena
    const supervisores = Object.values(resumoPorSupervisor)
      .sort((a, b) => a.supervisor.localeCompare(b.supervisor));
    
    const funcoes = Object.values(resumoPorFuncao)
      .sort((a, b) => a.funcao.localeCompare(b.funcao));
    
    // Calcula percentuais no resumo geral
    if (resumoGeral.total > 0) {
      resumoGeral.percentualPresente = ((resumoGeral.presente / resumoGeral.total) * 100).toFixed(1);
      resumoGeral.percentualAusente = (((resumoGeral.total - resumoGeral.presente) / resumoGeral.total) * 100).toFixed(1);
      resumoGeral.percentualDesvio = ((resumoGeral.desvio / resumoGeral.total) * 100).toFixed(1);
    }
    
    console.log('[RESUMO-BASE] ========== RESUMO FINAL ==========');
    console.log(`[RESUMO-BASE] ${supervisores.length} supervisores`);
    console.log(`[RESUMO-BASE] ${funcoes.length} funções`);
    console.log(`[RESUMO-BASE] ${resumoGeral.total} colaboradores no total`);
    console.log(`[RESUMO-BASE] ${resumoGeral.presente} presentes (${resumoGeral.percentualPresente}%)`);
    console.log(`[RESUMO-BASE] ${resumoGeral.desvio} desvios (${resumoGeral.percentualDesvio}%)`);
    console.log('[RESUMO-BASE] ========== FIM RESUMO ==========');
    
    return res.status(200).json({
      ok: true,
      dataReferencia: dataFiltro,
      resumoGeral,
      porSupervisor: supervisores,
      porFuncao: funcoes,
      totais: {
        supervisores: supervisores.length,
        funcoes: funcoes.length,
        colaboradores: resumoGeral.total
      },
      debug: {
        totalLinhas: rowsBase.length,
        registrosFiltrados,
        registrosIgnorados
      },
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    console.error('[RESUMO-BASE] ========== ERRO FATAL ==========');
    console.error('[RESUMO-BASE] Tipo:', error.name);
    console.error('[RESUMO-BASE] Mensagem:', error.message);
    console.error('[RESUMO-BASE] Stack:', error.stack);
    console.error('[RESUMO-BASE] =====================================');
    
    return res.status(500).json({
      ok: false,
      msg: 'Erro ao gerar dados',
      details: error.message,
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
};
