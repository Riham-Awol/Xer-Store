// Run Xer Store on Cloudflare Workers. The frontend (public/) is served as static
// assets; requests for /api, /images and /healthz reach the Express app below.
import { env } from 'cloudflare:workers';
import { httpServerHandler } from 'cloudflare:node';
import { createApp } from './src/app.js';
import { d1Adapter } from './src/db-d1.js';
import { ensureSchema } from './src/schema.js';
import schemaSql from './migrations/0001_init.sql';

const db = d1Adapter(env.DB);
const app = createApp({
  db,
  currency: env.CURRENCY || '$',
  siteName: env.SITE_NAME || 'Xer Store',
});
app.listen(3000);
const handler = httpServerHandler({ port: 3000 });

let ready; // creates the database tables once, on the first request
export default {
  async fetch(request, workerEnv, ctx) {
    ready ??= ensureSchema(db, schemaSql).catch((err) => {
      ready = undefined;
      throw err;
    });
    await ready;
    return handler.fetch(request, workerEnv, ctx);
  },
};
