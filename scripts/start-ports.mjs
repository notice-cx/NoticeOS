import { MANAGED_DOOR } from './ingest-door.mjs';
import { DEFAULT_PORT as POSTGRES_PORT } from './postgres-secrets.mjs';

export const MANAGED_START_PORTS = Object.freeze([5173, Number(new URL(MANAGED_DOOR).port), POSTGRES_PORT]);
