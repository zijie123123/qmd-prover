import assert from 'node:assert/strict';
import test from 'node:test';
import { indexBy, pushToMap, uniqueSorted } from '../skills/qmd-prover/src/lib/collections.js';
import {
  CONTROL_MARKERS, isControlMarker, KIND_BY_PREFIX, SEMANTIC_ID_PATTERN
} from '../skills/qmd-prover/src/lib/constants.js';
import { asErrorLike, errorMessage, hasErrorCode } from '../skills/qmd-prover/src/lib/errors.js';
import { stableJson } from '../skills/qmd-prover/src/lib/files.js';

test('shared semantic constants keep IDs, result kinds, and protected markers aligned', () => {
  assert.deepEqual(CONTROL_MARKERS, ['OPEN', 'REJECTED', 'VERIFIED', 'REVOKED']);
  assert.equal(isControlMarker('VERIFIED'), true);
  assert.equal(isControlMarker('workspace-verified'), false);
  assert.equal(SEMANTIC_ID_PATTERN.test('thm-main-uniform-index'), true);
  assert.equal(SEMANTIC_ID_PATTERN.test('theorem-uniform-index'), false);
  assert.deepEqual(KIND_BY_PREFIX, {
    def: 'definition', lem: 'lemma', thm: 'theorem', prp: 'proposition', cor: 'corollary'
  });
});

test('shared collection and error helpers preserve deterministic runtime behavior', () => {
  assert.deepEqual(uniqueSorted(['b', 'a', 'b']), ['a', 'b']);
  assert.equal(indexBy([{ id: 'a', value: 1 }], (item) => item.id).get('a')?.value, 1);
  const grouped = new Map<string, number[]>();
  pushToMap(grouped, 'x', 1);
  pushToMap(grouped, 'x', 2);
  assert.deepEqual(grouped.get('x'), [1, 2]);
  assert.equal(stableJson({ b: 2, a: 1 }, 0), '{"a":1,"b":2}\n');

  const failure = Object.assign(new Error('missing'), { code: 'ENOENT' });
  assert.equal(errorMessage(failure), 'missing');
  assert.equal(hasErrorCode(failure, 'ENOENT'), true);
  assert.deepEqual(asErrorLike('failure'), { message: 'failure' });
});
