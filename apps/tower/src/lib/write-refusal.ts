import { ApiError } from './api';

export function refusalMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 409) return 'Changed elsewhere — reload to see the current value';
    return error.message;
  }
  return error instanceof Error ? error.message : 'Could not save';
}
