const usuariosService = require('../lib/usuarios');
const { validarToken } = require('../lib/auth_token');

const ACOES = ['listar', 'salvar', 'excluir', 'buscarColaborador', 'historico'];

module.exports = async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ ok: false, msg: 'Método não permitido' });

  try {
    const { action, token } = req.body || {};

    // Só quem tem a área de gestão de usuários pode usar esta API
    const sessao = validarToken(token);
    if (!sessao) return res.status(401).json({ ok: false, msg: 'Sessão expirada. Faça login novamente.' });
    if (!(await usuariosService.usuarioEhAdmin(sessao.usuario))) {
      return res.status(403).json({ ok: false, msg: `Acesso restrito à área "${usuariosService.AREA_ADMIN}"` });
    }

    switch (action) {
      case 'listar':
        return res.status(200).json(await usuariosService.listar());

      case 'salvar':
        return res.status(200).json(await usuariosService.salvar(req.body, sessao.usuario));

      case 'excluir':
        return res.status(200).json(await usuariosService.excluir(req.body.usuario, sessao.usuario));

      // Busca no QLP para atrelar o usuário ao colaborador (sugere nome.sobrenome)
      case 'buscarColaborador':
        return res.status(200).json(await usuariosService.buscarColaborador(req.body.termo));

      // Histórico de alterações (de um usuário ou de todos)
      case 'historico':
        return res.status(200).json(await usuariosService.historico(req.body.usuario));

      default:
        return res.status(400).json({
          ok: false,
          msg: action ? 'Ação inválida: ' + action : 'Action é obrigatória',
          acoesDisponiveis: ACOES,
        });
    }
  } catch (error) {
    console.error('[API USUARIOS] Erro:', error);
    return res.status(500).json({ ok: false, msg: 'Erro interno: ' + error.message });
  }
};
