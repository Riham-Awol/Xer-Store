-- Xer Store schema. Used by Cloudflare D1 (wrangler d1 migrations apply)
-- and by the Node.js server (run on every start, so every statement is idempotent).

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

-- Stock can never go below zero. If two people buy the last item at the
-- same moment, the second order is rejected as a whole.
CREATE TRIGGER IF NOT EXISTS products_stock_not_negative
BEFORE UPDATE OF quantity ON products
WHEN NEW.quantity < 0
BEGIN
  SELECT RAISE(ABORT, 'OUT_OF_STOCK');
END;

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
CREATE INDEX IF NOT EXISTS idx_order_items_order ON order_items(order_id);

-- Uploaded photos (base64), so the app needs no file storage.
CREATE TABLE IF NOT EXISTS images (
  id         TEXT PRIMARY KEY,
  user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  mime       TEXT NOT NULL,
  data       TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO categories (slug, name, icon, sort) VALUES
  ('womens-fashion', 'Women''s Fashion', '👗', 0),
  ('mens-fashion', 'Men''s Fashion', '👔', 1),
  ('kids-baby', 'Kids & Baby', '🧸', 2),
  ('shoes', 'Shoes', '👟', 3),
  ('bags-accessories', 'Bags & Accessories', '👜', 4),
  ('jewelry-watches', 'Jewelry & Watches', '💍', 5),
  ('beauty', 'Beauty & Personal Care', '💄', 6),
  ('home-kitchen', 'Home & Kitchen', '🏠', 7),
  ('electronics', 'Electronics', '🎧', 8),
  ('phone-accessories', 'Phone Accessories', '📱', 9),
  ('health', 'Health & Wellness', '💊', 10),
  ('sports', 'Sports & Outdoors', '⚽', 11),
  ('toys', 'Toys & Games', '🎲', 12),
  ('other', 'Other', '📦', 13)
ON CONFLICT(slug) DO NOTHING;
