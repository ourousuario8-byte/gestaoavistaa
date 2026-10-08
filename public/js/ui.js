/*
 * Listas suspensas com busca.
 * Transforma automaticamente:
 *   <select multiple>        → lista suspensa com caixas de seleção
 *   <select data-busca>      → lista suspensa simples com busca
 * O <select> original continua sendo a fonte dos valores (fica oculto) e recebe
 * o evento "change" normalmente, então o código das telas não precisa mudar.
 */
(function () {
  const ABERTO = 'dd-aberto';
  let atual = null;

  function esc(v) {
    return String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function semAcento(v) {
    return String(v || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  }

  function fecharAtual() {
    if (atual) {
      atual.classList.remove(ABERTO);
      atual = null;
    }
  }

  document.addEventListener('click', e => {
    if (atual && !atual.contains(e.target)) fecharAtual();
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') fecharAtual();
  });

  function montar(select) {
    if (select._dd) return select._dd.render();

    const multi = select.multiple;
    const wrap = document.createElement('div');
    wrap.className = 'dd' + (multi ? ' dd-multi' : '');
    wrap.innerHTML = `
      <button type="button" class="dd-botao"><span class="dd-texto"></span><i class="fas fa-chevron-down"></i></button>
      <div class="dd-painel">
        <div class="dd-busca-wrap"><input type="text" class="dd-busca" placeholder="Buscar..."></div>
        ${multi ? '<div class="dd-acoes"><button type="button" data-acao="todos">Marcar todos</button><button type="button" data-acao="nenhum">Limpar</button></div>' : ''}
        <div class="dd-lista"></div>
      </div>`;

    select.insertAdjacentElement('afterend', wrap);
    select.classList.add('dd-nativo');
    select.tabIndex = -1;

    const botao = wrap.querySelector('.dd-botao');
    const texto = wrap.querySelector('.dd-texto');
    const busca = wrap.querySelector('.dd-busca');
    const lista = wrap.querySelector('.dd-lista');
    const placeholder = select.dataset.placeholder || (multi ? 'Todos' : 'Selecione...');

    function opcoes() {
      return [...select.options].filter(o => o.value !== '' || !multi);
    }

    function atualizarTexto() {
      const marcadas = [...select.selectedOptions].filter(o => o.value !== '');
      if (!marcadas.length) {
        texto.textContent = placeholder;
        wrap.classList.add('dd-vazio');
      } else {
        texto.textContent = multi && marcadas.length > 2
          ? `${marcadas.length} selecionados`
          : marcadas.map(o => o.textContent.trim()).join(', ');
        wrap.classList.remove('dd-vazio');
      }
      botao.disabled = select.disabled;
    }

    function renderLista() {
      const filtro = semAcento(busca.value.trim());
      let html = '';
      let grupoAtual = null;
      let visiveis = 0;

      opcoes().forEach((o, idx) => {
        const rotulo = o.textContent.trim();
        if (filtro && !semAcento(rotulo).includes(filtro)) return;
        const grupo = o.parentElement.tagName === 'OPTGROUP' ? o.parentElement.label : null;
        if (grupo !== grupoAtual) {
          if (grupo) html += `<div class="dd-grupo">${esc(grupo)}</div>`;
          grupoAtual = grupo;
        }
        visiveis++;
        const sel = o.selected && o.value !== '';
        html += `<div class="dd-item${sel ? ' dd-sel' : ''}${o.disabled ? ' dd-desab' : ''}" data-idx="${idx}">
          ${multi ? `<span class="dd-check">${sel ? '<i class="fas fa-check"></i>' : ''}</span>` : ''}
          <span>${esc(rotulo || placeholder)}</span>
          ${o.dataset.extra ? `<small>${esc(o.dataset.extra)}</small>` : ''}
        </div>`;
      });

      lista.innerHTML = visiveis ? html : '<div class="dd-nada">Nada encontrado</div>';
    }

    function render() {
      atualizarTexto();
      if (wrap.classList.contains(ABERTO)) renderLista();
      // Busca só aparece em listas grandes
      wrap.querySelector('.dd-busca-wrap').style.display = opcoes().length > 7 ? '' : 'none';
    }

    function emitir() {
      select.dispatchEvent(new Event('change', { bubbles: true }));
      atualizarTexto();
    }

    botao.addEventListener('click', () => {
      if (wrap.classList.contains(ABERTO)) return fecharAtual();
      fecharAtual();
      wrap.classList.add(ABERTO);
      atual = wrap;
      busca.value = '';
      renderLista();
      // Abre para cima se não couber embaixo
      const r = wrap.getBoundingClientRect();
      wrap.classList.toggle('dd-cima', window.innerHeight - r.bottom < 300 && r.top > 300);
      if (opcoes().length > 7) setTimeout(() => busca.focus(), 0);
    });

    busca.addEventListener('input', renderLista);

    lista.addEventListener('click', e => {
      const item = e.target.closest('.dd-item');
      if (!item || item.classList.contains('dd-desab')) return;
      const o = opcoes()[Number(item.dataset.idx)];
      if (multi) {
        o.selected = !o.selected;
        renderLista();
      } else {
        o.selected = true;
        fecharAtual();
      }
      emitir();
    });

    wrap.querySelector('.dd-acoes')?.addEventListener('click', e => {
      const acao = e.target.dataset.acao;
      if (!acao) return;
      opcoes().forEach(o => { o.selected = acao === 'todos'; });
      renderLista();
      emitir();
    });

    // Recria a lista quando o código da tela troca as opções
    new MutationObserver(render).observe(select, { childList: true, subtree: true, attributes: true, attributeFilter: ['disabled'] });
    select.addEventListener('change', atualizarTexto);

    // Atribuições diretas (select.value = x) não disparam eventos
    const desc = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value');
    Object.defineProperty(select, 'value', {
      get() { return desc.get.call(this); },
      set(v) { desc.set.call(this, v); atualizarTexto(); },
    });

    select._dd = { render, wrap };
    render();
  }

  function aplicar(raiz = document) {
    raiz.querySelectorAll('select[multiple], select[data-busca]').forEach(s => {
      if (!s.hasAttribute('data-nativo')) montar(s);
    });
  }

  window.UI = { aplicar, atualizar: s => s._dd && s._dd.render() };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => aplicar());
  else aplicar();
})();
