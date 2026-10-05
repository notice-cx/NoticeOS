// Initialize only the local bootstrap administrator, never a broad task user.
import fs from 'node:fs';
import { spawn } from 'node:child_process';
const root = '/dolt', marker = `${root}/.noticeos-demo-initialized`;
try {
  if (process.argv.length !== 2 || fs.realpathSync(root) !== root) throw new Error();
  fs.mkdirSync('/tmp/home/.dolt', { recursive: true, mode: 0o700 });
  fs.writeFileSync('/tmp/home/.dolt/config_global.json', '{"metrics.disabled":"true","versioncheck.disabled":"true"}\n', { mode: 0o600 });
  if (!fs.existsSync(marker)) {
    if (fs.readdirSync(root).length) throw new Error();
    const file = '/setup/dolt-password';
    if (fs.realpathSync(file) !== file || !fs.lstatSync(file).isFile() || (fs.statSync(file).mode & 0o777) !== 0o600) throw new Error();
    const password = fs.readFileSync(file, 'utf8').trim();
    if (!/^[a-f0-9]{64}$/u.test(password)) throw new Error();
    const sql = `CREATE USER 'noticeos_owner'@'localhost' IDENTIFIED BY '${password}'; GRANT ALL PRIVILEGES ON *.* TO 'noticeos_owner'@'localhost' WITH GRANT OPTION; DROP USER IF EXISTS 'root'@'localhost';`;
    const child = spawn('/usr/local/bin/dolt', ['--data-dir=/dolt', '--doltcfg-dir=/dolt/.doltcfg', 'sql', '--batch'], { cwd: root, stdio: ['pipe', 'ignore', 'ignore'] });
    const timeout = setTimeout(() => child.kill('SIGKILL'), 15000);
    child.stdin.on('error', () => {}); child.stdin.end(sql);
    const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); }).finally(() => clearTimeout(timeout));
    if (code !== 0) throw new Error();
    fs.writeFileSync(marker, '1\n', { flag: 'wx', mode: 0o600 });
  } else if (fs.realpathSync(marker) !== marker || !fs.lstatSync(marker).isFile() || fs.readFileSync(marker, 'utf8') !== '1\n') throw new Error();
  const child = spawn('/usr/local/bin/dolt', ['sql-server', '--config=/opt/noticeos/deploy/demo/dolt.yaml'], { cwd: root, stdio: 'inherit' });
  const stop = signal => child.kill(signal);
  const term = () => stop('SIGTERM'), interrupt = () => stop('SIGINT');
  process.on('SIGTERM', term); process.on('SIGINT', interrupt);
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  process.off('SIGTERM', term); process.off('SIGINT', interrupt); process.exitCode = code ?? 1;
} catch { process.stderr.write('Demo task database unavailable; preserve its volume for recovery.\n'); process.exitCode = 1; }
