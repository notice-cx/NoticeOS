import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { CONFIG_DOCUMENT_FILES } from './config-documents.mjs';
import { collectorDefaultDocument } from './config-defaults.mjs';
import { releasedDefaultDocuments } from './released-defaults.mjs';

test('released defaults cover the exact register and preserve each generic document', () => {
  const documents = releasedDefaultDocuments();
  assert.deepEqual(documents.map(row => row.file), [...CONFIG_DOCUMENT_FILES].sort());
  assert.ok(Object.isFrozen(documents));
  for (const row of documents) {
    assert.ok(Object.isFrozen(row));
    assert.equal(row.key, row.file.slice(7, -5));
    assert.deepEqual(JSON.parse(row.body), JSON.parse(readFileSync(new URL('../' + row.file, import.meta.url), 'utf8')));
  }
});

test('collector fallback remains a fresh value and excludes task coordination', () => {
  assert.equal(collectorDefaultDocument('config/beads.json'), null);
  assert.equal(collectorDefaultDocument('config/unknown.json'), null);
  const first = collectorDefaultDocument('config/entities.json');
  assert.ok(first);
  if (Array.isArray(first)) first.push({ site_id: 'fixture.example.test' });
  else first.fixture = 'changed';
  assert.deepEqual(collectorDefaultDocument('config/entities.json'), JSON.parse(readFileSync(new URL('../config/entities.json', import.meta.url), 'utf8')));
  assert.equal(releasedDefaultDocuments().find(row => row.key === 'entities').body.includes('fixture.example.test'), false);
});
