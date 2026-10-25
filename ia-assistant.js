(() => {
  'use strict';

  function startOfLocalDay(date = new Date()) {
    return new Date(date.getFullYear(), date.getMonth(), date.getDate());
  }

  const AssistenteIA = {
    produtosBase: [],

    inicializar(produtos) {
      this.produtosBase = Array.isArray(produtos) ? produtos : [];
    },

    gerarDescontoPorValidade(produto) {
      if (!produto?.dataValidade) return null;
      const validade = new Date(`${produto.dataValidade}T00:00:00`);
      if (Number.isNaN(validade.getTime())) return null;

      const diasRestantes = Math.ceil((validade - startOfLocalDay()) / 86400000);
      if (diasRestantes < 0) return null;

      let desconto = 0;
      let tipo = '';
      let mensagem = '';
      if (diasRestantes <= 2) {
        desconto = 40;
        tipo = 'urgente';
        mensagem = `URGENTE! Vence em ${diasRestantes} dia(s): ${desconto}% OFF.`;
      } else if (diasRestantes <= 7) {
        desconto = 25;
        tipo = 'oferta';
        mensagem = `Oferta especial: vence em ${diasRestantes} dias com ${desconto}% OFF.`;
      } else if (diasRestantes <= 15) {
        desconto = 10;
        tipo = 'aviso';
        mensagem = `Validade próxima: ${desconto}% OFF por vence em ${diasRestantes} dias.`;
      }
      return desconto ? { desconto, mensagem, tipo, diasRestantes } : null;
    },

    analisarCarrinho() {
      const ofertas = this.produtosBase
        .map(produto => ({ ...produto, ...this.gerarDescontoPorValidade(produto) }))
        .filter(produto => produto.desconto)
        .sort((a, b) => a.diasRestantes - b.diasRestantes);
      const economia = ofertas.reduce((total, oferta) => total + oferta.preco * oferta.desconto / 100, 0);
      return { ofertas, totalEconomia: economia.toFixed(2) };
    },

    falaProdutoEscaneado(produto, desconto) {
      if (!desconto) return `${produto.nome} adicionado por R$ ${produto.preco.toFixed(2)}.`;
      const final = produto.preco * (1 - desconto.desconto / 100);
      return `${produto.nome}: de R$ ${produto.preco.toFixed(2)} por R$ ${final.toFixed(2)}. ${desconto.mensagem}`;
    },

    recomendarComplementos(produto, todos = this.produtosBase) {
      const stopWords = new Set(['de', 'da', 'do', 'e', 'em', 'integral', 'tipo', 'por']);
      const termos = produto.nome.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').split(/[^a-z0-9]+/).filter(termo => termo.length > 3 && !stopWords.has(termo));
      return todos.filter(outro => {
        if (outro.codigo === produto.codigo) return false;
        const nome = outro.nome.toLowerCase();
        return termos.some(termo => nome.includes(termo));
      }).slice(0, 3);
    }
  };

  window.AssistenteIA = AssistenteIA;
})();
