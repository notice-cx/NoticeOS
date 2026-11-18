import { existsSync } from 'node:fs';
import path from 'node:path';
import { openCustomerOperating } from './local-customer-operating.mjs';
import { localMailbox, privateDirectory, startCustomerRuntime } from './local-customer.mjs';
import { startLocalCustomerSchedules } from './local-customer-schedules.mjs';
import { smtpIdentityMail } from './local-identity-mail.mjs';

/** Start the same customer app without provisioning, rotating logins or
 * changing database ownership. This controller owns the single scheduler. */
export async function startAttachedCustomer(plan, file, {
  startSchedules = startLocalCustomerSchedules, googleTransport, collectorTransport = googleTransport, dataForSeoTransport, smtpLaunch,
} = {}) {
  const db = await openCustomerOperating(plan, file);
  return startPreparedCustomer(plan, db, { startSchedules, collectorTransport, dataForSeoTransport, smtpLaunch });
}

export async function startPreparedCustomer(plan, db, {
  startSchedules = startLocalCustomerSchedules, googleTransport, collectorTransport = googleTransport, googleSetupTransport, dataForSeoTransport, smtpLaunch, deployment,
} = {}) {
  const { operating, signal } = db;
  let app, closing;
  const close = () => {
    closing ??= (async () => {
      try { await app?.close(); } finally { await db.close(); }
    })();
    return closing;
  };
  const whenLost = new Promise(resolve => {
    const lost = () => { resolve(signal.reason); if (app) void close().catch(() => {}); };
    if (signal.aborted) lost();
    else signal.addEventListener('abort', lost, { once: true });
  });
  try {
    const owned = dir => privateDirectory(dir, !existsSync(dir));
    const customer = owned(db.customer);
    const membershipMail = operating.mailRecipients === undefined;
    if (membershipMail && !operating.mailDelivery) throw new Error('Customer mail requires a configured relay or recipient list.');
    const outbox = operating.mailDelivery ? undefined : owned(path.join(customer, 'mail'));
    // Only the private Tower binding can submit a message. In membership mode
    // the fixed invitation and sign-in routes authorize its recipient.
    const accepts = email => membershipMail || operating.mailRecipients.includes(email.toLowerCase());
    const deliver = operating.mailDelivery ? smtpIdentityMail(operating.mailDelivery, accepts, { launch: smtpLaunch, signal })
      : localMailbox(outbox, accepts);
    app = await startCustomerRuntime(plan, { customer, outbox, workerState: deployment?.workerState ?? owned(path.join(customer, 'worker-state')),
      deliver, mailFrom: operating.mailDelivery?.from, membershipMail,
      workspaces: operating.workspaces, connectionString: db.address, identityDatabase: operating.identityAddress,
      grantConnectionString: operating.grantAddress, credentialsKey: operating.credentialsKey,
      identitySecret: operating.identitySecret, ntasksOrigin: operating.ntasksOrigin,
      startSchedules, resumeSince: db.resumeSince, backupResumeSince: db.backupResumeSince, deployment,
      operating: { googleDaily: operating.googleDaily, extendedArchives: operating.extendedArchives, collectorTransport, googleSetupTransport,
        collectorProviders: operating.collectorProviders, sitePulls: operating.sitePulls,
        siteChecks: operating.siteChecks, revenueNotices: operating.revenueNotices, taskFollowups: operating.taskFollowups,
        paidDataForSeo: operating.paidDataForSeo, dataForSeoTransport,
        siteReports: operating.siteReports, signal } });
    db.ready();
    return Object.freeze({ ...app, whenLost, close });
  } catch (error) {
    await close();
    throw error;
  }
}
