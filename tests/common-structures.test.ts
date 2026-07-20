import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { divContent, inlineText, readAst } from '../skills/qmd-prover/src/core/semantic/pandoc.js';
import type { PandocNode } from '../skills/qmd-prover/src/core/semantic/pandoc.js';
import {
  asErrorLike, STATUS_VALUES, errorMessage, hasErrorCode, indexBy,
  KIND_BY_PREFIX, pushToMap, SEMANTIC_ID_PATTERN, uniqueSorted
} from '../skills/qmd-prover/src/core/shared/core.js';
import { stableJson } from '../skills/qmd-prover/src/core/infrastructure/files.js';
import { factIntent, preVerificationStatus } from '../skills/qmd-prover/src/core/semantic/compiler.js';
import type { SemanticResult } from '../skills/qmd-prover/src/core/semantic/model.js';

test('shared semantic constants keep IDs, result kinds, and status vocabulary aligned', () => {
  assert.deepEqual(STATUS_VALUES, ['verified', 'disproved', 'rejected']);
  assert.equal(SEMANTIC_ID_PATTERN.test('thm-main-uniform-index'), true);
  assert.equal(SEMANTIC_ID_PATTERN.test('theorem-uniform-index'), false);
  assert.deepEqual(KIND_BY_PREFIX, {
    def: 'definition', lem: 'lemma', thm: 'theorem', prp: 'proposition', cor: 'corollary'
  });
  // Intent is read off the author's attributes alone: .abandon outranks .draft outranks .disproof.
  const lemma = (flags: Partial<SemanticResult>): SemanticResult =>
    ({ kind: 'lemma', proof_present: true, refutation: false, draft: false, abandon: false, ...flags } as SemanticResult);
  assert.equal(factIntent(lemma({ refutation: true })), 'disproof');
  assert.equal(factIntent(lemma({})), 'normal');
  assert.equal(factIntent(lemma({ draft: true, refutation: true })), 'draft');
  assert.equal(factIntent(lemma({ abandon: true, draft: true })), 'abandoned');
  // Rules 1-5 of the global composition, before any verdict exists.
  assert.equal(preVerificationStatus(lemma({ abandon: true }), true), 'abandoned');
  assert.equal(preVerificationStatus(lemma({}), true), 'broken');
  assert.equal(preVerificationStatus(lemma({ proof_present: false }), false), 'open');
  assert.equal(preVerificationStatus(lemma({ draft: true }), false), 'open');
  assert.equal(preVerificationStatus(lemma({}), false), 'unverified');
  // A definition is discharged by its own body, so it is never open for want of a proof block.
  assert.equal(preVerificationStatus({ ...lemma({ proof_present: false }), kind: 'definition' }, false), 'unverified');
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

// A mathematical statement lives mostly inside its formulas, so a text projection that drops them
// is semantically empty. Both halves matter: the reader has to hand us `Math` nodes at all, and
// `inlineText` has to render them back to source.
test('inlineText keeps LaTeX math verbatim, with its delimiters', () => {
  const math = (kind: string, body: string) => ({ t: 'Math', c: [{ t: kind }, body] });
  const blocks = [{
    t: 'Para',
    c: [
      { t: 'Str', c: 'defined' }, { t: 'Space' }, { t: 'Str', c: 'by' }, { t: 'Space' },
      math('DisplayMath', '\\begin{aligned}\\partial_tg&=-2\\mathfrak E\\end{aligned}'),
      { t: 'Space' }, { t: 'Str', c: 'with' }, { t: 'Space' },
      math('InlineMath', '\\kappa\\ge0'), { t: 'Space' },
      math('InlineMath', '|N_J|^2 e^{-f}')
    ]
  }];
  assert.equal(
    inlineText(blocks),
    'defined by \\[\\begin{aligned}\\partial_tg&=-2\\mathfrak E\\end{aligned}\\] with \\(\\kappa\\ge0\\) \\(|N_J|^2 e^{-f}\\)'
  );
  // A longhand environment reaches us as raw TeX. That is content; raw HTML is not.
  assert.equal(inlineText([{ t: 'RawBlock', c: ['tex', '\\begin{equation}x=1\\end{equation}'] }]), '\\begin{equation}x=1\\end{equation}');
  assert.equal(inlineText([{ t: 'RawBlock', c: ['html', '<div>'] }]), '');
});

test('the Pandoc reader parses single-backslash TeX delimiters as math', async () => {
  const pandoc = process.env.QMD_PROVER_PANDOC || 'pandoc';
  const root = await mkdtemp(path.join(os.tmpdir(), 'qmd-prover-math-'));
  const file = path.join(root, 'math.qmd');
  await writeFile(file, '::: {#def-flow .definition name="Flow"}\nis defined by \\[\\partial_tg=-2\\mathfrak E\\] where \\(\\kappa\\ge0\\)\n:::\n');
  const ast = await readAst(file, { pandoc }).catch((error: unknown) => errorMessage(error));
  // Nothing to assert about the reader on a machine with no Pandoc; the projection test above still runs.
  if (typeof ast === 'string') return assert.match(ast, /Pandoc is required/);
  assert.equal(
    inlineText(divContent(ast.blocks[0] as PandocNode).blocks),
    'is defined by \\[\\partial_tg=-2\\mathfrak E\\] where \\(\\kappa\\ge0\\)'
  );
});
