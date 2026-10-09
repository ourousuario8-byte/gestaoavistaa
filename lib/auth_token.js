const crypto = require('crypto');

// Token de sessão assinado (HMAC) gerado no login.
// Usado pelas APIs que precisam saber quem está chamando (ex.: gestão de usuários).
const VALIDADE_MS = 12 * 60 * 60 * 1000;

function segredo() {
  const s = process.env.AUTH_SECRET || process.env.GOOGLE_SHEETS_PRIVATE_KEY;
  if (!s) throw new Error('AUTH_SECRET não configurado');
  return s;
}

function assinar(payload) {
  return crypto.createHmac('sha256', segredo()).update(payload).digest('base64url');
}

function gerarToken(usuario, abas) {
  const payload = Buffer.from(JSON.stringify({
    u: usuario,
    abas,
    exp: Date.now() + VALIDADE_MS,
  })).toString('base64url');
  return `${payload}.${assinar(payload)}`;
}

// Retorna { usuario, abas } ou null se o token for inválido/expirado
function validarToken(token) {
  try {
    const [payload, assinatura] = String(token || '').split('.');
    if (!payload || !assinatura) return null;

    const esperado = Buffer.from(assinar(payload));
    const recebido = Buffer.from(assinatura);
    if (esperado.length !== recebido.length || !crypto.timingSafeEqual(esperado, recebido)) return null;

    const dados = JSON.parse(Buffer.from(payload, 'base64url').toString());
    if (!dados.exp || dados.exp < Date.now()) return null;
    return { usuario: dados.u, abas: dados.abas || [] };
  } catch (e) {
    return null;
  }
}

module.exports = { gerarToken, validarToken };
