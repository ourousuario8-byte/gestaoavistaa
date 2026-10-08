const express = require('express');
const path = require('path');
const app = express();

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// CORS
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  next();
});

// Rotas da API
app.use('/api/auth',         require('./api/auth'));
app.use('/api/colaboradores',require('./api/colaboradores'));
app.use('/api/coletores',    require('./api/coletores'));
app.use('/api/mapacarga',    require('./api/mapacarga'));
app.use('/api/avaria',       require('./api/avaria'));
app.use('/api/Linha_Distribuição', require('./api/Linha_Distribuição'));
app.use('/api/producao/resumo-base', require('./api/producao/resumo-base'));
app.use('/api/producao/dados',       require('./api/producao/dados'));
app.use('/api/qlp/dados',            require('./api/qlp/dados'));
app.use('/api/qlp/quadro',           require('./api/qlp/quadro'));
app.use('/api/recebimento',          require('./api/recebimento'));

// Rotas de página (clean URLs)
const pages = [
  'menu', 'ferramentas', 'painel', 'qlp', 'producao',
  'resumo-base', 'mapacarga', 'avaria', 'alocacaobox',
  'controle-coletores', 'resumo-equipamentos',
  'Linha_distribuição', 'recebimento', 'recebimento-agenda'
];

pages.forEach(page => {
  app.get(`/${page}`, (req, res) => {
    res.sendFile(path.join(__dirname, 'public', `${page}.html`));
  });
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
