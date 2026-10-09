// api/coletores.js - VERSÃO COMPLETA COM COLETORES E CHAVES
const sheetsColetorService = require('../lib/sheets_2');

module.exports = async function handler(req, res) {
  // ===== CORS CONFIGURADO CORRETAMENTE =====
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Credentials', 'true');

  // Responde OPTIONS (preflight)
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  console.log('[API COLETORES] Request recebido:', {
    method: req.method,
    action: req.body?.action || req.query?.action,
    body: req.body
  });

  try {
    // ===== ACEITA ACTION POR POST OU GET =====
    const action = req.method === 'POST' ? req.body?.action : req.query?.action;

    if (!action) {
      console.error('[API COLETORES] Action não fornecida');
      return res.status(400).json({ 
        ok: false, 
        msg: 'Action é obrigatória',
        acoesDisponiveis: [
          'obterDados',
          'salvarRegistro',
          'obterColetorStatus',
          'obterResumoColetores',
          'obterResumoPorSupervisor',
          'salvarRegistroChave',
          'obterChaveStatus',
          'obterResumoChaves',
          'obterResumoPorSupervisorChaves',
          'testarConexao'
        ]
      });
    }

    console.log('[API COLETORES] Processando action:', action);

    switch (action) {
      // ==================== ROTAS PARA COLETORES ====================
      
      // ===== BUSCAR COLABORADORES =====
      case 'obterDados': {
        console.log('[API COLETORES] Buscando dados do quadro...');
        
        try {
          const dados = await sheetsColetorService.obterDados();
          
          console.log('[API COLETORES] Colaboradores encontrados:', dados.length);
          
          return res.status(200).json({ 
            ok: true, 
            dados: dados,
            total: dados.length
          });
        } catch (error) {
          console.error('[API COLETORES] Erro ao buscar dados:', error);
          return res.status(500).json({ 
            ok: false, 
            msg: 'Erro ao buscar colaboradores: ' + error.message 
          });
        }
      }

      // ===== SALVAR REGISTRO =====
      case 'salvarRegistro': {
        const { chapa, nome, funcao, numeroColetor, tipoOperacao, situacoes } = req.body;
        
        console.log('[API COLETORES] Dados recebidos:', {
          chapa, 
          nome, 
          funcao,
          numeroColetor, 
          tipoOperacao, 
          situacoes,
          tipoSituacoes: Array.isArray(situacoes) ? 'array' : typeof situacoes
        });
        
        // ===== VALIDAÇÃO COMPLETA =====
        if (!chapa) {
          console.error('[API COLETORES] Chapa não fornecida');
          return res.status(400).json({ 
            ok: false, 
            msg: 'Chapa é obrigatória' 
          });
        }

        if (!numeroColetor) {
          console.error('[API COLETORES] Número do coletor não fornecido');
          return res.status(400).json({ 
            ok: false, 
            msg: 'Número do coletor é obrigatório' 
          });
        }

        if (!situacoes) {
          console.error('[API COLETORES] Situação não fornecida');
          return res.status(400).json({ 
            ok: false, 
            msg: 'Situação é obrigatória' 
          });
        }

        // ===== NORMALIZA SITUAÇÕES PARA ARRAY =====
        let situacoesArray;
        
        if (Array.isArray(situacoes)) {
          situacoesArray = situacoes;
        } else if (typeof situacoes === 'string') {
          situacoesArray = [situacoes];
        } else {
          console.error('[API COLETORES] Formato de situações inválido:', situacoes);
          return res.status(400).json({ 
            ok: false, 
            msg: 'Formato de situações inválido. Envie um array ou string.' 
          });
        }

        if (situacoesArray.length === 0) {
          return res.status(400).json({ 
            ok: false, 
            msg: 'Selecione pelo menos uma situação' 
          });
        }

        // ===== VALIDA NÚMERO DO COLETOR =====
        const numColetor = parseInt(numeroColetor);
        if (isNaN(numColetor) || numColetor < 1 || numColetor > 140) {
          return res.status(400).json({ 
            ok: false, 
            msg: 'Número do coletor deve estar entre 1 e 140' 
          });
        }

        // ===== VALIDA TIPO DE OPERAÇÃO =====
        if (!tipoOperacao || (tipoOperacao !== 'Entrega' && tipoOperacao !== 'Retirada')) {
          console.error('[API COLETORES] Tipo de operação inválido:', tipoOperacao);
          return res.status(400).json({ 
            ok: false, 
            msg: 'Tipo de operação deve ser "Entrega" ou "Retirada"' 
          });
        }
        
        console.log('[API COLETORES] Dados validados:', {
          chapa,
          nome: nome || 'Não fornecido',
          funcao: funcao || 'Não fornecida',
          numeroColetor: numColetor,
          tipoOperacao,
          situacoesArray
        });
        
        try {
          const resultado = await sheetsColetorService.salvarRegistro(
            chapa, 
            nome || '', 
            funcao || '', 
            numColetor, 
            tipoOperacao, 
            situacoesArray
          );
          
          console.log('[API COLETORES] Resultado salvamento:', resultado);
          
          if (resultado.ok) {
            return res.status(200).json(resultado);
          } else {
            return res.status(400).json(resultado);
          }
        } catch (error) {
          console.error('[API COLETORES] Erro ao salvar registro:', error);
          console.error('[API COLETORES] Stack:', error.stack);
          return res.status(500).json({ 
            ok: false, 
            msg: 'Erro ao salvar registro: ' + error.message 
          });
        }
      }

      // ===== STATUS DOS COLETORES =====
      case 'obterColetorStatus': {
        console.log('[API COLETORES] Obtendo status dos coletores...');
        
        try {
          const statusMap = await sheetsColetorService.obterColetorStatus();
          
          console.log('[API COLETORES] Status obtido:', Object.keys(statusMap).length, 'coletores');
          
          return res.status(200).json({ 
            ok: true, 
            statusMap: statusMap,
            total: Object.keys(statusMap).length
          });
        } catch (error) {
          console.error('[API COLETORES] Erro ao obter status:', error);
          return res.status(500).json({ 
            ok: false, 
            msg: 'Erro ao obter status dos coletores: ' + error.message 
          });
        }
      }

      // ===== RESUMO DE COLETORES =====
      case 'obterResumoColetores': {
        console.log('[API COLETORES] Gerando resumo de coletores...');
        
        try {
          const resumo = await sheetsColetorService.gerarResumoColetores();
          
          console.log('[API COLETORES] Resumo gerado:', resumo);
          
          return res.status(200).json({ 
            ok: true, 
            resumo: resumo
          });
        } catch (error) {
          console.error('[API COLETORES] Erro ao gerar resumo:', error);
          return res.status(500).json({ 
            ok: false, 
            msg: 'Erro ao gerar resumo: ' + error.message 
          });
        }
      }

      // ===== RESUMO POR SUPERVISOR =====
      case 'obterResumoPorSupervisor': {
        console.log('[API COLETORES] Gerando resumo por supervisor...');
        
        try {
          const resumoSup = await sheetsColetorService.gerarResumoPorSupervisor();
          
          console.log('[API COLETORES] Resumo por supervisor gerado');
          
          return res.status(200).json({ 
            ok: true, 
            resumoPorSupervisor: resumoSup
          });
        } catch (error) {
          console.error('[API COLETORES] Erro ao gerar resumo por supervisor:', error);
          return res.status(500).json({ 
            ok: false, 
            msg: 'Erro ao gerar resumo por supervisor: ' + error.message 
          });
        }
      }

      // ==================== ROTAS PARA CHAVES ====================
      
      // ===== SALVAR REGISTRO DE CHAVE =====
      case 'salvarRegistroChave': {
        const { chapa, nome, funcao, numeroChave, tipoOperacao, situacoes } = req.body;
        
        console.log('[API CHAVES] Dados recebidos:', {
          chapa, 
          nome, 
          funcao,
          numeroChave, 
          tipoOperacao, 
          situacoes,
          tipoSituacoes: Array.isArray(situacoes) ? 'array' : typeof situacoes
        });
        
        // ===== VALIDAÇÃO COMPLETA =====
        if (!chapa) {
          console.error('[API CHAVES] Chapa não fornecida');
          return res.status(400).json({ 
            ok: false, 
            msg: 'Chapa é obrigatória' 
          });
        }

        if (!numeroChave) {
          console.error('[API CHAVES] Número da chave não fornecido');
          return res.status(400).json({ 
            ok: false, 
            msg: 'Número da chave é obrigatório' 
          });
        }

        if (!situacoes) {
          console.error('[API CHAVES] Situação não fornecida');
          return res.status(400).json({ 
            ok: false, 
            msg: 'Situação é obrigatória' 
          });
        }

        // ===== NORMALIZA SITUAÇÕES PARA ARRAY =====
        let situacoesArray;
        
        if (Array.isArray(situacoes)) {
          situacoesArray = situacoes;
        } else if (typeof situacoes === 'string') {
          situacoesArray = [situacoes];
        } else {
          console.error('[API CHAVES] Formato de situações inválido:', situacoes);
          return res.status(400).json({ 
            ok: false, 
            msg: 'Formato de situações inválido. Envie um array ou string.' 
          });
        }

        if (situacoesArray.length === 0) {
          return res.status(400).json({ 
            ok: false, 
            msg: 'Selecione pelo menos uma situação' 
          });
        }

        // ===== VALIDA NÚMERO DA CHAVE =====
        const numChave = parseInt(numeroChave);
        if (isNaN(numChave) || numChave < 1 || numChave > 60) {
          return res.status(400).json({ 
            ok: false, 
            msg: 'Número da chave deve estar entre 1 e 60' 
          });
        }

        // ===== VALIDA TIPO DE OPERAÇÃO =====
        if (!tipoOperacao || (tipoOperacao !== 'Entrega' && tipoOperacao !== 'Retirada')) {
          console.error('[API CHAVES] Tipo de operação inválido:', tipoOperacao);
          return res.status(400).json({ 
            ok: false, 
            msg: 'Tipo de operação deve ser "Entrega" ou "Retirada"' 
          });
        }
        
        console.log('[API CHAVES] Dados validados:', {
          chapa,
          nome: nome || 'Não fornecido',
          funcao: funcao || 'Não fornecida',
          numeroChave: numChave,
          tipoOperacao,
          situacoesArray
        });
        
        try {
          const resultado = await sheetsColetorService.salvarRegistroChave(
            chapa, 
            nome || '', 
            funcao || '', 
            numChave, 
            tipoOperacao, 
            situacoesArray
          );
          
          console.log('[API CHAVES] Resultado salvamento:', resultado);
          
          if (resultado.ok) {
            return res.status(200).json(resultado);
          } else {
            return res.status(400).json(resultado);
          }
        } catch (error) {
          console.error('[API CHAVES] Erro ao salvar registro:', error);
          console.error('[API CHAVES] Stack:', error.stack);
          return res.status(500).json({ 
            ok: false, 
            msg: 'Erro ao salvar registro: ' + error.message 
          });
        }
      }

      // ===== STATUS DAS CHAVES =====
      case 'obterChaveStatus': {
        console.log('[API CHAVES] Obtendo status das chaves...');
        
        try {
          const statusMap = await sheetsColetorService.obterChaveStatus();
          
          console.log('[API CHAVES] Status obtido:', Object.keys(statusMap).length, 'chaves');
          
          return res.status(200).json({ 
            ok: true, 
            statusMap: statusMap,
            total: Object.keys(statusMap).length
          });
        } catch (error) {
          console.error('[API CHAVES] Erro ao obter status:', error);
          return res.status(500).json({ 
            ok: false, 
            msg: 'Erro ao obter status das chaves: ' + error.message 
          });
        }
      }

      // ===== RESUMO DE CHAVES =====
      case 'obterResumoChaves': {
        console.log('[API CHAVES] Gerando resumo de chaves...');
        
        try {
          const resumo = await sheetsColetorService.gerarResumoChaves();
          
          console.log('[API CHAVES] Resumo gerado:', resumo);
          
          return res.status(200).json({ 
            ok: true, 
            resumo: resumo
          });
        } catch (error) {
          console.error('[API CHAVES] Erro ao gerar resumo:', error);
          return res.status(500).json({ 
            ok: false, 
            msg: 'Erro ao gerar resumo: ' + error.message 
          });
        }
      }

      // ===== RESUMO POR SUPERVISOR (CHAVES) =====
      case 'obterResumoPorSupervisorChaves': {
        console.log('[API CHAVES] Gerando resumo por supervisor (chaves)...');
        
        try {
          const resumoSup = await sheetsColetorService.gerarResumoPorSupervisorChaves();
          
          console.log('[API CHAVES] Resumo por supervisor gerado');
          
          return res.status(200).json({ 
            ok: true, 
            resumoPorSupervisor: resumoSup
          });
        } catch (error) {
          console.error('[API CHAVES] Erro ao gerar resumo por supervisor:', error);
          return res.status(500).json({ 
            ok: false, 
            msg: 'Erro ao gerar resumo por supervisor: ' + error.message 
          });
        }
      }

      // ===== TESTE DE CONEXÃO =====
      case 'testarConexao': {
        console.log('[API COLETORES] Testando conexão...');
        
        try {
          const { docHistorico, docAtual } = await sheetsColetorService.init();
          
          const sheetsHistorico = Object.keys(docHistorico.sheetsByTitle);
          const sheetsAtual = Object.keys(docAtual.sheetsByTitle);
          
          console.log(`[API COLETORES] ✓ Planilha Histórico: ${docHistorico.title}`);
          console.log(`[API COLETORES] Abas:`, sheetsHistorico);
          console.log(`[API COLETORES] ✓ Planilha Atual: ${docAtual.title}`);
          console.log(`[API COLETORES] Abas:`, sheetsAtual);
          
          return res.status(200).json({
            ok: true,
            msg: 'Conectado com sucesso às duas planilhas',
            historico: {
              titulo: docHistorico.title,
              abas: sheetsHistorico,
              totalAbas: sheetsHistorico.length
            },
            atual: {
              titulo: docAtual.title,
              abas: sheetsAtual,
              totalAbas: sheetsAtual.length
            }
          });
        } catch (error) {
          console.error('[API COLETORES] Erro no teste de conexão:', error);
          return res.status(500).json({
            ok: false,
            msg: 'Erro ao conectar com as planilhas',
            details: error.message
          });
        }
      }

      default:
        console.error('[API COLETORES] Action inválida:', action);
        return res.status(400).json({ 
          ok: false, 
          msg: 'Ação inválida: ' + action,
          acoesDisponiveis: [
            'obterDados',
            'salvarRegistro',
            'obterColetorStatus',
            'obterResumoColetores',
            'obterResumoPorSupervisor',
            'salvarRegistroChave',
            'obterChaveStatus',
            'obterResumoChaves',
            'obterResumoPorSupervisorChaves',
            'testarConexao'
          ]
        });
    }
  } catch (error) {
    console.error('[API COLETORES] Erro geral:', error);
    console.error('[API COLETORES] Stack:', error.stack);
    return res.status(500).json({ 
      ok: false, 
      msg: 'Erro interno do servidor: ' + error.message,
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
};
