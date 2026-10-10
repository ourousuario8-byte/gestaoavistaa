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

function veTodosSetores(u) {
  return !u || !u.departamento || u.abas.some(a => normalizar(a) === normalizar(AREA_TODOS_SETORES));
}

/**
 * Acesso do usuário da requisição atual (pelo token da sessão).
 * { logado, usuario, setor, todos, permite(setorDoRegistro) }
 */
async function acessoAtual() {
  const sessao = validarToken(tokenAtual());
  if (!sessao) {
    return { logado: false, usuario: '', setor: '', todos: false, permite: () => false };
  }
  const cadastro = await cadastroUsuarios();
  const u = cadastro.get(sessao.usuario);
  const todos = veTodosSetores(u);
  const setor = u ? u.departamento : '';
  const alvo = normalizar(setor);
  return {
    logado: true,
    usuario: sessao.usuario,
    setor,
    todos,
    permite: setorRegistro => todos || normalizar(setorRegistro) === alvo,
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

// Setor do usuário logado para gravar nos registros novos ('' se não tiver)
async function setorParaGravar() {
  const acesso = await acessoAtual();
  return acesso.setor || '';
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
  setorParaGravar,
  invalidar,
  normalizar,
};
