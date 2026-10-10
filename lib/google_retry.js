// Limite de leituras do Google Sheets ("[429] Quota exceeded ... Read requests per minute"):
// quando a API recusa por excesso de chamadas, espera um pouco e tenta de novo
// (1s, 2s, 4s + variação aleatória). Se continuar recusando, devolve uma mensagem clara.
const ESPERAS_MS = [1000, 2000, 4000];
const MSG_LIMITE = 'A planilha está recebendo muitas consultas agora. Aguarde alguns segundos e tente de novo.';

const esperar = ms => new Promise(r => setTimeout(r, ms));

function comRetry(doc) {
  if (!doc || doc.__comRetry) return doc;
  doc.__comRetry = true;

  [doc.sheetsApi, doc.driveApi].filter(Boolean).forEach(api => {
    api.interceptors.response.use(undefined, async erro => {
      const config = erro && erro.config;
      const status = erro && erro.response && erro.response.status;
      const metodo = String((config && config.method) || 'get').toLowerCase();
      // 429 nunca foi executado no Google: pode repetir qualquer chamada.
      // 500/503 só em leituras (uma gravação pode ter sido aplicada).
      const repetir = status === 429 || ((status === 500 || status === 503) && metodo === 'get');
      if (!config || !repetir) throw erro;

      config.__tentativa = (config.__tentativa || 0) + 1;
      if (config.__tentativa > ESPERAS_MS.length) {
        if (status === 429) erro.message = MSG_LIMITE;
        throw erro;
      }
      const espera = ESPERAS_MS[config.__tentativa - 1] + Math.floor(Math.random() * 500);
      console.warn(`[GOOGLE] ${status} em ${metodo.toUpperCase()} ${config.url || ''} — nova tentativa em ${espera}ms`);
      await esperar(espera);
      return api.request(config);
    });
  });
  return doc;
}

module.exports = { comRetry, MSG_LIMITE };
