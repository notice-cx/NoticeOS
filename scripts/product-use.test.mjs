import assert from 'node:assert/strict';
import test from 'node:test';
import { readProductUseStages, productUseStagesRefusal, PRODUCT_USE_MAX_STAGES } from '../packages/contract/src/product-use.mjs';

const stage = { eventName: 'document_open', label: 'Opened a document', group: 'primary' };
test('product-use declarations are portable, bounded and independent of measurement settings', () => {
  assert.deepEqual(readProductUseStages([]), []);
  for (const value of [undefined, null, {}, [null], [{ ...stage, group: 'conversion' }],
    [{ ...stage, eventName: '--flag' }], [{ ...stage, label: '' }], [{ ...stage, compareTo: stage.eventName }],
    [{ ...stage, rule: 'replace' }], [stage, stage], Array.from({length: PRODUCT_USE_MAX_STAGES + 1}, (_, i) => ({ ...stage, eventName: `event_${i}` }))]) {
    assert.notEqual(productUseStagesRefusal(value), null);
    assert.equal(readProductUseStages(value), null);
  }
  const input = [stage, { eventName: 'document_save', label: 'Saved a document', group: 'sharing', compareTo: 'document_open', comparisonLabel: 'Saved of opened' }];
  const read = readProductUseStages(input);
  assert.deepEqual(read, input);
  assert.ok(Object.isFrozen(read)); assert.ok(Object.isFrozen(read[0]));
  input[0].label = 'Changed elsewhere'; assert.equal(read[0].label, 'Opened a document');
});
