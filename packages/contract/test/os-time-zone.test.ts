import { describe, expect, it } from 'vitest';
import constants from './fixture-config/constants.json';
import { OS_TIME_ZONE } from '../src/os-time-zone.js';
import { isIanaTimeZone, parseOsTimeZone, proposedTimeZone, savedOsTimeZone, timeZoneChosen } from '../src/time-zone-setting.js';

describe("a first run proposes the browser's clock until somebody chooses one", () => {
  it('counts a clock as chosen once saved, or when it is not the product default', () => {
    // A new installation: the product default, never saved.
    expect(timeZoneChosen('UTC', 'UTC', false)).toBe(false);
    // Etc/UTC and UTC are one clock.
    expect(timeZoneChosen('Etc/UTC', 'UTC', false)).toBe(false);
    // Saved from Settings, even back to UTC: a decision.
    expect(timeZoneChosen('UTC', 'UTC', true)).toBe(true);
    // Seeded from an installation's own file with its own zone.
    expect(timeZoneChosen('Europe/Warsaw', 'UTC', false)).toBe(true);
  });

  it('proposes the browser zone only while unchosen and different', () => {
    expect(proposedTimeZone({ timeZone: 'UTC', chosen: false }, 'America/New_York')).toBe('America/New_York');
    expect(proposedTimeZone({ timeZone: 'UTC', chosen: true }, 'America/New_York')).toBeNull();
    expect(proposedTimeZone({ timeZone: 'UTC', chosen: false }, 'UTC')).toBeNull();
    expect(proposedTimeZone({ timeZone: 'UTC', chosen: false }, 'Etc/UTC')).toBeNull();
    // A browser that names no zone the runtime knows proposes nothing.
    expect(proposedTimeZone({ timeZone: 'UTC', chosen: false }, 'Mars/Olympus')).toBeNull();
    expect(proposedTimeZone({ timeZone: 'UTC', chosen: false }, undefined)).toBeNull();
  });
});

describe('the operator clock is configuration', () => {
  it('reads the zone out of the constants document it was compiled with', () => {
    // The suite compiles test/fixture-config/constants.json in place of the
    // checkout's own, and that fixture names a different zone from the shipped
    // seed's, so this passes only while the clock really comes from the
    // document the suite supplies.
    expect(OS_TIME_ZONE).toBe(constants.os_time_zone);
    expect(OS_TIME_ZONE).toBe('Pacific/Auckland');
  });

  it('rejects a zone the runtime cannot resolve', () => {
    expect(() => parseOsTimeZone('America/Atlantis')).toThrow(/IANA timezone/u);
    expect(() => parseOsTimeZone('Pacific Time')).toThrow(/IANA timezone/u);
    expect(() => parseOsTimeZone('')).toThrow(/non-empty string/u);
    expect(() => parseOsTimeZone(undefined)).toThrow(/non-empty string/u);
    expect(() => parseOsTimeZone(5)).toThrow(/non-empty string/u);
  });

  it('accepts real zones and trims the value it stores', () => {
    expect(parseOsTimeZone('Europe/Warsaw')).toBe('Europe/Warsaw');
    expect(parseOsTimeZone('  Asia/Tokyo  ')).toBe('Asia/Tokyo');
    expect(parseOsTimeZone('UTC')).toBe('UTC');
  });

  it('asks Intl rather than a hand-written list of zone names', () => {
    expect(isIanaTimeZone('America/Los_Angeles')).toBe(true);
    expect(isIanaTimeZone('Pacific/Auckland')).toBe(true);
    expect(isIanaTimeZone('Nowhere/Nothing')).toBe(false);
    expect(isIanaTimeZone(null)).toBe(false);
    expect(isIanaTimeZone('   ')).toBe(false);
  });

  it('reads the saved zone first and the compiled one only when nothing usable is saved', () => {
    expect(savedOsTimeZone({ os_time_zone: 'Europe/Warsaw' }, 'UTC')).toBe('Europe/Warsaw');
    expect(savedOsTimeZone({ os_time_zone: ' Asia/Tokyo ' }, 'UTC')).toBe('Asia/Tokyo');
    // A stored document has no build to fail: an unusable value falls back
    // rather than throwing, and so does a document that is not one.
    expect(savedOsTimeZone({ os_time_zone: 'America/Atlantis' }, 'UTC')).toBe('UTC');
    expect(savedOsTimeZone({ os_time_zone: 5 }, 'UTC')).toBe('UTC');
    expect(savedOsTimeZone({}, 'Europe/Warsaw')).toBe('Europe/Warsaw');
    expect(savedOsTimeZone(null, 'Europe/Warsaw')).toBe('Europe/Warsaw');
    expect(savedOsTimeZone(['UTC'], 'Europe/Warsaw')).toBe('Europe/Warsaw');
  });
});
