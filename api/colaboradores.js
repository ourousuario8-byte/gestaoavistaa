// api/colaboradores.js - COM SUPORTE A VALIDAÇÃO POR ABA - COMPLETO
const sheetsService = require('../lib/sheets');
const setores = require('../lib/setores');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // GET - Buscar colaboradores
  if (req.method === 'GET') {
    try {
      const { filtro } = req.query;
      console.log('[API COLABORADORES] Buscando colaboradores com filtro:', filtro);
      
      const colaboradores = await sheetsService.buscarColaboradores(filtro || '');
      
      console.log(`[API COLABORADORES] ${colaboradores.length} colaboradores encontrados`);
      return res.status(200).json(colaboradores);
    } catch (error) {
      console.error('[API COLABORADORES] Erro ao buscar colaboradores:', error);
      return res.status(500).json({ error: 'Erro ao buscar colaboradores' });
    }
  }

  // POST - Ações diversas
  if (req.method === 'POST') {
    try {
      const { action } = req.body;
      
      console.log('[API COLABORADORES] Action:', action);
      console.log('[API COLABORADORES] Body completo:', JSON.stringify(req.body, null, 2));

      // Alterar a lista de outro supervisor: com sessão, o supervisor tem de ser o usuário logado
      if (['updateStatus', 'updateDesvio', 'removeBuffer', 'addBuffer'].includes(action)) {
        const acesso = await setores.acessoAtual();
        if (acesso.logado && req.body.supervisor && req.body.supervisor !== acesso.usuario) {
          return res.status(403).json({ ok: false, msg: 'Você só pode alterar a sua própria lista' });
        }
      }

      switch (action) {
        // ===== Correções pelo próprio usuário =====
        case 'minhaBase':
          return res.status(200).json(await sheetsService.minhaBase(req.body.data));

        case 'corrigirBase':
          return res.status(200).json(await sheetsService.corrigirBase(req.body));

        case 'excluirDaBase':
          return res.status(200).json(await sheetsService.excluirDaBase(req.body));

        case 'corrigirLista':
          return res.status(200).json(await sheetsService.corrigirLista(req.body));

        case 'addBuffer': {
          const { supervisor, aba, colaborador } = req.body;
          
          // Validação de parâmetros
          if (!supervisor || !aba || !colaborador) {
            console.error('[API COLABORADORES] Parâmetros faltando:', { 
              supervisor: !!supervisor, 
              aba: !!aba, 
              colaborador: !!colaborador 
            });
            return res.status(400).json({ 
              ok: false, 
              msg: 'Supervisor, aba e colaborador são obrigatórios' 
            });
          }
          
          if (!colaborador.matricula || !colaborador.nome) {
            console.error('[API COLABORADORES] Dados do colaborador incompletos:', colaborador);
            return res.status(400).json({ 
              ok: false, 
              msg: 'Colaborador deve ter matrícula e nome' 
            });
          }
          
          console.log('[API COLABORADORES] Adicionando colaborador:', {
            supervisor,
            aba,
            matricula: colaborador.matricula,
            nome: colaborador.nome,
            funcao: colaborador.funcao
          });
          
          const result = await sheetsService.adicionarBuffer(supervisor, aba, colaborador);
          
          console.log('[API COLABORADORES] Resultado:', result);
          return res.status(200).json(result);
        }

        case 'getBuffer': {
          const { supervisor, aba } = req.body;
          
          // Validação de parâmetros
          if (!supervisor || !aba) {
            console.error('[API COLABORADORES] Parâmetros faltando:', { 
              supervisor: !!supervisor, 
              aba: !!aba 
            });
            return res.status(400).json({ 
              ok: false, 
              msg: 'Supervisor e aba são obrigatórios' 
            });
          }
          
          console.log('[API COLABORADORES] Buscando buffer:', { supervisor, aba });
          
          const buffer = await sheetsService.getBuffer(supervisor, aba);
          
          console.log(`[API COLABORADORES] Buffer retornado: ${buffer.length} colaboradores`);
          return res.status(200).json(buffer);
        }

        case 'removeBuffer': {
          const { supervisor, aba, matricula } = req.body;
          
          // Validação de parâmetros
          if (!supervisor || !matricula) {
            console.error('[API COLABORADORES] Parâmetros faltando:', { 
              supervisor: !!supervisor, 
              matricula: !!matricula 
            });
            return res.status(400).json({ 
              ok: false, 
              msg: 'Supervisor e matrícula são obrigatórios' 
            });
          }
          
          console.log('[API COLABORADORES] Removendo colaborador:', { 
            supervisor, 
            aba, 
            matricula 
          });
          
          // Usa aba como chave principal se fornecida, senão usa supervisor
          const chave = aba || supervisor;
          const result = await sheetsService.removerBufferPorAba(chave, matricula);
          
          console.log('[API COLABORADORES] Resultado da remoção:', result);
          return res.status(200).json(result);
        }

        case 'updateStatus': {
          const { supervisor, aba, matricula, status } = req.body;
          
          // Validação de parâmetros
          if (!supervisor || !matricula || status === undefined) {
            console.error('[API COLABORADORES] Parâmetros faltando:', { 
              supervisor: !!supervisor, 
              matricula: !!matricula, 
              status: status !== undefined 
            });
            return res.status(400).json({ 
              ok: false, 
              msg: 'Supervisor, matrícula e status são obrigatórios' 
            });
          }
          
          console.log('[API COLABORADORES] Atualizando status:', { 
            supervisor, 
            aba, 
            matricula, 
            status 
          });
          
          // Usa aba como chave principal se fornecida, senão usa supervisor
          const chave = aba || supervisor;
          const result = await sheetsService.atualizarStatusBufferPorAba(chave, matricula, status);
          
          console.log('[API COLABORADORES] Resultado da atualização:', result);
          return res.status(200).json(result);
        }

        case 'updateDesvio': {
          const { supervisor, aba, matricula, desvio } = req.body;
          
          // Validação de parâmetros
          if (!supervisor || !matricula) {
            console.error('[API COLABORADORES] Parâmetros faltando:', { 
              supervisor: !!supervisor, 
              matricula: !!matricula 
            });
            return res.status(400).json({ 
              ok: false, 
              msg: 'Supervisor e matrícula são obrigatórios' 
            });
          }
          
          console.log('[API COLABORADORES] Atualizando desvio:', { 
            supervisor, 
            aba, 
            matricula, 
            desvio 
          });
          
          // Usa aba como chave principal se fornecida, senão usa supervisor
          const chave = aba || supervisor;
          const result = await sheetsService.atualizarDesvioBufferPorAba(chave, matricula, desvio);
          
          console.log('[API COLABORADORES] Resultado da atualização:', result);
          return res.status(200).json(result);
        }

        case 'saveToBase': {
          const { dados } = req.body;
          
          // Validação de parâmetros
          if (!dados || !Array.isArray(dados)) {
            console.error('[API COLABORADORES] Dados inválidos:', typeof dados);
            return res.status(400).json({ 
              ok: false, 
              msg: 'Dados devem ser um array' 
            });
          }
          
          if (dados.length === 0) {
            console.warn('[API COLABORADORES] Array de dados vazio');
            return res.status(400).json({ 
              ok: false, 
              msg: 'Nenhum dado para salvar' 
            });
          }
          
          console.log('[API COLABORADORES] Salvando na base:', dados.length, 'registros');
          console.log('[API COLABORADORES] Exemplo de registro:', dados[0]);
          
          const result = await sheetsService.salvarNaBase(dados);
          
          console.log('[API COLABORADORES] Resultado do salvamento:', result);
          return res.status(200).json(result);
        }

        default:
          console.error('[API COLABORADORES] Ação não reconhecida:', action);
          return res.status(400).json({ 
            ok: false, 
            msg: 'Ação não reconhecida: ' + action,
            acoesDisponiveis: ['addBuffer', 'getBuffer', 'removeBuffer', 'updateStatus', 'updateDesvio', 'saveToBase']
          });
      }
    } catch (error) {
      console.error('[API COLABORADORES] Erro na API:', error);
      console.error('[API COLABORADORES] Stack:', error.stack);
      return res.status(500).json({ 
        ok: false, 
        msg: 'Erro interno do servidor: ' + error.message,
        stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
      });
    }
  }

  console.warn('[API COLABORADORES] Método não permitido:', req.method);
  return res.status(405).json({ 
    ok: false, 
    msg: 'Método não permitido: ' + req.method,
    metodosPermitidos: ['GET', 'POST', 'OPTIONS']
  });
};
