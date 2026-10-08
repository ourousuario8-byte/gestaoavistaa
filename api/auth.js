// api/auth.js - VERSÃO CORRIGIDA
const sheetsService = require('../lib/sheets');
const { gerarToken } = require('../lib/auth_token');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Método não permitido' });
  }

  try {
    const { usuario, senha, action } = req.body;

    // Validação de entrada
    if (!action) {
      return res.status(400).json({ 
        ok: false, 
        msg: 'Ação não especificada' 
      });
    }

    // LOGIN
    if (action === 'login') {
      if (!usuario || !senha) {
        return res.status(400).json({ 
          ok: false, 
          msg: 'Usuário e senha são obrigatórios' 
        });
      }

      console.log(`[AUTH] Tentativa de login: ${usuario}`);
      
      try {
        const result = await sheetsService.validarLogin(usuario, senha);
        console.log(`[AUTH] Resultado do login:`, result);
        if (result.ok) result.token = gerarToken(result.usuario, result.abas);
        return res.status(200).json(result);
      } catch (loginError) {
        console.error('[AUTH] Erro no processo de login:', loginError);
        return res.status(500).json({
          ok: false,
          msg: 'Erro ao validar credenciais: ' + loginError.message
        });
      }
    }

    // TESTE DE CONEXÃO
    if (action === 'test') {
      console.log('[AUTH] Testando conexão com Google Sheets...');
      
      try {
        const doc = await sheetsService.init();
        const sheets = Object.keys(doc.sheetsByTitle);
        
        console.log(`[AUTH] Conectado à planilha: ${doc.title}`);
        console.log(`[AUTH] Abas encontradas:`, sheets);
        
        return res.status(200).json({
          ok: true,
          msg: `Conectado à planilha: ${doc.title}`,
          sheets: sheets,
          totalSheets: sheets.length
        });
      } catch (testError) {
        console.error('[AUTH] Erro no teste de conexão:', testError);
        return res.status(500).json({
          ok: false,
          msg: 'Erro ao conectar com Google Sheets',
          details: testError.message
        });
      }
    }

    // CRIAR DADOS DE TESTE
    if (action === 'createTestData') {
      console.log('[AUTH] Iniciando criação de dados de teste...');
      
      try {
        const doc = await sheetsService.init();
        console.log(`[AUTH] Conectado à planilha: ${doc.title}`);
        
        // Aba Usuarios
        let sheet = doc.sheetsByTitle['Usuarios'];
        if (!sheet) {
          console.log('[AUTH] Criando aba Usuarios...');
          sheet = await doc.addSheet({ 
            title: 'Usuarios',
            headerValues: ['Usuario', 'Senha', 'Aba']
          });
        }
        
        const existingUsers = await sheet.getRows();
        console.log(`[AUTH] Aba Usuarios: ${existingUsers.length} registros existentes`);
        
        if (existingUsers.length === 0) {
          console.log('[AUTH] Adicionando usuários de teste...');
          await sheet.addRows([
            { Usuario: 'admin', Senha: '123', Aba: 'PCP_Gestão' },
            { Usuario: 'supervisor1', Senha: '456', Aba: 'WMS TA' },
            { Usuario: 'supervisor2', Senha: '789', Aba: 'WMS TB' },
            { Usuario: 'admin', Senha: '123', Aba: 'Separação TB' }
          ]);
          console.log('[AUTH] Usuários criados com sucesso');
        }
        
        // Aba Quadro
        sheet = doc.sheetsByTitle['Quadro'];
        if (!sheet) {
          console.log('[AUTH] Criando aba Quadro...');
          sheet = await doc.addSheet({ 
            title: 'Quadro',
            headerValues: ['Coluna 1', 'NOME', 'FUNÇÃO NO RM', 'Função que atua', 'Coluna 2']
          });
        }
        
        const existingQuadro = await sheet.getRows();
        console.log(`[AUTH] Aba Quadro: ${existingQuadro.length} registros existentes`);
        
        if (existingQuadro.length === 0) {
          console.log('[AUTH] Adicionando colaboradores de teste...');
          await sheet.addRows([
            { 'Coluna 1': '001', 'NOME': 'João Silva', 'Função que atua': 'Operador' },
            { 'Coluna 1': '002', 'NOME': 'Maria Santos', 'Função que atua': 'Supervisora' },
            { 'Coluna 1': '003', 'NOME': 'Pedro Costa', 'Função que atua': 'Operador' },
            { 'Coluna 1': '004', 'NOME': 'Ana Oliveira', 'Função que atua': 'Analista' },
            { 'Coluna 1': '005', 'NOME': 'Carlos Souza', 'Função que atua': 'Operador' }
          ]);
          console.log('[AUTH] Colaboradores criados com sucesso');
        }
        
        // Cria abas vazias se não existirem
        if (!doc.sheetsByTitle['Lista']) {
          console.log('[AUTH] Criando aba Lista...');
          await doc.addSheet({ 
            title: 'Lista',
            headerValues: ['Supervisor', 'Grupo', 'matricula', 'Nome', 'Função', 'status']
          });
        }
        
        if (!doc.sheetsByTitle['Base']) {
          console.log('[AUTH] Criando aba Base...');
          await doc.addSheet({ 
            title: 'Base',
            headerValues: ['Supervisor', 'Aba', 'Matricula', 'Nome', 'Função', 'Status', 'Data']
          });
        }
        
        console.log('[AUTH] Dados de teste criados com sucesso!');
        return res.status(200).json({ 
          ok: true, 
          msg: 'Dados de teste criados com sucesso!' 
        });
        
      } catch (createError) {
        console.error('[AUTH] Erro ao criar dados de teste:', createError);
        return res.status(500).json({ 
          ok: false, 
          msg: 'Erro ao criar dados de teste: ' + createError.message 
        });
      }
    }

    // Ação não reconhecida
    console.warn(`[AUTH] Ação não reconhecida: ${action}`);
    return res.status(400).json({ 
      error: 'Ação não reconhecida',
      action: action,
      validActions: ['login', 'test', 'createTestData']
    });

  } catch (error) {
    console.error('[AUTH] Erro geral na API:', error);
    return res.status(500).json({ 
      error: 'Erro interno do servidor',
      details: error.message,
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
};
