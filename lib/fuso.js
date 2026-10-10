// Fuso horário do usuário: o navegador envia o próprio fuso (cabeçalho X-Fuso-Horario)
// e as datas/horas gravadas pelo servidor seguem a localização de quem fez a ação.
// Sem o cabeçalho (ou fuso inválido), usa Manaus.
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

// Executa fn com o fuso da requisição disponível para todo o código chamado por ela
function comFuso(req, fn) {
  return armazenamento.run(fusoDaRequisicao(req), fn);
}

function fusoAtual() {
  return armazenamento.getStore() || FUSO_PADRAO;
}

module.exports = { comFuso, fusoAtual, FUSO_PADRAO };
