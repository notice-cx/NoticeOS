import fs from 'node:fs';
import net from 'node:net';
import http from 'node:http';
// Native HTTP preserves the fixed public Host while dialing only loopback.
// Fetch may replace that header with the private destination's authority.
function healthRequest(url, options) {
  return new Promise((resolve, reject) => {
    let result, failure;
    const call = http.get(url, { ...options, agent: false }, response => {
      const okay = response.statusCode >= 200 && response.statusCode < 300;
      if (!okay) {
        result = { ok: false };
        response.destroy(); call.destroy();
        return;
      }
      const chunks = []; let bytes = 0;
      response.on('error', error => { failure = error; call.destroy(error); });
      response.on('data', chunk => {
        bytes += chunk.length;
        if (bytes > 16 * 1024) { call.destroy(new Error('Health response too large.')); return; }
        chunks.push(chunk);
      });
      response.on('end', () => { result = { ok: true, json: async () => JSON.parse(Buffer.concat(chunks).toString('utf8')) }; });
    });
    call.on('error', error => { failure = error; });
    call.once('close', () => failure ? reject(failure) : result ? resolve(result) : reject(new Error('Health response unavailable.')));
  });
}
export async function demoHealth(runtimeFile, request = healthRequest) {
  try {
    if (fs.realpathSync(runtimeFile) !== runtimeFile || !fs.lstatSync(runtimeFile).isFile() || fs.statSync(runtimeFile).size > 2 * 1024 * 1024) return false;
    const runtime = JSON.parse(fs.readFileSync(runtimeFile, 'utf8'));
    if (!Number.isInteger(runtime.listen.port) || runtime.listen.port < 1 || runtime.listen.port > 65535) return false;
    const response = await request(`http://127.0.0.1:${runtime.listen.port}/__noticeos_health`, { headers: { host: new URL(runtime.publicOrigin).host }, signal: AbortSignal.timeout(2000) });
    if (!response.ok) return false;
    return (await response.json()).ok === true;
  } catch { return false; }
}
export async function doltHealth() {
  return new Promise(resolve => {
    const socket = net.connect({ host: '127.0.0.1', port: 3306 });
    const finish = value => { socket.destroy(); resolve(value); };
    socket.setTimeout(2000); socket.once('connect', () => finish(true)); socket.once('error', () => finish(false)); socket.once('timeout', () => finish(false));
  });
}
if (process.argv[1] === import.meta.filename) {
  try {
    const args = process.argv.slice(2);
    const okay = args.length === 1 && args[0] === '--dolt' ? await doltHealth()
      : args.length === 2 && args[0] === '--runtime' ? await demoHealth(args[1]) : false;
    process.exitCode = okay ? 0 : 1;
  } catch { process.exitCode = 1; }
}
