// Setorização: cada usuário fica atrelado a um colaborador do QLP e vê só os dados
// do departamento dele (ex.: quem é do CD vê só o CD).
// - Setor do usuário = coluna "Departamento" da aba Usuarios (vem do QLP no cadastro)
// - Permissão "Todos os setores" (ou usuário sem setor definido) vê tudo
// - Registros antigos sem "Departamento" usam o setor de quem gravou (Supervisor/Usuário)
const sheetsService = require('./sheets');
const { validarToken } = require('./auth_token');
const { tokenAtual } = require('./fuso');

const ABA_USUARIOS = 'Usuarios';
const AREA_TODOS_SETORES = 'Todos os setores';
const COLUNAS_USUARIOS = ['Usuario', 'Senha', 'Aba', 'Grupo', 'Turno', 'Matricula', 'Nome', 'Função', 'Departamento'];

function normalizar(valor) {
  return String(valor || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Lê a aba Usuarios com as colunas de vínculo ao QLP e devolve um mapa
 * usuario → { usuario, abas[], matricula, nome, funcao, departamento, grupo, turno }.
 * Fica em cache por pouco tempo (o cadastro invalida ao salvar).
 */
async function cadastroUsuarios() {
  const cacheKey = 'setores:cadastro'; // cache curto (1 min): mudanças de setor valem logo
  const cached = sheetsService.getCached(cacheKey);
  if (cached) return cached;

  const doc = await sheetsService.init();
  const sheet = doc.sheetsByTitle[ABA_USUARIOS];
  const mapa = new Map();
  if (!sheet) return mapa;

  const colunas = await sheetsService.colunas(sheet, COLUNAS_USUARIOS);
  const rows = await sheet.getRows();
  const v = (row, nome) => sheetsService.valor(row, colunas, nome);
  rows.forEach(row => {
    const usuario = v(row, 'Usuario');
    if (!usuario) return;
    if (!mapa.has(usuario)) {
      mapa.set(usuario, { usuario, abas: [], matricula: '', nome: '', funcao: '', departamento: '', grupo: '', turno: '' });
    }
    const u = mapa.get(usuario);
    const aba = v(row, 'Aba');
    if (aba && !u.abas.includes(aba)) u.abas.push(aba);
    // Os dados do vínculo ficam repetidos nas linhas do usuário: vale o primeiro preenchido
    [['matricula', 'Matricula'], ['nome', 'Nome'], ['funcao', 'Função'], ['departamento', 'Departamento'],
      ['grupo', 'Grupo'], ['turno', 'Turno']].forEach(([campo, coluna]) => {
      if (!u[campo]) u[campo] = v(row, coluna);
    });
  });

  sheetsService.setCache(cacheKey, mapa);
  return mapa;
}

// Um usuário pode ter vários departamentos: gravados na mesma célula separados por ";"
function separarSetores(texto) {
  const vistos = new Map();
  String(texto || '').split(/[;|\n]/).map(x => x.trim()).filter(Boolean)
    .forEach(x => { if (!vistos.has(normalizar(x))) vistos.set(normalizar(x), x); });
  return [...vistos.values()];
}

function juntarSetores(lista) {
  return separarSetores((lista || []).join(';')).join('; ');
}

function veTodosSetores(u) {
  return !u || !separarSetores(u.departamento).length ||
    u.abas.some(a => normalizar(a) === normalizar(AREA_TODOS_SETORES));
}

/**
 * Acesso do usuário da requisição atual (pelo token da sessão).
 * { logado, usuario, setores[], setor (texto), todos, permite(setorDoRegistro) }
 */
async function acessoAtual() {
  const sessao = validarToken(tokenAtual());
  if (!sessao) {
    return { logado: false, usuario: '', setores: [], setor: '', todos: false, permite: () => false };
  }
  const cadastro = await cadastroUsuarios();
  const u = cadastro.get(sessao.usuario);
  const todos = veTodosSetores(u);
  const meus = u ? separarSetores(u.departamento) : [];
  const alvos = new Set(meus.map(normalizar));
  return {
    logado: true,
    usuario: sessao.usuario,
    setores: meus,
    setor: meus.join('; '),
    todos,
    // O registro pode ter um ou mais setores: basta um em comum
    permite: setorRegistro => todos || separarSetores(setorRegistro).some(x => alvos.has(normalizar(x))),
  };
}

// Setor de um registro: coluna Departamento ou, em registros antigos, o setor de quem gravou
async function resolvedorDeSetor() {
  const cadastro = await cadastroUsuarios();
  return (departamento, usuario) => {
    if (String(departamento || '').trim()) return String(departamento).trim();
    const u = cadastro.get(String(usuario || '').trim());
    return u ? u.departamento : '';
  };
}

/**
 * Regra de visibilidade do usuário logado para qualquer registro.
 * O setor do registro vem, nesta ordem, da coluna Departamento, do colaborador no QLP
 * (pela chapa/matrícula) ou do usuário que gravou. Registros sem setor ficam ocultos,
 * exceto quando semDonoVisivel (tabelas compartilhadas, ex.: Mapa de Carga).
 * @returns {Promise<{ok, acesso, permite({departamento, chapa, usuario, semDonoVisivel})}>}
 */
async function regraDeAcesso() {
  const acesso = await acessoAtual();
  if (!acesso.logado) return { ok: false, acesso, permite: () => false };
  if (acesso.todos) return { ok: true, acesso, permite: () => true };

  const setorDe = await resolvedorDeSetor();
  let porChapa = null;
  const setorDaChapa = async () => {
    if (porChapa) return porChapa;
    porChapa = new Map();
    (await sheetsService.listaColaboradores()).forEach(c => {
      if (c.departamento) porChapa.set(sheetsService.chaveMatricula(c.matricula), c.departamento);
    });
    return porChapa;
  };
  await setorDaChapa();

  return {
    ok: true,
    acesso,
    permite: ({ departamento, chapa, usuario, semDonoVisivel } = {}) => {
      let setor = String(departamento || '').trim();
      if (!setor && chapa) setor = porChapa.get(sheetsService.chaveMatricula(chapa)) || '';
      if (!setor && usuario) setor = setorDe('', usuario);
      if (!setor) return !!semDonoVisivel;
      return acesso.permite(setor);
    },
  };
}

/**
 * Filtra uma lista pelo setor do usuário logado.
 * @param {Array} lista
 * @param {Function} departamentoDe - item → coluna Departamento do registro
 * @param {Function} usuarioDe - item → usuário que gravou (para registros antigos)
 * @returns {Promise<{ok, lista, acesso}>} ok=false quando não há sessão
 */
async function filtrar(lista, departamentoDe, usuarioDe = () => '') {
  const regra = await regraDeAcesso();
  if (!regra.ok) return { ok: false, lista: [], acesso: regra.acesso };
  return {
    ok: true,
    lista: lista.filter(x => regra.permite({ departamento: departamentoDe(x), usuario: usuarioDe(x) })),
    acesso: regra.acesso,
  };
}

/**
 * Departamento a gravar num registro novo: o do colaborador no QLP (pela chapa),
 * senão o setor principal de quem está gravando.
 */
async function departamentoParaRegistro(chapa) {
  if (chapa) {
    const c = await sheetsService.colaboradorPorMatricula(chapa);
    if (c && c.departamento) return c.departamento;
  }
  return setorParaGravar();
}

// Garante a coluna "Departamento" numa aba (de qualquer planilha) e devolve o título real dela
async function colunaDepartamento(sheet) {
  const mapa = await sheetsService.colunas(sheet, ['Departamento']);
  return mapa.Departamento;
}

// Setor do usuário logado para gravar nos registros novos: o principal (primeiro da lista)
async function setorParaGravar() {
  const acesso = await acessoAtual();
  return acesso.setores[0] || '';
}

function invalidar() {
  sheetsService.invalidateCache('setores:');
}

module.exports = {
  AREA_TODOS_SETORES,
  COLUNAS_USUARIOS,
  cadastroUsuarios,
  acessoAtual,
  resolvedorDeSetor,
  filtrar,
  regraDeAcesso,
  departamentoParaRegistro,
  colunaDepartamento,
  separarSetores,
  juntarSetores,
  setorParaGravar,
  invalidar,
  normalizar,
};
