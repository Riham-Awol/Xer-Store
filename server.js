// Run Xer Store as a normal Node.js server (your computer, Docker, a VPS…).
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createApp } from './src/app.js';
import { openNodeDb, seedDemo } from './src/db-node.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');
const PORT = Number(process.env.PORT) || 3000;

const db = openNodeDb(DATA_DIR);
if (process.env.SEED_DEMO !== 'false') await seedDemo(db);

const legacyUploads = path.join(DATA_DIR, 'uploads');
const app = createApp({
  db,
  currency: process.env.CURRENCY || '$',
  siteName: process.env.SITE_NAME || 'Xer Store',
  publicDir: path.join(ROOT, 'public'),
  legacyUploadsDir: fs.existsSync(legacyUploads) ? legacyUploads : undefined,
});

app.listen(PORT, () => console.log(`Xer Store running at http://localhost:${PORT}`));
