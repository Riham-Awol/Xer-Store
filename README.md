# Xer Store

A multi-store marketplace for resellers who bring products from **Shein**, **Amazon** and other places and sell them locally.

- **Sellers** create an account, open their own store (name, logo, phone/WhatsApp, city, social link, color) and post products.
- Every product has a **category** and an **availability**:
  - **● Available now**: the seller has it on hand. Stock counts down with each order and shows "Sold out" at 0.
  - **⏱ By order**: the seller orders it from Shein/Amazon after the customer buys, with an estimated delivery time.
- **Shoppers** see the **stores at the top** of the home page, then products **listed by category**. Each product card shows the store it comes from. They can filter by category, availability, source (Shein/Amazon) and price, and search.
- **Cart and checkout** work across stores. A cart with items from 2 stores becomes 2 orders, one per store. Payment is on delivery or arranged with the store.
- **Order tracking**: customers track an order with its code and phone number. Sellers update the status (New → Confirmed → Ordered from supplier → Arrived → Out for delivery → Delivered, or Cancelled). Cancelling puts in-stock items back in stock.

## Put it online for free (Cloudflare)

The app runs on **Cloudflare Workers** (free plan) with a **Cloudflare D1** database. Products, orders and photos are all stored in D1, so nothing is lost on restarts. The site never sleeps.

1. Sign up for free at **dash.cloudflare.com**.
2. In the left menu, open **Workers & Pages** (under "Compute"), then click **Create application**.
3. Choose **Import a repository** (Continue with GitHub). Let Cloudflare access the **Xer-Store** repository, then select it.
4. Check the settings:
   - Project name: `xer-store`
   - Build command: leave empty
   - Deploy command: `npx wrangler deploy`
   - Branch: `main`
5. Click **Create and deploy**. The first deploy creates the database automatically. The app creates its tables the first time someone opens the site.
6. When it finishes, Cloudflare shows your link, something like `https://xer-store.<your-name>.workers.dev`. Open it, click **Sell** and create the first store.

After that, every change merged into `main` goes live automatically. Your data stays.

**Currency and site name** are set in `wrangler.jsonc` under `"vars"` (currently `ETB`). Change them there, not in the Cloudflare dashboard, because each deploy resets dashboard values to what's in the file.

**Own domain (optional):** in the worker's **Settings → Domains & Routes**, add a custom domain (e.g. `xerstore.com`). The domain must be added to your Cloudflare account first.

**If the first deploy fails with a D1/database error:** open **Storage & Databases → D1**, create a database named `xer-store`, copy its **Database ID**, and add `"database_id": "<that id>"` next to `"database_name"` in `wrangler.jsonc`. Then deploy again.

**Free plan limits** (as of late 2026): 100,000 requests a day, 5 GB of database storage, 5 million rows read and 100,000 rows written per day. That's plenty for a growing store. Each page view makes roughly 3–6 requests.

**Backups:** in the dashboard under **D1 → xer-store**, use Time Travel to restore to an earlier point. Or download a copy with:

```bash
npx wrangler d1 export xer-store --remote --output backup.sql
```

## Run it on your computer

Requires **Node.js 22.13 or newer**.

```bash
npm install
```

```bash
npm start
```

Open http://localhost:3000. On the first run the app adds 3 demo stores with products. To log in as a demo seller, use `demo@xer.store` / `demo1234`. Other demo sellers are `yonas@xer.store` and `hana@xer.store`, with the same password.

To run the Cloudflare version locally, with a local copy of the D1 database:

```bash
npm run cf:dev
```

### Settings for `npm start` (environment variables)

| Variable    | Default    | What it does                                        |
|-------------|------------|-----------------------------------------------------|
| `PORT`      | `3000`     | Port to listen on                                   |
| `CURRENCY`  | `$`        | Currency shown on prices, e.g. `ETB` or `Br`        |
| `SITE_NAME` | `Xer Store`| Shop name                                           |
| `DATA_DIR`  | `./data`   | Where the database is stored                        |
| `SEED_DEMO` | `true`     | Set to `false` to start with an empty marketplace   |

## Other ways to host

The same code also runs as a normal Node.js server, so any host with a **persistent disk** works. The included `Dockerfile` stores data in `/data`, so mount a volume there.

- **Railway / Render (paid plans):** connect the GitHub repo, add a volume/disk at `/data`, and set `CURRENCY` and `SEED_DEMO=false`.
- **Your own server:**

```bash
docker build -t xer-store .
```

```bash
docker run -d --name xer-store --restart unless-stopped -p 80:3000 -v xer-data:/data -e CURRENCY=ETB -e SEED_DEMO=false xer-store
```

Don't launch a public site with the demo data. The demo accounts use a public password.

## Tests

```bash
npm test
```

To run the same tests against the Cloudflare version, start `npm run cf:dev` on a fresh local database. Then, in a second terminal:

```bash
TEST_BASE_URL=http://127.0.0.1:8787 npm test
```

## Project layout

```
src/app.js              The marketplace API (shared by both runtimes)
src/db-d1.js            Database adapter for Cloudflare D1
src/db-node.js          Database adapter for Node.js SQLite + demo data
src/schema.js           Creates the tables on first run
src/passwords.js        Password hashing (Web Crypto PBKDF2)
migrations/0001_init.sql  Database schema
worker.js               Cloudflare Workers entry point
server.js               Node.js entry point
wrangler.jsonc          Cloudflare settings
public/                 Frontend (no build step): index.html, app.js, styles.css
test/                   API tests (node:test)
```
