// Delegate lifecycle to the maintained compiled launcher; no env/profile fallback.
if (process.argv.length !== 2) throw new Error('Demo entry refuses arguments.');
process.argv = [process.execPath, new URL('../../scripts/hosted-demo-serve.mjs', import.meta.url).pathname,
  '--runtime-file', '/state/runtime/runtime.json'];
await import('../../scripts/hosted-demo-serve.mjs');
