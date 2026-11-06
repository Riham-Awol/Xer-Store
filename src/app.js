// Xer Store — the marketplace API. Runs on Node.js (server.js) and Cloudflare Workers (worker.js).
import express from 'express';
import path from 'node:path';
import { Buffer } from 'node:buffer';
import { hashPassword, verifyPassword, randomToken } from './passwords.js';

export const ORDER_STATUSES = ['pending', 'confirmed', 'ordered', 'arrived', 'out_for_delivery', 'delivered', 'cancelled'];
const MAX_IMAGE_BASE64 = 1_800_000; // ~1.3 MB image; a database row can hold up to 2 MB

/**
 * @param {object} opts
 * @param {object} opts.db         adapter from db-node.js or db-d1.js
 * @param {string} [opts.currency]
 * @param {string} [opts.siteName]
 * @param {string} [opts.publicDir] serve the frontend from here (Node only; Workers use static assets)
 * @param {string} [opts.legacyUploadsDir] serve photos uploaded by the first version of the app
 */
export function createApp({ db, currency = '$', siteName = 'Xer Store', publicDir, legacyUploadsDir }) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  app.use(express.json({ limit: '3mb' }));

  app.get('/healthz', (_req, res) => res.json({ ok: true }));
  if (legacyUploadsDir) app.use('/uploads', express.static(legacyUploadsDir, { maxAge: '30d' }));
  if (publicDir) app.use(express.static(publicDir));

  // ---------- helpers ----------
  class HttpError extends Error {
    constructor(status, message) {
      super(message);
      this.status = status;
    }
  }
  const fail = (status, message) => {
    throw new HttpError(status, message);
  };

  function str(value, { max = 200, required = false, label = 'Field' } = {}) {
    const s = typeof value === 'string' ? value.trim() : value == null ? '' : String(value).trim();
    if (required && !s) fail(400, `${label} is required`);
    if (s.length > max) fail(400, `${label} is too long (max ${max} characters)`);
    return s;
  }

  function num(value, { min = 0, max = 1e9, integer = false, label = 'Number', required = true } = {}) {
    if ((value === '' || value == null) && !required) return null;
    const n = Number(value);
    if (!Number.isFinite(n)) fail(400, `${label} must be a number`);
    if (integer && !Number.isInteger(n)) fail(400, `${label} must be a whole number`);
    if (n < min || n > max) fail(400, `${label} must be between ${min} and ${max}`);
    return n;
  }

  const digits = (s) => String(s || '').replace(/\D/g, '');

  function imageUrl(value) {
    const s = str(value, { max: 500, label: 'Image' });
    if (!s) return '';
    if (/^\/(images|uploads)\/[A-Za-z0-9._-]+$/.test(s) || /^https?:\/\//i.test(s)) return s;
    fail(400, 'Image must be an uploaded file or an http(s) link');
  }

  const splitOptions = (s) => (s ? s.split(',').map((o) => o.trim()).filter(Boolean) : []);

  function productStatus(p) {
    if (p.availability === 'by_order') return 'by_order';
    return p.quantity > 0 ? 'available' : 'sold_out';
  }

  function shapeProduct(p) {
    return {
      id: p.id,
      title: p.title,
      description: p.description,
      price: p.price,
      old_price: p.old_price,
      image: p.image,
      source: p.source,
      availability: p.availability,
      status: productStatus(p),
      quantity: p.quantity,
      lead_days: p.lead_days,
      options: splitOptions(p.options),
      active: !!p.active,
      created_at: p.created_at,
      category: { id: p.category_id, slug: p.category_slug, name: p.category_name, icon: p.category_icon },
      store: {
        id: p.store_id,
        slug: p.store_slug,
        name: p.store_name,
        logo: p.store_logo,
        color: p.store_color,
        city: p.store_city,
      },
    };
  }

  const PRODUCT_SELECT = `
    SELECT p.*, c.slug AS category_slug, c.name AS category_name, c.icon AS category_icon,
           s.slug AS store_slug, s.name AS store_name, s.logo AS store_logo,
           s.color AS store_color, s.city AS store_city
    FROM products p
    JOIN categories c ON c.id = p.category_id
    JOIN stores s ON s.id = p.store_id`;

  const STORE_SELECT = `
    SELECT s.*,
      (SELECT COUNT(*) FROM products p WHERE p.store_id = s.id AND p.active = 1) AS product_count,
      (SELECT COUNT(*) FROM products p WHERE p.store_id = s.id AND p.active = 1
         AND p.availability = 'in_stock' AND p.quantity > 0) AS available_count,
      (SELECT COUNT(*) FROM products p WHERE p.store_id = s.id AND p.active = 1
         AND p.availability = 'by_order') AS by_order_count
    FROM stores s`;

  function publicStore(s) {
    return {
      id: s.id,
      slug: s.slug,
      name: s.name,
      description: s.description,
      logo: s.logo,
      phone: s.phone,
      city: s.city,
      social: s.social,
      color: s.color,
      created_at: s.created_at,
      product_count: s.product_count ?? undefined,
      available_count: s.available_count ?? undefined,
      by_order_count: s.by_order_count ?? undefined,
    };
  }

  async function loadOrder(order) {
    const items = await db.all('SELECT * FROM order_items WHERE order_id = ? ORDER BY id', order.id);
    return { ...order, items };
  }

  async function newOrderCode() {
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    for (;;) {
      const code = 'XS-' + Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) => alphabet[b % alphabet.length]).join('');
      if (!(await db.get('SELECT 1 AS x FROM orders WHERE code = ?', code))) return code;
    }
  }

  function slugify(text) {
    return String(text)
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'store';
  }

  async function uniqueStoreSlug(name, ignoreStoreId = 0) {
    const base = slugify(name);
    let slug = base;
    for (let n = 2; await db.get('SELECT id FROM stores WHERE slug = ? AND id != ?', slug, ignoreStoreId); n++) {
      slug = `${base}-${n}`;
    }
    return slug;
  }

  // ---------- auth ----------
  async function auth(req, _res, next) {
    const header = req.get('authorization') || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    const row = token
      ? await db.get(
          'SELECT u.id, u.name, u.email FROM sessions se JOIN users u ON u.id = se.user_id WHERE se.token = ?',
          token
        )
      : null;
    if (!row) throw new HttpError(401, 'Please log in');
    req.user = row;
    req.token = token;
    req.store = await db.get('SELECT * FROM stores WHERE owner_id = ?', row.id);
    next();
  }

  function requireStore(req, _res, next) {
    if (!req.store) throw new HttpError(400, 'Create your store first');
    next();
  }

  async function createSession(userId) {
    const token = randomToken();
    await db.run('INSERT INTO sessions (token, user_id) VALUES (?, ?)', token, userId);
    return token;
  }

  // ---------- public API ----------
  app.get('/api/config', (_req, res) => {
    res.json({ currency, site_name: siteName, order_statuses: ORDER_STATUSES });
  });

  app.get('/api/categories', async (_req, res) => {
    res.json(await db.all(`
      SELECT c.*, (
        SELECT COUNT(*) FROM products p JOIN stores s ON s.id = p.store_id
        WHERE p.category_id = c.id AND p.active = 1 AND s.active = 1
      ) AS product_count
      FROM categories c ORDER BY c.sort`));
  });

  app.get('/api/stores', async (_req, res) => {
    const rows = await db.all(`${STORE_SELECT} WHERE s.active = 1 ORDER BY product_count DESC, s.created_at`);
    res.json(rows.map(publicStore));
  });

  app.get('/api/stores/:slug', async (req, res) => {
    const store = await db.get(`${STORE_SELECT} WHERE s.slug = ? AND s.active = 1`, req.params.slug);
    if (!store) fail(404, 'Store not found');
    res.json(publicStore(store));
  });

  app.get('/api/products', async (req, res) => {
    const where = ['p.active = 1', 's.active = 1'];
    const params = [];
    const { category, store, availability, q, source, ids, sort } = req.query;

    if (category) { where.push('c.slug = ?'); params.push(String(category)); }
    if (store) { where.push('s.slug = ?'); params.push(String(store)); }
    if (source && ['shein', 'amazon', 'other'].includes(source)) { where.push('p.source = ?'); params.push(source); }
    if (availability === 'available') where.push("p.availability = 'in_stock' AND p.quantity > 0");
    else if (availability === 'by_order') where.push("p.availability = 'by_order'");
    if (q) {
      where.push('(p.title LIKE ? OR p.description LIKE ? OR s.name LIKE ?)');
      const like = `%${String(q).slice(0, 100)}%`;
      params.push(like, like, like);
    }
    if (ids) {
      const list = String(ids).split(',').map(Number).filter(Number.isInteger).slice(0, 100);
      if (!list.length) return res.json([]);
      where.push(`p.id IN (${list.map(() => '?').join(',')})`);
      params.push(...list);
    }
    const order = {
      price_asc: 'p.price ASC',
      price_desc: 'p.price DESC',
      newest: 'p.created_at DESC, p.id DESC',
    }[sort] || "(p.availability = 'in_stock' AND p.quantity > 0) DESC, p.created_at DESC, p.id DESC";

    const rows = await db.all(`${PRODUCT_SELECT} WHERE ${where.join(' AND ')} ORDER BY ${order} LIMIT 500`, ...params);
    res.json(rows.map(shapeProduct));
  });

  app.get('/api/products/:id', async (req, res) => {
    const row = await db.get(`${PRODUCT_SELECT} WHERE p.id = ? AND p.active = 1 AND s.active = 1`, Number(req.params.id) || 0);
    if (!row) fail(404, 'Product not found');
    res.json(shapeProduct(row));
  });

  // Place an order. Items from different stores become one order per store.
  app.post('/api/orders', async (req, res) => {
    const b = req.body || {};
    const customer_name = str(b.customer_name, { required: true, max: 80, label: 'Name' });
    const phone = str(b.phone, { required: true, max: 30, label: 'Phone' });
    if (digits(phone).length < 7) fail(400, 'Please enter a valid phone number');
    const address = str(b.address, { required: true, max: 300, label: 'Address' });
    const note = str(b.note, { max: 500, label: 'Note' });
    if (!Array.isArray(b.items) || !b.items.length) fail(400, 'Your cart is empty');
    if (b.items.length > 50) fail(400, 'Too many items in one order');

    // Merge duplicates (same product + option) and validate.
    const merged = new Map();
    for (const it of b.items) {
      const productId = num(it?.product_id, { integer: true, min: 1, label: 'Product' });
      const qty = num(it?.qty, { integer: true, min: 1, max: 99, label: 'Quantity' });
      const option = str(it?.option, { max: 60, label: 'Option' });
      const key = `${productId}::${option}`;
      merged.set(key, { productId, option, qty: (merged.get(key)?.qty || 0) + qty });
    }

    const byStore = new Map();
    const needed = new Map(); // productId -> total qty across options
    for (const { productId, option, qty } of merged.values()) {
      const p = await db.get(`${PRODUCT_SELECT} WHERE p.id = ? AND p.active = 1 AND s.active = 1`, productId);
      if (!p) fail(400, 'A product in your cart is no longer available');
      const opts = splitOptions(p.options);
      if (opts.length && !opts.includes(option)) fail(400, `Please choose an option for "${p.title}"`);
      if (!opts.length && option) fail(400, `"${p.title}" has no options`);
      if (p.availability === 'in_stock') {
        const total = (needed.get(p.id) || 0) + qty;
        needed.set(p.id, total);
        if (total > p.quantity) {
          fail(409, p.quantity > 0 ? `Only ${p.quantity} left of "${p.title}"` : `"${p.title}" is sold out`);
        }
      }
      if (!byStore.has(p.store_id)) byStore.set(p.store_id, []);
      byStore.get(p.store_id).push({ p, qty, option });
    }

    // Build everything as one atomic batch. The stock trigger aborts it if
    // someone else bought the last items in the meantime.
    const statements = [];
    const out = [];
    for (const [storeId, lines] of byStore) {
      const total = Math.round(lines.reduce((sum, l) => sum + l.p.price * l.qty, 0) * 100) / 100;
      const code = await newOrderCode();
      statements.push([
        `INSERT INTO orders (code, store_id, customer_name, phone, address, note, total) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        code, storeId, customer_name, phone, address, note, total,
      ]);
      for (const { p, qty, option } of lines) {
        statements.push([
          `INSERT INTO order_items (order_id, product_id, title, image, price, qty, option, availability, lead_days)
           VALUES ((SELECT id FROM orders WHERE code = ?), ?, ?, ?, ?, ?, ?, ?, ?)`,
          code, p.id, p.title, p.image, p.price, qty, option, p.availability,
          p.availability === 'by_order' ? p.lead_days : 0,
        ]);
        if (p.availability === 'in_stock') {
          statements.push(['UPDATE products SET quantity = quantity - ? WHERE id = ?', qty, p.id]);
        }
      }
      const s = await db.get('SELECT name, slug, phone FROM stores WHERE id = ?', storeId);
      out.push({
        code,
        total,
        status: 'pending',
        store: { name: s.name, slug: s.slug, phone: s.phone },
        has_by_order: lines.some((l) => l.p.availability === 'by_order'),
      });
    }

    try {
      await db.batch(statements);
    } catch (err) {
      if (/OUT_OF_STOCK/.test(String(err?.message))) fail(409, 'Sorry, some items just sold out. Please check your cart.');
      throw err;
    }
    res.status(201).json({ orders: out });
  });

  // Customers track an order with its code + the phone number they used.
  app.get('/api/orders/track', async (req, res) => {
    const code = str(req.query.code, { required: true, max: 20, label: 'Order code' }).toUpperCase();
    const phone = str(req.query.phone, { required: true, max: 30, label: 'Phone' });
    const order = await db.get('SELECT * FROM orders WHERE code = ?', code);
    if (!order || digits(order.phone).slice(-9) !== digits(phone).slice(-9)) {
      fail(404, 'No order found with that code and phone number');
    }
    const store = await db.get('SELECT * FROM stores WHERE id = ?', order.store_id);
    res.json({ ...(await loadOrder(order)), store: publicStore(store) });
  });

  // Uploaded photos are stored in the database.
  app.get('/images/:id', async (req, res) => {
    const img = await db.get('SELECT mime, data FROM images WHERE id = ?', req.params.id);
    if (!img) return res.status(404).end();
    res.set('Content-Type', img.mime);
    res.set('Cache-Control', 'public, max-age=31536000, immutable');
    res.send(Buffer.from(img.data, 'base64'));
  });

  // ---------- accounts ----------
  app.post('/api/auth/register', async (req, res) => {
    const b = req.body || {};
    const name = str(b.name, { required: true, max: 80, label: 'Name' });
    const email = str(b.email, { required: true, max: 120, label: 'Email' }).toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail(400, 'Please enter a valid email');
    const password = typeof b.password === 'string' ? b.password : '';
    if (password.length < 6) fail(400, 'Password must be at least 6 characters');
    if (password.length > 200) fail(400, 'Password is too long');
    if (await db.get('SELECT 1 AS x FROM users WHERE email = ?', email)) fail(409, 'An account with this email already exists');
    const { lastId: id } = await db.run(
      'INSERT INTO users (name, email, password_hash) VALUES (?, ?, ?)', name, email, await hashPassword(password)
    );
    res.status(201).json({ token: await createSession(id), user: { id, name, email }, store: null });
  });

  app.post('/api/auth/login', async (req, res) => {
    const b = req.body || {};
    const email = str(b.email, { max: 120 }).toLowerCase();
    const password = String(b.password || '').slice(0, 200);
    const user = await db.get('SELECT * FROM users WHERE email = ?', email);
    const check = user ? await verifyPassword(password, user.password_hash) : { ok: false };
    if (!check.ok) fail(401, 'Wrong email or password');
    if (check.rehash) {
      await db.run('UPDATE users SET password_hash = ? WHERE id = ?', await hashPassword(password), user.id);
    }
    const store = await db.get('SELECT * FROM stores WHERE owner_id = ?', user.id);
    res.json({
      token: await createSession(user.id),
      user: { id: user.id, name: user.name, email: user.email },
      store: store ? publicStore(store) : null,
    });
  });

  app.post('/api/auth/logout', auth, async (req, res) => {
    await db.run('DELETE FROM sessions WHERE token = ?', req.token);
    res.json({ ok: true });
  });

  app.get('/api/me', auth, (req, res) => {
    res.json({ user: req.user, store: req.store ? publicStore(req.store) : null });
  });

  // ---------- seller dashboard ----------
  function readStoreBody(b) {
    const color = str(b.color, { max: 9, label: 'Color' }) || '#ff4d6d';
    if (!/^#[0-9a-f]{6}$/i.test(color)) fail(400, 'Color must look like #ff4d6d');
    return {
      name: str(b.name, { required: true, max: 60, label: 'Store name' }),
      description: str(b.description, { max: 500, label: 'Description' }),
      logo: imageUrl(b.logo),
      phone: str(b.phone, { max: 30, label: 'Phone' }),
      city: str(b.city, { max: 60, label: 'City' }),
      social: str(b.social, { max: 120, label: 'Social link' }),
      color,
    };
  }

  app.post('/api/my/store', auth, async (req, res) => {
    if (req.store) fail(409, 'You already have a store');
    const s = readStoreBody(req.body || {});
    const { lastId } = await db.run(
      `INSERT INTO stores (owner_id, name, slug, description, logo, phone, city, social, color)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      req.user.id, s.name, await uniqueStoreSlug(s.name), s.description, s.logo, s.phone, s.city, s.social, s.color
    );
    res.status(201).json(publicStore(await db.get('SELECT * FROM stores WHERE id = ?', lastId)));
  });

  app.put('/api/my/store', auth, requireStore, async (req, res) => {
    const s = readStoreBody(req.body || {});
    const slug = s.name === req.store.name ? req.store.slug : await uniqueStoreSlug(s.name, req.store.id);
    await db.run(
      `UPDATE stores SET name = ?, slug = ?, description = ?, logo = ?, phone = ?, city = ?, social = ?, color = ?
       WHERE id = ?`,
      s.name, slug, s.description, s.logo, s.phone, s.city, s.social, s.color, req.store.id
    );
    res.json(publicStore(await db.get('SELECT * FROM stores WHERE id = ?', req.store.id)));
  });

  app.get('/api/my/summary', auth, requireStore, async (req, res) => {
    const r = await db.get(`
      SELECT
        (SELECT COUNT(*) FROM products WHERE store_id = ?1) AS products,
        (SELECT COUNT(*) FROM products WHERE store_id = ?1 AND active = 1 AND availability = 'in_stock' AND quantity > 0) AS available,
        (SELECT COUNT(*) FROM products WHERE store_id = ?1 AND active = 1 AND availability = 'by_order') AS by_order,
        (SELECT COUNT(*) FROM products WHERE store_id = ?1 AND availability = 'in_stock' AND quantity <= 0) AS sold_out,
        (SELECT COUNT(*) FROM orders WHERE store_id = ?1 AND status = 'pending') AS pending_orders,
        (SELECT COUNT(*) FROM orders WHERE store_id = ?1 AND status NOT IN ('delivered','cancelled')) AS open_orders,
        (SELECT COALESCE(SUM(total), 0) FROM orders WHERE store_id = ?1 AND status = 'delivered') AS revenue`,
      req.store.id);
    res.json(r);
  });

  app.get('/api/my/products', auth, requireStore, async (req, res) => {
    const rows = await db.all(`${PRODUCT_SELECT} WHERE p.store_id = ? ORDER BY p.created_at DESC, p.id DESC`, req.store.id);
    res.json(rows.map(shapeProduct));
  });

  async function readProductBody(b) {
    const category = await db.get(
      'SELECT id FROM categories WHERE id = ? OR slug = ?',
      Number(b.category_id) || 0, String(b.category_id || b.category || '')
    );
    if (!category) fail(400, 'Please choose a category');
    const availability = b.availability === 'by_order' ? 'by_order' : b.availability === 'in_stock' ? 'in_stock' : null;
    if (!availability) fail(400, 'Choose "Available now" or "By order"');
    const source = ['shein', 'amazon', 'other'].includes(b.source) ? b.source : 'other';
    const price = num(b.price, { min: 0, max: 1e7, label: 'Price' });
    const old_price = num(b.old_price, { min: 0, max: 1e7, label: 'Old price', required: false });
    const options = splitOptions(str(b.options, { max: 300, label: 'Options' })).slice(0, 30).join(', ');
    return {
      category_id: category.id,
      title: str(b.title, { required: true, max: 120, label: 'Title' }),
      description: str(b.description, { max: 2000, label: 'Description' }),
      price,
      old_price: old_price && old_price > price ? old_price : null,
      image: imageUrl(b.image),
      source,
      availability,
      quantity: availability === 'in_stock' ? num(b.quantity ?? 0, { integer: true, min: 0, max: 100000, label: 'Quantity' }) : 0,
      lead_days: availability === 'by_order' ? num(b.lead_days ?? 14, { integer: true, min: 1, max: 120, label: 'Delivery days' }) : 0,
      options,
      active: b.active === false ? 0 : 1,
    };
  }

  app.post('/api/my/products', auth, requireStore, async (req, res) => {
    const p = await readProductBody(req.body || {});
    const { lastId } = await db.run(
      `INSERT INTO products (store_id, category_id, title, description, price, old_price, image, source,
         availability, quantity, lead_days, options, active)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      req.store.id, p.category_id, p.title, p.description, p.price, p.old_price, p.image, p.source,
      p.availability, p.quantity, p.lead_days, p.options, p.active
    );
    res.status(201).json(shapeProduct(await db.get(`${PRODUCT_SELECT} WHERE p.id = ?`, lastId)));
  });

  async function ownProduct(req) {
    const row = await db.get('SELECT * FROM products WHERE id = ? AND store_id = ?', Number(req.params.id) || 0, req.store.id);
    if (!row) fail(404, 'Product not found');
    return row;
  }

  app.put('/api/my/products/:id', auth, requireStore, async (req, res) => {
    const existing = await ownProduct(req);
    const p = await readProductBody(req.body || {});
    await db.run(
      `UPDATE products SET category_id = ?, title = ?, description = ?, price = ?, old_price = ?, image = ?,
         source = ?, availability = ?, quantity = ?, lead_days = ?, options = ?, active = ? WHERE id = ?`,
      p.category_id, p.title, p.description, p.price, p.old_price, p.image, p.source, p.availability,
      p.quantity, p.lead_days, p.options, p.active, existing.id
    );
    res.json(shapeProduct(await db.get(`${PRODUCT_SELECT} WHERE p.id = ?`, existing.id)));
  });

  app.delete('/api/my/products/:id', auth, requireStore, async (req, res) => {
    const existing = await ownProduct(req);
    await db.run('DELETE FROM products WHERE id = ?', existing.id);
    res.json({ ok: true });
  });

  app.get('/api/my/orders', auth, requireStore, async (req, res) => {
    const status = req.query.status;
    const rows = ORDER_STATUSES.includes(status)
      ? await db.all('SELECT * FROM orders WHERE store_id = ? AND status = ? ORDER BY id DESC LIMIT 300', req.store.id, status)
      : await db.all('SELECT * FROM orders WHERE store_id = ? ORDER BY id DESC LIMIT 300', req.store.id);
    if (!rows.length) return res.json([]);
    const items = await db.all(
      `SELECT * FROM order_items WHERE order_id IN (${rows.map(() => '?').join(',')}) ORDER BY id`,
      ...rows.map((o) => o.id)
    );
    res.json(rows.map((o) => ({ ...o, items: items.filter((it) => it.order_id === o.id) })));
  });

  app.patch('/api/my/orders/:id', auth, requireStore, async (req, res) => {
    const order = await db.get('SELECT * FROM orders WHERE id = ? AND store_id = ?', Number(req.params.id) || 0, req.store.id);
    if (!order) fail(404, 'Order not found');
    const status = req.body?.status;
    if (!ORDER_STATUSES.includes(status)) fail(400, 'Unknown status');
    if (order.status === 'cancelled' && status !== 'cancelled') fail(400, 'A cancelled order cannot be reopened');

    const statements = [];
    if (status === 'cancelled' && order.status !== 'cancelled') {
      // Put on-hand items back in stock.
      const items = await db.all("SELECT * FROM order_items WHERE order_id = ? AND availability = 'in_stock'", order.id);
      for (const it of items) {
        if (it.product_id) statements.push(['UPDATE products SET quantity = quantity + ? WHERE id = ?', it.qty, it.product_id]);
      }
    }
    statements.push(["UPDATE orders SET status = ?, updated_at = datetime('now') WHERE id = ?", status, order.id]);
    await db.batch(statements);
    res.json(await loadOrder(await db.get('SELECT * FROM orders WHERE id = ?', order.id)));
  });

  // Image upload: the browser sends a resized image as a data URL.
  app.post('/api/uploads', auth, async (req, res) => {
    const dataUrl = String(req.body?.data || '');
    const m = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
    if (!m) fail(400, 'Please upload a JPG, PNG or WEBP image');
    if (m[2].length > MAX_IMAGE_BASE64) fail(400, 'Image is too large — please use a smaller photo');
    const id = randomToken(12) + (m[1] === 'image/png' ? '.png' : m[1] === 'image/webp' ? '.webp' : '.jpg');
    await db.run('INSERT INTO images (id, user_id, mime, data) VALUES (?, ?, ?, ?)', id, req.user.id, m[1], m[2]);
    res.status(201).json({ url: `/images/${id}` });
  });

  // ---------- errors & frontend fallback ----------
  app.use('/api', () => {
    throw new HttpError(404, 'Not found');
  });

  if (publicDir) {
    app.get(/^\/(?!api\/|uploads\/|images\/).*/, (_req, res) => {
      res.sendFile(path.join(publicDir, 'index.html'));
    });
  }

  app.use((err, _req, res, _next) => {
    if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Upload is too large' });
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid request' });
    const status = err.status || 500;
    if (status >= 500) console.error(err);
    res.status(status).json({ error: status >= 500 ? 'Something went wrong' : err.message });
  });

  return app;
}
