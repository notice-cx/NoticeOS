// One installation folder, one fixed layout: what `pnpm os:setup` makes and
// `pnpm os:adopt` moves an installation into, and what deploy/compose/stack.yaml
// reads through the folder's installation.env.
//
//   <installation>/
//     installation.env     the choices below, then the layout derived from the folder
//     state/               the app's /state: settings exports, bootstrap secrets, logs, task client
//     spokes/              the app's /spokes: task repositories (a choice; default here)
//     postgres-secrets/    the Postgres logins' verifiers and addresses
//     dolt-secrets/        the task server's passwords
//     backup/profile/      the backup worker's declaration
//     backup/staging/, backup/transport/   the backup's working folders
//     backup/assets/       exporter checkouts (a choice; default here)
//     backup/offsite/      where finished backups are handed off (a choice; default here)
//
// The checkout's `.local/stack.json` names the folder's installation.env and
// the stack's files; the os:* commands read nothing else.

import { existsSync, lstatSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const ENV_FILE = 'installation.env';
/** The stack definition and its optional backup layer, from a checkout. */
export const stackFiles = (root = ROOT, { backup = true } = {}) => [
  path.join(root, 'deploy', 'compose', 'stack.yaml'),
  ...(backup ? [path.join(root, 'deploy', 'compose', 'backup.compose.yaml')] : []),
];

/** Each folder of the layout, relative to the installation folder. */
export const LAYOUT = Object.freeze({
  state: 'state',
  spokes: 'spokes',
  postgresSecrets: 'postgres-secrets',
  doltSecrets: 'dolt-secrets',
  backupProfile: 'backup/profile',
  backupStaging: 'backup/staging',
  backupTransport: 'backup/transport',
  backupAssets: 'backup/assets',
  backupOffsite: 'backup/offsite',
});

/** Every path of the installation in `dir`. */
export function installationPaths(dir) {
  const own = Object.fromEntries(Object.entries(LAYOUT).map(([key, relative]) => [key, path.join(dir, relative)]));
  return { dir, env: path.join(dir, ENV_FILE), ...own };
}

/** Defaults a new installation starts from. */
export const DEFAULTS = Object.freeze({ project: 'noticeos', towerPort: 5173, postgresPort: 5432, doltPort: 3306 });

/** The variables an installation chooses, in the order the file lists them. */
const CHOICES = [
  ['COMPOSE_PROJECT_NAME', 'project'],
  ['NOTICEOS_INSTALLATION', 'dir'],
  ['NOTICEOS_APP_IMAGE', 'image'],
  ['NOTICEOS_APP_UID', 'uid'],
  ['NOTICEOS_APP_GID', 'gid'],
  ['NOTICEOS_TOWER_PORT', 'towerPort'],
  ['TOWER_ALLOWED_HOSTS', 'allowedHosts'],
  ['NOTICEOS_POSTGRES_PORT', 'postgresPort'],
  ['NOTICEOS_DOLT_PORT', 'doltPort'],
  ['NOTICEOS_POSTGRES_VOLUME', 'postgresVolume'],
  ['NOTICEOS_DOLT_VOLUME', 'doltVolume'],
  ['NOTICEOS_SPOKES_DIR', 'spokes'],
  ['NOTICEOS_BACKUP_ASSETS_DIR', 'backupAssets'],
  ['NOTICEOS_BACKUP_OFFSITE_PARENT', 'backupOffsite'],
];

/** The layout: each follows from the folder, the project or another choice. */
const DERIVED = [
  ['NOTICEOS_STATE_DIR', '${NOTICEOS_INSTALLATION}/' + LAYOUT.state],
  ['NOTICEOS_POSTGRES_SECRETS', '${NOTICEOS_INSTALLATION}/' + LAYOUT.postgresSecrets],
  ['NOTICEOS_DOLT_SECRETS', '${NOTICEOS_INSTALLATION}/' + LAYOUT.doltSecrets],
  ['NOTICEOS_BACKUP_PROFILE_DIR', '${NOTICEOS_INSTALLATION}/' + LAYOUT.backupProfile],
  ['NOTICEOS_BACKUP_STAGING_DIR', '${NOTICEOS_INSTALLATION}/' + LAYOUT.backupStaging],
  ['NOTICEOS_BACKUP_TRANSPORT_DIR', '${NOTICEOS_INSTALLATION}/' + LAYOUT.backupTransport],
  ['NOTICEOS_DOLT_BACKUP_VOLUME', '${NOTICEOS_DOLT_VOLUME}'],
  ['NOTICEOS_NETWORK', '${COMPOSE_PROJECT_NAME}_installation'],
];

const PROJECT = /^[a-z0-9][a-z0-9_-]{0,62}$/u;
const VOLUME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u;
const HOSTS = /^[A-Za-z0-9.:, -]{0,512}$/u;
const IMAGE = /^(?:sha256:[a-f0-9]{64}|[a-z0-9][a-z0-9._/-]{0,127}(?::[A-Za-z0-9_.-]{1,128})?(?:@sha256:[a-f0-9]{64})?)$/u;
// A path is written inside double quotes, where Compose expands `$` and reads
// `\` and `"` as escapes; none of those, and no line break, may be in one.
const PLAIN_PATH = /^\/[^"\\$\r\n\0]*$/u;

function fail(message) { throw new Error(message); }
const port = (value, name) => {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1024 || number > 65535) fail(`${name} must be a port from 1024 to 65535, not ${value}.`);
  return number;
};
const folder = (value, name) => {
  if (typeof value !== 'string' || !PLAIN_PATH.test(value) || path.normalize(value) !== value.replace(/(.)\/+$/u, '$1')) {
    fail(`${name} must be an absolute folder path without quotes, backslashes or $ (got ${JSON.stringify(value)}).`);
  }
  return value;
};

/** The choices checked and completed with the defaults that follow from the folder and project. */
export function installationChoices(input) {
  const dir = folder(input.dir, 'The installation folder');
  const project = input.project ?? DEFAULTS.project;
  if (!PROJECT.test(project)) fail(`The project name must be lower-case letters, digits, - and _ (got ${JSON.stringify(project)}).`);
  if (typeof input.image !== 'string' || !IMAGE.test(input.image)) fail('The app image must be an image ID or a plain image reference.');
  for (const id of ['uid', 'gid']) if (!Number.isInteger(input[id]) || input[id] < 0 || input[id] > 2 ** 31) fail(`The app ${id} must be a whole number.`);
  const allowedHosts = input.allowedHosts ?? '';
  if (!HOSTS.test(allowedHosts)) fail('TOWER_ALLOWED_HOSTS lists hostnames, separated by commas or spaces.');
  const volume = (value, fallback, name) => {
    const chosen = value ?? fallback;
    if (!VOLUME.test(chosen)) fail(`${name} must be a Docker volume name (got ${JSON.stringify(chosen)}).`);
    return chosen;
  };
  const optionalFolder = (value, name) => value === undefined || value === null ? null : folder(value, name);
  return {
    dir,
    project,
    image: input.image,
    uid: input.uid,
    gid: input.gid,
    towerPort: port(input.towerPort ?? DEFAULTS.towerPort, 'The Tower port'),
    allowedHosts,
    postgresPort: port(input.postgresPort ?? DEFAULTS.postgresPort, 'The Postgres port'),
    doltPort: port(input.doltPort ?? DEFAULTS.doltPort, 'The task server port'),
    postgresVolume: volume(input.postgresVolume, `${project}_postgres-data`, 'The Postgres volume'),
    doltVolume: volume(input.doltVolume, `${project}_dolt-data`, 'The task data volume'),
    spokes: optionalFolder(input.spokes, 'The task repositories folder'),
    backupAssets: optionalFolder(input.backupAssets, 'The exporter checkouts folder'),
    backupOffsite: optionalFolder(input.backupOffsite, 'The offsite folder'),
  };
}

/** The installation.env text for `choices` (see installationChoices). */
export function renderInstallationEnv(input) {
  const choices = installationChoices(input);
  const value = (key) => {
    const own = choices[key];
    if (own !== null) return String(own);
    return `\${NOTICEOS_INSTALLATION}/${LAYOUT[key]}`;
  };
  const line = (name, text) => `${name}="${text}"`;
  return [
    '# One NoticeOS installation, read by deploy/compose/stack.yaml.',
    '# pnpm os:setup or pnpm os:adopt wrote it. The first block holds this',
    '# installation\'s choices; the second is the layout, which follows from the folder.',
    ...CHOICES.map(([name, key]) => line(name, value(key))),
    '',
    '# The layout.',
    ...DERIVED.map(([name, text]) => line(name, text)),
    '',
  ].join('\n');
}

/**
 * Read an installation.env this module wrote: each variable, with `${NAME}`
 * expanded from the lines above it, as Compose expands them. Throws when the
 * file is not in that form.
 */
export function readInstallationEnv(file, io = { readFileSync, lstatSync }) {
  const stat = io.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16384) fail(`${file} is not an installation's environment file.`);
  const values = {};
  for (const raw of io.readFileSync(file, 'utf8').split('\n')) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const match = /^([A-Z][A-Z0-9_]*)="([^"\\]*)"$/u.exec(line);
    if (!match) fail(`${file} has a line that is not NAME="value".`);
    values[match[1]] = match[2].replace(/\$\{([A-Z][A-Z0-9_]*)\}/gu, (_whole, name) => {
      if (!(name in values)) fail(`${file} uses \${${name}} before setting it.`);
      return values[name];
    });
  }
  for (const [name] of [...CHOICES, ...DERIVED]) if (!(name in values)) fail(`${file} does not set ${name}.`);
  return values;
}

/** The `.local/stack.json` for the installation in `dir`. */
export function installationSelector({ dir, project, dockerHost, backup = true, root = ROOT }) {
  return { project, files: stackFiles(root, { backup }), envFile: path.join(dir, ENV_FILE), dockerHost };
}

/** Whether the installation in `dir` has a backup worker: its declaration is in the layout. */
export const hasBackup = (dir) => existsSync(path.join(dir, LAYOUT.backupProfile, 'profile.json'));
