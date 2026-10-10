const sheetsService = require('./sheets');
const { fusoAtual } = require('./fuso');

// Aba com a planilha do RM (QLP). A aba "QLP" antiga continua sendo usada pelo Resumo Base.
const ABA_QLP = 'QLP RM';
const COL_DATA_UPLOAD = 'Data Upload';

// Faltas seguidas a partir das quais o colaborador entra em "risco de abandono"
const LIMITE_RISCO_ABANDONO = 5;

// Status que não contam como dia de trabalho programado
const NAO_PROGRAMADOS = new Set(['ferias', 'folga', 'afastado']);

function normalizar(valor) {
  return String(valor || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

// Chapa sem prefixo de empresa ("1-000013") e sem zeros à esquerda
function chaveChapa(valor) {
  const texto = String(valor || '').trim();
  const semPrefixo = texto.includes('-') ? texto.split('-').pop() : texto;
  const digitos = semPrefixo.replace(/\D/g, '');
  return digitos.replace(/^0+/, '') || digitos;
}

// Chapa com a empresa ("1-000013" → "1-13"); vazio se não tiver prefixo
function chaveCompleta(valor) {
  const texto = String(valor || '').trim();
  if (!texto.includes('-')) return '';
  const [empresa, chapa] = [texto.split('-')[0], texto.split('-').pop()];
  return `${empresa.replace(/\D/g, '').replace(/^0+/, '')}-${chaveChapa(chapa)}`;
}

// Presença/lista guardadas pela chapa completa (com empresa) e pela chapa simples
function indexar(mapa, matricula, valor, acumular) {
  // Com empresa ("1-000018") só casa com a mesma empresa; sem empresa casa pela chapa
  const chave = chaveCompleta(matricula) || ('c:' + chaveChapa(matricula));
  [chave].filter(k => k && k !== 'c:').forEach(k => {
    if (acumular) { if (!mapa.has(k)) mapa.set(k, []); mapa.get(k).push(valor); }
    else mapa.set(k, valor);
  });
}

// Busca primeiro pela chapa com empresa (sem ambiguidade); depois pela chapa simples
function buscar(mapa, codChapa, chapa) {
  const completa = chaveCompleta(codChapa);
  if (completa && mapa.has(completa)) return mapa.get(completa);
  return mapa.get('c:' + chaveChapa(chapa || codChapa));
}

// "dd/mm/aaaa" ou "aaaa-mm-dd" → Date (meia-noite local)
function parseData(texto) {
  const t = String(texto || '').trim();
  let m = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  m = t.match(/^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{4})/);
  return m ? new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1])) : null;
}

function hojeManaus() {
  const [d, m, a] = new Date().toLocaleDateString('pt-BR', { timeZone: fusoAtual() }).split('/');
  return new Date(Number(a), Number(m) - 1, Number(d));
}

function idx(headers, ...nomes) {
  const norm = headers.map(normalizar);
  for (const nome of nomes) {
    const i = norm.indexOf(normalizar(nome));
    if (i !== -1) return i;
  }
  return -1;
}

function pct(parte, total) {
  return total ? Math.round((parte / total) * 1000) / 10 : 0;
}

class QLPService {
  async doc() {
    return sheetsService.init();
  }

  // ===== Upload da planilha do RM =====
  async importar(headers, linhas) {
    try {
      headers = (headers || []).map((h, i) => String(h || '').trim() || `Coluna ${i + 1}`);
      const contagem = {};
      headers = headers.map(h => {
        contagem[h] = (contagem[h] || 0) + 1;
        return contagem[h] > 1 ? `${h} (${contagem[h]})` : h;
      });
      linhas = (linhas || []).filter(l => Array.isArray(l) && l.some(v => String(v ?? '').trim()));
      if (!headers.length || !linhas.length) return { ok: false, msg: 'Arquivo sem dados' };
      if (idx(headers, 'NOME') === -1 || idx(headers, 'CHAPA', 'COD_CHAPA') === -1) {
        return { ok: false, msg: 'O arquivo precisa ter as colunas CHAPA e NOME' };
      }

      const doc = await this.doc();
      await doc.loadInfo();
      const headersFinais = [...headers.filter(h => h !== COL_DATA_UPLOAD), COL_DATA_UPLOAD];
      const dataUpload = new Date().toLocaleString('pt-BR', {
        timeZone: fusoAtual(), day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
      });

      let sheet = doc.sheetsByTitle[ABA_QLP];
      if (!sheet) {
        sheet = await doc.addSheet({
          title: ABA_QLP,
          gridProperties: { rowCount: linhas.length + 10, columnCount: headersFinais.length },
        });
      } else {
        await sheet.clear();
      }
      // O QLP é uma foto do quadro: cada envio substitui o anterior
      await sheet.resize({
        rowCount: Math.max(linhas.length + 10, 100),
        columnCount: Math.max(headersFinais.length, sheet.columnCount),
      });
      await sheet.setHeaderRow(headersFinais);

      const objetos = linhas.map(linha => {
        const obj = { [COL_DATA_UPLOAD]: dataUpload };
        headers.forEach((h, i) => { if (h !== COL_DATA_UPLOAD) obj[h] = String(linha[i] ?? '').trim(); });
        return obj;
      });

      const lote = 1500;
      for (let i = 0; i < objetos.length; i += lote) {
        await sheet.addRows(objetos.slice(i, i + lote), { raw: true });
      }

      console.log(`[QLP] ✓ ${objetos.length} colaboradores importados para "${ABA_QLP}"`);
      return { ok: true, msg: `${objetos.length} colaborador(es) importado(s) no QLP`, total: objetos.length, dataUpload };
    } catch (error) {
      console.error('[QLP] Erro ao importar:', error);
      return { ok: false, msg: 'Erro ao importar QLP: ' + error.message };
    }
  }

  async lerValores(doc, titulo, ultimaColuna = 'AZ') {
    const sheet = doc.sheetsByTitle[titulo];
    if (!sheet) return null;
    return (await sheet.getCellsInRange(`A:${ultimaColuna}`)) || [];
  }

  // ===== Painel: QLP + presença (Base) + supervisor atual (Lista) =====
  async painel({ dias = 30 } = {}) {
    const doc = await this.doc();
    await doc.loadInfo();

    const [qlp, base, lista] = await Promise.all([
      this.lerValores(doc, ABA_QLP),
      this.lerValores(doc, 'Base', 'L'),
      this.lerValores(doc, 'Lista', 'L'),
    ]);

    if (!qlp) {
      return { ok: false, semDados: true, msg: `Aba "${ABA_QLP}" não encontrada. Suba a planilha do QLP.` };
    }

    // --- QLP ---
    const hq = qlp[0] || [];
    const c = {
      chapa: idx(hq, 'CHAPA'), codChapa: idx(hq, 'COD_CHAPA'), nome: idx(hq, 'NOME'), funcao: idx(hq, 'FUNÇÃO', 'FUNCAO'),
      situacao: idx(hq, 'SITUAÇÃO', 'SITUACAO'), site: idx(hq, 'SITE'), departamento: idx(hq, 'DEPARTAMENTO'),
      grupo: idx(hq, 'GRUPO_SEÇÃO', 'GRUPO_SECAO'), secao: idx(hq, 'SEÇÃO', 'SECAO'), filial: idx(hq, 'FIL_NOME_FANTASIA'),
      ccusto: idx(hq, 'NOME_CCUSTO'), admissao: idx(hq, 'DATAADMISSAO'), tempo: idx(hq, 'TEMPO_DE_CASA'),
      tipo: idx(hq, 'TIPO_FUNC'), upload: idx(hq, COL_DATA_UPLOAD),
    };
    const v = (linha, i) => (i === -1 ? '' : String(linha[i] ?? '').trim());

    // --- Supervisor atual pela Lista (Supervisor, Grupo, matricula) ---
    const supervisorAtual = new Map();
    if (lista && lista.length) {
      const hl = lista[0];
      const iSup = idx(hl, 'Supervisor'), iGrupo = idx(hl, 'Grupo'), iMat = idx(hl, 'matricula', 'Matricula');
      lista.slice(1).forEach(l => {
        if (v(l, iMat) && v(l, iSup)) indexar(supervisorAtual, v(l, iMat), { supervisor: v(l, iSup), aba: v(l, iGrupo) });
      });
    }

    // --- Presença pela Base (Supervisor, Aba, Matricula, Nome, Função, Status, Desvio, Data) ---
    const limite = new Date(hojeManaus());
    const filtrarPeriodo = Number(dias) > 0;
    if (filtrarPeriodo) limite.setDate(limite.getDate() - Number(dias) + 1);

    const presenca = new Map(); // chapa → [{data, status, supervisor, aba}]
    const presencaPorNome = new Map(); // nome normalizado → mesmos registros
    if (base && base.length) {
      const hb = base[0];
      const iSup = idx(hb, 'Supervisor'), iAba = idx(hb, 'Aba'), iMat = idx(hb, 'Matricula'),
        iStatus = idx(hb, 'Status'), iData = idx(hb, 'Data'), iNome = idx(hb, 'Nome');
      base.slice(1).forEach(l => {
        const data = parseData(v(l, iData));
        if (!v(l, iMat) || !data) return;
        if (filtrarPeriodo && data < limite) return;
        const registro = { data, status: normalizar(v(l, iStatus)), supervisor: v(l, iSup), aba: v(l, iAba) };
        indexar(presenca, v(l, iMat), registro, true);
        // Também pelo nome: cobre matrículas digitadas em formato diferente do RM
        const nomeBase = normalizar(v(l, iNome));
        if (nomeBase) {
          if (!presencaPorNome.has(nomeBase)) presencaPorNome.set(nomeBase, []);
          presencaPorNome.get(nomeBase).push(registro);
        }
      });
    }

    // --- Monta colaboradores ---
    const colaboradores = [];
    let dataUpload = '';
    qlp.slice(1).forEach(l => {
      const nome = v(l, c.nome);
      if (!nome) return;
      if (!dataUpload) dataUpload = v(l, c.upload);

      const chapa = v(l, c.chapa) || v(l, c.codChapa);
      const codChapa = v(l, c.codChapa);
      const situacao = v(l, c.situacao);

      // Um registro por dia (o último do dia vale)
      const porDia = new Map();
      (buscar(presenca, codChapa, chapa) || presencaPorNome.get(normalizar(nome)) || []).forEach(r => porDia.set(r.data.getTime(), r));
      const registros = [...porDia.values()].sort((a, b) => a.data - b.data);

      const conta = s => registros.filter(r => r.status === s).length;
      const presentes = conta('presente');
      const faltas = conta('ausente');
      const atestados = conta('atestado');
      const programados = registros.filter(r => !NAO_PROGRAMADOS.has(r.status)).length;

      // Faltas consecutivas: atuais (do último registro para trás) e maior sequência.
      // Folga/férias/afastado não interrompem a sequência; presença interrompe.
      let atuais = 0, maior = 0, seq = 0, aberta = true;
      registros.forEach(r => {
        if (r.status === 'ausente' || r.status === 'abandono') { seq++; maior = Math.max(maior, seq); }
        else if (!NAO_PROGRAMADOS.has(r.status)) seq = 0;
      });
      for (let i = registros.length - 1; i >= 0 && aberta; i--) {
        const s = registros[i].status;
        if (s === 'ausente' || s === 'abandono') atuais++;
        else if (!NAO_PROGRAMADOS.has(s)) aberta = false;
      }

      const ultimo = registros[registros.length - 1];
      const sup = buscar(supervisorAtual, codChapa, chapa) || (ultimo ? { supervisor: ultimo.supervisor, aba: ultimo.aba } : null);
      const abandono = !!ultimo && ultimo.status === 'abandono';

      colaboradores.push({
        chapa,
        codChapa,
        nome,
        funcao: v(l, c.funcao),
        situacao,
        ativo: normalizar(situacao) === 'ativo',
        site: v(l, c.site),
        departamento: v(l, c.departamento),
        grupoSecao: v(l, c.grupo),
        secao: v(l, c.secao),
        filial: v(l, c.filial),
        ccusto: v(l, c.ccusto),
        admissao: v(l, c.admissao),
        tempoCasa: v(l, c.tempo),
        tipo: v(l, c.tipo),
        supervisor: sup ? sup.supervisor : '',
        aba: sup ? sup.aba : '',
        diasRegistrados: registros.length,
        diasProgramados: programados,
        diasPresente: presentes,
        faltas,
        atestados,
        faltasConsecutivas: atuais,
        maiorSequenciaFaltas: maior,
        absenteismo: pct(faltas + atestados, programados),
        abandono,
        riscoAbandono: !abandono && atuais >= LIMITE_RISCO_ABANDONO,
        ultimoStatus: ultimo ? ultimo.status : '',
        ultimaData: ultimo ? ultimo.data.toLocaleDateString('pt-BR') : '',
      });
    });

    return {
      ok: true,
      aba: ABA_QLP,
      dataUpload,
      periodoDias: Number(dias) || 0,
      limiteRiscoAbandono: LIMITE_RISCO_ABANDONO,
      colaboradores,
      estatisticas: this.estatisticas(colaboradores),
    };
  }

  estatisticas(lista) {
    const ativos = lista.filter(c => c.ativo);
    const agrupar = (campo) => {
      const g = {};
      lista.forEach(c => {
        const chave = c[campo] || 'Não informado';
        if (!g[chave]) g[chave] = { total: 0, ativos: 0, inativos: 0 };
        g[chave].total++;
        if (c.ativo) g[chave].ativos++; else g[chave].inativos++;
      });
      return g;
    };

    // Por supervisor (só quem já está em alguma lista de presença)
    const porSupervisor = {};
    lista.filter(c => c.supervisor).forEach(c => {
      const s = porSupervisor[c.supervisor] || (porSupervisor[c.supervisor] = {
        colaboradores: 0, diasPresente: 0, faltas: 0, atestados: 0, programados: 0, abandono: 0, riscoAbandono: 0,
      });
      s.colaboradores++;
      s.diasPresente += c.diasPresente;
      s.faltas += c.faltas;
      s.atestados += c.atestados;
      s.programados += c.diasProgramados;
      if (c.abandono) s.abandono++;
      if (c.riscoAbandono) s.riscoAbandono++;
    });
    Object.values(porSupervisor).forEach(s => {
      s.absenteismo = pct(s.faltas + s.atestados, s.programados);
      s.taxaAbandono = pct(s.abandono, s.colaboradores);
    });

    const faltas = lista.reduce((t, c) => t + c.faltas + c.atestados, 0);
    const programados = lista.reduce((t, c) => t + c.diasProgramados, 0);
    const emAbandono = lista.filter(c => c.abandono).length;
    const comPresenca = lista.filter(c => c.diasRegistrados > 0).length;

    return {
      total: lista.length,
      ativos: ativos.length,
      inativos: lista.length - ativos.length,
      comSupervisor: lista.filter(c => c.supervisor).length,
      comPresenca,
      absenteismo: pct(faltas, programados),
      emAbandono,
      taxaAbandono: pct(emAbandono, comPresenca || ativos.length),
      riscoAbandono: lista.filter(c => c.riscoAbandono).length,
      porSituacao: Object.fromEntries(Object.entries(agrupar('situacao')).map(([k, x]) => [k, x.total])),
      porSite: agrupar('site'),
      porDepartamento: agrupar('departamento'),
      porSecao: agrupar('grupoSecao'),
      porSupervisor,
    };
  }
}

const service = new QLPService();
service.ABA_QLP = ABA_QLP;
service.chaveChapa = chaveChapa;
module.exports = service;
