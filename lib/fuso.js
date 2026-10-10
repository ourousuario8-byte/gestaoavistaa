// Contexto da requisição:
// - fuso horário do usuário: o navegador envia o próprio fuso (cabeçalho X-Fuso-Horario)
//   e as datas/horas gravadas pelo servidor seguem a localização de quem fez a ação.
//   Sem o cabeçalho (ou fuso inválido), usa Manaus.
// - token de sessão (cabeçalho X-Token): usado para setorizar os dados (lib/setores.js).
const { AsyncLocalStorage } = require('async_hooks');

const FUSO_PADRAO = 'America/Manaus';
const armazenamento = new AsyncLocalStorage();

function fusoValido(fuso) {
  try {
    new Intl.DateTimeFormat('pt-BR', { timeZone: fuso });
    return true;
  } catch (e) {
    return false;
  }
}

function fusoDaRequisicao(req) {
  const headers = req.headers || {};
  const fuso = String(headers['x-fuso-horario'] || headers['X-Fuso-Horario'] || '').trim();
  return fuso && fusoValido(fuso) ? fuso : FUSO_PADRAO;
}

// Token de sessão da requisição: cabeçalho X-Token (enviado por /js/fuso.js) ou campo token
function tokenDaRequisicao(req) {
  const headers = req.headers || {};
  return String(headers['x-token'] || headers['X-Token'] ||
    (req.body && req.body.token) || (req.query && req.query.token) || '').trim();
}

// Executa fn com o fuso e o token da requisição disponíveis para todo o código chamado por ela
function comFuso(req, fn) {
  return armazenamento.run({ fuso: fusoDaRequisicao(req), token: tokenDaRequisicao(req) }, fn);
}

function fusoAtual() {
  const ctx = armazenamento.getStore();
  return (ctx && ctx.fuso) || FUSO_PADRAO;
}

function tokenAtual() {
  const ctx = armazenamento.getStore();
  return (ctx && ctx.token) || '';
}

module.exports = { comFuso, fusoAtual, tokenAtual, FUSO_PADRAO };
