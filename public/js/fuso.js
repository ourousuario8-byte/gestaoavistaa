/*
 * Fuso horário do usuário.
 * As telas mostram data/hora conforme a localização do aparelho, e cada chamada
 * à API leva o fuso (cabeçalho X-Fuso-Horario) para o servidor gravar as
 * datas/horas no mesmo horário que o usuário está vendo.
 * Também envia o token da sessão (X-Token) para o servidor setorizar os dados.
 */
(function () {
  let fuso = 'America/Manaus';
  try { fuso = Intl.DateTimeFormat().resolvedOptions().timeZone || fuso; } catch (e) { /* navegador antigo */ }
  window.FUSO_USUARIO = fuso;

  const fetchOriginal = window.fetch;
  if (!fetchOriginal) return;
  window.fetch = function (entrada, opcoes) {
    const url = typeof entrada === 'string' ? entrada : (entrada && entrada.url) || '';
    if (/^\/api\/|\/api\//.test(url)) {
      opcoes = Object.assign({}, opcoes);
      const headers = new Headers(opcoes.headers || (typeof entrada !== 'string' && entrada.headers) || {});
      headers.set('X-Fuso-Horario', fuso);
      // Sessão do usuário: o servidor mostra só os dados do setor dele
      let token = '';
      try { token = sessionStorage.getItem('token') || ''; } catch (e) { /* sem storage */ }
      if (token && !headers.has('X-Token')) headers.set('X-Token', token);
      opcoes.headers = headers;
    }
    return fetchOriginal.call(this, entrada, opcoes);
  };
})();
