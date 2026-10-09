// netlify/functions/api.js
const authHandler = require('../../api/auth');
const colaboradoresHandler = require('../../api/colaboradores');
const coletoresHandler = require('../../api/coletores');
const mapacargaHandler = require('../../api/mapacarga');
const avariaHandler = require('../../api/avaria');
const distribuicaoHandler = require('../../api/Linha_Distribuição');
const resumoBaseHandler = require('../../api/producao/resumo-base');
const producaoDadosHandler = require('../../api/producao/dados');
const qlpDadosHandler = require('../../api/qlp/dados');
const qlpQuadroHandler = require('../../api/qlp/quadro');
const recebimentoHandler = require('../../api/recebimento');
const usuariosHandler = require('../../api/usuarios');

function buildReq(event) {
  const body = event.body
    ? (() => { try { return JSON.parse(event.body); } catch { return {}; } })()
    : {};

  return {
    method: event.httpMethod,
    body,
    query: event.queryStringParameters || {},
    headers: event.headers || {},
    path: event.path,
  };
}

function buildRes() {
  let _status = 200;
  let _headers = { 'Content-Type': 'application/json' };
  let _body = '';

  const res = {
    statusCode: 200,
    status(code) { _status = code; return res; },
    setHeader(k, v) { _headers[k] = v; return res; },
    json(data) { _body = JSON.stringify(data); return res; },
    end() { return res; },
    getResult() {
      return { statusCode: _status, headers: _headers, body: _body };
    },
  };
  return res;
}

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  const path = event.path.replace('/.netlify/functions/api', '').replace('/api', '');
  const req = buildReq(event);
  const res = buildRes();

  try {
    if (path === '/auth' || path === '/auth/') {
      await authHandler(req, res);
    } else if (path.startsWith('/colaboradores')) {
      await colaboradoresHandler(req, res);
    } else if (path.startsWith('/coletores')) {
      await coletoresHandler(req, res);
    } else if (path.startsWith('/mapacarga')) {
      await mapacargaHandler(req, res);
    } else if (path.startsWith('/avaria')) {
      await avariaHandler(req, res);
    } else if (path.startsWith('/Linha_Distribuição') || path.startsWith('/Linha_Distribui')) {
      await distribuicaoHandler(req, res);
    } else if (path.startsWith('/producao/resumo-base')) {
      await resumoBaseHandler(req, res);
    } else if (path.startsWith('/producao/dados')) {
      await producaoDadosHandler(req, res);
    } else if (path.startsWith('/qlp/quadro')) {
      await qlpQuadroHandler(req, res);
    } else if (path.startsWith('/qlp/dados')) {
      await qlpDadosHandler(req, res);
    } else if (path.startsWith('/recebimento')) {
      await recebimentoHandler(req, res);
    } else if (path.startsWith('/usuarios')) {
      await usuariosHandler(req, res);
    } else {
      return { statusCode: 404, headers, body: JSON.stringify({ ok: false, msg: 'Rota não encontrada: ' + path }) };
    }

    const result = res.getResult();
    return { ...result, headers: { ...headers, ...result.headers } };

  } catch (err) {
    console.error('[NETLIFY FUNCTION] Erro:', err);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ ok: false, msg: 'Erro interno: ' + err.message }),
    };
  }
};
