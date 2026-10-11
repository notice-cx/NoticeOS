import type { Plugin } from 'vite';
import { publishedRevision } from '../../../scripts/published-image.mjs';
import type { InstallationFacts } from '../shared/installation';
import { laneMiddleware, type LaneReply, type LaneRequest } from './lane';

/** How long one registry answer stands: the panel may be opened often, and a version is published a few times a day at most. */
const PUBLISHED_FOR_MS = 60 * 60_000;

const port = (value: string | undefined): number | null => {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 && number < 65_536 ? number : null;
};

/** The host's facts the stack hands the app (deploy/compose/compose.yaml), as /api/installation answers them. */
export function hostFacts(env: NodeJS.ProcessEnv): Pick<InstallationFacts, 'folder' | 'tower' | 'postgresPort' | 'taskPort' | 'launcher'> {
  const towerPort = port(env.NOTICEOS_HOST_TOWER_PORT);
  return {
    folder: env.NOTICEOS_HOST_FOLDER || null,
    tower: towerPort === null ? null : { address: env.NOTICEOS_HOST_TOWER_ADDRESS || '127.0.0.1', port: towerPort },
    postgresPort: port(env.NOTICEOS_HOST_POSTGRES_PORT),
    taskPort: port(env.NOTICEOS_HOST_TASK_PORT),
    launcher: env.NOTICEOS_HOST_LAUNCHER || null,
  };
}

export interface InstallationLaneOptions {
  /** The commit the app runs (vite.config.ts's source version), and whether it is a checkout's live source. */
  commit: string | null;
  live: boolean;
  env?: NodeJS.ProcessEnv;
  published?: () => Promise<string | null>;
  now?: () => number;
}

/** /api/installation's answer; the registry is asked at most once an hour, and never for live source. */
export function createInstallationHandler({ commit, live, env = process.env, published = () => publishedRevision(), now = Date.now }: InstallationLaneOptions) {
  let cached: { at: number; value: Promise<string | null> } | null = null;
  return async (request: LaneRequest): Promise<LaneReply> => {
    if (request.method !== 'GET') return { status: 405, body: { error: 'method_not_allowed' } };
    if (!live && (cached === null || now() - cached.at >= PUBLISHED_FOR_MS)) cached = { at: now(), value: published() };
    const facts: InstallationFacts = { ...hostFacts(env), commit, live, published: live ? null : await cached!.value };
    return { status: 200, body: facts as unknown as Record<string, unknown> };
  };
}

export function installationLane(options: InstallationLaneOptions): Plugin {
  const handle = createInstallationHandler(options);
  return {
    name: 'installation', apply: 'serve', enforce: 'pre',
    configureServer(server) {
      server.middlewares.use(laneMiddleware({ matches: (pathname) => pathname === '/api/installation', handle, failure: 'installation_unavailable' }));
    },
  };
}
