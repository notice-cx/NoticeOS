import { execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:tls';
import path from 'node:path';

/** A loopback SMTPS inbox that requires TLS and the invented relay credential. */
export async function identitySmtpFixture(root) {
  const key = path.join(root, 'relay.key'), cert = path.join(root, 'relay.pem'), extension = path.join(root, 'relay-openssl.cnf');
  writeFileSync(extension, '[req]\ndistinguished_name=dn\n[dn]\n[v3]\nsubjectAltName=IP:127.0.0.1\nbasicConstraints=critical,CA:TRUE\n', { mode: 0o600 });
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=127.0.0.1', '-config', extension,
    '-extensions', 'v3', '-keyout', key, '-out', cert], { stdio: 'ignore' });
  const username = 'fixture-relay', password = randomBytes(20).toString('base64url') + ' "\\';
  const from = 'tower@example.test', authentication = `\0${username}\0${password}`;
  const connections = new Set(), inbox = [], recipients = [];
  let rejecting = false;
  const server = createServer({ key: readFileSync(key), cert: readFileSync(cert), minVersion: 'TLSv1.2' }, socket => {
    connections.add(socket);
    socket.once('close', () => connections.delete(socket));
    socket.on('error', () => {});
    socket.setEncoding('utf8');
    let buffer = '', data, authenticating = false, authenticated = false, sender, recipient;
    const say = line => socket.write(line + '\r\n');
    const authenticate = encoded => {
      authenticated = Buffer.from(encoded, 'base64').toString() === authentication;
      authenticating = false;
      say(authenticated ? '235 Authenticated' : '535 Invalid credentials');
    };
    const command = line => {
      if (data) {
        if (line === '.') {
          const headerEnd = data.indexOf('');
          const fromHeaders = headerEnd < 0 ? [] : data.slice(0, headerEnd).filter(header => /^from:/iu.test(header));
          const parsed = fromHeaders.length === 1 && /^from: ([^<>]+) <([^<>]+)>$/iu.exec(fromHeaders[0]);
          const messageFrom = parsed ? { name: parsed[1], address: parsed[2] } : null;
          inbox.push({ sender, recipient, from: messageFrom, wire: data.join('\r\n') });
          data = sender = recipient = undefined;
          say('250 Accepted');
        } else data.push(line.startsWith('..') ? line.slice(1) : line);
      } else if (authenticating) authenticate(line);
      else if (line.startsWith('EHLO ')) say('250-fixture\r\n250 AUTH PLAIN');
      else if (line.startsWith('AUTH PLAIN ')) authenticate(line.slice('AUTH PLAIN '.length));
      else if (line === 'AUTH PLAIN') { authenticating = true; say('334 '); }
      else if (authenticated && line === `MAIL FROM:<${from}>`) {
        sender = from;
        say('250 Sender accepted');
      } else if (authenticated && sender && /^RCPT TO:<[^<>]+>$/u.test(line)) {
        recipient = line.slice('RCPT TO:<'.length, -1);
        recipients.push(recipient);
        say(rejecting ? '451 Fixture temporarily unavailable' : '250 Recipient accepted');
      } else if (authenticated && recipient && !rejecting && line === 'DATA') { data = []; say('354 Send message'); }
      else if (line === 'QUIT') socket.end('221 Goodbye\r\n');
      else say('550 Refused');
    };
    socket.on('data', chunk => {
      buffer += chunk;
      if (buffer.length > 8192) { socket.destroy(); return; }
      let end;
      while ((end = buffer.indexOf('\r\n')) !== -1) {
        command(buffer.slice(0, end)); buffer = buffer.slice(end + 2);
      }
    });
    say('220 fixture ESMTP');
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return {
    declaration: { format: 'noticeos-identity-smtp/1', from, url: `smtps://127.0.0.1:${server.address().port}`, username, password },
    inbox, recipients,
    launch: (executable, args, options) => spawn(executable, [...args, '--cacert', cert], options),
    reject(value = true) { rejecting = value; },
    async close() {
      for (const socket of connections) socket.destroy();
      await new Promise(resolve => server.close(resolve));
    },
  };
}
