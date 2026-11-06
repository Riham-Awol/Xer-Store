// Database adapter for Cloudflare D1.
// Every adapter exposes the same async API: get, all, run, batch (atomic).
export function d1Adapter(d1) {
  const stmt = (sql, params) => d1.prepare(sql).bind(...params);
  return {
    async get(sql, ...params) {
      return (await stmt(sql, params).first()) ?? null;
    },
    async all(sql, ...params) {
      return (await stmt(sql, params).all()).results;
    },
    async run(sql, ...params) {
      const { meta } = await stmt(sql, params).run();
      return { changes: meta.changes, lastId: meta.last_row_id };
    },
    /** Runs [[sql, ...params], ...] as one transaction: all succeed or none do. */
    async batch(statements) {
      if (statements.length) await d1.batch(statements.map(([sql, ...params]) => stmt(sql, params)));
    },
  };
}
