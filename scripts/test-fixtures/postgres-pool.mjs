// pg-pool can resolve end() after removing a client but before that client's
// socket has ended. A disposable server must outlive those disconnections.
export function trackFixturePool(pool) {
  const clients = new Set();
  const errors = [];
  let closing;
  pool.on('error', error => errors.push(error));
  pool.on('connect', client => {
    let ended;
    const promise = new Promise(resolve => { ended = resolve; });
    clients.add(promise);
    client.once('end', () => { clients.delete(promise); ended(); });
  });
  return () => closing ??= (async () => {
    let timer;
    try {
      await Promise.race([
        (async () => { await pool.end(); await Promise.all([...clients]); })(),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Fixture PostgreSQL clients did not disconnect')), 5000); }),
      ]);
      if (errors.length) throw new AggregateError(errors, 'Fixture PostgreSQL pool failed');
    } finally { clearTimeout(timer); }
  })();
}
