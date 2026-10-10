// QLP a partir da planilha do RM (aba "QLP RM") cruzada com a presença (Base/Lista)
const qlpService = require('../../lib/qlp');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    // POST { action: 'importar', headers, linhas } — sobe a planilha do QLP
    if (req.method === 'POST') {
      const { action, headers, linhas } = req.body || {};
      if (action !== 'importar') return res.status(400).json({ ok: false, msg: 'Ação inválida' });
      if (!Array.isArray(headers) || !Array.isArray(linhas)) {
        return res.status(400).json({ ok: false, msg: 'Campos obrigatórios: headers, linhas' });
      }
      return res.status(200).json(await qlpService.importar(headers, linhas));
    }

    // GET ?dias=30 — painel; &resumo=1 devolve só as estatísticas (dashboard)
    const dias = req.query?.dias !== undefined ? Number(req.query.dias) : 30;
    const r = await qlpService.painel({ dias: Number.isFinite(dias) ? dias : 30 });
    if (r.ok && req.query?.resumo) delete r.colaboradores;
    return res.status(200).json(r);
  } catch (error) {
    console.error('[QLP PAINEL] Erro:', error);
    return res.status(500).json({ ok: false, msg: 'Erro interno: ' + error.message });
  }
};
