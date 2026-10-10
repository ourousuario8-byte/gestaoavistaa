const sheetsService = require('../lib/sheets');
const setores = require('../lib/setores');
const { fusoAtual, tokenAtual } = require('../lib/fuso');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  console.log('[API DISTRIBUICAO] Request:', {method: req.method, body: req.body});

  try {
    const { action, dados, supervisor, data } = req.body || req.query;

    if (!action) {
      return res.status(400).json({ ok: false, msg: 'Action é obrigatória' });
    }

    switch (action) {
      case 'importarLinhas': {
        if (!dados || !Array.isArray(dados)) {
          return res.status(400).json({ ok: false, msg: 'Dados inválidos' });
        }

        const doc = await sheetsService.init();
        let sheet = doc.sheetsByTitle['Linhas de Separacao'];
        
        if (!sheet) {
          sheet = await doc.addSheet({
            title: 'Linhas de Separacao',
            headerValues: ['carga','dep','box','col3','lote','tipo agrupamento','linha separacao','peso','volume','numero itens','numero volume','operacao','tempo geracao']
          });
        }

        // Setorização: a importação substitui só as linhas dos setores do usuário;
        // as linhas de outros setores continuam na aba
        const colDepartamento = await setores.colunaDepartamento(sheet);
        const departamento = await setores.setorParaGravar();
        const regra = await setores.regraDeAcesso();
        if (!regra.ok) return res.status(401).json({ ok: false, msg: 'Sessão expirada. Faça login novamente.' });
        const outrosSetores = (await sheet.getRows())
          .filter(row => String(row.get(colDepartamento) || '').trim() && !regra.permite({ departamento: row.get(colDepartamento) }))
          .map(row => row.toObject());

        await sheet.clearRows();
        await sheet.addRows([...outrosSetores, ...dados.map(d => ({
          [colDepartamento]: departamento,
          'carga': d.carga,
          'dep': d.dep,
          'box': d.box,
          'col3': d.col3,
          'lote': d.lote,
          'tipo agrupamento': d.tipoAgrupamento,
          'linha separacao': d.linhaSeparacao,
          'peso': d.peso,
          'volume': d.volume,
          'numero itens': d.numeroItens,
          'numero volume': d.numeroVolume,
          'operacao': d.operacao,
          'tempo geracao': d.tempoGeracao
        }))]);

        return res.status(200).json({ ok: true, msg: `${dados.length} linhas importadas` });
      }

      case 'obterLinhas': {
        const doc = await sheetsService.init();
        const sheet = doc.sheetsByTitle['Linhas de Separacao'];
        
        if (!sheet) {
          return res.status(200).json({ ok: true, dados: [] });
        }

        const regra = await setores.regraDeAcesso();
        if (!regra.ok) return res.status(401).json({ ok: false, msg: 'Sessão expirada. Faça login novamente.' });
        const rows = (await sheet.getRows())
          .filter(row => regra.permite({ departamento: row.get('Departamento'), semDonoVisivel: true }));
        const dados = rows.map(row => ({
          carga: String(row.get('carga') || ''),
          dep: String(row.get('dep') || ''),
          box: String(row.get('box') || ''),
          col3: String(row.get('col3') || ''),
          lote: String(row.get('lote') || ''),
          tipoAgrupamento: String(row.get('tipo agrupamento') || ''),
          linhaSeparacao: String(row.get('linha separacao') || ''),
          peso: parseFloat(row.get('peso') || 0),
          volume: parseFloat(row.get('volume') || 0),
          numeroItens: parseInt(row.get('numero itens') || 0),
          numeroVolume: parseInt(row.get('numero volume') || 0),
          operacao: String(row.get('operacao') || ''),
          tempoGeracao: String(row.get('tempo geracao') || '')
        }));

        return res.status(200).json({ ok: true, dados, total: dados.length });
      }

      case 'obterDistribuicao': {
        const doc = await sheetsService.init();
        const sheet = doc.sheetsByTitle['Distribuicao Supervisor'];
        
        if (!sheet) {
          return res.status(200).json({ ok: true, distribuicao: {} });
        }

        const regra = await setores.regraDeAcesso();
        if (!regra.ok) return res.status(401).json({ ok: false, msg: 'Sessão expirada. Faça login novamente.' });
        const rows = await sheet.getRows();
        const distribuicao = {};

        rows.forEach(row => {
          const sup = String(row.get('Supervisor') || '').trim();
          // Setorização: só supervisores dos setores do usuário
          if (!regra.permite({ departamento: row.get('Departamento'), usuario: sup })) return;
          const linha1 = String(row.get('Linha 1') || '').trim();
          const linha2 = String(row.get('Linha 2') || '').trim();

          if (!sup) return;

          if (!distribuicao[sup]) {
            distribuicao[sup] = [];
          }

          distribuicao[sup].push({ linha1, linha2 });
        });

        return res.status(200).json({ ok: true, distribuicao });
      }

      case 'salvarDistribuicao': {
        if (!dados || typeof dados !== 'object') {
          return res.status(400).json({ ok: false, msg: 'Dados de distribuição inválidos' });
        }

        const doc = await sheetsService.init();
        let sheet = doc.sheetsByTitle['Resultado Distribuicao'];
        
        if (!sheet) {
          sheet = await doc.addSheet({
            title: 'Resultado Distribuicao',
            headerValues: ['Data','Supervisor','Linha','Total Itens','Total Lotes','Volume','Peso','Colaboradores Sugeridos','Media Itens']
          });
        }

        const hoje = new Date().toLocaleDateString('pt-BR', { timeZone: fusoAtual() });
        const colDepartamento = await setores.colunaDepartamento(sheet);
        const departamento = await setores.setorParaGravar();
        const registros = [];

        for (const sup in dados) {
          dados[sup].linhas.forEach(linha => {
            registros.push({
              'Data': hoje,
              'Supervisor': sup,
              'Linha': linha.linha,
              'Total Itens': linha.totalItens,
              'Total Lotes': linha.totalLotes,
              'Volume': linha.volume,
              'Peso': linha.peso,
              'Colaboradores Sugeridos': linha.colasSugeridos,
              'Media Itens': linha.mediaItens,
              [colDepartamento]: departamento,
            });
          });
        }

        await sheet.addRows(registros);

        return res.status(200).json({ ok: true, msg: `${registros.length} registros salvos` });
      }

      case 'obterPresenca': {
        const dataRef = data || new Date().toISOString().split('T')[0];
        
        // Repassa a sessão e o fuso: o resumo já vem filtrado pelos setores do usuário
        const protocolo = (req.headers['x-forwarded-proto'] || 'https').split(',')[0];
        const resBase = await fetch(`${protocolo}://${req.headers.host}/api/producao/resumo-base?modo=dados&data=${dataRef}`, {
          headers: { 'X-Token': tokenAtual(), 'X-Fuso-Horario': fusoAtual() },
        });
        const resultBase = await resBase.json();

        if (!resultBase.ok) {
          throw new Error('Erro ao carregar presença');
        }

        const presentes = resultBase.dados.filter(d => 
          d.status && d.status.toLowerCase() === 'presente'
        );

        return res.status(200).json({ 
          ok: true, 
          presenca: presentes,
          total: presentes.length,
          dataReferencia: dataRef
        });
      }

      default:
        return res.status(400).json({ 
          ok: false, 
          msg: 'Ação inválida: ' + action,
          acoesDisponiveis: ['importarLinhas', 'obterLinhas', 'obterDistribuicao', 'salvarDistribuicao', 'obterPresenca']
        });
    }
  } catch (error) {
    console.error('[API DISTRIBUICAO] Erro:', error);
    return res.status(500).json({ 
      ok: false, 
      msg: 'Erro interno: ' + error.message,
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
};
