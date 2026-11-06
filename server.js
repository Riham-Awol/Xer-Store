// Xer Store — multi-store marketplace API + static frontend.
const express = require('express');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const {
  db,
  UPLOAD_DIR,
  hashPassword,
  verifyPassword,
  uniqueStoreSlug,
  transaction,
  seedDemo,
} = require('./db');

const PORT = Number(process.env.PORT) || 3000;
const CURRENCY = process.env.CURRENCY || '$';
const SITE_NAME = process.env.SITE_NAME || 'Xer Store';

if (process.env.SEED_DEMO !== 'false') seedDemo();

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);

app.get('/healthz', (_req, res) => res.json({ ok: true }));
app.use(express.json({ limit: '6mb' }));
app.use('/uploads', express.static(UPLOAD_DIR, { maxAge: '30d' }));
app.use(express.static(path.join(__dirname, 'public')));

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
  if (s.startsWith('/uploads/') || /^https?:\/\//i.test(s)) return s;
  fail(400, 'Image must be an uploaded file or an http(s) link');
}

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
    options: p.options ? p.options.split(',').map((o) => o.trim()).filter(Boolean) : [],
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

const STORE_SELECT = `
  SELECT s.*,
    (SELECT COUNT(*) FROM products p WHERE p.store_id = s.id AND p.active = 1) AS product_count,
    (SELECT COUNT(*) FROM products p WHERE p.store_id = s.id AND p.active = 1
       AND p.availability = 'in_stock' AND p.quantity > 0) AS available_count,
    (SELECT COUNT(*) FROM products p WHERE p.store_id = s.id AND p.active = 1
       AND p.availability = 'by_order') AS by_order_count
  FROM stores s`;

const ORDER_STATUSES = ['pending', 'confirmed', 'ordered', 'arrived', 'out_for_delivery', 'delivered', 'cancelled'];

function loadOrder(order) {
  const items = db.prepare('SELECT * FROM order_items WHERE order_id = ? ORDER BY id').all(order.id);
  return { ...order, items };
}

function newOrderCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = 'XS-' + Array.from(crypto.randomBytes(6), (b) => alphabet[b % alphabet.length]).join('');
  } while (db.prepare('SELECT 1 FROM orders WHERE code = ?').get(code));
  return code;
}

// ---------- auth ----------
function auth(req, _res, next) {
  const header = req.get('authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  const row = token
    ? db.prepare(
        `SELECT u.id, u.name, u.email FROM sessions se JOIN users u ON u.id = se.user_id WHERE se.token = ?`
      ).get(token)
    : null;
  if (!row) return next(new HttpError(401, 'Please log in'));
  req.user = row;
  req.token = token;
  req.store = db.prepare('SELECT * FROM stores WHERE owner_id = ?').get(row.id) || null;
  next();
}

function requireStore(req, _res, next) {
  if (!req.store) return next(new HttpError(400, 'Create your store first'));
  next();
}

function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare('INSERT INTO sessions (token, user_id) VALUES (?, ?)').run(token, userId);
  return token;
}

// ---------- public API ----------
app.get('/api/config', (_req, res) => {
  res.json({ currency: CURRENCY, site_name: SITE_NAME, order_statuses: ORDER_STATUSES });
});

app.get('/api/categories', (_req, res) => {
  const rows = db.prepare(`
    SELECT c.*, (
      SELECT COUNT(*) FROM products p JOIN stores s ON s.id = p.store_id
      WHERE p.category_id = c.id AND p.active = 1 AND s.active = 1
    ) AS product_count
    FROM categories c ORDER BY c.sort`).all();
  res.json(rows);
});

app.get('/api/stores', (_req, res) => {
  const rows = db.prepare(`${STORE_SELECT} WHERE s.active = 1 ORDER BY product_count DESC, s.created_at`).all();
  res.json(rows.map(publicStore));
});

app.get('/api/stores/:slug', (req, res) => {
  const store = db.prepare(`${STORE_SELECT} WHERE s.slug = ? AND s.active = 1`).get(req.params.slug);
  if (!store) fail(404, 'Store not found');
  res.json(publicStore(store));
});

app.get('/api/products', (req, res) => {
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

  const rows = db.prepare(`${PRODUCT_SELECT} WHERE ${where.join(' AND ')} ORDER BY ${order} LIMIT 500`).all(...params);
  res.json(rows.map(shapeProduct));
});

app.get('/api/products/:id', (req, res) => {
  const row = db.prepare(`${PRODUCT_SELECT} WHERE p.id = ? AND p.active = 1 AND s.active = 1`).get(Number(req.params.id));
  if (!row) fail(404, 'Product not found');
  res.json(shapeProduct(row));
});

// Place an order. Items from different stores become one order per store.
app.post('/api/orders', (req, res) => {
  const b = req.body || {};
  const customer_name = str(b.customer_name, { required: true, max: 80, label: 'Name' });
  const phone = str(b.phone, { required: true, max: 30, label: 'Phone' });
  if (digits(phone).length < 7) fail(400, 'Please enter a valid phone number');
  const address = str(b.address, { required: true, max: 300, label: 'Address' });
  const note = str(b.note, { max: 500, label: 'Note' });
  if (!Array.isArray(b.items) || !b.items.length) fail(400, 'Your cart is empty');
  if (b.items.length > 50) fail(400, 'Too many items in one order');

  const getProduct = db.prepare(`${PRODUCT_SELECT} WHERE p.id = ? AND p.active = 1 AND s.active = 1`);

  // Merge duplicates (same product + option) and validate.
  const merged = new Map();
  for (const it of b.items) {
    const productId = num(it.product_id, { integer: true, min: 1, label: 'Product' });
    const qty = num(it.qty, { integer: true, min: 1, max: 99, label: 'Quantity' });
    const option = str(it.option, { max: 60, label: 'Option' });
    const key = `${productId}::${option}`;
    const prev = merged.get(key);
    merged.set(key, { productId, option, qty: (prev?.qty || 0) + qty });
  }

  const created = transaction(() => {
    const byStore = new Map();
    const needed = new Map(); // productId -> total qty across options

    for (const { productId, option, qty } of merged.values()) {
      const p = getProduct.get(productId);
      if (!p) fail(400, 'A product in your cart is no longer available');
      const opts = p.options ? p.options.split(',').map((o) => o.trim()).filter(Boolean) : [];
      if (opts.length && !opts.includes(option)) fail(400, `Please choose an option for "${p.title}"`);
      if (!opts.length && option) fail(400, `"${p.title}" has no options`);
      if (p.availability === 'in_stock') {
        const total = (needed.get(p.id) || 0) + qty;
        needed.set(p.id, total);
        if (total > p.quantity) {
          fail(409, p.quantity > 0
            ? `Only ${p.quantity} left of "${p.title}"`
            : `"${p.title}" is sold out`);
        }
      }
      if (!byStore.has(p.store_id)) byStore.set(p.store_id, { store: p, lines: [] });
      byStore.get(p.store_id).lines.push({ p, qty, option });
    }

    const insertOrder = db.prepare(
      `INSERT INTO orders (code, store_id, customer_name, phone, address, note, total)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    );
    const insertItem = db.prepare(
      `INSERT INTO order_items (order_id, product_id, title, image, price, qty, option, availability, lead_days)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const decrement = db.prepare('UPDATE products SET quantity = quantity - ? WHERE id = ?');

    const out = [];
    for (const [storeId, { store, lines }] of byStore) {
      const total = Math.round(lines.reduce((sum, l) => sum + l.p.price * l.qty, 0) * 100) / 100;
      const code = newOrderCode();
      const orderId = insertOrder.run(code, storeId, customer_name, phone, address, note, total).lastInsertRowid;
      for (const { p, qty, option } of lines) {
        insertItem.run(orderId, p.id, p.title, p.image, p.price, qty, option, p.availability,
          p.availability === 'by_order' ? p.lead_days : 0);
        if (p.availability === 'in_stock') decrement.run(qty, p.id);
      }
      const s = db.prepare('SELECT * FROM stores WHERE id = ?').get(storeId);
      out.push({
        code,
        total,
        status: 'pending',
        store: { name: store.store_name, slug: store.store_slug, phone: s.phone },
        has_by_order: lines.some((l) => l.p.availability === 'by_order'),
      });
    }
    return out;
  });

  res.status(201).json({ orders: created });
});

// Customers track an order with its code + the phone number they used.
app.get('/api/orders/track', (req, res) => {
  const code = str(req.query.code, { required: true, max: 20, label: 'Order code' }).toUpperCase();
  const phone = str(req.query.phone, { required: true, max: 30, label: 'Phone' });
  const order = db.prepare('SELECT * FROM orders WHERE code = ?').get(code);
  if (!order || digits(order.phone).slice(-9) !== digits(phone).slice(-9)) {
    fail(404, 'No order found with that code and phone number');
  }
  const store = db.prepare('SELECT * FROM stores WHERE id = ?').get(order.store_id);
  res.json({ ...loadOrder(order), store: publicStore(store) });
});

// ---------- accounts ----------
app.post('/api/auth/register', (req, res) => {
  const b = req.body || {};
  const name = str(b.name, { required: true, max: 80, label: 'Name' });
  const email = str(b.email, { required: true, max: 120, label: 'Email' }).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail(400, 'Please enter a valid email');
  const password = typeof b.password === 'string' ? b.password : '';
  if (password.length < 6) fail(400, 'Password must be at least 6 characters');
  if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) fail(409, 'An account with this email already exists');
  const id = db.prepare('INSERT INTO users (name, email, password_hash) VALUES (?, ?, ?)')
    .run(name, email, hashPassword(password)).lastInsertRowid;
  res.status(201).json({ token: createSession(id), user: { id, name, email }, store: null });
});

app.post('/api/auth/login', (req, res) => {
  const b = req.body || {};
  const email = str(b.email, { max: 120 }).toLowerCase();
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!user || !verifyPassword(String(b.password || ''), user.password_hash)) fail(401, 'Wrong email or password');
  const store = db.prepare('SELECT * FROM stores WHERE owner_id = ?').get(user.id);
  res.json({
    token: createSession(user.id),
    user: { id: user.id, name: user.name, email: user.email },
    store: store ? publicStore(store) : null,
  });
});

app.post('/api/auth/logout', auth, (req, res) => {
  db.prepare('DELETE FROM sessions WHERE token = ?').run(req.token);
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

app.post('/api/my/store', auth, (req, res) => {
  if (req.store) fail(409, 'You already have a store');
  const s = readStoreBody(req.body || {});
  const id = db.prepare(
    `INSERT INTO stores (owner_id, name, slug, description, logo, phone, city, social, color)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(req.user.id, s.name, uniqueStoreSlug(s.name), s.description, s.logo, s.phone, s.city, s.social, s.color)
    .lastInsertRowid;
  res.status(201).json(publicStore(db.prepare('SELECT * FROM stores WHERE id = ?').get(id)));
});

app.put('/api/my/store', auth, requireStore, (req, res) => {
  const s = readStoreBody(req.body || {});
  const slug = s.name === req.store.name ? req.store.slug : uniqueStoreSlug(s.name, req.store.id);
  db.prepare(
    `UPDATE stores SET name = ?, slug = ?, description = ?, logo = ?, phone = ?, city = ?, social = ?, color = ?
     WHERE id = ?`
  ).run(s.name, slug, s.description, s.logo, s.phone, s.city, s.social, s.color, req.store.id);
  res.json(publicStore(db.prepare('SELECT * FROM stores WHERE id = ?').get(req.store.id)));
});

app.get('/api/my/summary', auth, requireStore, (req, res) => {
  const id = req.store.id;
  const one = (sql) => db.prepare(sql).get(id).n;
  res.json({
    products: one('SELECT COUNT(*) n FROM products WHERE store_id = ?'),
    available: one("SELECT COUNT(*) n FROM products WHERE store_id = ? AND active = 1 AND availability = 'in_stock' AND quantity > 0"),
    by_order: one("SELECT COUNT(*) n FROM products WHERE store_id = ? AND active = 1 AND availability = 'by_order'"),
    sold_out: one("SELECT COUNT(*) n FROM products WHERE store_id = ? AND availability = 'in_stock' AND quantity <= 0"),
    pending_orders: one("SELECT COUNT(*) n FROM orders WHERE store_id = ? AND status = 'pending'"),
    open_orders: one("SELECT COUNT(*) n FROM orders WHERE store_id = ? AND status NOT IN ('delivered','cancelled')"),
    revenue: db.prepare("SELECT COALESCE(SUM(total),0) n FROM orders WHERE store_id = ? AND status = 'delivered'").get(id).n,
  });
});

app.get('/api/my/products', auth, requireStore, (req, res) => {
  const rows = db.prepare(`${PRODUCT_SELECT} WHERE p.store_id = ? ORDER BY p.created_at DESC, p.id DESC`).all(req.store.id);
  res.json(rows.map(shapeProduct));
});

function readProductBody(b) {
  const category = db.prepare('SELECT id FROM categories WHERE id = ? OR slug = ?')
    .get(Number(b.category_id) || 0, String(b.category_id || b.category || ''));
  if (!category) fail(400, 'Please choose a category');
  const availability = b.availability === 'by_order' ? 'by_order' : b.availability === 'in_stock' ? 'in_stock' : null;
  if (!availability) fail(400, 'Choose "Available now" or "By order"');
  const source = ['shein', 'amazon', 'other'].includes(b.source) ? b.source : 'other';
  const price = num(b.price, { min: 0, max: 1e7, label: 'Price' });
  const old_price = num(b.old_price, { min: 0, max: 1e7, label: 'Old price', required: false });
  const options = str(b.options, { max: 300, label: 'Options' })
    .split(',').map((o) => o.trim()).filter(Boolean).slice(0, 30).join(', ');
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

app.post('/api/my/products', auth, requireStore, (req, res) => {
  const p = readProductBody(req.body || {});
  const id = db.prepare(
    `INSERT INTO products (store_id, category_id, title, description, price, old_price, image, source,
       availability, quantity, lead_days, options, active)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(req.store.id, p.category_id, p.title, p.description, p.price, p.old_price, p.image, p.source,
    p.availability, p.quantity, p.lead_days, p.options, p.active).lastInsertRowid;
  res.status(201).json(shapeProduct(db.prepare(`${PRODUCT_SELECT} WHERE p.id = ?`).get(id)));
});

function ownProduct(req) {
  const row = db.prepare('SELECT * FROM products WHERE id = ? AND store_id = ?').get(Number(req.params.id), req.store.id);
  if (!row) fail(404, 'Product not found');
  return row;
}

app.put('/api/my/products/:id', auth, requireStore, (req, res) => {
  const existing = ownProduct(req);
  const p = readProductBody(req.body || {});
  db.prepare(
    `UPDATE products SET category_id = ?, title = ?, description = ?, price = ?, old_price = ?, image = ?,
       source = ?, availability = ?, quantity = ?, lead_days = ?, options = ?, active = ? WHERE id = ?`
  ).run(p.category_id, p.title, p.description, p.price, p.old_price, p.image, p.source, p.availability,
    p.quantity, p.lead_days, p.options, p.active, existing.id);
  res.json(shapeProduct(db.prepare(`${PRODUCT_SELECT} WHERE p.id = ?`).get(existing.id)));
});

app.delete('/api/my/products/:id', auth, requireStore, (req, res) => {
  const existing = ownProduct(req);
  db.prepare('DELETE FROM products WHERE id = ?').run(existing.id);
  res.json({ ok: true });
});

app.get('/api/my/orders', auth, requireStore, (req, res) => {
  const status = req.query.status;
  const rows = ORDER_STATUSES.includes(status)
    ? db.prepare('SELECT * FROM orders WHERE store_id = ? AND status = ? ORDER BY id DESC').all(req.store.id, status)
    : db.prepare('SELECT * FROM orders WHERE store_id = ? ORDER BY id DESC').all(req.store.id);
  res.json(rows.map(loadOrder));
});

app.patch('/api/my/orders/:id', auth, requireStore, (req, res) => {
  const order = db.prepare('SELECT * FROM orders WHERE id = ? AND store_id = ?').get(Number(req.params.id), req.store.id);
  if (!order) fail(404, 'Order not found');
  const status = req.body?.status;
  if (!ORDER_STATUSES.includes(status)) fail(400, 'Unknown status');
  if (order.status === 'cancelled' && status !== 'cancelled') fail(400, 'A cancelled order cannot be reopened');

  transaction(() => {
    if (status === 'cancelled' && order.status !== 'cancelled') {
      // Put on-hand items back in stock.
      const items = db.prepare("SELECT * FROM order_items WHERE order_id = ? AND availability = 'in_stock'").all(order.id);
      const restock = db.prepare('UPDATE products SET quantity = quantity + ? WHERE id = ?');
      for (const it of items) if (it.product_id) restock.run(it.qty, it.product_id);
    }
    db.prepare("UPDATE orders SET status = ?, updated_at = datetime('now') WHERE id = ?").run(status, order.id);
  });
  res.json(loadOrder(db.prepare('SELECT * FROM orders WHERE id = ?').get(order.id)));
});

// Image upload: the browser sends a resized image as a data URL.
app.post('/api/uploads', auth, (req, res) => {
  const dataUrl = String(req.body?.data || '');
  const m = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
  if (!m) fail(400, 'Please upload a JPG, PNG or WEBP image');
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length > 4 * 1024 * 1024) fail(400, 'Image is too large (max 4 MB)');
  const ext = m[1] === 'jpeg' ? 'jpg' : m[1];
  const name = `${crypto.randomBytes(12).toString('hex')}.${ext}`;
  fs.writeFileSync(path.join(UPLOAD_DIR, name), buf);
  res.status(201).json({ url: `/uploads/${name}` });
});

// ---------- errors & SPA fallback ----------
app.use('/api', (_req, _res, next) => next(new HttpError(404, 'Not found')));

app.get(/^\/(?!api\/|uploads\/).*/, (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.use((err, _req, res, _next) => {
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Upload is too large' });
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid request' });
  const status = err.status || 500;
  if (status >= 500) console.error(err);
  res.status(status).json({ error: status >= 500 ? 'Something went wrong' : err.message });
});

if (require.main === module) {
  app.listen(PORT, () => console.log(`${SITE_NAME} running at http://localhost:${PORT}`));
}

module.exports = app;
