import * as fs from 'node:fs';
import path from 'node:path';

const inspectFormat = '{"id":{{json .Id}},"name":{{json .Name}},"image":{{json .Config.Image}},"labels":{{json .Config.Labels}},"mounts":{{json .Mounts}},"ports":{{json .HostConfig.PortBindings}}}';

// Only disposable proof resources belong here. A failed absence check keeps
// their files and a bounded receipt; daemon errors never mean "not found".
export function containerProofCleanup({ base, project, image, mounts, runDocker }) {
  if (!/^noticeos-start-[a-z0-9]+$/u.test(project)) throw new Error('Declare a disposable proof project.');
  const tracked = [];
  const failures = [];
  let uncertainCreation = false;
  const receipt = { project, oneOffs: [], actions: [] };
  const save = () => fs.writeFileSync(path.join(base, 'cleanup-receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
  const fail = message => { failures.push(message); receipt.failures = [...failures]; save(); throw new Error(message); };
  const call = async (args, timeoutMs = 30_000) => {
    let result;
    try { result = await runDocker(args, { timeoutMs }); }
    catch { return fail('The proof resource command did not finish.'); }
    receipt.actions.push({ operation: args.slice(0, 2).join(' '), code: result.code, timedOut: result.timedOut === true });
    save();
    return result;
  };
  const ids = async (kind, filter) => {
    const result = await call([kind, 'ls', ...(kind === 'container' ? ['--all', '--no-trunc'] : ['--no-trunc']), '--filter', filter, '--format', '{{.ID}}']);
    if (result.code !== 0) return fail('The proof could not verify resource absence.');
    const found = result.stdout.trim().split(/\s+/u).filter(Boolean);
    if (found.some(id => !/^[a-f0-9]{64}$/u.test(id))) return fail('The proof received an invalid resource identity.');
    return found;
  };
  const named = name => ids('container', `name=^/${name}$`);
  const owned = async record => {
    const found = await named(record.name);
    if (!found.length) return null;
    if (found.length !== 1) return fail('The proof container name is ambiguous.');
    const result = await call(['container', 'inspect', found[0], '--format', inspectFormat]);
    if (result.code !== 0) return fail('The proof could not verify container ownership.');
    let container;
    try { container = JSON.parse(result.stdout); } catch { return fail('The proof received invalid container metadata.'); }
    const labels = container.labels ?? {};
    const actualMounts = container.mounts ?? [];
    if (container.id !== found[0] || (record.id && container.id !== record.id)
      || container.name !== `/${record.name}` || container.image !== image
      || labels['com.docker.compose.project'] !== project
      || labels['com.docker.compose.service'] !== record.service
      || labels['com.docker.compose.oneoff'] !== 'True'
      || Object.keys(container.ports ?? {}).length !== 0
      || actualMounts.length !== mounts.length
      || actualMounts.some(actual => actual.Type !== 'bind' || !mounts.some(expected => actual.Source === expected.source && actual.Destination === expected.destination))) {
      return fail('The proof refused a container outside its declared ownership.');
    }
    record.id = container.id;
    save();
    return container;
  };
  const retire = async record => {
    const container = await owned(record);
    if (container) {
      // The immutable ID prevents replacement names from being removed.
      await call(['container', 'rm', '--force', container.id]);
    }
    if ((await named(record.name)).length) return fail('The proof container remains after cleanup.');
    record.absent = true;
    save();
  };
  const absent = async () => {
    if ((await ids('container', `label=com.docker.compose.project=${project}`)).length) return fail('The proof project still has containers.');
    if ((await ids('network', `name=^${project}_default$`)).length) return fail('The proof network remains after cleanup.');
  };
  return {
    // Call before enabling teardown, while no resource has been created.
    async proveFresh() { await absent(); },
    async oneOff(launch, { service = 'noticeos', timeoutMs = 240_000 } = {}) {
      if (!/^[a-z][a-z0-9-]*$/u.test(service)) throw new Error('Declare the proof service.');
      const record = { name: `${project}-proof-${tracked.length + 1}`, service };
      if ((await named(record.name)).length) return fail('The proof container name already exists.');
      tracked.push(record); receipt.oneOffs.push(record); save();
      try {
        // Do not use --rm: keep exit status and logs until explicit retirement.
        let started;
        try { started = await launch(['run', '--detach', '--no-deps', '--name', record.name, service]); }
        catch { uncertainCreation = true; return fail('Container creation did not finish; its files require explicit recovery.'); }
        record.launch = { code: started.code, timedOut: started.timedOut === true }; save();
        if (started.timedOut) { uncertainCreation = true; return fail('Container creation timed out; its files require explicit recovery.'); }
        if (started.code !== 0) return started;
        const container = await owned(record);
        if (!container) return fail('The proof container disappeared before its identity was verified.');
        const waited = await call(['container', 'wait', container.id], timeoutMs);
        const logs = await call(['container', 'logs', '--tail', '200', container.id]);
        if (logs.code !== 0) return fail('The proof could not read its container result.');
        const exit = waited.stdout.trim();
        if (waited.code === 0 && !/^\d+$/u.test(exit)) return fail('The proof received an invalid container exit status.');
        return { code: waited.code === 0 ? Number(exit) : waited.code, timedOut: waited.timedOut === true, stdout: logs.stdout, stderr: logs.stderr };
      } finally { await retire(record); }
    },
    async finish(teardowns) {
      let safeToTearDown = !uncertainCreation;
      for (const record of tracked) {
        try { await retire(record); }
        catch { safeToTearDown = false; /* Still retire independently verified one-offs. */ }
      }
      // Compose must not reach a replacement service that identity checks refused.
      if (!safeToTearDown) { receipt.teardownSkipped = 'Resource ownership or creation remains uncertain.'; save(); }
      for (const teardown of safeToTearDown ? teardowns : []) {
        try {
          const result = await teardown();
          receipt.actions.push({ operation: 'compose down', code: result.code, timedOut: result.timedOut === true }); save();
          if (result.code !== 0) fail('The proof project teardown did not finish.');
        } catch (error) { if (!failures.includes(error.message)) { failures.push('The proof project teardown did not finish.'); receipt.failures = [...failures]; save(); } }
      }
      try { await absent(); } catch { /* Absence failures are already recorded. */ }
      if (failures.length) throw new Error(`Proof cleanup failed; preserved fixture and receipt at ${base}.`);
      receipt.complete = true; save();
      fs.rmSync(base, { recursive: true, force: true });
      return structuredClone(receipt);
    },
  };
}
