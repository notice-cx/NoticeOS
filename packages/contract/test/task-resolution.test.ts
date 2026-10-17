import { describe, expect, it } from 'vitest';
import { isTaskResolution, readTaskResolution, TASK_RESOLUTION_LABELS, TASK_RESOLUTIONS } from '../src/task-resolution.mjs';
import { recordsClose, SERVER_TASK_METADATA } from '../src/task-metadata.mjs';

const CLOSED_AT = '2026-10-17T12:00:00Z';
const closer = (extra: Record<string, unknown>, at = CLOSED_AT) => ({ noticeos_closed_by: 'dana', noticeos_closed_at: at, ...extra });

describe('a close names how it ended', () => {
  it('has five resolutions, Done first, each with the words the Tower shows', () => {
    expect(TASK_RESOLUTIONS).toEqual(['done', 'wont-do', 'duplicate', 'cant-reproduce', 'already-handled']);
    expect(TASK_RESOLUTIONS.map((resolution) => TASK_RESOLUTION_LABELS[resolution]))
      .toEqual(['Done', "Won't do", 'Duplicate', "Can't reproduce", 'Already handled']);
    expect([isTaskResolution('wont-do'), isTaskResolution("Won't do"), isTaskResolution(undefined)]).toEqual([true, false, false]);
  });

  it('reads the resolution recorded for this close, and done for anything else', () => {
    expect(readTaskResolution(closer({ noticeos_resolution: 'wont-do' }), CLOSED_AT)).toEqual({ resolution: 'wont-do', duplicateOf: null });
    expect(readTaskResolution(closer({ noticeos_resolution: 'duplicate', noticeos_duplicate_of: 'ro-a1b' }), '2026-10-17T12:00:00.400Z'))
      .toEqual({ resolution: 'duplicate', duplicateOf: 'ro-a1b' });
    const done = { resolution: 'done', duplicateOf: null };
    // A close recorded before resolutions existed, an earlier close's record, an unknown word, no record at all.
    expect(readTaskResolution(closer({}), CLOSED_AT)).toEqual(done);
    expect(readTaskResolution(closer({ noticeos_resolution: 'wont-do' }, '2026-10-01T12:00:00Z'), CLOSED_AT)).toEqual(done);
    expect(readTaskResolution(closer({ noticeos_resolution: 'fixed' }), CLOSED_AT)).toEqual(done);
    expect(readTaskResolution(null, CLOSED_AT)).toEqual(done);
    expect(readTaskResolution(closer({ noticeos_resolution: 'wont-do' }), null)).toEqual(done);
    // Another resolution never carries the other task; an unreadable one is left out.
    expect(readTaskResolution(closer({ noticeos_resolution: 'wont-do', noticeos_duplicate_of: 'ro-a1b' }), CLOSED_AT).duplicateOf).toBeNull();
    expect(readTaskResolution(closer({ noticeos_resolution: 'duplicate', noticeos_duplicate_of: '--force' }), CLOSED_AT))
      .toEqual({ resolution: 'duplicate', duplicateOf: null });
  });

  it('is written by the server only, with the closer it belongs to', () => {
    expect(SERVER_TASK_METADATA).toEqual(expect.arrayContaining(['noticeos_resolution', 'noticeos_duplicate_of']));
    expect([recordsClose(closer({}), CLOSED_AT), recordsClose(closer({}), '2026-10-17T12:00:02Z'), recordsClose({ noticeos_closed_at: CLOSED_AT }, CLOSED_AT)])
      .toEqual([true, false, false]);
  });
});
