/* Ágil Simula: camada de plataforma (Supabase).
   Oferece ao app a mesma interface que ele usava no claude.ai
   (window.claude.use: db, user, assets, downloads), agora apoiada no
   Supabase (banco, arquivos e login).
   Cada estudo pertence a quem o criou: o login da equipe vê só os próprios
   estudos; os usuários master veem todos (regras no banco, tabela simula_docs). */
(function () {
  const CFG = window.AGIL_CONFIG;
  const sb = window.supabase.createClient(CFG.url, CFG.key, {
    auth: { persistSession: true, autoRefreshToken: true, storageKey: 'agil-simula-auth' }
  });
  const TABELA = 'simula_docs';
  window.SB = sb;
  window.AGIL_HOSTED = true;
  let liberar;
  window.agilPronto = new Promise(r => (liberar = r));
  let EU = null; // { email, nome, papel }
  let ACESSO = {}; // email -> { nome, papel }

  /* ---------------- banco: documentos com caminho (colecao/id) ---------------- */
  const pai = p => p.split('/').slice(0, -1).join('/');
  const ultimo = p => p.split('/').pop();
  const ouvintes = new Map(); // colecao -> Set(fn)
  const snapDoc = (path, data) => ({
    id: ultimo(path), exists: data !== undefined && data !== null,
    data: () => (data == null ? undefined : JSON.parse(JSON.stringify(data))),
    metadata: { fromCache: false, hasPendingWrites: false }
  });
  const erro = e => {
    const m = (e && e.message) || String(e);
    return { code: /row-level security|permission|42501/i.test(m) ? 'invalid_argument' : 'unavailable', message: m };
  };
  function avisar(col) { const s = ouvintes.get(col); if (s) s.forEach(fn => fn()); }
  function mesclar(a, b) {
    const o = { ...(a || {}) };
    for (const k of Object.keys(b)) {
      const v = b[k];
      o[k] = v && typeof v === 'object' && !Array.isArray(v) && o[k] && typeof o[k] === 'object' && !Array.isArray(o[k]) ? mesclar(o[k], v) : v;
    }
    return o;
  }
  function docRef(path) {
    const ref = {
      id: ultimo(path), path,
      async get() {
        const { data, error } = await sb.from(TABELA).select('data').eq('path', path).maybeSingle();
        if (error) throw erro(error);
        return snapDoc(path, data ? data.data : undefined);
      },
      async set(d) {
        const { error } = await sb.from(TABELA).upsert({ path, colecao: pai(path), data: d });
        if (error) throw erro(error);
        avisar(pai(path));
      },
      async update(d) {
        const cur = await ref.get();
        if (!cur.exists) throw { code: 'invalid_argument', message: 'documento não existe' };
        await ref.set(mesclar(cur.data(), d));
      },
      async delete() {
        const { error } = await sb.from(TABELA).delete().eq('path', path);
        if (error) throw erro(error);
        avisar(pai(path));
      },
      onSnapshot(next, fail) {
        const col = pai(path);
        const run = () => ref.get().then(next, e => fail && fail(e));
        if (!ouvintes.has(col)) ouvintes.set(col, new Set());
        ouvintes.get(col).add(run); run();
        return () => ouvintes.get(col).delete(run);
      },
      collection: sub => colRef(path + '/' + sub)
    };
    return ref;
  }
  function colRef(path, ord, lim) {
    const q = {
      path,
      doc: id => docRef(path + '/' + (id || (Date.now().toString(36) + Math.random().toString(36).slice(2, 8)))),
      orderBy: (campo, dir) => colRef(path, { campo, dir: dir || 'asc' }, lim),
      limit: n => colRef(path, ord, n),
      where: () => q,
      async add(d) { const r = q.doc(); await r.set(d); return r; },
      async get() {
        let qq = sb.from(TABELA).select('path,data').eq('colecao', path);
        if (ord) qq = qq.order('data->' + ord.campo, { ascending: ord.dir !== 'desc' });
        if (lim) qq = qq.limit(lim);
        const { data, error } = await qq;
        if (error) throw erro(error);
        const docs = (data || []).map(r => snapDoc(r.path, r.data));
        return { docs, size: docs.length, empty: !docs.length, docChanges: () => [], metadata: { fromCache: false, hasPendingWrites: false } };
      },
      onSnapshot(next, fail) {
        const run = () => q.get().then(next, e => fail && fail(e));
        if (!ouvintes.has(path)) ouvintes.set(path, new Set());
        ouvintes.get(path).add(run); run();
        return () => ouvintes.get(path).delete(run);
      }
    };
    return q;
  }
  const DB = { doc: docRef, collection: p => colRef(p) };
  // alterações feitas em outros computadores chegam em tempo real
  const timers = {};
  function tempoReal() {
    sb.channel('simula-tempo-real')
      .on('postgres_changes', { event: '*', schema: 'public', table: TABELA }, ev => {
        const col = (ev.new && ev.new.colecao) || (ev.old && ev.old.colecao);
        if (!col) { ouvintes.forEach((_, c) => avisar(c)); return; }
        clearTimeout(timers[col]); timers[col] = setTimeout(() => avisar(col), 300);
      })
      .subscribe();
  }

  /* ---------------- quem está usando ---------------- */
  const USER = {
    async id() { return EU && EU.email; },
    async me() { return { id: EU && EU.email, name: EU && EU.nome }; },
    async can(nome) { return nome === 'data.write' ? !!EU : null; },
    isOwner() { return !!(EU && EU.papel === 'master'); },
    canEdit() { return !!EU; },
    async profiles(ids) {
      const o = {};
      (ids || []).forEach(i => { const a = ACESSO[String(i).toLowerCase()]; o[i] = { name: a ? (a.nome || i) : '' }; });
      return o;
    }
  };

  /* ---------------- arquivos (Supabase Storage, pasta simula/<email>/) ---------------- */
  const BUCKET = 'anexos';
  const limpa = n => n.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\w.\-]+/g, '_').slice(-80);
  const ASSETS = {
    async upload(blob, opt) {
      const nome = blob.name || 'arquivo';
      const id = 'simula/' + EU.email + '/' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6) + '-' + limpa(nome);
      const tipo = (opt && opt.type) || blob.type || 'application/octet-stream';
      const { error } = await sb.storage.from(BUCKET).upload(id, blob, { contentType: tipo, upsert: false });
      if (error) throw { code: /size|large/i.test(error.message) ? 'too_large' : 'upstream_error', message: error.message };
      return { id, url: '/_blob/' + id, sizeBytes: blob.size, contentType: tipo };
    },
    async delete(id) { const { error } = await sb.storage.from(BUCKET).remove([id]); if (error) throw erro(error); return { deleted: true }; },
    async list() { return { assets: [], usage: {} }; }
  };
  document.addEventListener('click', async e => {
    const a = e.target.closest && e.target.closest('a[href^="/_blob/"]');
    if (!a) return;
    e.preventDefault();
    const id = decodeURIComponent(a.getAttribute('href').slice(7));
    const { data, error } = await sb.storage.from(BUCKET).createSignedUrl(id, 600);
    if (error) { alertar('Este arquivo não está disponível. Ele pode ter sido anexado na versão antiga do Simula, no Claude.'); return; }
    window.open(data.signedUrl, '_blank', 'noopener');
  }, true);
  function alertar(t) {
    document.querySelectorAll('.toast').forEach(x => x.remove());
    const d = document.createElement('div'); d.className = 'toast'; d.textContent = t; document.body.appendChild(d);
    setTimeout(() => d.remove(), 5000);
  }

  /* ---------------- downloads ---------------- */
  const DOWN = {
    async save({ filename, data }) {
      const blob = data instanceof Blob ? data : new Blob([data]);
      const u = URL.createObjectURL(blob);
      const a = document.createElement('a'); a.href = u; a.download = filename; document.body.appendChild(a); a.click();
      setTimeout(() => { URL.revokeObjectURL(u); a.remove(); }, 4000);
      return { status: 'saved' };
    }
  };

  window.claude = {
    use: async n => ({ db: DB, user: USER, assets: ASSETS, downloads: DOWN }[n] || null)
  };

  /* ---------------- login ---------------- */
  const css = `#login{position:fixed;inset:0;z-index:200;display:flex;align-items:center;justify-content:center;background:linear-gradient(135deg,#0C2B44,#0b4f8a);padding:16px}
  #login .bx{background:#fff;border-radius:16px;padding:34px 34px 28px;width:min(400px,100%);box-shadow:0 20px 60px rgba(0,0,0,.3);font-family:Calibri,Carlito,"Segoe UI",Arial,sans-serif;color:#0C2B44}
  #login img{height:40px;display:block;margin-bottom:18px}#login h1{font-size:22px;margin:0 0 4px}#login p{color:#6a7886;font-size:14px;margin:0 0 18px}
  #login label{display:block;font-size:12px;font-weight:700;color:#6a7886;text-transform:uppercase;letter-spacing:.05em;margin:12px 0 5px}
  #login input{width:100%;box-sizing:border-box;border:1px solid #dde3ea;border-radius:8px;padding:11px 12px;font-size:15px;font-family:inherit;color:#0C2B44;background:#fff}
  #login button{width:100%;margin-top:18px;border:0;border-radius:8px;padding:12px;background:#F28C28;color:#fff;font-weight:700;font-size:15px;cursor:pointer;font-family:inherit}
  #login .msg{margin-top:12px;font-size:13px;color:#c0392b;min-height:16px}`;
  function telaLogin(modo, aviso) {
    let el = document.getElementById('login');
    if (!el) { const st = document.createElement('style'); st.textContent = css; document.head.appendChild(st); el = document.createElement('div'); el.id = 'login'; document.body.appendChild(el); }
    if (modo === 'senha') {
      el.innerHTML = `<form class="bx"><img src="assets/logo-colorida.png" alt="Ágil Aduaneira"><h1>Crie sua senha</h1><p>Primeiro acesso: escolha uma senha com pelo menos 8 caracteres.</p>
      <label for="ns1">Nova senha</label><input type="password" id="ns1" minlength="8" required autocomplete="new-password"><label for="ns2">Repita a senha</label><input type="password" id="ns2" minlength="8" required autocomplete="new-password">
      <button type="submit">Salvar senha e entrar</button><div class="msg" id="lmsg"></div></form>`;
      el.querySelector('form').onsubmit = async e => {
        e.preventDefault(); const a = document.getElementById('ns1').value, b = document.getElementById('ns2').value, m = document.getElementById('lmsg');
        if (a.length < 8) { m.textContent = 'A senha precisa ter pelo menos 8 caracteres.'; return; }
        if (a !== b) { m.textContent = 'As senhas não conferem.'; return; }
        const { error } = await sb.auth.updateUser({ password: a, data: { trocar_senha: false } });
        if (error) { m.textContent = 'Não foi possível salvar: ' + error.message; return; }
        const { data } = await sb.auth.getSession(); entrar(data.session, true);
      };
      return;
    }
    el.innerHTML = `<form class="bx"><img src="assets/logo-colorida.png" alt="Ágil Aduaneira"><h1>Ágil Simula</h1><p>Estudos de viabilidade de importação</p>
    <label for="lem">E-mail</label><input type="email" id="lem" required autocomplete="username" placeholder="nome@agiladuaneira.com.br">
    <label for="lpw">Senha</label><input type="password" id="lpw" required autocomplete="current-password">
    <button type="submit">Entrar</button><div class="msg" id="lmsg"></div></form>`;
    if (aviso) document.getElementById('lmsg').textContent = aviso;
    el.querySelector('form').onsubmit = async e => {
      e.preventDefault(); const m = document.getElementById('lmsg'); m.textContent = 'Entrando...';
      const { data, error } = await sb.auth.signInWithPassword({ email: document.getElementById('lem').value.trim(), password: document.getElementById('lpw').value });
      if (error) { m.textContent = /invalid/i.test(error.message) ? 'E-mail ou senha incorretos.' : error.message; return; }
      entrar(data.session);
    };
  }
  let entrou = false;
  async function entrar(session, aposTroca) {
    if (!session) return telaLogin();
    const email = String(session.user.email || '').toLowerCase();
    const { data: lista, error } = await sb.from('simula_acesso').select('email,nome,papel');
    const meu = !error && (lista || []).find(x => String(x.email).toLowerCase() === email);
    if (!meu) { await sb.auth.signOut(); return telaLogin(null, 'Este e-mail não tem acesso ao Ágil Simula. Fale com o administrador.'); }
    if (!aposTroca && session.user.user_metadata && session.user.user_metadata.trocar_senha) return telaLogin('senha');
    ACESSO = {}; (lista || []).forEach(x => { ACESSO[String(x.email).toLowerCase()] = { nome: x.nome, papel: x.papel }; });
    EU = { email, nome: meu.nome || email, papel: meu.papel };
    window.AGIL_USUARIO = EU;
    const el = document.getElementById('login'); if (el) el.remove();
    const st = document.getElementById('usr');
    if (st) {
      st.innerHTML = `<b></b><span></span><a href="#" id="sair">Sair</a>`;
      st.querySelector('b').textContent = EU.nome;
      st.querySelector('span').textContent = EU.papel === 'master' ? 'Acesso master: todos os estudos' : 'Vê os estudos deste login';
      document.getElementById('sair').onclick = async ev => { ev.preventDefault(); await sb.auth.signOut(); location.reload(); };
    }
    if (!entrou) { entrou = true; tempoReal(); liberar(); }
  }
  sb.auth.getSession().then(({ data }) => data.session ? entrar(data.session) : telaLogin());
})();
