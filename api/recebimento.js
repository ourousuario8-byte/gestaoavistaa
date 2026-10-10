const sheetsRecebimento = require('../lib/sheets_recebimento');

const ACOES = [
  'obterOpcoes', 'obterAgenda', 'importarAgenda', 'editarAgenda', 'verificarAgenda',
  'registrarChegada', 'registrarInicio', 'registrarFim', 'atualizarCarga',
  'obterRecebimentos', 'criarAbas', 'testarConexao',
];

module.exports = async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const action = req.method === 'POST' ? req.body?.action : req.query?.action;
    console.log('[API RECEBIMENTO] Request:', { method: req.method, action });

    switch (action) {
      case 'obterOpcoes':
        return res.status(200).json(await sheetsRecebimento.obterOpcoes());

      case 'obterAgenda':
        return res.status(200).json(await sheetsRecebimento.obterAgenda());

      case 'importarAgenda': {
        const { headers, linhas } = req.body || {};
        if (!Array.isArray(headers) || !Array.isArray(linhas)) {
          return res.status(400).json({ ok: false, msg: 'Campos obrigatórios: headers, linhas' });
        }
        return res.status(200).json(await sheetsRecebimento.importarAgenda(headers, linhas));
      }

      case 'editarAgenda':
        return res.status(200).json(await sheetsRecebimento.editarAgenda(req.body || {}));

      case 'verificarAgenda': {
        const { fornecedor, notaFiscal } = req.body || {};
        const resultado = await sheetsRecebimento.cruzarComAgenda(
          fornecedor, sheetsRecebimento.separarNotas(notaFiscal)
        );
        return res.status(200).json({ ok: true, ...resultado });
      }

      case 'registrarChegada':
        return res.status(200).json(await sheetsRecebimento.registrarChegada(req.body || {}));

      case 'registrarInicio':
        return res.status(200).json(await sheetsRecebimento.registrarInicio(req.body || {}));

      case 'registrarFim':
        return res.status(200).json(await sheetsRecebimento.registrarFim(req.body || {}));

      case 'atualizarCarga':
        return res.status(200).json(await sheetsRecebimento.atualizarCarga(req.body || {}));

      case 'obterRecebimentos': {
        const filtros = req.method === 'POST' ? req.body?.filtros : req.query;
        return res.status(200).json(await sheetsRecebimento.obterRecebimentos(filtros || {}));
      }

      // GET /api/recebimento?action=criarAbas — cria as abas que não existem
      case 'criarAbas':
        return res.status(200).json(await sheetsRecebimento.criarAbas());

      case 'testarConexao': {
        const doc = await sheetsRecebimento.init();
        return res.status(200).json({ ok: true, msg: `Conectado: ${doc.title}`, abas: Object.keys(doc.sheetsByTitle) });
      }

      default:
        return res.status(400).json({
          ok: false,
          msg: action ? 'Ação inválida: ' + action : 'Action é obrigatória',
          acoesDisponiveis: ACOES,
        });
    }
  } catch (error) {
    console.error('[API RECEBIMENTO] Erro:', error);
    return res.status(500).json({ ok: false, msg: 'Erro interno: ' + error.message });
  }
};
