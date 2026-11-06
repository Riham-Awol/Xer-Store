// End-to-end API tests. Run with: npm test
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/app.js';
import { openNodeDb } from '../src/db-node.js';

// Set TEST_BASE_URL (e.g. http://127.0.0.1:8787 from `npm run cf:dev` on a fresh
// database) to run the same tests against the Cloudflare Workers version.
const REMOTE = process.env.TEST_BASE_URL;
const dataDir = REMOTE ? null : fs.mkdtempSync(path.join(os.tmpdir(), 'xer-store-test-'));
const db = REMOTE ? null : openNodeDb(dataDir);
const app = REMOTE ? null : createApp({ db });

let server;
let base;

before(async () => {
  if (REMOTE) {
    base = REMOTE;
    return;
  }
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => {
  if (REMOTE) return;
  server.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

async function call(method, url, body, token) {
  const headers = {};
  if (body) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(base + url, { method, headers, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json() };
}

async function seller(email, storeName) {
  const reg = await call('POST', '/api/auth/register', { name: 'Seller', email, password: 'secret123' });
  assert.equal(reg.status, 201);
  const store = await call('POST', '/api/my/store', { name: storeName, phone: '+251911223344' }, reg.body.token);
  assert.equal(store.status, 201);
  return { token: reg.body.token, store: store.body };
}

test('full marketplace flow: stores, categories, availability, orders, stock', async () => {
  const a = await seller('a@test.com', 'Alpha Shop');
  const b = await seller('b@test.com', 'Beta Shop');
  assert.equal(a.store.slug, 'alpha-shop');

  const inStock = await call('POST', '/api/my/products', {
    title: 'Dress', category_id: 'womens-fashion', price: 30, source: 'shein',
    availability: 'in_stock', quantity: 2, options: 'S, M',
  }, a.token);
  assert.equal(inStock.status, 201);
  assert.equal(inStock.body.status, 'available');
  assert.deepEqual(inStock.body.options, ['S', 'M']);

  const byOrder = await call('POST', '/api/my/products', {
    title: 'Earbuds', category_id: 'electronics', price: 50, source: 'amazon',
    availability: 'by_order', lead_days: 20,
  }, b.token);
  assert.equal(byOrder.body.status, 'by_order');
  assert.equal(byOrder.body.lead_days, 20);

  // Public listings
  const stores = await call('GET', '/api/stores');
  assert.equal(stores.body.length, 2);
  const cats = await call('GET', '/api/categories');
  assert.equal(cats.body.find((c) => c.slug === 'womens-fashion').product_count, 1);
  assert.equal((await call('GET', '/api/products?availability=available')).body.length, 1);
  assert.equal((await call('GET', '/api/products?availability=by_order')).body.length, 1);
  assert.equal((await call('GET', '/api/products?category=electronics')).body[0].store.name, 'Beta Shop');
  assert.equal((await call('GET', '/api/products?store=alpha-shop')).body.length, 1);

  // Option is required when the product has options
  const noOpt = await call('POST', '/api/orders', {
    customer_name: 'Cust', phone: '0911000000', address: 'Bole',
    items: [{ product_id: inStock.body.id, qty: 1 }],
  });
  assert.equal(noOpt.status, 400);

  // Cannot buy more than in stock
  const tooMany = await call('POST', '/api/orders', {
    customer_name: 'Cust', phone: '0911000000', address: 'Bole',
    items: [{ product_id: inStock.body.id, qty: 3, option: 'S' }],
  });
  assert.equal(tooMany.status, 409);

  // Cart across two stores -> two orders
  const order = await call('POST', '/api/orders', {
    customer_name: 'Cust', phone: '0911000000', address: 'Bole',
    items: [
      { product_id: inStock.body.id, qty: 2, option: 'M' },
      { product_id: byOrder.body.id, qty: 1 },
    ],
  });
  assert.equal(order.status, 201);
  assert.equal(order.body.orders.length, 2);

  // Stock went down -> sold out
  const after1 = await call('GET', `/api/products/${inStock.body.id}`);
  assert.equal(after1.body.quantity, 0);
  assert.equal(after1.body.status, 'sold_out');

  // Seller sees only their own orders
  const aOrders = await call('GET', '/api/my/orders', null, a.token);
  assert.equal(aOrders.body.length, 1);
  assert.equal(aOrders.body[0].total, 60);
  assert.equal(aOrders.body[0].items[0].option, 'M');

  // Customer tracking needs the right phone
  const code = aOrders.body[0].code;
  assert.equal((await call('GET', `/api/orders/track?code=${code}&phone=000`)).status, 404);
  const tracked = await call('GET', `/api/orders/track?code=${code}&phone=+251911000000`);
  assert.equal(tracked.status, 200);
  assert.equal(tracked.body.status, 'pending');

  // Cancelling restores stock
  const cancel = await call('PATCH', `/api/my/orders/${aOrders.body[0].id}`, { status: 'cancelled' }, a.token);
  assert.equal(cancel.status, 200);
  assert.equal((await call('GET', `/api/products/${inStock.body.id}`)).body.quantity, 2);

  // Sellers cannot touch other stores' products or orders
  assert.equal((await call('PUT', `/api/my/products/${inStock.body.id}`, { title: 'x' }, b.token)).status, 404);
  assert.equal((await call('PATCH', `/api/my/orders/${aOrders.body[0].id}`, { status: 'confirmed' }, b.token)).status, 404);
  assert.equal((await call('GET', '/api/my/products')).status, 401);
});

test('validation and auth', async () => {
  assert.equal((await call('POST', '/api/auth/register', { name: 'X', email: 'bad', password: 'secret123' })).status, 400);
  assert.equal((await call('POST', '/api/auth/login', { email: 'a@test.com', password: 'wrong' })).status, 401);
  const login = await call('POST', '/api/auth/login', { email: 'a@test.com', password: 'secret123' });
  assert.equal(login.status, 200);
  assert.equal(login.body.store.name, 'Alpha Shop');
  const bad = await call('POST', '/api/my/products', { title: 'X', category_id: 'nope', price: 1, availability: 'in_stock' }, login.body.token);
  assert.equal(bad.status, 400);
  const badImg = await call('POST', '/api/my/products', {
    title: 'X', category_id: 'other', price: 1, availability: 'in_stock', image: 'javascript:alert(1)',
  }, login.body.token);
  assert.equal(badImg.status, 400);
});

test('photo upload is stored in the database and served back', async () => {
  const login = await call('POST', '/api/auth/login', { email: 'a@test.com', password: 'secret123' });
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const up = await call('POST', '/api/uploads', { data: `data:image/png;base64,${png}` }, login.body.token);
  assert.equal(up.status, 201);
  assert.match(up.body.url, /^\/images\/[a-f0-9]+\.png$/);
  const res = await fetch(base + up.body.url);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/png');
  assert.equal(Buffer.from(await res.arrayBuffer()).toString('base64'), png);
  assert.equal((await call('POST', '/api/uploads', { data: 'data:text/html;base64,AAAA' }, login.body.token)).status, 400);
  assert.equal((await call('POST', '/api/uploads', { data: `data:image/png;base64,${png}` })).status, 401);
});

test('two buyers racing for the last item: only one order succeeds', async () => {
  const login = await call('POST', '/api/auth/login', { email: 'b@test.com', password: 'secret123' });
  const p = await call('POST', '/api/my/products', {
    title: 'Last one', category_id: 'toys', price: 5, availability: 'in_stock', quantity: 1,
  }, login.body.token);
  const order = () => call('POST', '/api/orders', {
    customer_name: 'C', phone: '0911000001', address: 'X', items: [{ product_id: p.body.id, qty: 1 }],
  });
  const results = await Promise.all([order(), order(), order()]);
  assert.deepEqual(results.map((r) => r.status).sort(), [201, 409, 409]);
  assert.equal((await call('GET', `/api/products/${p.body.id}`)).body.quantity, 0);
});

test('stock can never go negative, even with a direct update', { skip: !!REMOTE }, async () => {
  await assert.rejects(db.run('UPDATE products SET quantity = -1 WHERE id = 1'), /OUT_OF_STOCK/);
});
