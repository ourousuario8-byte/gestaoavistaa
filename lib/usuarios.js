const sheetsService = require('./sheets');

const ABA_USUARIOS = 'Usuarios';

// Área que dá acesso à gestão de usuários
const AREA_ADMIN = 'Usuários';

// Painéis conhecidos (o menu redireciona pelo nome da área)
const PAINEIS_PADRAO = [
  'Gestão', 'Painel de Presença', 'QLP', 'Produção', 'Resumo Base',
  'Resumo Equipamentos', 'Mapa de Carga', 'Alocação BOX', 'Controle de Equipamentos',
  'Avaria', 'Recebimento', AREA_ADMIN,
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

class UsuariosService {
  async getSheet() {
    const doc = await sheetsService.init();
    let sheet = doc.sheetsByTitle[ABA_USUARIOS];
    if (!sheet) {
      sheet = await doc.addSheet({ title: ABA_USUARIOS, headerValues: ['Usuario', 'Senha', 'Aba'] });
    }
    return sheet;
  }

  invalidar() {
    sheetsService.invalidateCache('usuarios:');
  }

  // Confere na planilha (não só no token) se o usuário ainda tem a área de admin
  async usuarioEhAdmin(usuario) {
    const sheet = await this.getSheet();
    const rows = await sheet.getRows();
    return ehAdmin(rows
      .filter(r => String(r.get('Usuario') || '').trim() === usuario)
      .map(r => String(r.get('Aba') || '').trim()));
  }

  // Lista usuários agrupados (sem senha)
  async listar() {
    const sheet = await this.getSheet();
    const rows = await sheet.getRows();

    const mapa = new Map();
    const areas = new Set(PAINEIS_PADRAO);

    rows.forEach(row => {
      const usuario = String(row.get('Usuario') || '').trim();
      const aba = String(row.get('Aba') || '').trim();
      if (!usuario) return;
      if (!mapa.has(usuario)) mapa.set(usuario, { usuario, abas: [] });
      if (aba && !mapa.get(usuario).abas.includes(aba)) {
        mapa.get(usuario).abas.push(aba);
        areas.add(aba);
      }
    });

    const usuarios = [...mapa.values()].sort((a, b) => a.usuario.localeCompare(b.usuario, 'pt-BR'));
    return {
      ok: true,
      usuarios,
      areas: [...areas].sort((a, b) => a.localeCompare(b, 'pt-BR')),
      areaAdmin: AREA_ADMIN,
    };
  }

  /**
   * Cria ou atualiza um usuário: grava uma linha por área na aba Usuarios.
   * @param {object} dados - { usuario, senha, abas, novo }
   * @param {string} solicitante - usuário logado que está alterando
   */
  async salvar({ usuario, senha, abas, novo }, solicitante) {
    usuario = String(usuario || '').trim();
    senha = String(senha || '').trim();
    abas = [...new Set((abas || []).map(a => String(a || '').trim()).filter(Boolean))];

    if (!usuario) return { ok: false, msg: 'Informe o usuário' };
    if (!abas.length) return { ok: false, msg: 'Selecione ao menos um painel' };
    if (usuario === solicitante && !ehAdmin(abas)) {
      return { ok: false, msg: `Você não pode remover o seu próprio acesso a "${AREA_ADMIN}"` };
    }

    const sheet = await this.getSheet();
    const rows = await sheet.getRows();
    const doUsuario = rows.filter(r => String(r.get('Usuario') || '').trim() === usuario);

    if (novo && doUsuario.length) return { ok: false, msg: `O usuário "${usuario}" já existe` };
    if (!doUsuario.length && !senha) return { ok: false, msg: 'Informe a senha' };

    const senhaFinal = senha || String(doUsuario[0].get('Senha') || '').trim();

    // Remove as áreas que saíram (de baixo para cima para não deslocar as linhas)
    const remover = doUsuario
      .filter(r => !abas.includes(String(r.get('Aba') || '').trim()))
      .sort((a, b) => b.rowNumber - a.rowNumber);
    for (const row of remover) await row.delete();

    // Atualiza a senha nas linhas que ficaram
    const mantidas = doUsuario.filter(r => !remover.includes(r));
    if (senha) {
      for (const row of mantidas) {
        row.set('Senha', senhaFinal);
        await row.save({ raw: true });
      }
    }

    // Adiciona as áreas novas
    const existentes = new Set(mantidas.map(r => String(r.get('Aba') || '').trim()));
    const novas = abas.filter(a => !existentes.has(a))
      .map(aba => ({ Usuario: usuario, Senha: senhaFinal, Aba: aba }));
    if (novas.length) await sheet.addRows(novas, { raw: true });

    this.invalidar();
    console.log(`[USUARIOS] ${solicitante} salvou ${usuario}: ${abas.join(', ')}`);
    return { ok: true, msg: novo || !doUsuario.length ? 'Usuário criado' : 'Usuário atualizado' };
  }

  async excluir(usuario, solicitante) {
    usuario = String(usuario || '').trim();
    if (!usuario) return { ok: false, msg: 'Informe o usuário' };
    if (usuario === solicitante) return { ok: false, msg: 'Você não pode excluir o seu próprio usuário' };

    const sheet = await this.getSheet();
    const rows = await sheet.getRows();
    const linhas = rows
      .filter(r => String(r.get('Usuario') || '').trim() === usuario)
      .sort((a, b) => b.rowNumber - a.rowNumber);
    if (!linhas.length) return { ok: false, msg: 'Usuário não encontrado' };

    for (const row of linhas) await row.delete();

    this.invalidar();
    console.log(`[USUARIOS] ${solicitante} excluiu ${usuario}`);
    return { ok: true, msg: 'Usuário excluído' };
  }
}

const service = new UsuariosService();
service.ehAdmin = ehAdmin;
service.AREA_ADMIN = AREA_ADMIN;

module.exports = service;
