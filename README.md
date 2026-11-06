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
