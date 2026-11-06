// Database setup (SQLite, built into Node.js >= 22.13).
const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const db = new DatabaseSync(path.join(DATA_DIR, 'xer-store.db'));

db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT NOT NULL,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS stores (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id    INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  slug        TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL DEFAULT '',
  logo        TEXT NOT NULL DEFAULT '',
  phone       TEXT NOT NULL DEFAULT '',
  city        TEXT NOT NULL DEFAULT '',
  social      TEXT NOT NULL DEFAULT '',
  color       TEXT NOT NULL DEFAULT '#ff4d6d',
  active      INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS categories (
  id    INTEGER PRIMARY KEY AUTOINCREMENT,
  slug  TEXT NOT NULL UNIQUE,
  name  TEXT NOT NULL,
  icon  TEXT NOT NULL DEFAULT '',
  sort  INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS products (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  store_id     INTEGER NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  category_id  INTEGER NOT NULL REFERENCES categories(id),
  title        TEXT NOT NULL,
  description  TEXT NOT NULL DEFAULT '',
  price        REAL NOT NULL,
  old_price    REAL,
  image        TEXT NOT NULL DEFAULT '',
  source       TEXT NOT NULL DEFAULT 'other' CHECK (source IN ('shein','amazon','other')),
  availability TEXT NOT NULL CHECK (availability IN ('in_stock','by_order')),
  quantity     INTEGER NOT NULL DEFAULT 0,
  lead_days    INTEGER NOT NULL DEFAULT 14,
  options      TEXT NOT NULL DEFAULT '',
  active       INTEGER NOT NULL DEFAULT 1,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_products_store ON products(store_id);
CREATE INDEX IF NOT EXISTS idx_products_category ON products(category_id);

CREATE TABLE IF NOT EXISTS orders (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  code           TEXT NOT NULL UNIQUE,
  store_id       INTEGER NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  customer_name  TEXT NOT NULL,
  phone          TEXT NOT NULL,
  address        TEXT NOT NULL,
  note           TEXT NOT NULL DEFAULT '',
  status         TEXT NOT NULL DEFAULT 'pending',
  total          REAL NOT NULL,
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_orders_store ON orders(store_id);

CREATE TABLE IF NOT EXISTS order_items (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id     INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id   INTEGER REFERENCES products(id) ON DELETE SET NULL,
  title        TEXT NOT NULL,
  image        TEXT NOT NULL DEFAULT '',
  price        REAL NOT NULL,
  qty          INTEGER NOT NULL,
  option       TEXT NOT NULL DEFAULT '',
  availability TEXT NOT NULL,
  lead_days    INTEGER NOT NULL DEFAULT 0
);
`);

const CATEGORIES = [
  ['womens-fashion', "Women's Fashion", '👗'],
  ['mens-fashion', "Men's Fashion", '👔'],
  ['kids-baby', 'Kids & Baby', '🧸'],
  ['shoes', 'Shoes', '👟'],
  ['bags-accessories', 'Bags & Accessories', '👜'],
  ['jewelry-watches', 'Jewelry & Watches', '💍'],
  ['beauty', 'Beauty & Personal Care', '💄'],
  ['home-kitchen', 'Home & Kitchen', '🏠'],
  ['electronics', 'Electronics', '🎧'],
  ['phone-accessories', 'Phone Accessories', '📱'],
  ['health', 'Health & Wellness', '💊'],
  ['sports', 'Sports & Outdoors', '⚽'],
  ['toys', 'Toys & Games', '🎲'],
  ['other', 'Other', '📦'],
];
const insertCat = db.prepare(
  'INSERT INTO categories (slug, name, icon, sort) VALUES (?, ?, ?, ?) ON CONFLICT(slug) DO NOTHING'
);
CATEGORIES.forEach(([slug, name, icon], i) => insertCat.run(slug, name, icon, i));

// ---------- helpers ----------
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, hash] = String(stored).split(':');
  if (!salt || !hash) return false;
  const test = crypto.scryptSync(password, salt, 64);
  const real = Buffer.from(hash, 'hex');
  return real.length === test.length && crypto.timingSafeEqual(real, test);
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

function uniqueStoreSlug(name, ignoreStoreId = 0) {
  const base = slugify(name);
  let slug = base;
  let n = 2;
  const q = db.prepare('SELECT id FROM stores WHERE slug = ? AND id != ?');
  while (q.get(slug, ignoreStoreId)) slug = `${base}-${n++}`;
  return slug;
}

function transaction(fn) {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

// ---------- demo data ----------
function seedDemo() {
  const count = db.prepare('SELECT COUNT(*) AS n FROM stores').get().n;
  if (count > 0) return false;

  const cat = Object.fromEntries(
    db.prepare('SELECT id, slug FROM categories').all().map((c) => [c.slug, c.id])
  );
  const addUser = db.prepare('INSERT INTO users (name, email, password_hash) VALUES (?, ?, ?)');
  const addStore = db.prepare(
    `INSERT INTO stores (owner_id, name, slug, description, phone, city, social, color)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const addProduct = db.prepare(
    `INSERT INTO products (store_id, category_id, title, description, price, old_price, source,
       availability, quantity, lead_days, options)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );

  const stores = [
    {
      user: ['Sara', 'demo@xer.store'],
      store: ['Sara Style House', 'Trendy Shein fashion — dresses, tops and bags. Many pieces on hand, the rest we order for you.', '+251911000001', 'Addis Ababa', '@sarastyle', '#ff4d6d'],
      products: [
        ['womens-fashion', 'Floral Wrap Midi Dress', 'Lightweight floral wrap dress, perfect for summer.', 32, 40, 'shein', 'in_stock', 4, 0, 'S, M, L'],
        ['womens-fashion', 'Ribbed Knit Crop Top', 'Soft ribbed knit, stretchy fit.', 12, null, 'shein', 'in_stock', 10, 0, 'Black, White, Beige'],
        ['womens-fashion', 'High-Waist Wide Leg Jeans', 'Comfortable high-rise denim.', 28, null, 'shein', 'by_order', 0, 14, 'XS, S, M, L, XL'],
        ['bags-accessories', 'Mini Quilted Crossbody Bag', 'Chain strap, gold hardware.', 18, 22, 'shein', 'in_stock', 3, 0, 'Black, Pink'],
        ['jewelry-watches', 'Layered Gold Necklace Set', '3-piece layered necklace set.', 9, null, 'shein', 'by_order', 0, 12, ''],
        ['shoes', 'Platform Chunky Sneakers', 'Everyday chunky sole sneakers.', 35, null, 'shein', 'by_order', 0, 18, '37, 38, 39, 40'],
        ['beauty', 'Matte Liquid Lipstick (6 pack)', 'Long-lasting matte finish.', 11, null, 'shein', 'in_stock', 0, 0, ''],
      ],
    },
    {
      user: ['Yonas', 'yonas@xer.store'],
      store: ['Yonas Tech Imports', 'Original gadgets from Amazon. Ready stock in Addis, or we bring any Amazon item you want.', '+251911000002', 'Addis Ababa', 't.me/yonastech', '#2563eb'],
      products: [
        ['electronics', 'Wireless Noise Cancelling Earbuds', 'Bluetooth 5.3, 30h battery with case.', 65, 80, 'amazon', 'in_stock', 6, 0, ''],
        ['electronics', 'Smart Watch Fitness Tracker', 'Heart rate, sleep, 100+ sport modes.', 49, null, 'amazon', 'by_order', 0, 21, 'Black, Silver'],
        ['phone-accessories', '20W Fast Charger + USB-C Cable', 'Fast charging for iPhone and Android.', 15, null, 'amazon', 'in_stock', 20, 0, ''],
        ['phone-accessories', 'MagSafe Clear Phone Case', 'Shockproof clear case with MagSafe.', 14, null, 'amazon', 'by_order', 0, 21, 'iPhone 14, iPhone 15, iPhone 16'],
        ['home-kitchen', 'Mini Portable Blender', 'USB rechargeable, 380ml.', 25, null, 'amazon', 'in_stock', 5, 0, ''],
        ['home-kitchen', 'Digital Air Fryer 5L', 'Oil-free cooking, 8 presets.', 95, 110, 'amazon', 'by_order', 0, 25, ''],
        ['health', 'Digital Blood Pressure Monitor', 'Upper arm, large display.', 38, null, 'amazon', 'in_stock', 2, 0, ''],
      ],
    },
    {
      user: ['Hana', 'hana@xer.store'],
      store: ['Little Ones Corner', 'Kids clothes and toys from Shein & Amazon.', '+251911000003', 'Adama', '', '#16a34a'],
      products: [
        ['kids-baby', 'Baby Cotton Romper Set (3 pcs)', 'Soft cotton rompers, 0–12 months.', 19, null, 'shein', 'in_stock', 8, 0, '0-3M, 3-6M, 6-12M'],
        ['kids-baby', 'Girls Tutu Party Dress', 'Sparkly tulle party dress.', 21, null, 'shein', 'by_order', 0, 14, '2Y, 3Y, 4Y, 5Y'],
        ['toys', 'Magnetic Building Tiles (60 pcs)', 'STEM magnetic tiles for creative play.', 39, null, 'amazon', 'in_stock', 3, 0, ''],
        ['toys', 'Kids Drawing Tablet', 'LCD writing pad, reusable.', 10, null, 'amazon', 'in_stock', 12, 0, ''],
        ['shoes', 'Kids Light-Up Sneakers', 'LED sneakers, USB rechargeable.', 24, null, 'shein', 'by_order', 0, 16, '26, 28, 30, 32'],
      ],
    },
  ];

  transaction(() => {
    for (const s of stores) {
      const userId = addUser.run(s.user[0], s.user[1], hashPassword('demo1234')).lastInsertRowid;
      const [name, description, phone, city, social, color] = s.store;
      const storeId = addStore.run(userId, name, uniqueStoreSlug(name), description, phone, city, social, color).lastInsertRowid;
      for (const p of s.products) {
        const [c, title, desc, price, oldPrice, source, availability, qty, lead, options] = p;
        addProduct.run(storeId, cat[c], title, desc, price, oldPrice, source, availability, qty, lead, options);
      }
    }
  });
  return true;
}

module.exports = {
  db,
  DATA_DIR,
  UPLOAD_DIR,
  hashPassword,
  verifyPassword,
  uniqueStoreSlug,
  transaction,
  seedDemo,
};
