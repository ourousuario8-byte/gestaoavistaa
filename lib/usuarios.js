const sheetsService = require('./sheets');

const ABA_USUARIOS = 'Usuarios';

// Área que dá acesso à gestão de usuários
const AREA_ADMIN = 'Usuários';

// Painéis conhecidos (o menu redireciona pelo nome da área)
const PAINEIS_PADRAO = [
  'Gestão', 'Painel de Presença', 'QLP', 'Importar QLP', 'Produção', 'Resumo de Colaboradores',
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

// ===== Perfil: o próprio usuário altera só grupo, turno e senha =====

const TURNOS_PADRAO = ['1º Turno', '2º Turno', '3º Turno', 'Comercial'];
const COLUNAS_USUARIOS = ['Usuario', 'Senha', 'Aba', 'Grupo', 'Turno'];

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
