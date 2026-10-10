const { GoogleSpreadsheet } = require('google-spreadsheet');
const setores = require('./setores');
const { fusoAtual } = require('./fuso');
const { comRetry } = require('./google_retry');
const { JWT } = require('google-auth-library');

class SheetsAvariaService {
  constructor() {
    this.doc = null;
    this.initialized = false;
  }

  async init() {
    if (this.initialized) return this.doc;
    try {
      const serviceAccountAuth = new JWT({
        email: process.env.GOOGLE_SHEETS_CLIENT_EMAIL,
        key: (() => {
        const key = process.env.GOOGLE_SHEETS_PRIVATE_KEY || '';
        // Remove aspas extras que o Netlify às vezes adiciona
        const cleaned = key.replace(/^"|"$/g, '');
        // Substitui \n literais por quebras de linha reais
        return cleaned.includes('\\n') 
          ? cleaned.replace(/\\n/g, '\n') 
          : cleaned;
      })(),
        scopes: ['https://www.googleapis.com/auth/spreadsheets'],
      });
      this.doc = comRetry(new GoogleSpreadsheet(process.env.GOOGLE_SHEETS_ID_AVARIA, serviceAccountAuth));
      await this.doc.loadInfo();
      this.initialized = true;
      console.log(`[AVARIA] ✓ Conectado: ${this.doc.title}`);
      return this.doc;
    } catch (error) {
      console.error('[AVARIA] Erro na conexão:', error);
      throw new Error('Falha na conexão com planilha de avaria: ' + error.message);
    }
  }

  /**
   * Gera todas as variações possíveis de um código para busca
   * @param {string} codigo - Código a ser normalizado
   * @returns {Array<string>} - Array com todas as variações
   */
  gerarVariacoesCodigo(codigo) {
    if (!codigo) return [];
    
    const codigoStr = String(codigo).trim();
    const variacoes = new Set();
    
    // Adiciona o código original
    variacoes.add(codigoStr);
    
    // Adiciona sem zeros à esquerda
    const semZeros = codigoStr.replace(/^0+/, '') || '0';
    variacoes.add(semZeros);
    
    // Adiciona com zeros à esquerda (padrões comuns de código de barras)
    if (!isNaN(codigoStr)) {
      variacoes.add(codigoStr.padStart(8, '0'));  // Code 39 padrão
      variacoes.add(codigoStr.padStart(12, '0')); // UPC
      variacoes.add(codigoStr.padStart(13, '0')); // EAN-13
      variacoes.add(codigoStr.padStart(14, '0')); // DUN-14
    }
    
    return Array.from(variacoes);
  }

  async obterDadosProdutos() {
    try {
      await this.init();
      console.log('[AVARIA] Buscando produtos na aba Endereços...');
      
      const sheet = this.doc.sheetsByTitle['Endereços'];
      if (!sheet) {
        console.error('[AVARIA] ✗ Aba "Endereços" não encontrada');
        return { produtos: [], mapaBusca: {} };
      }
      
      await sheet.loadHeaderRow();
      const headers = sheet.headerValues;
      console.log('[AVARIA] Headers:', headers);
      
      const rows = await sheet.getRows();
      console.log(`[AVARIA] Total de linhas: ${rows.length}`);
      
      const produtos = [];
      const mapaBusca = {}; // ← SEMPRE retorna objeto simples
      
      rows.forEach((row, index) => {
        try {
          // Lê as colunas EXATAMENTE como estão na planilha
          const codigo = String(row.get('COD') || '').trim();
          const descricao = String(row.get('DESC') || '').trim();
          const ean = String(row.get('Ean') || '').trim();
          const dun = String(row.get('Dun') || '').trim();
          const codDesc = String(row.get('Cod. desc.') || '').trim();
          const endereco = String(row.get('Endereço') || '').trim();
          
          // Debug primeiras 10 linhas
          if (index < 10) {
            console.log(`[AVARIA] Linha ${index + 1}:`, {
              codigo,
              descricao: descricao.substring(0, 30) + '...',
              ean,
              dun,
              codDesc
            });
          }
          
          // Ignora linhas sem descrição
          if (!descricao) return;
          
          // Cria objeto do produto
          const produto = {
            codigo: codigo || '',
            descricao: descricao,
            embalagem: codDesc || 'N/A',
            ean: ean || '',
            dun: dun || '',
            endereco: endereco || 'N/A'
          };
          
          produtos.push(produto);
          
          // INDEXA TODAS AS VARIAÇÕES DE TODOS OS CÓDIGOS
          const codigosParaIndexar = [];
          
          if (codigo) {
            const variacoesCod = this.gerarVariacoesCodigo(codigo);
            codigosParaIndexar.push(...variacoesCod);
          }
          
          if (ean) {
            const variacoesEan = this.gerarVariacoesCodigo(ean);
            codigosParaIndexar.push(...variacoesEan);
          }
          
          if (dun) {
            const variacoesDun = this.gerarVariacoesCodigo(dun);
            codigosParaIndexar.push(...variacoesDun);
          }
          
          // Remove duplicatas e vazios
          const codigosUnicos = [...new Set(codigosParaIndexar)].filter(c => c && c !== '0');
          
          // Indexa cada variação no mapa (OBJETO SIMPLES)
          codigosUnicos.forEach(chave => {
            if (!mapaBusca[chave]) {
              mapaBusca[chave] = produto;
            }
          });
          
          // Debug: mostra indexação da primeira linha
          if (index === 0) {
            console.log(`[AVARIA] Exemplo de indexação (linha 1):`, {
              codigosIndexados: codigosUnicos.slice(0, 10), // Primeiros 10
              produto: {
                descricao: produto.descricao.substring(0, 50),
                embalagem: produto.embalagem
              }
            });
          }
          
        } catch (erro) {
          console.error(`[AVARIA] Erro ao processar linha ${index + 1}:`, erro);
        }
      });
      
      console.log(`[AVARIA] ✓ ${produtos.length} produtos processados`);
      console.log(`[AVARIA] ✓ ${Object.keys(mapaBusca).length} códigos indexados`);
      
      // Debug: mostra alguns exemplos de códigos indexados
      const exemplos = Object.keys(mapaBusca).slice(0, 20);
      console.log('[AVARIA] Primeiros 20 códigos indexados:', exemplos);
      
      return {
        produtos: produtos,
        mapaBusca: mapaBusca // ← RETORNA SEMPRE COMO OBJETO
      };
      
    } catch (error) {
      console.error('[AVARIA] Erro ao buscar produtos:', error);
      return { produtos: [], mapaBusca: {} };
    }
  }

  async salvarRegistro(usuarioLogado, codigoProduto, descricaoProduto, embalagemProduto, motivo, quantidade) {
    try {
      await this.init();
      let sheet = this.doc.sheetsByTitle['Base'];
      
      if (!sheet) {
        console.log('[AVARIA] Criando aba Base...');
        sheet = await this.doc.addSheet({
          title: 'Base',
          headerValues: ['Data/Hora', 'Usuário', 'Código Produto', 'Descrição', 'Embalagem', 'Motivo', 'Quantidade']
        });
      }
      
      // ===== HORÁRIO GMT-4 (Manaus) =====
      const agora = new Date();
      const dataHora = agora.toLocaleString('pt-BR', { 
        timeZone: fusoAtual(),
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
      });
      
      // Setorização: departamento de quem registrou
      const colDepartamento = await setores.colunaDepartamento(sheet);
      await sheet.addRow({
        [colDepartamento]: await setores.departamentoParaRegistro(''),
        'Data/Hora': dataHora,
        'Usuário': usuarioLogado,
        'Código Produto': String(codigoProduto),
        'Descrição': descricaoProduto,
        'Embalagem': embalagemProduto,
        'Motivo': motivo,
        'Quantidade': parseInt(quantidade, 10)
      });
      
      console.log(`[AVARIA] ✓ Registro salvo: ${usuarioLogado} - ${codigoProduto} - ${motivo} - ${quantidade}`);
      return { ok: true, msg: '✓ Registro salvo com sucesso!' };
    } catch (error) {
      console.error('[AVARIA] Erro ao salvar:', error);
      return { ok: false, msg: 'Erro ao salvar: ' + error.message };
    }
  }

  async obterHistorico(filtros = {}) {
    try {
      await this.init();
      const sheet = this.doc.sheetsByTitle['Base'];
      if (!sheet) {
        return { ok: true, dados: [] };
      }
      const rows = await sheet.getRows();
      let dados = rows.map(row => ({
        dataHora: String(row.get('Data/Hora') || ''),
        usuario: String(row.get('Usuário') || ''),
        codigoProduto: String(row.get('Código Produto') || ''),
        descricao: String(row.get('Descrição') || ''),
        embalagem: String(row.get('Embalagem') || ''),
        motivo: String(row.get('Motivo') || ''),
        quantidade: parseInt(row.get('Quantidade') || 0),
        departamento: String(row.get('Departamento') || ''),
      }));

      // Setorização: só os registros dos setores do usuário logado
      const regra = await setores.regraDeAcesso();
      if (!regra.ok) return { ok: false, msg: 'Sessão expirada. Faça login novamente.' };
      dados = dados.filter(d => regra.permite({ departamento: d.departamento, usuario: d.usuario }));
      
      // Aplica filtros se fornecidos
      if (filtros.usuario) {
        dados = dados.filter(d => d.usuario.toLowerCase().includes(filtros.usuario.toLowerCase()));
      }
      if (filtros.codigoProduto) {
        dados = dados.filter(d => d.codigoProduto.includes(filtros.codigoProduto));
      }
      
      console.log(`[AVARIA] Histórico: ${dados.length} registros`);
      return { ok: true, dados };
    } catch (error) {
      console.error('[AVARIA] Erro ao buscar histórico:', error);
      return { ok: false, msg: error.message };
    }
  }
}

module.exports = new SheetsAvariaService();
