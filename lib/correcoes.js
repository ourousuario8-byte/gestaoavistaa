// Correções feitas pelos usuários nos próprios lançamentos (recebimento, Base e Lista).
// - Só quem tem a permissão "Correções" pode corrigir (além de ser o dono do registro)
// - Cada campo alterado vira uma linha na aba "Correções" (antes/depois, quem e quando)
const sheetsService = require('./sheets');
const setores = require('./setores');
const { fusoAtual } = require('./fuso');

const AREA_CORRECOES = 'Correções';
const ABA_CORRECOES = 'Correções';
const COLUNAS_CORRECOES = ['Data', 'Usuário', 'Tela', 'Registro', 'Campo', 'Antes', 'Depois', 'Departamento'];

/**
 * Confere sessão e permissão "Correções" do usuário logado.
 * @returns {Promise<{ok, usuario, msg}>}
 */
async function podeCorrigir() {
  const acesso = await setores.acessoAtual();
  if (!acesso.logado) return { ok: false, msg: 'Sessão expirada. Faça login novamente.' };
  const cadastro = await setores.cadastroUsuarios();
  const u = cadastro.get(acesso.usuario);
  const tem = u && u.abas.some(a => setores.normalizar(a) === setores.normalizar(AREA_CORRECOES));
  if (!tem) return { ok: false, msg: `Acesso restrito à permissão "${AREA_CORRECOES}"` };
  return { ok: true, usuario: acesso.usuario, setor: acesso.setores[0] || '' };
}

/**
 * Registra as alterações na aba "Correções" (uma linha por campo alterado).
 * Falha ao registrar não desfaz a correção (só fica no log do servidor).
 * @param {object} info - { usuario, tela, registro, departamento }
 * @param {Array<{campo, antes, depois}>} mudancas
 */
async function registrar(info, mudancas) {
  const linhas = (mudancas || []).filter(m => String(m.antes ?? '') !== String(m.depois ?? ''));
  if (!linhas.length) return;
  try {
    const doc = await sheetsService.init();
    let sheet = doc.sheetsByTitle[ABA_CORRECOES];
    if (!sheet) sheet = await doc.addSheet({ title: ABA_CORRECOES, headerValues: COLUNAS_CORRECOES });
    const mapa = await sheetsService.colunas(sheet, COLUNAS_CORRECOES);
    const ultima = ((await sheet.getCellsInRange('A:A')) || []).length || 1;
    const data = new Date().toLocaleString('pt-BR', { timeZone: fusoAtual() });
    await sheetsService.inserirLinhas(sheet, mapa, linhas.map(m => ({
      'Data': data,
      'Usuário': info.usuario,
      'Tela': info.tela,
      'Registro': info.registro,
      'Campo': m.campo,
      'Antes': String(m.antes ?? ''),
      'Depois': String(m.depois ?? ''),
      'Departamento': info.departamento || '',
    })), ultima);
  } catch (e) {
    console.error('[CORRECOES] Erro ao registrar:', e.message);
  }
}

// Correções feitas pelo usuário logado (mais recentes primeiro)
async function minhasCorrecoes(limite = 200) {
  const permissao = await podeCorrigir();
  if (!permissao.ok) return permissao;
  const doc = await sheetsService.init();
  const sheet = doc.sheetsByTitle[ABA_CORRECOES];
  if (!sheet) return { ok: true, correcoes: [] };
  const mapa = await sheetsService.colunas(sheet, COLUNAS_CORRECOES);
  const correcoes = (await sheet.getRows())
    .map(r => Object.fromEntries(COLUNAS_CORRECOES.map(c => [c, sheetsService.valor(r, mapa, c)])))
    .filter(c => c['Usuário'] === permissao.usuario)
    .reverse()
    .slice(0, limite);
  return { ok: true, correcoes };
}

module.exports = { AREA_CORRECOES, ABA_CORRECOES, podeCorrigir, registrar, minhasCorrecoes };
