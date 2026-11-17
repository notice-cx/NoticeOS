import net from 'node:net';
import { MANAGED_START_PORTS } from '../start-postgres.mjs';

/** The customer launcher binds its HTTP port and a database two ports later. */
export async function availableCustomerPort() {
  for (let attempt = 0; attempt < 12; attempt++) {
    const reservations = [];
    const bind = async port => {
      const server = net.createServer();
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', resolve);
      });
      reservations.push(server);
      return server.address().port;
    };
    try {
      const port = await bind(0);
      if (port > 65_533 || [port, port + 2].some(value => MANAGED_START_PORTS.includes(value))) continue;
      await bind(port + 2);
      return port;
    } catch (error) {
      if (error.code !== 'EADDRINUSE') throw error;
    } finally {
      await Promise.all(reservations.map(server => new Promise(resolve => server.close(resolve))));
    }
  }
  throw new Error('Could not reserve the two ports for the local customer fixture.');
}
