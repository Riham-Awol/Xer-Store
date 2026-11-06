// Creates the tables on first run, so a fresh Cloudflare D1 database needs no setup command.
// The SQL lives in migrations/0001_init.sql and every statement in it is idempotent.

/** Splits a .sql file into single statements (handles CREATE TRIGGER … BEGIN … END blocks). */
export function splitSql(sql) {
  const statements = [];
  let buf = [];
  let inTrigger = false;
  for (const line of sql.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('--')) continue;
    buf.push(line);
    if (/^CREATE TRIGGER/i.test(t)) inTrigger = true;
    if (inTrigger ? /^END;$/i.test(t) : t.endsWith(';')) {
      statements.push(buf.join('\n').trim().replace(/;$/, ''));
      buf = [];
      inTrigger = false;
    }
  }
  return statements;
}

export async function ensureSchema(db, sql) {
  // The batch is atomic, so if the last table exists the whole schema is in place.
  const done = await db.get(
    "SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = 'images'"
  );
  if (done) return false;
  await db.batch(splitSql(sql).map((s) => [s]));
  return true;
}
