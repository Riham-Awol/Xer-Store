/* Xer Store frontend — a small single-page app with hash routing. */
(() => {
  'use strict';

  const $app = document.getElementById('app');
  const state = {
    config: { currency: '$', site_name: 'Xer Store', order_statuses: [] },
    categories: [],
    token: load('xs_token', ''),
    me: null, // { user, store }
  };

  const STATUS_LABELS = {
    pending: 'New',
    confirmed: 'Confirmed',
    ordered: 'Ordered from supplier',
    arrived: 'Arrived in store',
    out_for_delivery: 'Out for delivery',
    delivered: 'Delivered',
    cancelled: 'Cancelled',
  };
  const SOURCE_LABELS = { shein: 'Shein', amazon: 'Amazon', other: 'Other' };

  // ---------- utils ----------
  function load(key, fallback) {
    try {
      const v = localStorage.getItem(key);
      return v == null ? fallback : JSON.parse(v);
    } catch { return fallback; }
  }
  function save(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage unavailable */ }
  }
  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function money(n) {
    const v = Number(n || 0);
    const s = v.toLocaleString(undefined, { minimumFractionDigits: v % 1 ? 2 : 0, maximumFractionDigits: 2 });
    const c = state.config.currency;
    return c.length > 1 ? `${s} ${esc(c)}` : `${esc(c)}${s}`;
  }
  function initials(name) {
    return esc(String(name || '?').trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase());
  }
  function fmtDate(s) {
    const d = new Date(String(s).replace(' ', 'T') + 'Z');
    return isNaN(d) ? '' : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  }
  function toast(msg) {
    const t = document.getElementById('toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => t.classList.remove('show'), 2600);
  }
  function waLink(phone, text) {
    const d = String(phone || '').replace(/\D/g, '');
    return d ? `https://wa.me/${d}${text ? `?text=${encodeURIComponent(text)}` : ''}` : '';
  }
  function socialLink(s) {
    const v = String(s || '').trim();
    if (!v) return '';
    if (/^https?:\/\//i.test(v)) return v;
    if (/^t\.me\//i.test(v) || /^(www\.)?(instagram|tiktok|facebook)\.com\//i.test(v)) return `https://${v}`;
    if (v.startsWith('@')) return `https://instagram.com/${v.slice(1)}`;
    return '';
  }
  function qs(params) {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v) p.set(k, v);
    const s = p.toString();
    return s ? `?${s}` : '';
  }

  async function api(path, { method = 'GET', body } = {}) {
    const headers = {};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (state.token) headers.Authorization = `Bearer ${state.token}`;
    const res = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      if (res.status === 401 && state.token && path !== '/api/auth/login') {
        setSession(null);
      }
      const err = new Error(data.error || 'Something went wrong');
      err.status = res.status;
      throw err;
    }
    return data;
  }

  function setSession(data) {
    if (data) {
      state.token = data.token || state.token;
      state.me = { user: data.user, store: data.store };
    } else {
      state.token = '';
      state.me = null;
    }
    save('xs_token', state.token);
    updateHeader();
  }

  // ---------- cart ----------
  const cart = {
    items: load('xs_cart', []), // [{ product_id, qty, option }]
    save() { save('xs_cart', this.items); updateHeader(); },
    count() { return this.items.reduce((n, i) => n + i.qty, 0); },
    add(product_id, qty, option) {
      const existing = this.items.find((i) => i.product_id === product_id && i.option === option);
      if (existing) existing.qty = Math.min(99, existing.qty + qty);
      else this.items.push({ product_id, qty, option });
      this.save();
    },
    setQty(index, qty) {
      if (qty <= 0) this.items.splice(index, 1);
      else this.items[index].qty = Math.min(99, qty);
      this.save();
    },
    clear() { this.items = []; this.save(); },
  };

  function updateHeader() {
    const n = cart.count();
    document.getElementById('cartCount').textContent = n ? String(n) : '';
    const sell = document.getElementById('sellLink');
    sell.textContent = state.me?.store ? 'My store' : 'Sell';
  }

  // ---------- shared view pieces ----------
  function storeAvatar(store, size = '') {
    const img = store.logo ? `<img src="${esc(store.logo)}" alt="" loading="lazy">` : initials(store.name);
    return `<span class="avatar ${size}" style="--c:${esc(store.color || '#ff4d6d')}">${img}</span>`;
  }

  function productImage(p) {
    if (p.image) return `<img src="${esc(p.image)}" alt="${esc(p.title)}" loading="lazy">`;
    return `<div class="placeholder" style="--c:${esc(p.store?.color || '#ff4d6d')}">${esc(p.category?.icon || '📦')}</div>`;
  }

  function statusBadge(p, soft = false) {
    const label = { available: 'Available now', by_order: 'By order', sold_out: 'Sold out' }[p.status];
    const icon = { available: '●', by_order: '⏱', sold_out: '✕' }[p.status];
    return `<span class="badge ${soft ? 'soft ' : ''}${p.status}">${icon} ${label}</span>`;
  }

  function availText(p) {
    if (p.status === 'available') return p.quantity <= 5 ? `In stock · only ${p.quantity} left` : 'In stock · ready to deliver';
    if (p.status === 'by_order') return `Order now · arrives in ~${p.lead_days} days`;
    return 'Sold out';
  }

  function priceHtml(p) {
    return `<div class="price">${money(p.price)}${p.old_price ? `<s>${money(p.old_price)}</s>` : ''}</div>`;
  }

  function productCard(p, { showStore = true } = {}) {
    return `
      <a class="card" href="#/product/${p.id}">
        ${showStore ? `<div class="card-store">${storeAvatar(p.store, 'sm')}<span>${esc(p.store.name)}</span></div>` : ''}
        <div class="card-img">
          ${productImage(p)}
          ${p.source !== 'other' ? `<span class="src ${p.source}">${SOURCE_LABELS[p.source]}</span>` : ''}
          ${statusBadge(p)}
        </div>
        <div class="card-body">
          <div class="card-title">${esc(p.title)}</div>
          ${priceHtml(p)}
          <div class="avail ${p.status}">${esc(availText(p))}</div>
        </div>
      </a>`;
  }

  function storeCard(s) {
    return `
      <a class="store-card" href="#/store/${esc(s.slug)}" style="--c:${esc(s.color)}">
        ${storeAvatar(s)}
        <div class="meta">
          <div class="name">${esc(s.name)}</div>
          <div class="counts"><b>${s.available_count}</b> available · <b>${s.by_order_count}</b> by order</div>
          ${s.city ? `<div class="counts">📍 ${esc(s.city)}</div>` : ''}
        </div>
      </a>`;
  }

  function availabilityTabs(current, hrefFor) {
    const tabs = [['', 'All'], ['available', '● Available now'], ['by_order', '⏱ By order']];
    return `<div class="tabs" role="tablist">${tabs
      .map(([v, l]) => `<a class="tab ${current === v ? 'active' : ''}" href="${hrefFor(v)}">${l}</a>`)
      .join('')}</div>`;
  }

  // Products grouped into category sections (in category order).
  function groupedByCategory(products, { showStore = true, seeAllHref, limit = 0 } = {}) {
    const groups = new Map();
    for (const p of products) {
      if (!groups.has(p.category.slug)) groups.set(p.category.slug, []);
      groups.get(p.category.slug).push(p);
    }
    const order = state.categories.map((c) => c.slug);
    return [...groups.entries()]
      .sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0]))
      .map(([slug, list]) => {
        const c = list[0].category;
        const shown = limit ? list.slice(0, limit) : list;
        return `
          <section class="section">
            <div class="section-head">
              <h2>${esc(c.icon)} ${esc(c.name)} <span class="muted small">(${list.length})</span></h2>
              ${seeAllHref && list.length > shown.length ? `<a href="${seeAllHref(slug)}">See all →</a>` : ''}
            </div>
            <div class="grid">${shown.map((p) => productCard(p, { showStore })).join('')}</div>
          </section>`;
      })
      .join('');
  }

  function emptyState(icon, title, extra = '') {
    return `<div class="empty"><div class="big">${icon}</div><h3>${title}</h3>${extra}</div>`;
  }

  // ---------- views ----------
  async function viewHome(query) {
    const category = query.get('category') || '';
    const availability = query.get('availability') || '';
    const q = query.get('q') || '';
    const source = query.get('source') || '';
    const sort = query.get('sort') || '';
    document.getElementById('searchInput').value = q;

    const [stores, products] = await Promise.all([
      api('/api/stores'),
      api(`/api/products${qs({ category, availability, q, source, sort })}`),
    ]);

    const href = (over) => `#/${qs({ category, availability, q, source, sort, ...over })}`;
    const filtered = !!(category || q || source || sort);
    const cat = state.categories.find((c) => c.slug === category);

    let body;
    if (!products.length) {
      body = emptyState('🔍', 'No products found', `<p><a class="btn ghost sm" href="#/">Clear filters</a></p>`);
    } else if (filtered) {
      body = `<div class="grid">${products.map((p) => productCard(p)).join('')}</div>`;
    } else {
      body = groupedByCategory(products, { limit: 8, seeAllHref: (slug) => href({ category: slug }) });
    }

    $app.innerHTML = `
      ${!filtered && !availability ? `
        <div class="hero">
          <h1>Shop Shein & Amazon products from local stores</h1>
          <p>Buy what's in stock today, or order what you want — each store brings it for you.</p>
          <div class="legend"><span>● Available now = on hand, delivered fast</span><span>⏱ By order = store orders it for you</span></div>
        </div>` : ''}

      <section class="section">
        <div class="section-head"><h2>🏬 Stores</h2><a href="#/sell">Open your store →</a></div>
        ${stores.length
          ? `<div class="strip">${stores.map(storeCard).join('')}</div>`
          : `<div class="strip"><a class="store-card add" href="#/sell">+ Be the first store</a></div>`}
      </section>

      <div class="chips" aria-label="Categories">
        <a class="chip ${!category ? 'active' : ''}" href="${href({ category: '' })}">All</a>
        ${state.categories.filter((c) => c.product_count > 0 || c.slug === category).map((c) => `
          <a class="chip ${c.slug === category ? 'active' : ''}" href="${href({ category: c.slug })}">${esc(c.icon)} ${esc(c.name)}<span class="n">${c.product_count}</span></a>`).join('')}
      </div>

      <div class="filters">
        ${availabilityTabs(availability, (v) => href({ availability: v }))}
        <span class="spacer"></span>
        <select id="fSource" aria-label="Source">
          <option value="">All sources</option>
          <option value="shein" ${source === 'shein' ? 'selected' : ''}>Shein</option>
          <option value="amazon" ${source === 'amazon' ? 'selected' : ''}>Amazon</option>
          <option value="other" ${source === 'other' ? 'selected' : ''}>Other</option>
        </select>
        <select id="fSort" aria-label="Sort">
          <option value="">Available first</option>
          <option value="newest" ${sort === 'newest' ? 'selected' : ''}>Newest</option>
          <option value="price_asc" ${sort === 'price_asc' ? 'selected' : ''}>Price: low to high</option>
          <option value="price_desc" ${sort === 'price_desc' ? 'selected' : ''}>Price: high to low</option>
        </select>
      </div>

      ${filtered ? `<div class="section-head" style="margin-top:16px"><h2>${cat ? `${esc(cat.icon)} ${esc(cat.name)}` : q ? `Results for “${esc(q)}”` : 'Products'} <span class="muted small">(${products.length})</span></h2><a href="#/">Clear</a></div>` : ''}
      ${body}`;

    document.getElementById('fSource').onchange = (e) => (location.hash = href({ source: e.target.value }));
    document.getElementById('fSort').onchange = (e) => (location.hash = href({ sort: e.target.value }));
  }

  async function viewStore(slug, query) {
    const availability = query.get('availability') || '';
    const category = query.get('category') || '';
    const [store, all] = await Promise.all([
      api(`/api/stores/${encodeURIComponent(slug)}`),
      api(`/api/products${qs({ store: slug })}`),
    ]);
    const products = all.filter((p) =>
      (!availability || p.status === availability) && (!category || p.category.slug === category));
    const cats = [...new Map(all.map((p) => [p.category.slug, p.category])).values()]
      .sort((a, b) => state.categories.findIndex((c) => c.slug === a.slug) - state.categories.findIndex((c) => c.slug === b.slug));
    const href = (over) => `#/store/${esc(slug)}${qs({ availability, category, ...over })}`;
    const wa = waLink(store.phone, `Hello ${store.name}, I saw your store on Xer Store.`);
    const social = socialLink(store.social);

    $app.innerHTML = `
      <div class="store-hero" style="--c:${esc(store.color)}">
        <div class="cover"></div>
        <div class="info">
          ${storeAvatar(store, 'lg')}
          <div class="txt">
            <h1>${esc(store.name)}</h1>
            ${store.description ? `<p>${esc(store.description)}</p>` : ''}
            <div class="stat-row">
              <span class="badge soft available">● ${store.available_count} available now</span>
              <span class="badge soft by_order">⏱ ${store.by_order_count} by order</span>
              ${store.city ? `<span class="badge soft sold_out">📍 ${esc(store.city)}</span>` : ''}
            </div>
          </div>
          <div class="contact">
            ${store.phone ? `<a class="btn ghost sm" href="tel:${esc(store.phone)}">📞 Call</a>` : ''}
            ${wa ? `<a class="btn sm" style="background:#25d366" href="${esc(wa)}" target="_blank" rel="noopener">WhatsApp</a>` : ''}
            ${social ? `<a class="btn ghost sm" href="${esc(social)}" target="_blank" rel="noopener">${esc(store.social)}</a>` : store.social ? `<span class="btn ghost sm">${esc(store.social)}</span>` : ''}
          </div>
        </div>
      </div>

      <div class="chips">
        <a class="chip ${!category ? 'active' : ''}" href="${href({ category: '' })}">All<span class="n">${all.length}</span></a>
        ${cats.map((c) => `<a class="chip ${c.slug === category ? 'active' : ''}" href="${href({ category: c.slug })}">${esc(c.icon)} ${esc(c.name)}<span class="n">${all.filter((p) => p.category.slug === c.slug).length}</span></a>`).join('')}
      </div>
      <div class="filters">${availabilityTabs(availability, (v) => href({ availability: v }))}</div>

      ${products.length
        ? groupedByCategory(products, { showStore: false })
        : emptyState('🛍️', all.length ? 'Nothing matches this filter' : 'This store has no products yet')}`;
  }

  async function viewProduct(id) {
    const p = await api(`/api/products/${encodeURIComponent(id)}`);
    const more = (await api(`/api/products${qs({ store: p.store.slug })}`)).filter((x) => x.id !== p.id).slice(0, 8);
    const store = await api(`/api/stores/${encodeURIComponent(p.store.slug)}`).catch(() => p.store);
    const maxQty = p.status === 'available' ? Math.min(99, p.quantity) : 99;
    let qty = 1;

    const box = {
      available: ['✅', 'Available now', p.quantity <= 5 ? `Only ${p.quantity} left in stock — the store has it on hand and can deliver soon.` : 'The store has this on hand and can deliver soon.'],
      by_order: ['⏱', 'By order', `The store orders this from ${p.source === 'other' ? 'its supplier' : SOURCE_LABELS[p.source]} after you place your order. Expected in about ${p.lead_days} days.`],
      sold_out: ['✕', 'Sold out', 'This item is out of stock right now. Contact the store to ask if they can order it.'],
    }[p.status];
    const wa = waLink(store.phone, `Hello, I'm interested in "${p.title}" (${money(p.price).replace(/&[^;]+;/g, '')}) on Xer Store.`);

    $app.innerHTML = `
      <div class="product">
        <div class="gallery">
          ${productImage(p)}
          ${p.source !== 'other' ? `<span class="src ${p.source}">From ${SOURCE_LABELS[p.source]}</span>` : ''}
        </div>
        <div class="stack">
          <a class="muted small" href="#/?category=${esc(p.category.slug)}">${esc(p.category.icon)} ${esc(p.category.name)}</a>
          <h1>${esc(p.title)}</h1>
          ${priceHtml(p)}
          <div class="avail-box ${p.status}">
            <div class="ic">${box[0]}</div>
            <div><b>${box[1]}</b><div class="small">${esc(box[2])}</div></div>
          </div>
          ${p.options.length ? `
            <label class="field">Choose option
              <select id="opt"><option value="">Select…</option>${p.options.map((o) => `<option>${esc(o)}</option>`).join('')}</select>
            </label>` : ''}
          ${p.status !== 'sold_out' ? `
            <div class="row">
              <div class="qty"><button type="button" id="qMinus" aria-label="Less">−</button><span id="qVal">1</span><button type="button" id="qPlus" aria-label="More">+</button></div>
              <button class="btn ghost" id="addCart">Add to cart</button>
              <button class="btn ${p.status === 'by_order' ? 'warn' : ''}" id="buyNow">${p.status === 'by_order' ? 'Order now' : 'Buy now'}</button>
            </div>` : `${wa ? `<a class="btn" style="background:#25d366" href="${esc(wa)}" target="_blank" rel="noopener">Ask the store on WhatsApp</a>` : ''}`}
          <div id="pErr"></div>
          <a class="store-line" href="#/store/${esc(p.store.slug)}">
            ${storeAvatar(store)}
            <div style="flex:1;min-width:0"><div class="small muted">Sold by</div><b>${esc(store.name)}</b>${store.city ? `<div class="small muted">📍 ${esc(store.city)}</div>` : ''}</div>
            <span class="muted">Visit store →</span>
          </a>
          ${p.description ? `<div><h3>Details</h3><p class="desc">${esc(p.description)}</p></div>` : ''}
        </div>
      </div>
      ${more.length ? `
        <section class="section">
          <div class="section-head"><h2>More from ${esc(store.name)}</h2><a href="#/store/${esc(p.store.slug)}">See store →</a></div>
          <div class="grid">${more.map((x) => productCard(x, { showStore: false })).join('')}</div>
        </section>` : ''}`;

    if (p.status === 'sold_out') return;
    const qVal = document.getElementById('qVal');
    document.getElementById('qMinus').onclick = () => { qty = Math.max(1, qty - 1); qVal.textContent = qty; };
    document.getElementById('qPlus').onclick = () => {
      if (qty >= maxQty) return toast(`Only ${maxQty} available`);
      qty += 1; qVal.textContent = qty;
    };
    const addToCart = () => {
      const option = p.options.length ? document.getElementById('opt').value : '';
      if (p.options.length && !option) {
        document.getElementById('pErr').innerHTML = '<div class="error">Please choose an option first.</div>';
        return false;
      }
      const inCart = cart.items.filter((i) => i.product_id === p.id).reduce((n, i) => n + i.qty, 0);
      if (p.status === 'available' && inCart + qty > p.quantity) {
        document.getElementById('pErr').innerHTML = `<div class="error">Only ${p.quantity} in stock (you already have ${inCart} in your cart).</div>`;
        return false;
      }
      document.getElementById('pErr').innerHTML = '';
      cart.add(p.id, qty, option);
      return true;
    };
    document.getElementById('addCart').onclick = () => { if (addToCart()) toast('Added to cart'); };
    document.getElementById('buyNow').onclick = () => { if (addToCart()) location.hash = '#/cart'; };
  }

  async function viewCart() {
    if (!cart.items.length) {
      $app.innerHTML = emptyState('🛒', 'Your cart is empty', '<p><a class="btn" href="#/">Start shopping</a></p>');
      return;
    }
    const ids = [...new Set(cart.items.map((i) => i.product_id))];
    const products = await api(`/api/products?ids=${ids.join(',')}`);
    const byId = new Map(products.map((p) => [p.id, p]));

    // Drop items that no longer exist.
    const before = cart.items.length;
    cart.items = cart.items.filter((i) => byId.has(i.product_id));
    if (cart.items.length !== before) { cart.save(); toast('Some items are no longer available and were removed'); }
    if (!cart.items.length) return viewCart();

    const groups = new Map();
    cart.items.forEach((item, index) => {
      const p = byId.get(item.product_id);
      if (!groups.has(p.store.id)) groups.set(p.store.id, { store: p.store, lines: [] });
      groups.get(p.store.id).lines.push({ item, index, p });
    });
    const total = cart.items.reduce((s, i) => s + byId.get(i.product_id).price * i.qty, 0);
    const problems = cart.items.some((i) => {
      const p = byId.get(i.product_id);
      return p.status === 'sold_out' || (p.status === 'available' && i.qty > p.quantity);
    });
    const customer = load('xs_customer', {});

    $app.innerHTML = `
      <h1 style="margin-bottom:14px">Your cart</h1>
      <div class="cart">
        <div class="stack">
          ${[...groups.values()].map(({ store, lines }) => `
            <div class="panel cart-group">
              <div class="head">${storeAvatar(store, 'sm')}<a href="#/store/${esc(store.slug)}">${esc(store.name)}</a></div>
              ${lines.map(({ item, index, p }) => `
                <div class="line">
                  <a class="thumb" href="#/product/${p.id}">${productImage(p)}</a>
                  <div>
                    <a href="#/product/${p.id}"><b>${esc(p.title)}</b></a>
                    ${item.option ? `<div class="small muted">Option: ${esc(item.option)}</div>` : ''}
                    <div class="row" style="gap:8px;margin-top:4px">${statusBadge(p, true)}<span class="small muted">${esc(availText(p))}</span></div>
                    ${p.status === 'sold_out' ? '<div class="error small" style="margin-top:6px">Sold out — please remove</div>'
                      : p.status === 'available' && item.qty > p.quantity ? `<div class="error small" style="margin-top:6px">Only ${p.quantity} left — please reduce</div>` : ''}
                    <div class="controls">
                      <div class="qty"><button type="button" data-dec="${index}">−</button><span>${item.qty}</span><button type="button" data-inc="${index}">+</button></div>
                      <b>${money(p.price * item.qty)}</b>
                      <span class="spacer"></span>
                      <button class="link-btn" data-rm="${index}">Remove</button>
                    </div>
                  </div>
                </div>`).join('')}
            </div>`).join('')}
        </div>

        <form class="panel form" id="checkout">
          <h2>Checkout</h2>
          ${[...groups.values()].map(({ store, lines }) => `
            <div class="summary-line"><span>${esc(store.name)}</span><span>${money(lines.reduce((s, l) => s + l.p.price * l.item.qty, 0))}</span></div>`).join('')}
          <div class="summary-line total"><span>Total</span><span>${money(total)}</span></div>
          ${groups.size > 1 ? `<div class="small muted">Your items come from ${groups.size} stores, so you'll get ${groups.size} separate orders. Each store will contact you.</div>` : ''}
          ${cart.items.some((i) => byId.get(i.product_id).status === 'by_order') ? '<div class="avail-box by_order small"><div>⏱</div><div>Some items are <b>by order</b>: the store orders them after you check out, so they arrive later.</div></div>' : ''}
          <label class="field">Full name<input type="text" name="customer_name" required maxlength="80" value="${esc(customer.customer_name || '')}"></label>
          <label class="field">Phone number<input type="tel" name="phone" required maxlength="30" value="${esc(customer.phone || '')}" placeholder="+251 9…"></label>
          <label class="field">Delivery address<textarea name="address" required maxlength="300" rows="2">${esc(customer.address || '')}</textarea></label>
          <label class="field">Note <span class="hint">Optional — e.g. best time to call</span><textarea name="note" maxlength="500" rows="2"></textarea></label>
          <div class="small muted">💵 Pay the store on delivery or as you agree with them.</div>
          <div id="coErr"></div>
          <button class="btn block" ${problems ? 'disabled' : ''}>Place order${groups.size > 1 ? 's' : ''}</button>
        </form>
      </div>`;

    $app.querySelectorAll('[data-inc]').forEach((b) => (b.onclick = () => {
      const i = Number(b.dataset.inc);
      const p = byId.get(cart.items[i].product_id);
      if (p.status === 'available' && cart.items[i].qty >= p.quantity) return toast(`Only ${p.quantity} available`);
      cart.setQty(i, cart.items[i].qty + 1); viewCart();
    }));
    $app.querySelectorAll('[data-dec]').forEach((b) => (b.onclick = () => {
      const i = Number(b.dataset.dec); cart.setQty(i, cart.items[i].qty - 1); viewCart();
    }));
    $app.querySelectorAll('[data-rm]').forEach((b) => (b.onclick = () => { cart.setQty(Number(b.dataset.rm), 0); viewCart(); }));

    document.getElementById('checkout').onsubmit = async (e) => {
      e.preventDefault();
      const f = Object.fromEntries(new FormData(e.target));
      const btn = e.target.querySelector('button.btn');
      btn.disabled = true;
      try {
        save('xs_customer', { customer_name: f.customer_name, phone: f.phone, address: f.address });
        const { orders } = await api('/api/orders', { method: 'POST', body: { ...f, items: cart.items } });
        const mine = load('xs_orders', []);
        save('xs_orders', [...orders.map((o) => ({ code: o.code, store: o.store.name, phone: f.phone, at: Date.now() })), ...mine].slice(0, 30));
        cart.clear();
        viewOrderPlaced(orders, f.phone);
      } catch (err) {
        document.getElementById('coErr').innerHTML = `<div class="error">${esc(err.message)}</div>`;
        btn.disabled = false;
      }
    };
  }

  function viewOrderPlaced(orders, phone) {
    window.scrollTo(0, 0);
    $app.innerHTML = `
      <div class="panel stack" style="max-width:640px;margin:0 auto;text-align:center">
        <div style="font-size:3rem">🎉</div>
        <h1>Order placed!</h1>
        <p class="muted">The store will call you on <b>${esc(phone)}</b> to confirm. Save your order code to track it.</p>
        ${orders.map((o) => {
          const wa = waLink(o.store.phone, `Hello ${o.store.name}, I just placed order ${o.code} on Xer Store.`);
          return `
          <div class="panel" style="text-align:left">
            <div class="row"><span class="code">${esc(o.code)}</span><span class="spacer"></span><b>${money(o.total)}</b></div>
            <div class="small muted" style="margin-top:4px">${esc(o.store.name)}${o.has_by_order ? ' · includes by-order items' : ''}</div>
            <div class="row" style="margin-top:10px">
              <a class="btn ghost sm" href="#/track?code=${esc(o.code)}">Track</a>
              ${wa ? `<a class="btn sm" style="background:#25d366" href="${esc(wa)}" target="_blank" rel="noopener">Message store</a>` : ''}
            </div>
          </div>`;
        }).join('')}
        <a class="btn" href="#/">Continue shopping</a>
      </div>`;
  }

  function orderTimeline(status) {
    if (status === 'cancelled') return '<div class="avail-box sold_out"><div class="ic">✕</div><div><b>This order was cancelled.</b></div></div>';
    const steps = ['pending', 'confirmed', 'ordered', 'arrived', 'out_for_delivery', 'delivered'];
    const idx = steps.indexOf(status);
    return `<div class="timeline">${steps.map((s, i) => `
      <div class="step ${i <= idx ? 'done' : ''} ${i === idx ? 'current' : ''}"><span class="dot"></span>${s === 'pending' ? 'Order received' : STATUS_LABELS[s]}</div>`).join('')}</div>`;
  }

  async function viewTrack(query) {
    const mine = load('xs_orders', []);
    const code = query.get('code') || '';
    const known = mine.find((o) => o.code === code);
    const phone = known?.phone || load('xs_customer', {}).phone || '';

    $app.innerHTML = `
      <div style="max-width:640px;margin:0 auto" class="stack">
        <h1>Track your order</h1>
        <form class="panel form" id="trackForm">
          <div class="two">
            <label class="field">Order code<input type="text" name="code" required value="${esc(code)}" placeholder="XS-XXXXXX"></label>
            <label class="field">Phone used<input type="tel" name="phone" required value="${esc(phone)}"></label>
          </div>
          <button class="btn">Track</button>
        </form>
        <div id="trackResult"></div>
        ${mine.length ? `
          <div class="panel">
            <h3>Orders from this device</h3>
            <div class="stack" style="margin-top:10px">
              ${mine.map((o) => `<a class="row" href="#/track?code=${esc(o.code)}"><span class="code">${esc(o.code)}</span><span class="muted small">${esc(o.store)}</span><span class="spacer"></span><span class="muted">→</span></a>`).join('')}
            </div>
          </div>` : ''}
      </div>`;

    const form = document.getElementById('trackForm');
    const run = async () => {
      const f = Object.fromEntries(new FormData(form));
      const out = document.getElementById('trackResult');
      out.innerHTML = '<div class="loading">Looking up…</div>';
      try {
        const o = await api(`/api/orders/track${qs({ code: f.code.trim(), phone: f.phone.trim() })}`);
        out.innerHTML = `
          <div class="panel order">
            <div class="head"><span class="code">${esc(o.code)}</span><span class="status ${o.status}">${STATUS_LABELS[o.status]}</span><span class="spacer"></span><span class="small muted">${fmtDate(o.created_at)}</span></div>
            <div class="body">
              <a class="row" href="#/store/${esc(o.store.slug)}">${storeAvatar(o.store, 'sm')}<b>${esc(o.store.name)}</b>${o.store.phone ? `<span class="muted small">· ${esc(o.store.phone)}</span>` : ''}</a>
              ${orderTimeline(o.status)}
              <div class="items">${o.items.map((it) => `
                <div class="item"><span>${it.qty} × ${esc(it.title)}${it.option ? ` <span class="muted">(${esc(it.option)})</span>` : ''}
                  <span class="badge soft ${it.availability === 'in_stock' ? 'available' : 'by_order'}">${it.availability === 'in_stock' ? 'In stock' : `By order · ~${it.lead_days}d`}</span></span>
                  <b>${money(it.price * it.qty)}</b></div>`).join('')}</div>
              <div class="summary-line total"><span>Total</span><span>${money(o.total)}</span></div>
            </div>
          </div>`;
      } catch (err) {
        out.innerHTML = `<div class="error">${esc(err.message)}</div>`;
      }
    };
    form.onsubmit = (e) => { e.preventDefault(); run(); };
    if (code && phone) run();
  }

  // ---------- auth views ----------
  function viewAuth(mode) {
    const isLogin = mode === 'login';
    $app.innerHTML = `
      <div class="auth">
        <div class="pitch">
          <h1>Open your store on Xer Store</h1>
          <p class="muted">Bring products from Shein, Amazon and anywhere else — and sell them to customers near you.</p>
          <ul>
            <li>🏬 <span>Your own store page with your name, logo and contact.</span></li>
            <li>🗂️ <span>Products listed by category, next to other stores' products.</span></li>
            <li>● <span><b>Available now</b> — items you have on hand, with stock that counts down.</span></li>
            <li>⏱ <span><b>By order</b> — items you order for the customer, with a delivery estimate.</span></li>
            <li>📦 <span>Receive orders and update their status so customers can track them.</span></li>
          </ul>
        </div>
        <form class="panel form" id="authForm">
          <h2>${isLogin ? 'Log in' : 'Create your seller account'}</h2>
          ${isLogin ? '' : '<label class="field">Your name<input type="text" name="name" required maxlength="80"></label>'}
          <label class="field">Email<input type="email" name="email" required autocomplete="email"></label>
          <label class="field">Password<input type="password" name="password" required minlength="6" autocomplete="${isLogin ? 'current-password' : 'new-password'}"></label>
          <div id="authErr"></div>
          <button class="btn block">${isLogin ? 'Log in' : 'Create account'}</button>
          <div class="small muted" style="text-align:center">
            ${isLogin ? 'New here? <a href="#/register" style="color:var(--accent);font-weight:700">Create an account</a>' : 'Already have an account? <a href="#/login" style="color:var(--accent);font-weight:700">Log in</a>'}
          </div>
        </form>
      </div>`;
    document.getElementById('authForm').onsubmit = async (e) => {
      e.preventDefault();
      const body = Object.fromEntries(new FormData(e.target));
      try {
        const data = await api(isLogin ? '/api/auth/login' : '/api/auth/register', { method: 'POST', body });
        setSession(data);
        location.hash = '#/sell';
      } catch (err) {
        document.getElementById('authErr').innerHTML = `<div class="error">${esc(err.message)}</div>`;
      }
    };
  }

  // ---------- image upload helper ----------
  function resizeImage(file, maxSize = 1200) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error('Could not read the file'));
      reader.onload = () => {
        const img = new Image();
        img.onerror = () => reject(new Error('That file is not an image'));
        img.onload = () => {
          const scale = Math.min(1, maxSize / Math.max(img.width, img.height));
          const canvas = document.createElement('canvas');
          canvas.width = Math.round(img.width * scale);
          canvas.height = Math.round(img.height * scale);
          const ctx = canvas.getContext('2d');
          ctx.fillStyle = '#fff';
          ctx.fillRect(0, 0, canvas.width, canvas.height);
          ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
          resolve(canvas.toDataURL('image/jpeg', 0.85));
        };
        img.src = reader.result;
      };
      reader.readAsDataURL(file);
    });
  }

  function uploadField(name, value, label, hint) {
    return `
      <div class="field" style="display:grid;gap:6px">
        <span style="font-weight:600;font-size:.9rem">${label} <span class="hint" style="font-weight:400;color:var(--muted);font-size:.8rem">${hint}</span></span>
        <div class="upload">
          <div class="preview" id="${name}Preview">${value ? `<img src="${esc(value)}" alt="">` : 'No image'}</div>
          <div class="stack" style="flex:1;min-width:200px">
            <input type="file" accept="image/*" id="${name}File">
            <input type="text" inputmode="url" name="${name}" id="${name}Url" value="${esc(value)}" placeholder="…or paste an image link (https://…)">
          </div>
        </div>
      </div>`;
  }

  function bindUpload(name) {
    const file = document.getElementById(`${name}File`);
    const url = document.getElementById(`${name}Url`);
    const preview = document.getElementById(`${name}Preview`);
    const show = (src) => { preview.innerHTML = src ? `<img src="${esc(src)}" alt="">` : 'No image'; };
    url.oninput = () => show(url.value.trim());
    file.onchange = async () => {
      if (!file.files[0]) return;
      preview.textContent = 'Uploading…';
      try {
        const data = await resizeImage(file.files[0]);
        const { url: uploaded } = await api('/api/uploads', { method: 'POST', body: { data } });
        url.value = uploaded;
        show(uploaded);
      } catch (err) {
        show(url.value.trim());
        toast(err.message);
      }
    };
  }

  // ---------- seller dashboard ----------
  function storeForm(store, isNew) {
    const s = store || { color: '#ff4d6d' };
    return `
      <form class="panel form" id="storeForm">
        <h2>${isNew ? 'Create your store' : 'Store settings'}</h2>
        ${isNew ? '<p class="muted" style="margin:0">This is what customers will see at the top of your products.</p>' : ''}
        <label class="field">Store name<input type="text" name="name" required maxlength="60" value="${esc(s.name || '')}"></label>
        <label class="field">About your store <span class="hint">What you sell, where you bring products from, delivery info…</span>
          <textarea name="description" maxlength="500" rows="3">${esc(s.description || '')}</textarea></label>
        <div class="two">
          <label class="field">Phone / WhatsApp<input type="tel" name="phone" maxlength="30" value="${esc(s.phone || '')}" placeholder="+251 9…"></label>
          <label class="field">City<input type="text" name="city" maxlength="60" value="${esc(s.city || '')}"></label>
        </div>
        <div class="two">
          <label class="field">Instagram / Telegram / TikTok <span class="hint">e.g. @mystore or t.me/mystore</span><input type="text" name="social" maxlength="120" value="${esc(s.social || '')}"></label>
          <label class="field">Store color<input type="color" name="color" value="${esc(s.color || '#ff4d6d')}"></label>
        </div>
        ${uploadField('logo', s.logo || '', 'Logo', 'optional')}
        <div id="storeErr"></div>
        <button class="btn">${isNew ? 'Create store' : 'Save changes'}</button>
      </form>`;
  }

  function bindStoreForm(isNew) {
    bindUpload('logo');
    document.getElementById('storeForm').onsubmit = async (e) => {
      e.preventDefault();
      const body = Object.fromEntries(new FormData(e.target));
      try {
        const store = await api('/api/my/store', { method: isNew ? 'POST' : 'PUT', body });
        state.me.store = store;
        updateHeader();
        toast(isNew ? 'Your store is open! Add your first product.' : 'Saved');
        location.hash = isNew ? '#/sell/new' : '#/sell';
        if (!isNew) route();
      } catch (err) {
        document.getElementById('storeErr').innerHTML = `<div class="error">${esc(err.message)}</div>`;
      }
    };
  }

  function productForm(p) {
    const v = p || { availability: 'in_stock', source: 'shein', quantity: 1, lead_days: 14, options: [], active: true };
    return `
      <form class="panel form" id="productForm">
        <h2>${p ? 'Edit product' : 'Add a product'}</h2>
        <label class="field">Product name<input type="text" name="title" required maxlength="120" value="${esc(v.title || '')}"></label>
        <div class="two">
          <label class="field">Category
            <select name="category_id" required>
              <option value="">Choose…</option>
              ${state.categories.map((c) => `<option value="${c.id}" ${v.category?.id === c.id ? 'selected' : ''}>${esc(c.icon)} ${esc(c.name)}</option>`).join('')}
            </select></label>
          <div class="field" style="display:grid;gap:6px"><span style="font-weight:600;font-size:.9rem">Bought from</span>
            <div class="seg">
              ${['shein', 'amazon', 'other'].map((s) => `<label><input type="radio" name="source" value="${s}" ${v.source === s ? 'checked' : ''}>${SOURCE_LABELS[s]}</label>`).join('')}
            </div>
          </div>
        </div>
        <div class="two">
          <label class="field">Price (${esc(state.config.currency)})<input type="number" name="price" required min="0" step="0.01" value="${v.price ?? ''}"></label>
          <label class="field">Old price <span class="hint">optional — shows as a discount</span><input type="number" name="old_price" min="0" step="0.01" value="${v.old_price ?? ''}"></label>
        </div>

        <div class="field" style="display:grid;gap:6px"><span style="font-weight:600;font-size:.9rem">Availability</span>
          <div class="choice">
            <label class="in_stock"><input type="radio" name="availability" value="in_stock" ${v.availability === 'in_stock' ? 'checked' : ''}>
              <span class="t">● Available now</span><span class="d">I have it on hand and can deliver right away.</span></label>
            <label class="by_order"><input type="radio" name="availability" value="by_order" ${v.availability === 'by_order' ? 'checked' : ''}>
              <span class="t">⏱ By order</span><span class="d">I order it from Shein/Amazon after the customer buys.</span></label>
          </div>
        </div>
        <label class="field" id="qtyField">How many do you have?<input type="number" name="quantity" min="0" step="1" value="${v.availability === 'in_stock' ? v.quantity : 1}"></label>
        <label class="field" id="leadField">Delivery time (days) <span class="hint">About how long until the customer gets it</span><input type="number" name="lead_days" min="1" max="120" step="1" value="${v.availability === 'by_order' ? v.lead_days : 14}"></label>

        <label class="field">Sizes / colors / variants <span class="hint">Separate with commas, e.g. S, M, L — leave empty if none</span>
          <input type="text" name="options" maxlength="300" value="${esc(v.options.join(', '))}"></label>
        <label class="field">Description<textarea name="description" maxlength="2000" rows="4">${esc(v.description || '')}</textarea></label>
        ${uploadField('image', v.image || '', 'Photo', 'a clear photo sells better')}
        <label class="row" style="font-weight:600"><input type="checkbox" name="active" ${v.active ? 'checked' : ''}> Show this product in my store</label>
        <div id="prodErr"></div>
        <div class="row">
          <button class="btn">${p ? 'Save changes' : 'Publish product'}</button>
          <a class="btn ghost" href="#/sell/products">Cancel</a>
        </div>
      </form>`;
  }

  function bindProductForm(p) {
    const form = document.getElementById('productForm');
    const sync = () => {
      const a = form.availability.value;
      document.getElementById('qtyField').classList.toggle('hidden', a !== 'in_stock');
      document.getElementById('leadField').classList.toggle('hidden', a !== 'by_order');
    };
    form.querySelectorAll('input[name=availability]').forEach((r) => (r.onchange = sync));
    sync();
    bindUpload('image');
    form.onsubmit = async (e) => {
      e.preventDefault();
      const body = Object.fromEntries(new FormData(form));
      body.active = form.active.checked;
      try {
        await api(p ? `/api/my/products/${p.id}` : '/api/my/products', { method: p ? 'PUT' : 'POST', body });
        toast(p ? 'Product updated' : 'Product published');
        await refreshCategories();
        location.hash = '#/sell/products';
      } catch (err) {
        document.getElementById('prodErr').innerHTML = `<div class="error">${esc(err.message)}</div>`;
      }
    };
  }

  function dashShell(active, content) {
    const s = state.me.store;
    const links = [['', '📊 Overview'], ['products', '🛍️ Products'], ['new', '➕ Add product'], ['orders', '📦 Orders'], ['settings', '⚙️ Store settings']];
    return `
      <div class="dash">
        <nav class="side">
          <div class="store-mini">${storeAvatar(s, 'sm')}<span>${esc(s.name)}</span></div>
          ${links.map(([k, l]) => `<a href="#/sell${k ? '/' + k : ''}" class="${active === k ? 'active' : ''}">${l}</a>`).join('')}
          <a href="#/store/${esc(s.slug)}">👀 View my store</a>
          <a href="#" id="logout">↩ Log out</a>
        </nav>
        <div class="stack" id="dashContent">${content}</div>
      </div>`;
  }

  function orderCard(o) {
    const wa = waLink(o.phone, `Hello ${o.customer_name}, this is ${state.me.store.name} about your order ${o.code}.`);
    return `
      <div class="panel order">
        <div class="head">
          <span class="code">${esc(o.code)}</span>
          <span class="status ${o.status}">${STATUS_LABELS[o.status]}</span>
          <span class="spacer"></span>
          <span class="small muted">${fmtDate(o.created_at)}</span>
        </div>
        <div class="body">
          <div>
            <b>${esc(o.customer_name)}</b> · <a href="tel:${esc(o.phone)}" style="color:var(--accent)">${esc(o.phone)}</a>
            ${wa ? ` · <a href="${esc(wa)}" target="_blank" rel="noopener" style="color:#128c4b">WhatsApp</a>` : ''}
            <div class="small muted">📍 ${esc(o.address)}</div>
            ${o.note ? `<div class="small">📝 ${esc(o.note)}</div>` : ''}
          </div>
          <div class="items">${o.items.map((it) => `
            <div class="item">
              <span>${it.qty} × ${esc(it.title)}${it.option ? ` <span class="muted">(${esc(it.option)})</span>` : ''}
                <span class="badge soft ${it.availability === 'in_stock' ? 'available' : 'by_order'}">${it.availability === 'in_stock' ? 'From stock' : 'Order from supplier'}</span></span>
              <b>${money(it.price * it.qty)}</b>
            </div>`).join('')}</div>
          <div class="row">
            <b>Total ${money(o.total)}</b>
            <span class="spacer"></span>
            ${o.status === 'cancelled' ? '' : `
              <label class="small muted">Status
                <select data-order="${o.id}" style="width:auto;margin-left:6px">
                  ${state.config.order_statuses.map((s) => `<option value="${s}" ${s === o.status ? 'selected' : ''}>${STATUS_LABELS[s]}</option>`).join('')}
                </select></label>`}
          </div>
        </div>
      </div>`;
  }

  async function viewSell(sub, arg, query) {
    if (!state.token) return viewAuth('register');
    if (!state.me) {
      try { state.me = await api('/api/me'); updateHeader(); } catch { return viewAuth('login'); }
    }
    if (!state.me.store) {
      $app.innerHTML = `<div style="max-width:720px;margin:0 auto">${storeForm(null, true)}</div>`;
      return bindStoreForm(true);
    }

    const render = (active, html) => {
      $app.innerHTML = dashShell(active, html);
      document.getElementById('logout').onclick = async (e) => {
        e.preventDefault();
        await api('/api/auth/logout', { method: 'POST' }).catch(() => {});
        setSession(null);
        location.hash = '#/';
      };
    };

    if (!sub) {
      const [sum, orders] = await Promise.all([api('/api/my/summary'), api('/api/my/orders?status=pending')]);
      render('', `
        <h1>Hi ${esc(state.me.user.name)} 👋</h1>
        <div class="stats">
          <a class="stat" href="#/sell/orders?status=pending"><div class="n" style="color:var(--accent)">${sum.pending_orders}</div><div class="l">New orders</div></a>
          <a class="stat" href="#/sell/orders"><div class="n">${sum.open_orders}</div><div class="l">Open orders</div></a>
          <a class="stat" href="#/sell/products"><div class="n" style="color:var(--ok)">${sum.available}</div><div class="l">Available now</div></a>
          <a class="stat" href="#/sell/products"><div class="n" style="color:var(--warn)">${sum.by_order}</div><div class="l">By order</div></a>
          <a class="stat" href="#/sell/products"><div class="n">${sum.sold_out}</div><div class="l">Sold out</div></a>
          <div class="stat"><div class="n">${money(sum.revenue)}</div><div class="l">Delivered sales</div></div>
        </div>
        ${sum.products === 0 ? emptyState('🛍️', 'Add your first product', '<p><a class="btn" href="#/sell/new">Add product</a></p>') : ''}
        <div class="section-head" style="margin-top:8px"><h2>New orders</h2><a href="#/sell/orders">All orders →</a></div>
        ${orders.length ? orders.map(orderCard).join('') : '<div class="empty">No new orders right now.</div>'}`);
      bindOrderSelects();
      return;
    }

    if (sub === 'products') {
      const products = await api('/api/my/products');
      render('products', `
        <div class="row"><h1>My products</h1><span class="spacer"></span><a class="btn" href="#/sell/new">➕ Add product</a></div>
        ${products.length ? `<div class="plist">${products.map((p) => `
          <div class="prow ${p.active ? '' : 'inactive'}">
            <div class="thumb">${productImage(p)}</div>
            <div style="min-width:0">
              <b>${esc(p.title)}</b>
              <div class="row" style="gap:6px;margin-top:4px">
                ${statusBadge(p, true)}
                <span class="small muted">${esc(p.category.icon)} ${esc(p.category.name)} · ${SOURCE_LABELS[p.source]} · ${money(p.price)}</span>
                ${p.status === 'available' ? `<span class="small muted">· ${p.quantity} in stock</span>` : ''}
                ${p.active ? '' : '<span class="small muted">· hidden</span>'}
              </div>
            </div>
            <div class="actions">
              <a class="btn ghost sm" href="#/sell/edit/${p.id}">Edit</a>
              <button class="btn danger sm" data-del="${p.id}">Delete</button>
            </div>
          </div>`).join('')}</div>` : emptyState('🛍️', 'No products yet', '<p><a class="btn" href="#/sell/new">Add product</a></p>')}`);
      $app.querySelectorAll('[data-del]').forEach((b) => (b.onclick = async () => {
        if (!confirm('Delete this product? This cannot be undone.')) return;
        await api(`/api/my/products/${b.dataset.del}`, { method: 'DELETE' });
        toast('Product deleted');
        await refreshCategories();
        route();
      }));
      return;
    }

    if (sub === 'new' || sub === 'edit') {
      let p = null;
      if (sub === 'edit') {
        p = (await api('/api/my/products')).find((x) => String(x.id) === arg);
        if (!p) return render('products', emptyState('🤷', 'Product not found'));
      }
      render(sub === 'new' ? 'new' : 'products', productForm(p));
      bindProductForm(p);
      return;
    }

    if (sub === 'orders') {
      const status = query.get('status') || '';
      const orders = await api(`/api/my/orders${qs({ status })}`);
      render('orders', `
        <h1>Orders</h1>
        <div class="chips">
          <a class="chip ${!status ? 'active' : ''}" href="#/sell/orders">All</a>
          ${state.config.order_statuses.map((s) => `<a class="chip ${s === status ? 'active' : ''}" href="#/sell/orders?status=${s}">${STATUS_LABELS[s]}</a>`).join('')}
        </div>
        ${orders.length ? orders.map(orderCard).join('') : '<div class="empty">No orders here yet.</div>'}`);
      bindOrderSelects();
      return;
    }

    if (sub === 'settings') {
      render('settings', storeForm(state.me.store, false));
      bindStoreForm(false);
      return;
    }

    location.hash = '#/sell';
  }

  function bindOrderSelects() {
    $app.querySelectorAll('select[data-order]').forEach((sel) => (sel.onchange = async () => {
      const prev = [...sel.options].find((o) => o.defaultSelected)?.value;
      if (sel.value === 'cancelled' && !confirm('Cancel this order? Items from stock will be put back.')) {
        sel.value = prev;
        return;
      }
      try {
        await api(`/api/my/orders/${sel.dataset.order}`, { method: 'PATCH', body: { status: sel.value } });
        toast(`Order marked “${STATUS_LABELS[sel.value]}”`);
        route();
      } catch (err) {
        toast(err.message);
        sel.value = prev;
      }
    }));
  }

  // ---------- router ----------
  async function refreshCategories() {
    state.categories = await api('/api/categories');
  }

  let routeId = 0;
  async function route() {
    const id = ++routeId;
    const hash = location.hash.replace(/^#/, '') || '/';
    const [pathPart, queryPart = ''] = hash.split('?');
    const parts = pathPart.split('/').filter(Boolean).map(decodeURIComponent);
    const query = new URLSearchParams(queryPart);
    if (parts[0] !== undefined && parts[0] !== '') document.getElementById('searchInput').value = '';

    try {
      switch (parts[0]) {
        case undefined: await viewHome(query); break;
        case 'store': await viewStore(parts[1], query); break;
        case 'product': await viewProduct(parts[1]); break;
        case 'cart': await viewCart(); break;
        case 'track': await viewTrack(query); break;
        case 'login': viewAuth('login'); break;
        case 'register': viewAuth('register'); break;
        case 'sell': await viewSell(parts[1], parts[2], query); break;
        default: $app.innerHTML = emptyState('🤷', 'Page not found', '<p><a class="btn" href="#/">Go home</a></p>');
      }
    } catch (err) {
      if (id !== routeId) return;
      if (err.status === 401) return viewAuth('login');
      $app.innerHTML = emptyState('😕', esc(err.message), '<p><a class="btn ghost" href="#/">Go home</a></p>');
    }
    if (id === routeId && !location.hash.includes('?')) window.scrollTo(0, 0);
  }

  document.getElementById('searchForm').onsubmit = (e) => {
    e.preventDefault();
    const q = document.getElementById('searchInput').value.trim();
    location.hash = `#/${qs({ q })}`;
  };
  window.addEventListener('hashchange', route);

  (async function start() {
    updateHeader();
    try {
      const [config] = await Promise.all([api('/api/config'), refreshCategories()]);
      state.config = config;
      if (state.token) {
        state.me = await api('/api/me').catch(() => null);
        updateHeader();
      }
    } catch { /* show whatever we can */ }
    route();
  })();
})();
