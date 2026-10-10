const sheetsService = require('./sheets');
const setores = require('./setores');
const { fusoAtual } = require('./fuso');

const ABA_USUARIOS = 'Usuarios';

// Área que dá acesso à gestão de usuários
const AREA_ADMIN = 'Usuários';

// Painéis conhecidos (o menu redireciona pelo nome da área)
const PAINEIS_PADRAO = [
  'Gestão', 'Painel de Presença', 'QLP', 'Importar QLP', 'Produção', 'Resumo de Colaboradores',
  'Resumo Equipamentos', 'Mapa de Carga', 'Alocação BOX', 'Controle de Equipamentos',
  'Avaria', 'Recebimento', 'Dashboard Recebimento', 'Correções', AREA_ADMIN, 'Todos os setores',
];

function normalizar(valor) {
  return String(valor || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim();
}

function ehAdmin(abas) {
  return (abas || []).some(a => normalizar(a) === normalizar(AREA_ADMIN));
}

const ABA_HISTORICO = 'Histórico Usuários';
const COLUNAS_HISTORICO = ['Data', 'Responsável', 'Usuário', 'Ação', 'Abas', 'Matrícula', 'Nome', 'Função', 'Departamento', 'Grupo', 'Turno'];
const PALAVRAS_LIGACAO = new Set(['da', 'de', 'do', 'das', 'dos', 'e']);

// Matrícula comparável ("1-000013" → "1-13", "000013" → "13")
function chaveMatricula(valor) {
  const t = String(valor || '').trim();
  if (!t) return '';
  const partes = t.split('-');
  const chapa = partes.pop().replace(/\D/g, '').replace(/^0+/, '');
  const empresa = partes.length ? partes[0].replace(/\D/g, '').replace(/^0+/, '') : '';
  return empresa ? `${empresa}-${chapa}` : chapa;
}

/**
 * Sugestão de usuário a partir do nome: nome.sobrenome (sem acento, minúsculo).
 * Se já existir, tenta nome + outros sobrenomes e, por fim, acrescenta um número.
 */
function sugerirUsuario(nome, existentes) {
  const partes = String(nome || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z\s]/g, ' ').split(/\s+/).filter(p => p && !PALAVRAS_LIGACAO.has(p));
  if (!partes.length) return '';
  const [primeiro] = partes;
  const candidatos = [];
  if (partes.length > 1) candidatos.push(`${primeiro}.${partes[partes.length - 1]}`);
  for (let i = 1; i < partes.length - 1; i++) candidatos.push(`${primeiro}.${partes[i]}`);
  if (partes.length === 1) candidatos.push(primeiro);
  const livre = candidatos.find(c => !existentes.has(c));
  if (livre) return livre;
  let n = 2;
  while (existentes.has(`${candidatos[0]}${n}`)) n++;
  return `${candidatos[0]}${n}`;
}

function idxColuna(headers, ...nomes) {
  const norm = headers.map(h => normalizar(h));
  for (const nome of nomes) {
    const i = norm.indexOf(normalizar(nome));
    if (i !== -1) return i;
  }
  return -1;
}

class UsuariosService {
  async getSheet() {
    const doc = await sheetsService.init();
    let sheet = doc.sheetsByTitle[ABA_USUARIOS];
    if (!sheet) {
      sheet = await doc.addSheet({ title: ABA_USUARIOS, headerValues: setores.COLUNAS_USUARIOS });
    }
    return sheet;
  }

  invalidar() {
    sheetsService.invalidateCache('usuarios:');
    setores.invalidar();
  }

  // Linhas da aba Usuarios com as colunas do vínculo ao QLP (criadas se faltarem)
  async lerCadastro() {
    const sheet = await this.getSheet();
    const mapa = await sheetsService.colunas(sheet, setores.COLUNAS_USUARIOS);
    const rows = await sheet.getRows();
    const v = (row, nome) => sheetsService.valor(row, mapa, nome);
    return { sheet, mapa, rows, v };
  }

  // Agrupa as linhas (uma por área) em um registro por usuário
  agrupar(rows, v) {
    const mapa = new Map();
    rows.forEach(row => {
      const usuario = v(row, 'Usuario');
      if (!usuario) return;
      if (!mapa.has(usuario)) {
        mapa.set(usuario, { usuario, abas: [], matricula: '', nome: '', funcao: '', departamento: '', grupo: '', turno: '' });
      }
      const u = mapa.get(usuario);
      const aba = v(row, 'Aba');
      if (aba && !u.abas.includes(aba)) u.abas.push(aba);
      [['matricula', 'Matricula'], ['nome', 'Nome'], ['funcao', 'Função'], ['departamento', 'Departamento'],
        ['grupo', 'Grupo'], ['turno', 'Turno']].forEach(([campo, coluna]) => {
        if (!u[campo]) u[campo] = v(row, coluna);
      });
    });
    return mapa;
  }

  // Confere na planilha (não só no token) se o usuário ainda tem a área de admin
  async usuarioEhAdmin(usuario) {
    const { rows, v } = await this.lerCadastro();
    return ehAdmin(rows.filter(r => v(r, 'Usuario') === usuario).map(r => v(r, 'Aba')));
  }

  // QLP (aba "QLP RM") em objetos simples
  async colaboradoresQLP() {
    const doc = await sheetsService.init();
    const sheet = doc.sheetsByTitle['QLP RM'];
    if (!sheet) return [];
    const valores = (await sheet.getCellsInRange('A:AZ')) || [];
    if (!valores.length) return [];
    const h = valores[0];
    const c = {
      chapa: idxColuna(h, 'CHAPA'), codChapa: idxColuna(h, 'COD_CHAPA'), nome: idxColuna(h, 'NOME'),
      funcao: idxColuna(h, 'FUNÇÃO', 'FUNCAO'), departamento: idxColuna(h, 'DEPARTAMENTO'),
      situacao: idxColuna(h, 'SITUAÇÃO', 'SITUACAO'), secao: idxColuna(h, 'SEÇÃO', 'SECAO'), site: idxColuna(h, 'SITE'),
    };
    const v = (l, i) => (i === -1 ? '' : String(l[i] ?? '').trim());
    return valores.slice(1).map(l => ({
      matricula: v(l, c.codChapa) || v(l, c.chapa),
      chapa: v(l, c.chapa),
      nome: v(l, c.nome),
      funcao: v(l, c.funcao),
      departamento: v(l, c.departamento),
      situacao: v(l, c.situacao),
      secao: v(l, c.secao),
      site: v(l, c.site),
    })).filter(x => x.nome);
  }

  // Lista usuários agrupados (sem senha), com o vínculo ao QLP
  async listar() {
    const { rows, v } = await this.lerCadastro();
    const mapa = this.agrupar(rows, v);
    const areas = new Set(PAINEIS_PADRAO);
    mapa.forEach(u => u.abas.forEach(a => areas.add(a)));

    let departamentos = [];
    try {
      const qlp = await this.colaboradoresQLP();
      departamentos = [...new Set(qlp.map(c => c.departamento).filter(Boolean))]
        .sort((a, b) => a.localeCompare(b, 'pt-BR'));
      // Departamento atual do colaborador atrelado (pode mudar a cada importação do QLP)
      const deptoPorMatricula = new Map(qlp.map(c => [chaveMatricula(c.matricula), c.departamento]));
      mapa.forEach(u => { u.departamentoQLP = u.matricula ? deptoPorMatricula.get(chaveMatricula(u.matricula)) || '' : ''; });
    } catch (e) { /* sem QLP */ }

    const usuarios = [...mapa.values()].sort((a, b) => a.usuario.localeCompare(b.usuario, 'pt-BR'));
    return {
      ok: true,
      usuarios,
      areas: [...areas].sort((a, b) => a.localeCompare(b, 'pt-BR')),
      areaAdmin: AREA_ADMIN,
      areaTodosSetores: setores.AREA_TODOS_SETORES,
      departamentos,
    };
  }

  /**
   * Busca colaboradores no QLP por nome ou matrícula, já com a sugestão de usuário
   * (nome.sobrenome) e indicando se já estão vinculados a algum usuário.
   */
  async buscarColaborador(termo) {
    const alvo = normalizar(termo);
    if (alvo.length < 2) return { ok: true, colaboradores: [] };

    const [qlp, { rows, v }] = await Promise.all([this.colaboradoresQLP(), this.lerCadastro()]);
    if (!qlp.length) return { ok: false, msg: 'QLP não encontrado. Importe a planilha do QLP primeiro.' };

    const usuarios = this.agrupar(rows, v);
    const existentes = new Set([...usuarios.keys()].map(u => u.toLowerCase()));
    const porMatricula = new Map();
    usuarios.forEach(u => { if (u.matricula) porMatricula.set(chaveMatricula(u.matricula), u.usuario); });

    const encontrados = qlp
      .filter(c => normalizar(c.nome).includes(alvo) || normalizar(c.matricula).includes(alvo) || normalizar(c.chapa).includes(alvo))
      // Ativos primeiro, depois por nome
      .sort((a, b) => (normalizar(b.situacao) === 'ativo') - (normalizar(a.situacao) === 'ativo') || a.nome.localeCompare(b.nome, 'pt-BR'))
      .slice(0, 20)
      .map(c => ({
        ...c,
        vinculadoA: porMatricula.get(chaveMatricula(c.matricula)) || '',
        sugestaoUsuario: sugerirUsuario(c.nome, existentes),
      }));

    return { ok: true, colaboradores: encontrados };
  }

  // ===== Histórico =====
  async sheetHistorico() {
    const doc = await sheetsService.init();
    let sheet = doc.sheetsByTitle[ABA_HISTORICO];
    if (!sheet) sheet = await doc.addSheet({ title: ABA_HISTORICO, headerValues: COLUNAS_HISTORICO });
    const mapa = await sheetsService.colunas(sheet, COLUNAS_HISTORICO);
    return { sheet, mapa };
  }

  async registrarHistorico(entrada) {
    try {
      const { sheet, mapa } = await this.sheetHistorico();
      const ultima = ((await sheet.getCellsInRange('A:A')) || []).length || 1;
      await sheetsService.inserirLinhas(sheet, mapa, [{
        'Data': new Date().toLocaleString('pt-BR', { timeZone: fusoAtual() }),
        ...entrada,
      }], ultima);
    } catch (e) {
      // O histórico não pode impedir a alteração em si
      console.error('[USUARIOS] Erro ao gravar histórico:', e.message);
    }
  }

  async historico(usuario) {
    const doc = await sheetsService.init();
    const sheet = doc.sheetsByTitle[ABA_HISTORICO];
    if (!sheet) return { ok: true, historico: [] };
    const mapa = await sheetsService.colunas(sheet, COLUNAS_HISTORICO);
    const rows = await sheet.getRows();
    const lista = rows
      .map(r => Object.fromEntries(COLUNAS_HISTORICO.map(c => [c, sheetsService.valor(r, mapa, c)])))
      .filter(h => h['Usuário'] && (!usuario || h['Usuário'] === usuario))
      .reverse()
      .slice(0, 300);
    return { ok: true, historico: lista };
  }

  /**
   * Cria ou atualiza um usuário: grava uma linha por área na aba Usuarios, todas com
   * o vínculo ao colaborador do QLP (matrícula, nome, função e departamento/setor).
   * @param {object} dados - { usuario, senha, abas, novo, vinculo: { matricula, nome, funcao, departamento } }
   * @param {string} solicitante - usuário logado que está alterando
   */
  async salvar({ usuario, senha, abas, novo, vinculo }, solicitante) {
    usuario = String(usuario || '').trim();
    senha = String(senha || '').trim();
    abas = [...new Set((abas || []).map(a => String(a || '').trim()).filter(Boolean))];

    if (!usuario) return { ok: false, msg: 'Informe o usuário' };
    if (!abas.length) return { ok: false, msg: 'Selecione ao menos um painel' };
    if (usuario === solicitante && !ehAdmin(abas)) {
      return { ok: false, msg: `Você não pode remover o seu próprio acesso a "${AREA_ADMIN}"` };
    }

    const { sheet, mapa, rows, v } = await this.lerCadastro();
    const doUsuario = rows.filter(r => v(r, 'Usuario') === usuario);
    const usuarios = this.agrupar(rows, v);
    const atual = usuarios.get(usuario);

    if (novo && doUsuario.length) return { ok: false, msg: `O usuário "${usuario}" já existe` };
    if (!doUsuario.length && !senha) return { ok: false, msg: 'Informe a senha' };

    // Vínculo ao QLP: sem "vinculo" na requisição, mantém o que já está gravado
    const vinc = vinculo
      ? {
          matricula: String(vinculo.matricula || '').trim(),
          nome: String(vinculo.nome || '').trim(),
          funcao: String(vinculo.funcao || '').trim(),
          // Um ou mais departamentos (lista ou texto separado por ";")
          departamento: setores.juntarSetores(Array.isArray(vinculo.departamentos)
            ? vinculo.departamentos
            : setores.separarSetores(vinculo.departamento)),
        }
      : { matricula: atual?.matricula || '', nome: atual?.nome || '', funcao: atual?.funcao || '', departamento: atual?.departamento || '' };

    // Um colaborador do QLP só pode estar atrelado a um usuário
    if (vinc.matricula) {
      const chave = chaveMatricula(vinc.matricula);
      const outro = [...usuarios.values()].find(u => u.usuario !== usuario && u.matricula && chaveMatricula(u.matricula) === chave);
      if (outro) return { ok: false, msg: `A matrícula ${vinc.matricula} já está atrelada ao usuário "${outro.usuario}"` };
    }

    const senhaFinal = senha || v(doUsuario[0], 'Senha');
    const campos = {
      'Senha': senhaFinal,
      'Matricula': vinc.matricula,
      'Nome': vinc.nome,
      'Função': vinc.funcao,
      'Departamento': vinc.departamento,
      'Grupo': atual?.grupo || '',
      'Turno': atual?.turno || '',
    };

    const remover = doUsuario.filter(r => !abas.includes(v(r, 'Aba')));
    const mantidas = doUsuario.filter(r => !remover.includes(r));
    const existentes = new Set(mantidas.map(r => v(r, 'Aba')));
    const novas = abas.filter(a => !existentes.has(a)).map(aba => ({ 'Usuario': usuario, 'Aba': aba, ...campos }));

    const doc = await sheetsService.init();
    // 1) Atualiza as linhas que ficam (só as células do vínculo/senha)
    if (mantidas.length) {
      const data = [];
      mantidas.forEach(row => Object.entries(campos).forEach(([nome, valor]) => {
        const col = sheetsService.letraColuna(sheet.headerValues.indexOf(mapa[nome]) + 1);
        data.push({ range: `${sheet.a1SheetName}!${col}${row.rowNumber}`, values: [[valor]] });
      }));
      await doc.sheetsApi.post('/values:batchUpdate', { valueInputOption: 'RAW', data });
    }
    // 2) Apaga as áreas que saíram e 3) insere as novas no fim
    const ultima = (rows.length ? rows[rows.length - 1].rowNumber : 1) - remover.length;
    await sheetsService.apagarLinhas(sheet, remover.map(r => r.rowNumber));
    await sheetsService.inserirLinhas(sheet, mapa, novas, ultima);

    this.invalidar();
    const criado = !doUsuario.length;
    await this.registrarHistorico({
      'Responsável': solicitante,
      'Usuário': usuario,
      'Ação': criado ? 'Criado' : ('Editado' + (senha ? ' (senha alterada)' : '')),
      'Abas': abas.join(', '),
      'Matrícula': vinc.matricula,
      'Nome': vinc.nome,
      'Função': vinc.funcao,
      'Departamento': vinc.departamento,
      'Grupo': campos.Grupo,
      'Turno': campos.Turno,
    });

    console.log(`[USUARIOS] ${solicitante} salvou ${usuario}: ${abas.join(', ')} (${vinc.matricula || 'sem vínculo'})`);
    return { ok: true, msg: criado ? 'Usuário criado' : 'Usuário atualizado' };
  }

  async excluir(usuario, solicitante) {
    usuario = String(usuario || '').trim();
    if (!usuario) return { ok: false, msg: 'Informe o usuário' };
    if (usuario === solicitante) return { ok: false, msg: 'Você não pode excluir o seu próprio usuário' };

    const { sheet, rows, v } = await this.lerCadastro();
    const linhas = rows.filter(r => v(r, 'Usuario') === usuario);
    if (!linhas.length) return { ok: false, msg: 'Usuário não encontrado' };
    const u = this.agrupar(linhas, v).get(usuario);

    await sheetsService.apagarLinhas(sheet, linhas.map(r => r.rowNumber));

    this.invalidar();
    await this.registrarHistorico({
      'Responsável': solicitante,
      'Usuário': usuario,
      'Ação': 'Excluído',
      'Abas': u.abas.join(', '),
      'Matrícula': u.matricula,
      'Nome': u.nome,
      'Função': u.funcao,
      'Departamento': u.departamento,
      'Grupo': u.grupo,
      'Turno': u.turno,
    });
    console.log(`[USUARIOS] ${solicitante} excluiu ${usuario}`);
    return { ok: true, msg: 'Usuário excluído' };
  }
}

// ===== Perfil: o próprio usuário altera só grupo, turno e senha =====

const TURNOS_PADRAO = ['1º Turno', '2º Turno', '3º Turno', 'Comercial'];
const COLUNAS_USUARIOS = setores.COLUNAS_USUARIOS;

function unicos(lista) {
  const vistos = new Map();
  lista.map(v => String(v || '').trim()).filter(Boolean).forEach(v => {
    if (!vistos.has(normalizar(v))) vistos.set(normalizar(v), v);
  });
  return [...vistos.values()].sort((a, b) => a.localeCompare(b, 'pt-BR'));
}

UsuariosService.prototype.linhasDoUsuario = async function (usuario) {
  const sheet = await this.getSheet();
  const mapa = await sheetsService.colunas(sheet, COLUNAS_USUARIOS);
  const rows = await sheet.getRows();
  const v = (row, nome) => sheetsService.valor(row, mapa, nome);
  return { sheet, mapa, rows, v, minhas: rows.filter(r => v(r, 'Usuario') === usuario) };
};

UsuariosService.prototype.meuPerfil = async function (usuario) {
  const { rows, v, minhas } = await this.linhasDoUsuario(usuario);
  if (!minhas.length) return { ok: false, msg: 'Usuário não encontrado' };
  const primeiro = nome => (minhas.map(r => v(r, nome)).find(Boolean) || '');

  // Sugestões: grupos já usados na Lista e nos usuários; turnos já usados
  let gruposLista = [];
  try {
    const { sheet: lista, mapa } = await sheetsService.sheetLista();
    if (lista) gruposLista = (await lista.getRows()).map(r => sheetsService.valor(r, mapa, 'Grupo'));
  } catch (e) { /* sem Lista */ }

  return {
    ok: true,
    usuario,
    grupo: primeiro('Grupo'),
    turno: primeiro('Turno'),
    // Vínculo ao QLP (só leitura no perfil; quem altera é a gestão de usuários)
    matricula: primeiro('Matricula'),
    nome: primeiro('Nome'),
    funcao: primeiro('Função'),
    departamento: primeiro('Departamento'),
    grupos: unicos([...gruposLista, ...rows.map(r => v(r, 'Grupo'))]),
    turnos: unicos([...TURNOS_PADRAO, ...rows.map(r => v(r, 'Turno'))]),
  };
};

/**
 * Salva o perfil do próprio usuário (identificado pelo token, nunca pelo corpo da requisição).
 * Grupo e turno ficam em todas as linhas do usuário na aba Usuarios; ao trocar o grupo,
 * a lista de presença do usuário (aba Lista) acompanha o novo grupo.
 */
UsuariosService.prototype.salvarPerfil = async function (usuario, dados) {
  const grupo = String(dados.grupo || '').trim();
  const turno = String(dados.turno || '').trim();
  const senhaAtual = String(dados.senhaAtual || '').trim();
  const novaSenha = String(dados.novaSenha || '').trim();

  if (!grupo) return { ok: false, msg: 'Informe o grupo da lista de presença' };
  if (!turno) return { ok: false, msg: 'Informe o turno' };

  const { sheet, mapa, minhas, v } = await this.linhasDoUsuario(usuario);
  if (!minhas.length) return { ok: false, msg: 'Usuário não encontrado' };

  if (novaSenha) {
    if (v(minhas[0], 'Senha') !== senhaAtual) return { ok: false, msg: 'Senha atual incorreta' };
    if (novaSenha.length < 4) return { ok: false, msg: 'A nova senha precisa ter ao menos 4 caracteres' };
  }

  const grupoAntigo = minhas.map(r => v(r, 'Grupo')).find(Boolean) || '';
  const campos = { Grupo: grupo, Turno: turno };
  if (novaSenha) campos.Senha = novaSenha;

  // Grava só as células desses campos nas linhas do usuário
  const doc = await sheetsService.init();
  const colunaDe = nome => sheetsService.letraColuna(sheet.headerValues.indexOf(mapa[nome]) + 1);
  const data = [];
  minhas.forEach(row => Object.entries(campos).forEach(([nome, valor]) => {
    data.push({ range: `${sheet.a1SheetName}!${colunaDe(nome)}${row.rowNumber}`, values: [[valor]] });
  }));
  await doc.sheetsApi.post('/values:batchUpdate', { valueInputOption: 'RAW', data });

  // A lista de presença do usuário passa para o novo grupo
  let movidos = 0;
  if (normalizar(grupo) !== normalizar(grupoAntigo)) {
    const { sheet: lista, mapa: ml } = await sheetsService.sheetLista();
    if (lista) {
      const linhas = (await lista.getRows()).filter(r =>
        sheetsService.valor(r, ml, 'Supervisor') === usuario && sheetsService.valor(r, ml, 'Grupo') !== grupo);
      if (linhas.length) {
        const letra = sheetsService.letraColuna(lista.headerValues.indexOf(ml.Grupo) + 1);
        await doc.sheetsApi.post('/values:batchUpdate', {
          valueInputOption: 'RAW',
          data: linhas.map(r => ({ range: `${lista.a1SheetName}!${letra}${r.rowNumber}`, values: [[grupo]] })),
        });
        movidos = linhas.length;
        sheetsService.invalidateCache('buffer:');
      }
    }
  }

  this.invalidar();
  const primeiro = nome => (minhas.map(r => v(r, nome)).find(Boolean) || '');
  await this.registrarHistorico({
    'Responsável': usuario,
    'Usuário': usuario,
    'Ação': 'Perfil' + (novaSenha ? ' (senha alterada)' : ''),
    'Abas': [...new Set(minhas.map(r => v(r, 'Aba')).filter(Boolean))].join(', '),
    'Matrícula': primeiro('Matricula'),
    'Nome': primeiro('Nome'),
    'Função': primeiro('Função'),
    'Departamento': primeiro('Departamento'),
    'Grupo': grupo,
    'Turno': turno,
  });
  console.log(`[USUARIOS] ${usuario} atualizou o próprio perfil (grupo=${grupo}, turno=${turno}${novaSenha ? ', senha' : ''})`);
  return {
    ok: true,
    msg: 'Dados atualizados' + (novaSenha ? ' — senha alterada' : '') +
      (movidos ? ` — ${movidos} colaborador(es) da sua lista foram para o grupo ${grupo}` : ''),
    grupo,
    turno,
  };
};

const service = new UsuariosService();
service.ehAdmin = ehAdmin;
service.AREA_ADMIN = AREA_ADMIN;

module.exports = service;
