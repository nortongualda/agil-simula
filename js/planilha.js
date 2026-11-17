/* Ágil Simula: leitura de proforma em Excel/CSV sem IA.
   Procura a linha de cabeçalho (ref., descrição, NCM, quantidade, unitário,
   total e peso) e lê os itens abaixo dela. Devolve o mesmo formato que a
   leitura pelo Claude devolvia, para a tela de conferência continuar igual. */
(function () {
  const semAc = s => String(s == null ? '' : s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
  // ordem importa: a primeira regra que casar define a coluna
  const REGRAS = [
    ['peso', /(^|\b)(n\.?\s?w\.?|net\s*w(eigh)?t|peso\s*liq|peso\s*liquido|net\s*kg|nw\s*\(?kg)/],
    ['pesoBruto', /(^|\b)(g\.?\s?w\.?|gross\s*w(eigh)?t|peso\s*bruto)/],
    ['ncm', /(^|\b)(ncm|hs\s*code|h\.s\.?|hs\s*no|hscode|tariff|^hs$|codigo\s*hs)/],
    ['unit', /(unit\s*price|u\/?\s*price|price\s*\/?\s*(unit|pc|pcs|un|set)|preco\s*unit|valor\s*unit|vlr\s*unit|unit\s*value|unit\s*cost|^price|^unit$|^unitario|fob\s*unit|usd\s*\/\s*(pc|pcs|unit|set))/],
    ['total', /(total\s*(amount|price|value|usd|fob|cif)?|amount|valor\s*total|vlr\s*total|subtotal|^value$|^valor$|line\s*total|ext(ended)?\s*price)/],
    ['qtd', /(^|\b)(q'?ty|qtd|qtde|quant|quantity|quantidade|pcs|^units?$|^sets?$|^nos?\.?$)/],
    ['ref', /(^|\b)(ref|reference|item\s*no|item\s*code|item\s*#|part\s*(no|number|#)|p\/n|^pn$|model|modelo|codigo|^cod|^code|sku|art\.?\s*no|article)/],
    ['desc', /(desc|description|descricao|product|produto|goods|mercadoria|commodity|name\s*of|item\s*name|^name$|^nome$|specification|especificacao|^item$|^items?$)/]
  ];
  const IGNORAR = /(^|\b)(total|subtotal|sub-total|grand total|freight|frete|insurance|seguro|discount|desconto|deposit|balance|say total|amount in words)(\b|$)/;
  function classificar(cel) {
    const t = semAc(cel);
    if (!t || t.length > 60) return null;
    for (const [k, re] of REGRAS) if (re.test(t)) return k;
    return null;
  }
  function numero(v) {
    if (typeof v === 'number') return isFinite(v) ? v : 0;
    let s = String(v == null ? '' : v).replace(/[^\d,.\-]/g, '');
    if (!s || s === '-') return 0;
    if (s.includes(',') && s.includes('.')) {
      const ul = Math.max(s.lastIndexOf(','), s.lastIndexOf('.'));
      s = s.slice(0, ul).replace(/[.,]/g, '') + '.' + s.slice(ul + 1);
    } else if (s.includes(',')) {
      s = /^-?\d{1,3}(,\d{3})+$/.test(s) ? s.replace(/,/g, '') : s.replace(/,/g, '.');
    } else if ((s.match(/\./g) || []).length > 1) s = s.replace(/\./g, '');
    const n = parseFloat(s);
    return isFinite(n) ? n : 0;
  }
  function mapear(labels) {
    const cols = {};
    labels.forEach((c, j) => { const k = classificar(c); if (k && cols[k] == null) cols[k] = j; });
    return cols;
  }
  const PRINC = ['desc', 'qtd', 'unit', 'total', 'ref', 'ncm', 'peso'];
  const pontuar = cols => PRINC.filter(k => cols[k] != null).length;
  const valido = cols => (cols.qtd != null || cols.total != null || cols.unit != null) && (cols.desc != null || cols.ref != null);
  const textual = row => row.filter(v => typeof v === 'string' && v.trim()).length >= 2 && !row.some(v => typeof v === 'number' || (typeof v === 'string' && /^\s*-?[\d.,]+\s*$/.test(v)));
  function acharCabecalho(linhas) {
    let melhor = null;
    const max = Math.min(linhas.length, 60);
    for (let i = 0; i < max; i++) {
      const row = linhas[i] || [];
      let cols = mapear(row), duas = false;
      const prox = linhas[i + 1] || [];
      if (Object.keys(cols).length >= 1 && textual(prox)) {
        const n = Math.max(row.length, prox.length), lab = [];
        for (let j = 0; j < n; j++) lab.push(((row[j] == null ? '' : row[j]) + ' ' + (prox[j] == null ? '' : prox[j])).trim());
        const m = mapear(lab);
        if (valido(m) && pontuar(m) >= pontuar(cols)) { cols = m; duas = true; }
      }
      if (valido(cols) && (!melhor || pontuar(cols) > melhor.pontos)) melhor = { linha: i, cols, pontos: pontuar(cols), duas };
    }
    return melhor;
  }
  function cabecalhoDoc(linhas, ate) {
    const txt = linhas.slice(0, Math.max(ate, 1)).map(r => (r || []).filter(c => c != null && c !== '').join(' ')).join('\n');
    const todo = linhas.map(r => (r || []).join(' ')).join('\n');
    const out = { fatura: '', exportador: '', moeda: '', incoterm: '' };
    const m1 = /(?:invoice|proforma|p\.?\s?i\.?|fatura|contract|order)\s*(?:(?:no\.?|n[ºo°]\.?|number|#)\s*[:：]?|[:：])\s*([A-Z0-9][A-Z0-9\-\/_.]{2,})/i.exec(txt);
    if (m1 && !/^(date|data|no)$/i.test(m1[1])) out.fatura = m1[1];
    const m2 = /\b(USD|EUR|CNY|RMB|GBP|JPY|BRL)\b/.exec(todo) || (/US\$/.test(todo) ? ['', 'USD'] : null);
    if (m2) out.moeda = m2[1] === 'RMB' ? 'CNY' : m2[1];
    const m3 = /\b(EXW|FCA|FAS|FOB|CFR|CIF|CPT|CIP|DAP|DPU|DDP)\b/.exec(todo);
    if (m3) out.incoterm = m3[1];
    const m4 = /(?:seller|exporter|shipper|supplier|manufacturer|vendedor|exportador|fornecedor|beneficiary)\s*[:：]?\s*([^\n]{3,80})/i.exec(txt);
    if (m4) out.exportador = m4[1].replace(/\s{2,}.*/, '').trim();
    return out;
  }
  function lerLinhas(linhas) {
    const cab = acharCabecalho(linhas);
    if (!cab) return null;
    const c = cab.cols;
    const val = (row, k) => (c[k] == null ? '' : row[c[k]]);
    const itens = [];
    let total_fatura = 0, vazias = 0;
    const ini = cab.linha + (cab.duas ? 2 : 1);
    for (let i = ini; i < linhas.length; i++) {
      const row = linhas[i] || [];
      const textoLinha = semAc(row.filter(v => typeof v === 'string').join(' '));
      const qtd = numero(val(row, 'qtd')), unit = numero(val(row, 'unit')), tot = numero(val(row, 'total'));
      const desc = String(val(row, 'desc') == null ? '' : val(row, 'desc')).trim();
      const ref = String(val(row, 'ref') == null ? '' : val(row, 'ref')).trim();
      if (!row.some(v => v !== '' && v != null)) { if (++vazias >= 4 && itens.length) break; continue; }
      vazias = 0;
      if (IGNORAR.test(textoLinha) && !(qtd && (desc || ref) && !/total/.test(semAc(desc + ' ' + ref)))) {
        if (/total/.test(textoLinha) && tot && !total_fatura) total_fatura = tot;
        if (/total/.test(textoLinha) && itens.length) break;
        continue;
      }
      if (!qtd && !tot && !unit) continue;
      if (!desc && !ref) continue;
      const peso = numero(val(row, 'peso'));
      itens.push({ ref, desc, ncm: String(val(row, 'ncm') == null ? '' : val(row, 'ncm')).replace(/[^\d.]/g, ''), qtd, unit, total: tot, peso });
    }
    return { ...cabecalhoDoc(linhas, cab.linha), total_fatura, itens, colunas: c };
  }
  window.lerPlanilhaLocal = async function (file) {
    if (!window.XLSX) throw { code: 'leitor' };
    const wb = XLSX.read(await file.arrayBuffer(), { type: 'array' });
    let melhor = null;
    for (const nome of wb.SheetNames) {
      const linhas = XLSX.utils.sheet_to_json(wb.Sheets[nome], { header: 1, raw: true, defval: '', blankrows: true });
      const r = lerLinhas(linhas);
      if (r && (!melhor || r.itens.length > melhor.itens.length)) melhor = r;
    }
    return melhor || { fatura: '', exportador: '', moeda: '', incoterm: '', total_fatura: 0, itens: [] };
  };
  window.__planilhaInterna = { lerLinhas, numero, classificar };
})();
