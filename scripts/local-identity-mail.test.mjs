import assert from 'node:assert/strict';
import { chmodSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { readLocalIdentityMail, smtpIdentityMail } from './local-identity-mail.mjs';
import { testFixtureRoot } from './test-fixture-root.mjs';
import { identitySmtpFixture } from './test-fixtures/identity-smtp.mjs';

test('only a valid, private local relay declaration can select the sign-in sender', t => {
  const root = testFixtureRoot('n-smtp-config-');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const plan = path.join(root, 'runtime.json'), file = path.join(root, 'mail.json');
  const base = { format: 'noticeos-identity-smtp/1', url: 'smtps://relay.example.test:465', from: 'tower@example.test', username: 'fixture', password: 'synthetic' };
  const read = (update = {}) => {
    writeFileSync(file, JSON.stringify({ ...base, ...update }), { mode: 0o600 });
    return readLocalIdentityMail('mail.json', plan);
  };
  const config = read();
  assert.equal(config.url, base.url);
  assert.equal(config.from, base.from);
  for (const update of [{ url: 'smtp://relay.example.test' }, { url: base.url + '/other' }, { url: base.url + '?extra=1' },
    { url: 'smtps://private@relay.example.test' }, { from: 'tower@example.test\nBcc: other@example.test' }, { password: '\n--other' }]) {
    assert.throws(() => read(update), /delivery unavailable/u);
  }
  read();
  chmodSync(file, 0o644);
  assert.throws(() => readLocalIdentityMail('mail.json', plan), /delivery unavailable/u);
  chmodSync(file, 0o600);
  symlinkSync(file, path.join(root, 'alias.json'));
  assert.throws(() => readLocalIdentityMail('alias.json', plan), /delivery unavailable/u);
  assert.throws(() => readLocalIdentityMail('../mail.json', plan), /delivery unavailable/u);
});

test('SMTP delivery authenticates over TLS, limits the recipient and reports refusal without returning a code', { timeout: 15_000 }, async t => {
  const root = testFixtureRoot('n-smtp-relay-');
  let relay;
  t.after(async () => { await relay?.close(); rmSync(root, { recursive: true, force: true }); });
  relay = await identitySmtpFixture(root);
  const { from } = relay.declaration;
  const recipient = 'owner@example.test';
  const message = { from, to: recipient, subject: 'Your NoticeOS sign-in code', text: 'Your NoticeOS sign-in code is 123456.' };
  await assert.rejects(smtpIdentityMail(relay.declaration, email => email === recipient)(message), /unavailable/u);
  assert.deepEqual(relay.recipients, []);
  const delivery = smtpIdentityMail(relay.declaration, email => email === recipient, { launch(executable, args, options) {
    assert.ok(![...args, ...Object.values(options.env)].some(item => /123456|\bfixture-relay\b/u.test(item) || item.includes(relay.declaration.password)));
    return relay.launch(executable, args, options);
  } });
  await assert.rejects(delivery({ ...message, to: 'foreign@example.test' }), /unavailable/u);
  await assert.rejects(delivery({ ...message, subject: 'Forged\nBcc: foreign@example.test' }), /unavailable/u);
  assert.deepEqual(relay.recipients, []);
  const id = await delivery(message);
  assert.deepEqual(relay.recipients, [recipient]);
  assert.equal(relay.inbox.length, 1);
  assert.equal(relay.inbox[0].sender, from);
  assert.deepEqual(relay.inbox[0].from, { name: 'NoticeOS', address: from });
  assert.ok(relay.inbox[0].wire.includes(`Message-ID: <${id}@example.test>`));
  assert.equal(relay.inbox[0].wire.split('\r\n\r\n')[1], message.text);
  relay.reject();
  await assert.rejects(delivery(message), error => /^Identity mail delivery unavailable\.$/u.test(error.message));
  assert.equal(relay.inbox.length, 1);
});
