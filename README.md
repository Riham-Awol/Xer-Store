# Xer Store

A multi-store marketplace for resellers who bring products from **Shein**, **Amazon** and other places and sell them locally.

- **Sellers** create an account, open their own store (name, logo, phone/WhatsApp, city, social link, color) and post products.
- Every product has a **category** and an **availability**:
  - **● Available now**: the seller has it on hand. Stock counts down with each order and shows "Sold out" at 0.
  - **⏱ By order**: the seller orders it from Shein/Amazon after the customer buys, with an estimated delivery time.
- **Shoppers** see the **stores at the top** of the home page, then products **listed by category**. Each product card shows the store it comes from. They can filter by category, availability, source (Shein/Amazon) and price, and search.
- **Cart and checkout** work across stores. A cart with items from 2 stores becomes 2 orders, one per store. Payment is on delivery or arranged with the store.
- **Order tracking**: customers track an order with its code and phone number. Sellers update the status (New → Confirmed → Ordered from supplier → Arrived → Out for delivery → Delivered, or Cancelled). Cancelling puts in-stock items back in stock.

## Run it

Requires **Node.js 22.13 or newer** (uses the built-in SQLite).

```bash
npm install
```

```bash
npm start
```

Open http://localhost:3000.

On the first run the app adds 3 demo stores with products. To log in as a demo seller, use `demo@xer.store` / `demo1234`. Other demo sellers are `yonas@xer.store` and `hana@xer.store`, with the same password.

## Settings (environment variables)

| Variable    | Default    | What it does                                        |
|-------------|------------|-----------------------------------------------------|
| `PORT`      | `3000`     | Port to listen on                                   |
| `CURRENCY`  | `$`        | Currency shown on prices, e.g. `ETB` or `Br`        |
| `SITE_NAME` | `Xer Store`| Name used in the API config                         |
| `DATA_DIR`  | `./data`   | Where the database and uploaded images are stored   |
| `SEED_DEMO` | `true`     | Set to `false` to start with an empty marketplace   |

Example:

```bash
CURRENCY=ETB SEED_DEMO=false npm start
```

## Hosting (putting it online)

The app keeps its database and uploaded photos in one folder (`DATA_DIR`). **The host must give you a persistent disk/volume for that folder.** Without one, all stores, products and orders are erased whenever the app restarts or redeploys. Free plans without a disk are only good for a quick demo.

The repo includes a `Dockerfile` that stores data in `/data`. Any host that runs Docker can use it.

### Option A: Railway (easiest)

1. Merge this code into the `main` branch on GitHub.
2. Go to railway.com and sign in with GitHub.
3. **New Project → Deploy from GitHub repo** and pick `xer-store`. Railway finds the `Dockerfile` and builds it.
4. In the service, **add a Volume** with mount path `/data`.
5. Under **Variables**, add:
   - `CURRENCY` = `ETB` (or your currency)
   - `SEED_DEMO` = `false` (start without demo stores)
6. Under **Settings → Networking**, click **Generate Domain**. You get a public `https://….up.railway.app` link.
7. Optional: add your own domain (e.g. `xerstore.com`) in the same Networking section, then add the DNS record it shows you at your domain registrar.

### Option B: Render

1. Merge the code into `main`.
2. On render.com: **New → Web Service** → connect the GitHub repo. Render detects the `Dockerfile`.
3. Choose a **paid instance** (the free one has no disk and sleeps when idle).
4. Under **Disks**, add a disk with mount path `/data` (1 GB is plenty to start).
5. Add environment variables `CURRENCY` and `SEED_DEMO=false`.
6. Set the health check path to `/healthz` and deploy. Render gives you an `https://….onrender.com` link.

### Option C: Your own VPS (DigitalOcean, Hetzner, etc.)

```bash
git clone https://github.com/riham-awol/xer-store.git && cd xer-store
```

```bash
docker build -t xer-store .
```

```bash
docker run -d --name xer-store --restart unless-stopped -p 80:3000 -v xer-data:/data -e CURRENCY=ETB -e SEED_DEMO=false xer-store
```

For HTTPS on a VPS, put a reverse proxy such as Caddy in front of it.

### After it's live

- **Don't launch with the demo data.** The demo seller accounts use a public password (`demo1234`). Start with `SEED_DEMO=false`. If you already started with demo data, use a fresh volume.
- **Back up** the `/data` folder regularly. It holds everything: `xer-store.db` plus the `uploads/` photos.
- Updating is automatic on Railway and Render: push to `main` and they redeploy. Your data on the volume stays.

## Tests

```bash
npm test
```

## Project layout

```
server.js        Express API and static file server
db.js            SQLite schema, categories, demo data, password helpers
public/          Frontend (no build step): index.html, app.js, styles.css
test/            API tests (node:test)
data/            Created at runtime: database + uploaded images (git-ignored)
```
