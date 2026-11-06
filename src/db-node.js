// Database adapter for Node.js (built-in SQLite, Node >= 22.13), plus demo data.
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hashPassword } from './passwords.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

export function openNodeDb(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(path.join(dataDir, 'xer-store.db'));
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  db.exec(fs.readFileSync(path.join(ROOT, 'migrations', '0001_init.sql'), 'utf8'));
  return nodeAdapter(db);
}

export function nodeAdapter(db) {
  const cache = new Map();
  const prep = (sql) => {
    let s = cache.get(sql);
    if (!s) cache.set(sql, (s = db.prepare(sql)));
    return s;
  };
  return {
    async get(sql, ...params) {
      return prep(sql).get(...params) ?? null;
    },
    async all(sql, ...params) {
      return prep(sql).all(...params);
    },
    async run(sql, ...params) {
      const r = prep(sql).run(...params);
      return { changes: Number(r.changes), lastId: Number(r.lastInsertRowid) };
    },
    /** Runs [[sql, ...params], ...] as one transaction: all succeed or none do. */
    async batch(statements) {
      db.exec('BEGIN');
      try {
        for (const [sql, ...params] of statements) prep(sql).run(...params);
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
    },
  };
}

// ---------- demo data (Node only; Cloudflare starts empty) ----------
const DEMO = [
  {
    user: ['Sara', 'demo@xer.store'],
    store: ['Sara Style House', 'sara-style-house', 'Trendy Shein fashion — dresses, tops and bags. Many pieces on hand, the rest we order for you.', '+251911000001', 'Addis Ababa', '@sarastyle', '#ff4d6d'],
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
    store: ['Yonas Tech Imports', 'yonas-tech-imports', 'Original gadgets from Amazon. Ready stock in Addis, or we bring any Amazon item you want.', '+251911000002', 'Addis Ababa', 't.me/yonastech', '#2563eb'],
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
    store: ['Little Ones Corner', 'little-ones-corner', 'Kids clothes and toys from Shein & Amazon.', '+251911000003', 'Adama', '', '#16a34a'],
    products: [
      ['kids-baby', 'Baby Cotton Romper Set (3 pcs)', 'Soft cotton rompers, 0–12 months.', 19, null, 'shein', 'in_stock', 8, 0, '0-3M, 3-6M, 6-12M'],
      ['kids-baby', 'Girls Tutu Party Dress', 'Sparkly tulle party dress.', 21, null, 'shein', 'by_order', 0, 14, '2Y, 3Y, 4Y, 5Y'],
      ['toys', 'Magnetic Building Tiles (60 pcs)', 'STEM magnetic tiles for creative play.', 39, null, 'amazon', 'in_stock', 3, 0, ''],
      ['toys', 'Kids Drawing Tablet', 'LCD writing pad, reusable.', 10, null, 'amazon', 'in_stock', 12, 0, ''],
      ['shoes', 'Kids Light-Up Sneakers', 'LED sneakers, USB rechargeable.', 24, null, 'shein', 'by_order', 0, 16, '26, 28, 30, 32'],
    ],
  },
];

export async function seedDemo(db) {
  if ((await db.get('SELECT COUNT(*) AS n FROM stores')).n > 0) return false;
  const statements = [];
  for (const s of DEMO) {
    const [name, email] = s.user;
    const [storeName, slug, description, phone, city, social, color] = s.store;
    statements.push(['INSERT INTO users (name, email, password_hash) VALUES (?, ?, ?)', name, email, await hashPassword('demo1234')]);
    statements.push([
      `INSERT INTO stores (owner_id, name, slug, description, phone, city, social, color)
       VALUES ((SELECT id FROM users WHERE email = ?), ?, ?, ?, ?, ?, ?, ?)`,
      email, storeName, slug, description, phone, city, social, color,
    ]);
    for (const [cat, title, desc, price, oldPrice, source, availability, qty, lead, options] of s.products) {
      statements.push([
        `INSERT INTO products (store_id, category_id, title, description, price, old_price, source, availability, quantity, lead_days, options)
         VALUES ((SELECT id FROM stores WHERE slug = ?), (SELECT id FROM categories WHERE slug = ?), ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        slug, cat, title, desc, price, oldPrice, source, availability, qty, lead, options,
      ]);
    }
  }
  await db.batch(statements);
  return true;
}
