import assert from 'node:assert/strict';
import test from 'node:test';
import { assessSerpOrganicQuality } from './panel-serp-organic.mjs';
import { archiveRows } from './signal-archive.mjs';

const reportDate = '2026-10-12';
const queries = ['alpha', 'beta', 'gamma', 'delta', 'epsilon'];
const organic = (rank_group, domain, url) => ({ type: 'organic', rank_group, domain, url });

function observations(items) {
  return archiveRows({
    asset: 'example.com', integration: 'dataforseo', report: 'serp-panel', reportDate,
    collectedAt: `${reportDate}T12:00:00Z`, dataState: 'provider-snapshot', providerTruncated: true,
    pages: queries.map(keyword => ({
      request: { body: { keyword, device: 'mobile', depth: 20 } },
      response: { tasks: [{ result: [{ items }] }] },
    })),
  }, new Map());
}

test('tracked organic provenance distinguishes provider domains, Google redirects and URL destinations', () => {
  const rows = observations([
    organic(1, 'google.com', 'https://www.google.com/url?q=https%3A%2F%2Fexample.org'),
    organic(2, 'google.com', 'https://example.net/result'),
    organic(3, undefined, 'https://www.google.com/search?q=search'),
    { type: 'ai_overview', references: [{ domain: 'example.com' }] },
  ]);
  const [row] = rows;
  assert.equal(row.top3_domains, 'google.com|google.com|google.com');
  assert.equal(row.top3_reported_domains, 'google.com|google.com|');
  assert.equal(row.top3_url_domains, 'google.com|example.net|google.com');
  assert.equal(row.top3_google_url_kinds, 'internal||internal');
  assert.equal(row.best_rank, '');
  assert.equal(row.aio_cites_us, true);
  assert.deepEqual(assessSerpOrganicQuality(rows), {
    reportDate, status: 'suspect', rows: 5, usableRows: 5, rankedRows: 0, googleOnlyRows: 5,
    googleOnlyQueries: 5, sourceRows: 5, googleInternalUrls: 10, conflictingDomains: 5, provenance: 'source-fields',
  });
});

test('ordinary Google-hosted destinations and below-depth ranks leave the organic warning clear', () => {
  const hosted = observations([
    organic(1, 'google.com', 'https://www.google.com/maps/place/example'),
    organic(2, 'google.com', 'https://www.google.com/travel/'),
    organic(3, 'google.com', 'https://support.google.com/a/answer/1'),
  ]);
  assert.equal(assessSerpOrganicQuality(hosted).googleOnlyRows, 5);
  assert.equal(assessSerpOrganicQuality(hosted).status, 'clear');
  const elsewhere = observations([
    organic(1, 'example.org', 'https://example.org/'),
    organic(2, 'google.com', 'https://www.google.com/maps/'),
    organic(3, 'example.net', 'https://example.net/'),
  ]);
  assert.equal(elsewhere[0].best_rank, '');
  assert.equal(elsewhere[0].tracked_depth, 20);
  assert.equal(assessSerpOrganicQuality(elsewhere).status, 'clear');
  assert.equal(assessSerpOrganicQuality(elsewhere.slice(0, 1)).status, 'unassessed');
});
