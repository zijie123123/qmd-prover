import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { compileProject, theoremBundle } from '../skills/qmd-prover/scripts/lib/compiler.mjs';
import { readExternalPolicy } from '../skills/qmd-prover/scripts/lib/external.mjs';
import { readJson } from '../skills/qmd-prover/scripts/lib/files.mjs';
import { analyzeDependencies, inspectFact, inspectPath, inspectProject } from '../skills/qmd-prover/scripts/lib/inspector.mjs';
import { initializeProject } from '../skills/qmd-prover/scripts/lib/project.mjs';
import { renderProject } from '../skills/qmd-prover/scripts/lib/render.mjs';
import { checkStaleness } from '../skills/qmd-prover/scripts/lib/staleness.mjs';
import { submitProof, revokeVerification } from '../skills/qmd-prover/scripts/lib/verification.mjs';
import { initializeWorkspace, inspectWorkspace } from '../skills/qmd-prover/scripts/lib/workspace.mjs';

const here = path.dirname(new URL(import.meta.url).pathname);
const fakePandoc = path.join(here, 'fixtures', 'fake-pandoc.mjs');
const verifier = path.join(here, 'fixtures', 'mock-verifier.mjs');
const staleVerifier = path.join(here, 'fixtures', 'stale-verifier.mjs');
const malformedVerifier = path.join(here, 'fixtures', 'malformed-verifier.mjs');
const options = { pandoc: fakePandoc };
process.env.PATH = `${path.dirname(process.execPath)}:${process.env.PATH}`;

async function project() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'qmd-prover-'));
  await mkdir(path.join(root, '.qmd-prover', 'workspaces', 'test', 'proposals'), { recursive: true });
  await Promise.all([chmod(fakePandoc, 0o755), chmod(verifier, 0o755), chmod(staleVerifier, 0o755), chmod(malformedVerifier, 0o755)]);
  return root;
}

async function bareProject() {
  return mkdtemp(path.join(os.tmpdir(), 'qmd-prover-init-'));
}

function proposalPath(root, name) {
  return path.join(root, '.qmd-prover', 'workspaces', 'test', 'proposals', name);
}

function proof(id, text) {
  return `::: {.proof of="${id}"}\n${text}\n:::\n`;
}

function result(id, statement, { proofText, title = id, exported = false, extra = '' } = {}) {
  const kind = id.startsWith('lem-') ? 'lemma' : id.startsWith('def-') ? 'definition' : id.startsWith('prp-') ? 'proposition' : id.startsWith('cor-') ? 'corollary' : 'theorem';
  const block = `::: {#${id} .${kind}${id.startsWith('thm-main-') ? ' .goal' : ''} name="${title}" date="2026-07-13"${exported ? ` export="${id}"` : ''}${extra}}\n${statement}\n:::\n`;
  return proofText == null ? block : `${block}\n${proof(id, proofText)}`;
}

function document(imports, body) {
  if (!imports.length) return body;
  return `---\nqmd-prover:\n  imports:\n${imports.map((entry) => `    - from: ${entry.from}\n      use:\n${entry.use.map((id) => `        - ${id}`).join('\n')}`).join('\n')}\n---\n\n${body}`;
}

test('compiler reads metadata imports, linked proofs, and deterministic semantic indexes', async () => {
  const root = await project();
  await mkdir(path.join(root, 'foundations'));
  await writeFile(path.join(root, 'foundations', 'base.qmd'), result('lem-base', 'For every x, x equals x.', { proofText: 'This follows by reflexivity.', exported: true }));
  await writeFile(path.join(root, 'goal.qmd'), document(
    [{ from: 'foundations/base.qmd', use: ['lem-base'] }],
    `Unrestricted prose.\n\n${result('thm-main-goal', 'For every x, x equals x.', { proofText: 'Apply @lem-base.' })}`
  ));
  const first = await compileProject(root, options);
  const firstManifest = await readFile(path.join(root, '.qmd-prover', 'manifest.json'), 'utf8');
  const second = await compileProject(root, options);
  const secondManifest = await readFile(path.join(root, '.qmd-prover', 'manifest.json'), 'utf8');
  assert.equal(first.ok, false);
  assert.equal(first.complete, true);
  assert.equal(second.ok, false);
  assert.equal(firstManifest, secondManifest);
  assert.deepEqual(first.summary.goals.map((goal) => goal.id), ['thm-main-goal']);
  assert.deepEqual(first.graph.edges.map(({ from, to }) => ({ from, to })), [{ from: 'thm-main-goal', to: 'lem-base' }]);
  assert.deepEqual(first.manifest.results.find((item) => item.id === 'thm-main-goal').dependencies, ['lem-base']);
  assert.ok(first.diagnostics.some((item) => item.code === 'DEPENDENCY_STATUS_INSUFFICIENT' && item.severity === 'error'));
  assert.equal(first.graph.edges[0].checks.status, 'fail');
  assert.equal(theoremBundle(first, '@thm-main-goal').dependencies[0].id, 'lem-base');
});

test('source discovery honors configured exclusions and gitignore reinclusions deterministically', async () => {
  const root = await project();
  await Promise.all([mkdir(path.join(root, 'generated')), mkdir(path.join(root, 'ignored'))]);
  await writeFile(path.join(root, '.qmd-prover', 'config.yml'), 'project:\n  exclude: [generated]\nrender:\n  output-dir: rendered\n');
  await writeFile(path.join(root, '.gitignore'), 'ignored/\n!ignored/keep.qmd\n');
  await writeFile(path.join(root, 'visible.qmd'), result('lem-visible', 'Visible.'));
  await writeFile(path.join(root, 'generated', 'excluded.qmd'), result('lem-config-excluded', 'Excluded.'));
  await writeFile(path.join(root, 'ignored', 'excluded.qmd'), result('lem-git-excluded', 'Excluded.'));
  await writeFile(path.join(root, 'ignored', 'keep.qmd'), result('lem-git-reincluded', 'Reincluded.'));
  const compilation = await compileProject(root, options);
  assert.deepEqual(compilation.manifest.files.map((file) => file.path), ['ignored/keep.qmd', 'visible.qmd']);
  assert.deepEqual(compilation.manifest.results.map((item) => item.id), ['lem-git-reincluded', 'lem-visible']);
});

test('compiler diagnoses metadata imports, duplicates, proof shape, and cycles', async () => {
  const root = await project();
  await writeFile(path.join(root, 'a.qmd'), document(
    [{ from: 'b.qmd', use: ['lem-b'] }],
    result('lem-a', 'A.', { proofText: 'Use @lem-b.' })
  ));
  await writeFile(path.join(root, 'b.qmd'), document(
    [{ from: 'a.qmd', use: ['lem-a'] }],
    `${result('lem-b', 'B.', { exported: true })}${result('lem-a', 'Duplicate.')}`
  ));
  await writeFile(path.join(root, 'orphan.qmd'), proof('lem-missing', 'No target exists.'));
  const compilation = await compileProject(root, options);
  const codes = new Set(compilation.diagnostics.map((item) => item.code));
  assert.equal(compilation.ok, false);
  for (const code of ['DUPLICATE_ID', 'IMPORT_CYCLE', 'IMPORT_NOT_EXPORTED', 'PROOF_TARGET_UNKNOWN']) assert.ok(codes.has(code), code);
});

test('compiler rejects semantic dependency cycles and legacy section layout', async () => {
  const root = await project();
  await writeFile(path.join(root, 'cycle.qmd'), `${result('lem-left', 'Left.', { proofText: 'Apply @lem-right.' })}\n${result('lem-right', 'Right.', { proofText: 'Apply @lem-left.' })}`);
  await writeFile(path.join(root, 'legacy.qmd'), `::: {#lem-legacy .lemma name="Legacy" date="2026-07-13"}\n### Statement\nLegacy.\n### Proof\nOld.\n:::\n`);
  const compilation = await compileProject(root, options);
  const codes = new Set(compilation.diagnostics.map((item) => item.code));
  assert.ok(codes.has('DEPENDENCY_CYCLE'));
  assert.ok(codes.has('LEGACY_RESULT_SECTIONS'));
  assert.deepEqual((await analyzeDependencies(root, 'cycles', [], options)).cycles, [['lem-left', 'lem-right', 'lem-left']]);
  assert.deepEqual((await analyzeDependencies(root, 'frontier', ['@lem-left'], options)).frontier.map((item) => item.fact.id), ['lem-left', 'lem-right']);
});

test('compiler validates result names, semantic kinds, and main-goal classes', async () => {
  const root = await project();
  const wrongKind = result('lem-wrong', 'Shape.').replace('.lemma', '.proposition');
  const noName = result('thm-main-no-name', 'Missing caption.').replace(' name="thm-main-no-name"', '');
  const unsafeId = result('lem-unsafe/path', 'Unsafe identifier.');
  await writeFile(path.join(root, 'shape.qmd'), `${wrongKind}\n${noName}\n${unsafeId}`);
  const compilation = await compileProject(root, options);
  const codes = new Set(compilation.diagnostics.map((item) => item.code));
  assert.ok(codes.has('ID_KIND_MISMATCH'));
  assert.ok(codes.has('RESULT_NAME_MISSING'));
  assert.ok(codes.has('INVALID_SEMANTIC_ID'));
});

test('compiler enforces introduction dates and record-backed marker placement', async () => {
  const root = await project();
  const missingDate = result('lem-date-missing', 'Missing date.').replace(' date="2026-07-13"', '');
  const invalidDate = result('lem-date-invalid', 'Invalid date.').replace('2026-07-13', '2026-02-30');
  const misplacedDefinition = result('def-marker-position', 'VERIFIED\n\nA construction.');
  const unsupportedRejected = result('lem-rejected-marker', 'A claim.', { proofText: 'REJECTED\n\nA failed proof.' });
  await writeFile(path.join(root, 'shape-details.qmd'), [missingDate, invalidDate, misplacedDefinition, unsupportedRejected].join('\n'));
  const compilation = await compileProject(root, options);
  const codes = new Set(compilation.diagnostics.map((item) => item.code));
  for (const code of ['RESULT_DATE_MISSING', 'RESULT_DATE_INVALID', 'DEFINITION_MARKER_POSITION', 'REJECTED_RECORD_INVALID']) assert.ok(codes.has(code), code);
  assert.equal(compilation.manifest.results.find((item) => item.id === 'def-marker-position').status, 'candidate');
  assert.equal(compilation.manifest.results.find((item) => item.id === 'lem-rejected-marker').status, 'candidate');
});

test('main statement and name baselines are immutable', async () => {
  const root = await project();
  const file = path.join(root, 'goal.qmd');
  await writeFile(file, result('thm-main-fixed', 'Original statement.', { title: 'Fixed theorem' }));
  assert.equal((await compileProject(root, options)).ok, true);
  await writeFile(file, result('thm-main-fixed', 'Changed statement.', { title: 'Changed theorem' }));
  const changed = await compileProject(root, options);
  const codes = new Set(changed.diagnostics.map((item) => item.code));
  assert.ok(codes.has('MAIN_STATEMENT_MUTATED'));
  assert.ok(codes.has('MAIN_TITLE_MUTATED'));
});

test('complete snapshot identities change with exact mathematical content', async () => {
  const root = await project();
  const file = path.join(root, 'fact.qmd');
  await writeFile(file, result('lem-snapshot-identity', 'First statement.'));
  const first = await compileProject(root, options);
  await writeFile(file, result('lem-snapshot-identity', 'Second statement.'));
  const second = await compileProject(root, options);
  assert.notEqual(first.graph.snapshot_id, second.graph.snapshot_id);
  assert.equal((await readJson(path.join(root, '.qmd-prover', 'graphs', 'latest.json'))).snapshot_id, second.graph.snapshot_id);
});

test('definitions declare construction dependencies and unresolved graph edges retain failed checks', async () => {
  const root = await project();
  await writeFile(path.join(root, 'definitions.qmd'), [
    result('def-base', 'A base object.'),
    result('def-derived', 'Construct the derived object from @def-base.'),
    result('lem-broken', 'A broken claim.', { proofText: 'Apply @lem-absent.' })
  ].join('\n'));
  const compilation = await compileProject(root, options);
  const derived = compilation.manifest.results.find((item) => item.id === 'def-derived');
  const brokenEdge = compilation.graph.edges.find((edge) => edge.from === 'lem-broken');
  assert.deepEqual(derived.dependencies, ['def-base']);
  assert.equal(brokenEdge.to, 'lem-absent');
  assert.equal(brokenEdge.checks.existence, 'fail');
  assert.equal(compilation.graph.nodes.find((node) => node.id === 'lem-absent').status, 'missing');
  assert.ok(compilation.diagnostics.some((item) => item.code === 'DEPENDENCY_UNKNOWN' && item.id === 'lem-broken'));
});

test('inspector supports fact, path, search, and lowest-frontier queries on a named snapshot', async () => {
  const root = await project();
  await mkdir(path.join(root, 'foundations'));
  await writeFile(path.join(root, 'foundations', 'base.qmd'), result('lem-frontier-base', 'The base obligation.', { title: 'Base frontier fact', exported: true }));
  await writeFile(path.join(root, 'goal.qmd'), document(
    [{ from: 'foundations/base.qmd', use: ['lem-frontier-base'] }],
    `${result('lem-frontier-middle', 'The middle claim.', { proofText: 'Use @lem-frontier-base.' })}\n${result('thm-main-frontier', 'The final claim.', { proofText: 'Use @lem-frontier-middle.' })}`
  ));
  const projectInspection = await inspectProject(root, options);
  assert.equal(projectInspection.ok, false);
  assert.equal(projectInspection.snapshot_published, true);
  const factInspection = await inspectFact(root, '@thm-main-frontier', options);
  assert.deepEqual(factInspection.graph.nodes.map((node) => node.id).sort(), ['lem-frontier-base', 'lem-frontier-middle', 'thm-main-frontier']);
  const pathInspection = await inspectPath(root, 'goal.qmd', options);
  assert.equal(pathInspection.graph.nodes.find((node) => node.id === 'lem-frontier-base').scope, 'external');
  const frontier = await analyzeDependencies(root, 'frontier', ['@thm-main-frontier'], options);
  assert.deepEqual(frontier.frontier.map((item) => item.fact.id), ['lem-frontier-base']);
  assert.deepEqual(frontier.frontier[0].path, ['thm-main-frontier', 'lem-frontier-middle', 'lem-frontier-base']);
  const dependencies = await analyzeDependencies(root, 'dependencies', ['@thm-main-frontier'], options);
  assert.deepEqual(dependencies.direct.map((item) => item.id), ['lem-frontier-middle']);
  assert.deepEqual(dependencies.transitive.map((item) => item.id).sort(), ['lem-frontier-base', 'lem-frontier-middle']);
  const reverse = await analyzeDependencies(root, 'reverse-dependencies', ['@lem-frontier-base'], options);
  assert.deepEqual(reverse.transitive.map((item) => item.id).sort(), ['lem-frontier-middle', 'thm-main-frontier']);
  assert.deepEqual((await analyzeDependencies(root, 'path', ['@thm-main-frontier', '@lem-frontier-base'], options)).path, ['thm-main-frontier', 'lem-frontier-middle', 'lem-frontier-base']);
  assert.deepEqual((await analyzeDependencies(root, 'cycles', [], options)).cycles, []);
  const search = await analyzeDependencies(root, 'search', ['base frontier'], { ...options, kind: 'lemma' });
  assert.deepEqual(search.matches.map((item) => item.id), ['lem-frontier-base']);
  assert.equal(search.snapshot_id, projectInspection.snapshot_id);
});

test('dependency findings expose unused declarations, reachability, reuse, and deterministic alternative paths', async () => {
  const root = await project();
  await writeFile(path.join(root, 'foundations.qmd'), [
    result('def-path-base', 'A base construction.', { exported: true }),
    result('lem-unused-export', 'An unused exported fact.', { exported: true }),
    result('lem-never-imported', 'An export no file imports.', { exported: true }),
    result('lem-isolated', 'An isolated fact.')
  ].join('\n'));
  await writeFile(path.join(root, 'goal.qmd'), document(
    [{ from: 'foundations.qmd', use: ['def-path-base', 'lem-unused-export'] }],
    [
      result('lem-path-left', 'The left route.', { proofText: 'Use @def-path-base.' }),
      result('lem-path-right', 'The right route.', { proofText: 'Use @def-path-base.' }),
      result('thm-main-paths', 'Both routes reach the goal.', { proofText: 'Use @lem-path-left and @lem-path-right.' })
    ].join('\n')
  ));
  await writeFile(path.join(root, 'invalid-metadata.qmd'), document(
    [{ from: 'missing.qmd', use: ['lem-missing-export'] }],
    result('def-file-error', 'A candidate blocked by a file-level error.')
  ));
  await compileProject(root, options);
  const findings = (await analyzeDependencies(root, 'findings', [], options)).findings;
  assert.deepEqual(findings.unused_imports.map((item) => item.id), ['lem-unused-export']);
  assert.deepEqual(findings.unused_exports.map((item) => item.id), ['lem-never-imported']);
  assert.ok(findings.isolated_facts.some((item) => item.id === 'lem-isolated'));
  assert.ok(findings.unreachable.facts.some((item) => item.id === 'lem-isolated'));
  assert.equal(findings.heavily_reused[0].fact.id, 'def-path-base');
  assert.equal(findings.heavily_reused[0].transitive_dependents, 3);
  assert.ok(!findings.candidate_ready_for_ai.some((item) => item.id === 'def-file-error'));
  const paths = await analyzeDependencies(root, 'alternative-paths', ['@thm-main-paths', '@def-path-base'], options);
  assert.deepEqual(paths.paths, [
    ['thm-main-paths', 'lem-path-left', 'def-path-base'],
    ['thm-main-paths', 'lem-path-right', 'def-path-base']
  ]);
});

test('inspection verifies ready facts in dependency order, caches exact checks, and marks definitions at block end', async () => {
  const root = await project();
  const countFile = path.join(root, 'verifier-calls.txt');
  process.env.QMD_PROVER_VERIFIER = verifier;
  process.env.QMD_PROVER_VERIFIER_COUNT = countFile;
  try {
    await writeFile(path.join(root, 'auto.qmd'), [
      result('def-auto-object', 'Define the auto object directly.'),
      result('lem-auto-result', 'The auto object exists.', { proofText: 'Apply @def-auto-object.' })
    ].join('\n'));
    const before = await compileProject(root, options);
    const constructionHash = before.manifest.results.find((item) => item.id === 'def-auto-object').statement_hash;

    const first = await inspectProject(root, options);
    assert.equal(first.ok, true, JSON.stringify(first.diagnostics));
    assert.equal(first.verification.verifier_calls, 2);
    assert.deepEqual(first.facts.map((fact) => [fact.id, fact.ai.status]), [
      ['def-auto-object', 'pass'],
      ['lem-auto-result', 'pass']
    ]);
    assert.deepEqual((await readFile(countFile, 'utf8')).trim().split('\n'), ['def-auto-object', 'lem-auto-result']);
    const source = await readFile(path.join(root, 'auto.qmd'), 'utf8');
    assert.match(source, /Define the auto object directly\.\n\nVERIFIED\n:::/);
    assert.match(source, /\.proof of="lem-auto-result"\}\nVERIFIED\n\nApply @def-auto-object\./);
    const after = await compileProject(root, options);
    assert.equal(after.manifest.results.find((item) => item.id === 'def-auto-object').statement_hash, constructionHash);
    assert.equal(after.graph.edges[0].checks.ai_sufficiency, 'pass');

    const second = await inspectProject(root, options);
    assert.equal(second.ok, true);
    assert.equal(second.verification.verifier_calls, 0);
    assert.equal(second.verification.cache_hits, 2);
    assert.deepEqual((await readFile(countFile, 'utf8')).trim().split('\n'), ['def-auto-object', 'lem-auto-result']);
  } finally {
    delete process.env.QMD_PROVER_VERIFIER;
    delete process.env.QMD_PROVER_VERIFIER_COUNT;
  }
});

test('inspection removes stale VERIFIED before failing closed on an unavailable verifier', async () => {
  const root = await project();
  const sourceFile = path.join(root, 'stale-inspection.qmd');
  process.env.QMD_PROVER_VERIFIER = verifier;
  await writeFile(sourceFile, result('lem-inspection-stale', 'A stable statement.', { proofText: 'The original proof.' }));
  assert.equal((await inspectFact(root, '@lem-inspection-stale', options)).ok, true);
  const verifiedSource = await readFile(sourceFile, 'utf8');
  assert.match(verifiedSource, /VERIFIED/);
  await writeFile(sourceFile, verifiedSource.replace('The original proof.', 'A changed proof.'));
  delete process.env.QMD_PROVER_VERIFIER;

  const failed = await inspectFact(root, '@lem-inspection-stale', options);
  assert.equal(failed.ok, false);
  assert.equal(failed.check.ai.status, 'error');
  assert.equal(failed.check.ai.code, 'unconfigured');
  assert.match(failed.check.ai.remediation, /rerun inspection/);
  assert.deepEqual(failed.staleness.changed.map((item) => item.id), ['lem-inspection-stale']);
  assert.doesNotMatch(await readFile(sourceFile, 'utf8'), /VERIFIED/);
  assert.equal((await compileProject(root, options)).manifest.results[0].status, 'stale');
  const staleIndex = await readJson(path.join(root, '.qmd-prover', 'verification', 'index.json'));
  assert.equal((await readJson(path.join(root, staleIndex['lem-inspection-stale'].cache))).stale, true);

  await writeFile(sourceFile, (await readFile(sourceFile, 'utf8')).replace('A changed proof.', 'The original proof.'));
  const restored = await inspectFact(root, '@lem-inspection-stale', options);
  assert.equal(restored.ok, true);
  assert.equal(restored.verification.verifier_calls, 0);
  assert.equal(restored.verification.cache_hits, 1);
  assert.match(await readFile(sourceFile, 'utf8'), /VERIFIED/);
});

test('inspection caches rejected mathematical verdicts and malformed verifier output fails closed', async () => {
  const root = await project();
  const countFile = path.join(root, 'rejected-calls.txt');
  process.env.QMD_PROVER_VERIFIER = verifier;
  process.env.QMD_PROVER_VERIFIER_COUNT = countFile;
  await writeFile(path.join(root, 'rejected.qmd'), result('lem-auto-rejected', 'A rejected claim.', { proofText: 'GAP in the argument.' }));
  const rejected = await inspectFact(root, '@lem-auto-rejected', options);
  assert.equal(rejected.ok, false);
  assert.equal(rejected.check.ai.status, 'fail');
  assert.deepEqual(rejected.check.ai.report.gaps, ['justify the missing step']);
  const repeated = await inspectFact(root, '@lem-auto-rejected', options);
  assert.equal(repeated.verification.verifier_calls, 0);
  assert.equal(repeated.verification.cache_hits, 1);
  assert.equal((await readFile(countFile, 'utf8')).trim().split('\n').length, 1);

  await writeFile(path.join(root, '.qmd-prover', '.external.qmd'), 'Only explicitly declared external facts may be used.\n');
  const changedBasis = await inspectFact(root, '@lem-auto-rejected', options);
  assert.equal(changedBasis.check.ai.status, 'fail');
  assert.equal(changedBasis.verification.verifier_calls, 1);
  assert.equal((await readFile(countFile, 'utf8')).trim().split('\n').length, 2);

  delete process.env.QMD_PROVER_VERIFIER_COUNT;
  process.env.QMD_PROVER_VERIFIER = malformedVerifier;
  await writeFile(path.join(root, 'malformed.qmd'), result('lem-malformed-check', 'A checkable claim.', { proofText: 'A candidate proof.' }));
  const malformed = await inspectFact(root, '@lem-malformed-check', options);
  assert.equal(malformed.ok, false);
  assert.equal(malformed.check.ai.status, 'error');
  assert.equal(malformed.check.ai.code, 'malformed');
  assert.equal(malformed.check.ai.details.stdout_excerpt, '{not-json');
  assert.doesNotMatch(await readFile(path.join(root, 'malformed.qmd'), 'utf8'), /VERIFIED/);
  delete process.env.QMD_PROVER_VERIFIER;
});

test('record-backed markers fail closed when their exact evidence is absent', async () => {
  const root = await project();
  await writeFile(path.join(root, 'unsupported.qmd'), result('lem-unsupported-marker', 'A claim.', { proofText: 'VERIFIED\n\nA purported proof.' }));
  const compilation = await compileProject(root, options);
  const fact = compilation.manifest.results.find((item) => item.id === 'lem-unsupported-marker');
  assert.equal(fact.status, 'candidate');
  assert.ok(compilation.diagnostics.some((item) => item.code === 'VERIFIED_RECORD_INVALID'));
  const stale = await checkStaleness(root, options);
  assert.deepEqual(stale.changed[0].reasons, ['verified-marker-without-current-record']);
  assert.doesNotMatch(await readFile(path.join(root, 'unsupported.qmd'), 'utf8'), /VERIFIED/);
});

test('rejected linked-proof proposals preserve canonical QMD and accepted repair inserts only proof', async () => {
  const root = await project();
  process.env.QMD_PROVER_VERIFIER = verifier;
  await writeFile(path.join(root, '.qmd-prover', '.external.qmd'), 'Finite group theory may be used.\n');
  const canonicalFile = path.join(root, 'goal.qmd');
  const initial = result('thm-main-proof', 'One equals one.', { title: 'Reflexivity' });
  await writeFile(canonicalFile, initial);
  const badProposal = proposalPath(root, 'bad.qmd');
  await writeFile(badProposal, proof('thm-main-proof', 'INVALID reasoning.'));
  const rejected = await submitProof(root, badProposal, options);
  assert.equal(rejected.status, 'rejected');
  assert.equal(await readFile(canonicalFile, 'utf8'), initial);
  assert.equal((await compileProject(root, options)).manifest.results[0].status, 'open');
  const goodProposal = proposalPath(root, 'good.qmd');
  await writeFile(goodProposal, proof('thm-main-proof', 'By reflexivity, one equals one.'));
  const accepted = await submitProof(root, goodProposal, options);
  assert.equal(accepted.status, 'verified');
  assert.match(accepted.report.summary, /external:declared:Finite group theory may be used/);
  const merged = await readFile(canonicalFile, 'utf8');
  assert.match(merged, /:::\n\n::: \{\.proof of="thm-main-proof"\}\nVERIFIED\n\nBy reflexivity/);
  assert.equal((await compileProject(root, options)).manifest.results[0].status, 'verified');
  await assert.rejects(() => submitProof(root, goodProposal, options), /already verified/);
  assert.equal((await revokeVerification(root, '@thm-main-proof', 'New concern', options)).status, 'revoked');
  delete process.env.QMD_PROVER_VERIFIER;
});

test('a correct verdict with a gap is rejected and proposals cannot redefine canonical results', async () => {
  const root = await project();
  const countFile = path.join(root, 'submission-verifier-calls.txt');
  process.env.QMD_PROVER_VERIFIER = verifier;
  process.env.QMD_PROVER_VERIFIER_COUNT = countFile;
  const target = path.join(root, 'goal.qmd');
  const original = result('thm-main-gap', 'A complete proof is required.');
  await writeFile(target, original);
  const gap = proposalPath(root, 'gap.qmd');
  await writeFile(gap, proof('thm-main-gap', 'GAP in justification.'));
  const rejected = await submitProof(root, gap, options);
  assert.equal(rejected.status, 'rejected');
  assert.deepEqual(rejected.report.gaps, ['justify the missing step']);
  assert.equal(await readFile(target, 'utf8'), original);
  assert.equal((await submitProof(root, gap, options)).status, 'rejected');
  assert.deepEqual((await readFile(countFile, 'utf8')).trim().split('\n'), ['thm-main-gap']);
  const redefinition = proposalPath(root, 'redefinition.qmd');
  await writeFile(redefinition, result('thm-main-gap', 'Changed statement.', { proofText: 'A proof.' }));
  await assert.rejects(() => submitProof(root, redefinition, options), /must not redefine existing canonical result/);
  delete process.env.QMD_PROVER_VERIFIER_COUNT;
  delete process.env.QMD_PROVER_VERIFIER;
});

test('accepted new-result proposals are promoted atomically to an explicit canonical destination', async () => {
  const root = await project();
  process.env.QMD_PROVER_VERIFIER = verifier;
  await writeFile(path.join(root, 'goal.qmd'), `${result('thm-main-existing', 'Existing goal.')}\n${result('lem-new-base', 'A reusable premise.', { exported: true })}`);
  const baseProposal = proposalPath(root, 'new-result-base.qmd');
  await writeFile(baseProposal, proof('lem-new-base', 'By direct calculation.'));
  assert.equal((await submitProof(root, baseProposal, options)).status, 'verified');
  const proposal = proposalPath(root, 'new-result.qmd');
  await writeFile(proposal, document(
    [{ from: 'goal.qmd', use: ['lem-new-base'] }],
    result('lem-new', 'A newly verified lemma.', { proofText: 'Apply @lem-new-base.', title: 'New lemma', exported: true })
  ));
  const accepted = await submitProof(root, proposal, { ...options, destination: 'lemmas.qmd' });
  assert.equal(accepted.status, 'verified');
  const promoted = await readFile(path.join(root, 'lemmas.qmd'), 'utf8');
  assert.match(promoted, /#lem-new/);
  assert.match(promoted, /\.proof of="lem-new"/);
  assert.equal((await compileProject(root, options)).manifest.results.find((item) => item.id === 'lem-new').status, 'verified');
  delete process.env.QMD_PROVER_VERIFIER;
});

test('staleness invalidates verified reverse dependencies and retains exact paths', async () => {
  const root = await project();
  process.env.QMD_PROVER_VERIFIER = verifier;
  const baseFile = path.join(root, 'base.qmd');
  await writeFile(baseFile, result('lem-stale-base', 'The stable premise.', { exported: true }));
  await writeFile(path.join(root, 'goal.qmd'), document(
    [{ from: 'base.qmd', use: ['lem-stale-base'] }],
    result('thm-main-stale-chain', 'The dependent conclusion.')
  ));
  const baseProposal = proposalPath(root, 'base-proof.qmd');
  await writeFile(baseProposal, proof('lem-stale-base', 'A proof of the premise.'));
  assert.equal((await submitProof(root, baseProposal, options)).status, 'verified');
  const targetProposal = proposalPath(root, 'target-proof.qmd');
  await writeFile(targetProposal, proof('thm-main-stale-chain', 'Apply @lem-stale-base.'));
  assert.equal((await submitProof(root, targetProposal, options)).status, 'verified');
  assert.deepEqual((await compileProject(root, options)).manifest.results.map((item) => item.status), ['verified', 'verified']);
  assert.deepEqual((await analyzeDependencies(root, 'impact', ['@lem-stale-base'], options)).affected.map((item) => item.id), ['thm-main-stale-chain']);

  await writeFile(baseFile, result('lem-stale-base', 'The stable premise.', { proofText: 'A changed proof.', exported: true }));
  const stale = await checkStaleness(root, options);
  assert.deepEqual(stale.changed.map((item) => item.id), ['lem-stale-base']);
  assert.deepEqual(stale.invalidated.find((item) => item.id === 'thm-main-stale-chain').path, ['lem-stale-base', 'thm-main-stale-chain']);
  const index = await readJson(path.join(root, '.qmd-prover', 'verification', 'index.json'));
  assert.equal(index['lem-stale-base'].status, 'stale');
  assert.equal(index['thm-main-stale-chain'].status, 'stale');
  assert.doesNotMatch(await readFile(path.join(root, 'goal.qmd'), 'utf8'), /^VERIFIED$/m);
  assert.deepEqual((await compileProject(root, options)).manifest.results.map((item) => item.status), ['stale', 'stale']);
  delete process.env.QMD_PROVER_VERIFIER;
});

test('staleness fails closed when the configured checker contract changes', async () => {
  const root = await project();
  process.env.QMD_PROVER_VERIFIER = verifier;
  await writeFile(path.join(root, 'fact.qmd'), result('lem-checker-contract', 'A checked fact.'));
  const proposal = proposalPath(root, 'checker-contract.qmd');
  await writeFile(proposal, proof('lem-checker-contract', 'A direct proof.'));
  assert.equal((await submitProof(root, proposal, options)).status, 'verified');
  await writeFile(path.join(root, '.qmd-prover', 'config.yml'), 'verification:\n  backend: none\n  model: changed-model\n');
  const stale = await checkStaleness(root, options);
  assert.deepEqual(stale.changed[0].reasons, ['checker-contract-changed']);
  assert.equal((await compileProject(root, options)).manifest.results[0].status, 'stale');
  delete process.env.QMD_PROVER_VERIFIER;
});

test('staleness invalidates verified results when the external basis changes', async () => {
  const root = await project();
  process.env.QMD_PROVER_VERIFIER = verifier;
  const policyFile = path.join(root, '.qmd-prover', '.external.qmd');
  const targetFile = path.join(root, 'external-policy-goal.qmd');
  await writeFile(policyFile, 'Standard arithmetic may be used.\n');
  await writeFile(targetFile, result('thm-main-external-policy', 'A policy-sensitive claim.'));
  const proposal = proposalPath(root, 'external-policy.qmd');
  await writeFile(proposal, proof('thm-main-external-policy', 'Use the allowed external basis.'));
  assert.equal((await submitProof(root, proposal, options)).status, 'verified');
  await writeFile(policyFile, '  \n');
  const stale = await checkStaleness(root, options);
  assert.equal(stale.changed[0].id, 'thm-main-external-policy');
  assert.deepEqual(stale.changed[0].reasons, ['external-basis-changed']);
  assert.notEqual(stale.changed[0].previous.external_basis_hash, stale.changed[0].current.external_basis_hash);
  assert.doesNotMatch(await readFile(targetFile, 'utf8'), /VERIFIED/);
  delete process.env.QMD_PROVER_VERIFIER;
});

test('render prepares Quarto-compatible status QMD and an SVG linked to canonical sources', async () => {
  const root = await project();
  await writeFile(path.join(root, 'goal.qmd'), result('thm-main-render', 'If x < y, then x < y.', { title: 'Render < safely' }));
  const rendered = await renderProject(root, options);
  assert.equal(rendered.status, 'prepared');
  assert.equal(rendered.render_command, 'quarto render');
  const statusQmd = await readFile(path.join(root, '.qmd-prover', 'generated', 'proof-status.qmd'), 'utf8');
  const graph = await readFile(path.join(root, '.qmd-prover', 'generated', 'dependencies.svg'), 'utf8');
  assert.match(statusQmd, /\| @thm-main-render \| open \|/);
  assert.match(graph, /goal\.qmd#thm-main-render/);
  assert.match(graph, /Render &lt; safely/);
  assert.equal((await readJson(path.join(root, '.qmd-prover', 'reports', 'status.json'))).summary.results, 1);
  await assert.rejects(() => stat(path.join(root, '.qmd-prover', 'site')), /ENOENT/);
});

test('goal workspaces preserve a protected target snapshot and report staleness', async () => {
  const root = await project();
  const canonical = path.join(root, 'goal.qmd');
  await writeFile(canonical, result('thm-main-work', 'Do the work.', { title: 'Workspace theorem' }));
  const created = await initializeWorkspace(root, '@thm-main-work', options);
  assert.equal(created.status, 'created');
  const workspace = path.join(root, created.workspace);
  assert.match(await readFile(path.join(workspace, 'target.qmd'), 'utf8'), /#thm-main-work/);
  await mkdir(path.join(workspace, 'local-theory'));
  await mkdir(path.join(workspace, '.machine'));
  await mkdir(path.join(workspace, 'generated'));
  await writeFile(path.join(workspace, 'local-theory', 'lemma.qmd'), result('lem-work', 'A working lemma.', { proofText: 'A workspace argument.' }));
  await writeFile(path.join(workspace, '.machine', 'ignored.qmd'), result('lem-hidden-work', 'Hidden machine state.'));
  await writeFile(path.join(workspace, 'generated', 'ignored.qmd'), result('lem-generated-work', 'Generated output.'));
  await writeFile(path.join(workspace, 'main-attempt.qmd'), proof('thm-main-work', 'Use @lem-work.'));
  const inspected = await inspectWorkspace(root, '@thm-main-work', options);
  assert.equal(inspected.stale, false);
  assert.ok(inspected.manifest.results.every((item) => item.origin === 'workspace'));
  assert.equal(inspected.manifest.results.find((item) => item.id === 'lem-work').status, 'workspace-candidate');
  assert.equal(inspected.manifest.results.find((item) => item.id === 'thm-main-work').status, 'workspace-candidate');
  assert.ok(!inspected.manifest.results.some((item) => ['lem-hidden-work', 'lem-generated-work'].includes(item.id)));
  assert.ok(inspected.graph.edges.some((edge) => edge.from === 'thm-main-work' && edge.to === 'lem-work'));
  await writeFile(canonical, result('thm-main-work', 'Do the work.', { title: 'Workspace theorem', proofText: 'A concurrent proof.' }));
  assert.equal((await inspectWorkspace(root, '@thm-main-work', options)).stale, true);
});

test('workspace inspection verifies a provisional dependency chain and reuses exact caches', async () => {
  const root = await project();
  const countFile = path.join(root, 'workspace-verifier-calls.txt');
  process.env.QMD_PROVER_VERIFIER = verifier;
  process.env.QMD_PROVER_VERIFIER_COUNT = countFile;
  try {
    await writeFile(path.join(root, 'goal.qmd'), result('thm-main-workspace-ai', 'The workspace route succeeds.'));
    const created = await initializeWorkspace(root, '@thm-main-workspace-ai', options);
    const workspace = path.join(root, created.workspace);
    const route = path.join(workspace, 'route.qmd');
    await writeFile(route, [
      result('def-workspace-object', 'Construct the workspace object.'),
      result('lem-workspace-route', 'The workspace object has the needed property.', { proofText: 'Apply @def-workspace-object.' }),
      proof('thm-main-workspace-ai', 'Apply @lem-workspace-route.')
    ].join('\n'));

    const first = await inspectWorkspace(root, '@thm-main-workspace-ai', options);
    assert.equal(first.ok, true, JSON.stringify(first.diagnostics));
    assert.equal(first.verification.verifier_calls, 3);
    assert.deepEqual(first.facts.map((fact) => fact.status), ['workspace-verified', 'workspace-verified', 'workspace-verified']);
    assert.doesNotMatch(await readFile(route, 'utf8'), /VERIFIED/);
    const firstSnapshot = first.snapshot_id;
    const firstPointer = await readJson(path.join(workspace, 'latest.json'));
    assert.equal(firstPointer.snapshot_id, firstSnapshot);
    assert.equal((await readJson(path.join(workspace, firstPointer.file))).snapshot_id, firstSnapshot);

    const second = await inspectWorkspace(root, '@thm-main-workspace-ai', options);
    assert.equal(second.ok, true);
    assert.equal(second.verification.verifier_calls, 0);
    assert.equal(second.verification.cache_hits, 3);
    assert.equal(second.snapshot_id, firstSnapshot);
    assert.equal((await readFile(countFile, 'utf8')).trim().split('\n').length, 3);

    await writeFile(route, `\n${await readFile(route, 'utf8')}`);
    const moved = await inspectWorkspace(root, '@thm-main-workspace-ai', options);
    assert.equal(moved.ok, true);
    assert.equal(moved.verification.verifier_calls, 0);
    assert.equal(moved.verification.cache_hits, 3);

    await writeFile(route, (await readFile(route, 'utf8')).replace('Apply @def-workspace-object.', 'Apply @def-workspace-object by the changed route.'));
    const changed = await inspectWorkspace(root, '@thm-main-workspace-ai', options);
    assert.equal(changed.ok, true);
    assert.equal(changed.verification.verifier_calls, 2);
    assert.equal(changed.verification.cache_hits, 1);
    assert.notEqual(changed.snapshot_id, firstSnapshot);
    assert.equal((await readFile(countFile, 'utf8')).trim().split('\n').length, 5);
  } finally {
    delete process.env.QMD_PROVER_VERIFIER;
    delete process.env.QMD_PROVER_VERIFIER_COUNT;
  }
});

test('workspace inspection admits only current verified canonical imports from the protected target', async () => {
  const root = await project();
  process.env.QMD_PROVER_VERIFIER = verifier;
  await writeFile(path.join(root, 'base.qmd'), `${result('lem-workspace-import', 'Imported premise.', { exported: true })}\n${result('lem-workspace-hidden', 'Unimported premise.', { exported: true })}`);
  await writeFile(path.join(root, 'goal.qmd'), document(
    [{ from: 'base.qmd', use: ['lem-workspace-import'] }],
    result('thm-main-workspace-scope', 'Workspace conclusion.')
  ));
  for (const id of ['lem-workspace-import', 'lem-workspace-hidden']) {
    const proposal = proposalPath(root, `${id}.qmd`);
    await writeFile(proposal, proof(id, 'A direct proof.'));
    assert.equal((await submitProof(root, proposal, options)).status, 'verified');
  }
  const created = await initializeWorkspace(root, '@thm-main-workspace-scope', options);
  const workspace = path.join(root, created.workspace);
  const attempt = path.join(workspace, 'main-attempt.qmd');
  await writeFile(attempt, proof('thm-main-workspace-scope', 'Apply @lem-workspace-import.'));
  const available = await inspectWorkspace(root, '@thm-main-workspace-scope', options);
  assert.equal(available.ok, true, JSON.stringify(available.diagnostics));
  assert.equal(available.graph.edges[0].checks.scope, 'pass');
  assert.equal(available.graph.edges[0].checks.status, 'pass');
  await writeFile(attempt, proof('thm-main-workspace-scope', 'Apply @lem-workspace-hidden.'));
  const unavailable = await inspectWorkspace(root, '@thm-main-workspace-scope', options);
  assert.equal(unavailable.ok, false);
  assert.ok(unavailable.diagnostics.some((item) => item.code === 'WORKSPACE_DEPENDENCY_UNAVAILABLE'));
  delete process.env.QMD_PROVER_VERIFIER;
});

test('concurrent independent submissions serialize canonical state writes', async () => {
  const root = await project();
  process.env.QMD_PROVER_VERIFIER = verifier;
  await writeFile(path.join(root, 'goals.qmd'), `${result('thm-main-left', 'Left is left.')}\n${result('thm-main-right', 'Right is right.')}`);
  const left = proposalPath(root, 'left.qmd');
  const right = proposalPath(root, 'right.qmd');
  await Promise.all([writeFile(left, proof('thm-main-left', 'By reflexivity.')), writeFile(right, proof('thm-main-right', 'By reflexivity.'))]);
  const results = await Promise.all([submitProof(root, left, options), submitProof(root, right, options)]);
  assert.deepEqual(results.map((item) => item.status), ['verified', 'verified']);
  assert.deepEqual((await compileProject(root, options)).manifest.results.map((item) => item.status), ['verified', 'verified']);
  const events = (await readFile(path.join(root, '.qmd-prover', 'events.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(events.filter((event) => event.type === 'verification-accepted').length, 2);
  delete process.env.QMD_PROVER_VERIFIER;
});

test('accepted verifier output is rejected as stale after a concurrent target edit', async () => {
  const root = await project();
  const targetFile = path.join(root, 'goal.qmd');
  const marker = path.join(root, 'verifier-ready');
  await writeFile(targetFile, result('thm-main-stale', 'Keep current state.'));
  const proposal = proposalPath(root, 'stale.qmd');
  await writeFile(proposal, proof('thm-main-stale', 'Candidate proof.'));
  process.env.QMD_PROVER_VERIFIER = staleVerifier;
  process.env.QMD_PROVER_VERIFIER_READY = marker;
  const submission = submitProof(root, proposal, options);
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try { await readFile(marker); break; } catch { await new Promise((resolve) => setTimeout(resolve, 10)); }
  }
  await writeFile(targetFile, result('thm-main-stale', 'Keep current state.', { proofText: 'Concurrent canonical proof.' }));
  await assert.rejects(submission, /Stale submission/);
  assert.match(await readFile(targetFile, 'utf8'), /Concurrent canonical proof/);
  delete process.env.QMD_PROVER_VERIFIER;
  delete process.env.QMD_PROVER_VERIFIER_READY;
});

test('accepted verifier output is rejected as stale after the external basis changes', async () => {
  const root = await project();
  const policyFile = path.join(root, '.qmd-prover', '.external.qmd');
  const marker = path.join(root, 'external-verifier-ready');
  await writeFile(policyFile, 'Only elementary arithmetic may be used.\n');
  await writeFile(path.join(root, 'goal.qmd'), result('thm-main-external-stale', 'Keep the same external basis.'));
  const proposal = proposalPath(root, 'external-stale.qmd');
  await writeFile(proposal, proof('thm-main-external-stale', 'Candidate proof.'));
  process.env.QMD_PROVER_VERIFIER = staleVerifier;
  process.env.QMD_PROVER_VERIFIER_READY = marker;
  const submission = submitProof(root, proposal, options);
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try { await readFile(marker); break; } catch { await new Promise((resolve) => setTimeout(resolve, 10)); }
  }
  await writeFile(policyFile, 'Standard algebra may be used.\n');
  await assert.rejects(submission, /external basis changed/);
  delete process.env.QMD_PROVER_VERIFIER;
  delete process.env.QMD_PROVER_VERIFIER_READY;
});

test('project initialization inventories external policy, adopts, preserves, appends, and synchronizes safely', async () => {
  const canonicalSource = await readFile(path.join(here, '..', 'skills', 'qmd-prover', 'references', 'AGENTS.md'), 'utf8');
  const canonicalBlock = canonicalSource.match(/<!-- qmd-prover-contract:start version=12 -->[\s\S]*?<!-- qmd-prover-contract:end -->/)[0];

  const fresh = await bareProject();
  const created = await initializeProject(fresh);
  assert.deepEqual({ ok: created.ok, status: created.status, version: created.contract_version }, { ok: true, status: 'created', version: 12 });
  assert.equal(created.existing.external_policy.mode, 'unrestricted');
  assert.equal(created.workspace_root, '.qmd-prover/workspaces');
  assert.equal((await stat(path.join(fresh, '.qmd-prover', 'workspaces'))).isDirectory(), true);
  assert.match(await readFile(path.join(fresh, 'AGENTS.md'), 'utf8'), /## Project-specific additions/);
  assert.equal((await initializeProject(fresh)).status, 'already-initialized');

  const external = await bareProject();
  await mkdir(path.join(external, '.qmd-prover'));
  await writeFile(path.join(external, '.qmd-prover', '.external.qmd'), '  \n');
  assert.equal((await initializeProject(external)).existing.external_policy.mode, 'none');
  await writeFile(path.join(external, '.qmd-prover', '.external.qmd'), 'Standard ZFC may be used.\n');
  assert.deepEqual(await readExternalPolicy(external), {
    path: '.qmd-prover/.external.qmd', mode: 'declared', content: 'Standard ZFC may be used.\n'
  });

  const partial = await bareProject();
  await mkdir(path.join(partial, 'theory'));
  await writeFile(path.join(partial, '_quarto.yml'), 'project:\n  type: website\n');
  await writeFile(path.join(partial, 'theory', 'existing.qmd'), '# Existing mathematics\n');
  const intentRequired = await initializeProject(partial);
  assert.deepEqual({ ok: intentRequired.ok, status: intentRequired.status }, { ok: false, status: 'intent-required' });
  assert.deepEqual(intentRequired.existing.quarto_configs, ['_quarto.yml']);
  assert.deepEqual(intentRequired.existing.qmd_files, ['theory/existing.qmd']);
  await assert.rejects(readFile(path.join(partial, 'AGENTS.md')), { code: 'ENOENT' });
  await assert.rejects(stat(path.join(partial, '.qmd-prover')), { code: 'ENOENT' });
  assert.equal((await initializeProject(partial, { adoptExisting: true })).status, 'adopted');
  assert.equal(await readFile(path.join(partial, 'theory', 'existing.qmd'), 'utf8'), '# Existing mathematics\n');

  const existing = await bareProject();
  const localPolicy = '# Existing project policy\n\n- Preserve this rule.\n';
  await writeFile(path.join(existing, 'AGENTS.md'), localPolicy);
  const appendRequired = await initializeProject(existing);
  assert.equal(appendRequired.status, 'append-required');
  assert.equal(appendRequired.ok, false);
  assert.equal(await readFile(path.join(existing, 'AGENTS.md'), 'utf8'), localPolicy);
  assert.equal((await initializeProject(existing, { appendContract: true })).status, 'appended');
  const appended = await readFile(path.join(existing, 'AGENTS.md'), 'utf8');
  assert.ok(appended.startsWith(localPolicy));
  assert.ok(appended.includes(canonicalBlock));

  const stale = await bareProject();
  const oldBlock = canonicalBlock.replace('version=12', 'version=1');
  await writeFile(path.join(stale, 'AGENTS.md'), `# Local before\n\n${oldBlock}\n\n## Local after\n`);
  const syncRequired = await initializeProject(stale);
  assert.deepEqual({ ok: syncRequired.ok, status: syncRequired.status, current: syncRequired.current_contract_version }, { ok: false, status: 'sync-required', current: 1 });
  assert.equal((await initializeProject(stale, { syncContract: true })).status, 'synchronized');
  const synchronized = await readFile(path.join(stale, 'AGENTS.md'), 'utf8');
  assert.match(synchronized, /^# Local before/);
  assert.match(synchronized, /## Local after\n$/);
  assert.ok(synchronized.includes(canonicalBlock));
  assert.doesNotMatch(synchronized, /version=1 -->/);
});

test('dispatcher preserves JSON commands and adds workspace operations', async () => {
  const root = await bareProject();
  const cli = path.join(here, '..', 'skills', 'qmd-prover', 'scripts', 'qmd-prover.mjs');
  const initialized = await new Promise((resolve, reject) => execFile(process.execPath, [cli, 'init'], {
    cwd: root
  }, (error, stdout, stderr) => error ? reject(error) : resolve(JSON.parse(stdout))));
  assert.equal(initialized.status, 'created');
  assert.equal(initialized.contract_version, 12);
  assert.equal(initialized.workspace_root, '.qmd-prover/workspaces');
  const policyRoot = await bareProject();
  await writeFile(path.join(policyRoot, 'AGENTS.md'), '# Existing policy\n');
  const guarded = await new Promise((resolve) => execFile(process.execPath, [cli, 'init'], {
    cwd: policyRoot
  }, (error, stdout) => resolve({ error, output: JSON.parse(stdout) })));
  assert.equal(guarded.error.code, 2);
  assert.deepEqual({ ok: guarded.output.ok, status: guarded.output.status }, { ok: false, status: 'append-required' });
  await chmod(fakePandoc, 0o755);
  await writeFile(path.join(root, 'goal.qmd'), result('thm-main-cli', 'CLI statement.', { proofText: 'The statement follows directly.' }));
  const run = await new Promise((resolve, reject) => execFile(process.execPath, [cli, 'inspect', 'project'], {
    cwd: root, env: { ...process.env, QMD_PROVER_PANDOC: fakePandoc, QMD_PROVER_VERIFIER: verifier }
  }, (error, stdout, stderr) => error ? reject(error) : resolve({ stdout, stderr })));
  const jsonInspection = JSON.parse(run.stdout);
  assert.equal(jsonInspection.summary.goals[0].id, 'thm-main-cli');
  const cliEnv = { ...process.env, QMD_PROVER_PANDOC: fakePandoc, QMD_PROVER_VERIFIER: verifier };
  const runJson = (args) => new Promise((resolve, reject) => execFile(process.execPath, [cli, ...args], {
    cwd: root, env: cliEnv
  }, (error, stdout) => error ? reject(error) : resolve(JSON.parse(stdout))));
  assert.equal((await runJson(['inspect', 'fact', '@thm-main-cli'])).fact.id, 'thm-main-cli');
  assert.equal((await runJson(['inspect', 'theorem', '@thm-main-cli'])).fact.id, 'thm-main-cli');
  assert.deepEqual((await runJson(['inspect', 'path', 'goal.qmd'])).scope, { type: 'file', path: 'goal.qmd' });
  assert.equal((await runJson(['dependency', 'reverse', 'dependencies', '@thm-main-cli'])).operation, 'dependency-reverse-dependencies');
  assert.equal((await runJson(['dependency', 'alternative', 'paths', '@thm-main-cli', '@thm-main-cli'])).operation, 'dependency-alternative-paths');
  assert.equal((await runJson(['dependency', 'unused', 'imports'])).operation, 'dependency-unused-imports');
  assert.equal((await runJson(['dependency', 'unused', 'exports'])).operation, 'dependency-unused-exports');
  assert.equal((await runJson(['dependency', 'ready', 'for', 'ai'])).operation, 'dependency-ready-for-ai');
  assert.equal((await runJson(['check', 'staleness'])).operation, 'check-staleness');
  const printed = await new Promise((resolve, reject) => execFile(process.execPath, [cli, 'inspect', 'project', '--print'], {
    cwd: root, env: { ...process.env, QMD_PROVER_PANDOC: fakePandoc, QMD_PROVER_VERIFIER: verifier }
  }, (error, stdout) => error ? reject(error) : resolve(stdout)));
  assert.match(printed, new RegExp(`snapshot: ${jsonInspection.snapshot_id}`));
  const workspace = await new Promise((resolve, reject) => execFile(process.execPath, [cli, 'workspace', 'init', '@thm-main-cli'], {
    cwd: root, env: { ...process.env, QMD_PROVER_PANDOC: fakePandoc, QMD_PROVER_VERIFIER: verifier }
  }, (error, stdout) => error ? reject(error) : resolve(JSON.parse(stdout))));
  assert.equal(workspace.status, 'created');
  await writeFile(path.join(root, 'duplicate.qmd'), result('thm-main-cli', 'Duplicate.'));
  const failed = await new Promise((resolve) => execFile(process.execPath, [cli, 'inspect', 'project'], {
    cwd: root, env: { ...process.env, QMD_PROVER_PANDOC: fakePandoc, QMD_PROVER_VERIFIER: verifier }
  }, (error, stdout) => resolve({ error, stdout })));
  assert.equal(failed.error.code, 2);
  assert.equal(JSON.parse(failed.stdout).ok, false);
});

test('dispatcher provides help for every command group and leaf', async () => {
  const cli = path.join(here, '..', 'skills', 'qmd-prover', 'scripts', 'qmd-prover.mjs');
  const run = (args) => new Promise((resolve) => execFile(process.execPath, [cli, ...args], (error, stdout, stderr) => resolve({ error, stdout, stderr })));
  const commands = [
    'init',
    'inspect', 'inspect project', 'inspect fact', 'inspect theorem', 'inspect path',
    'dependency', 'dependency dependencies', 'dependency reverse', 'dependency reverse dependencies',
    'dependency impact', 'dependency frontier', 'dependency path', 'dependency alternative', 'dependency alternative paths',
    'dependency cycles', 'dependency findings', 'dependency unused', 'dependency unused imports', 'dependency unused exports',
    'dependency isolated', 'dependency unreachable', 'dependency ready', 'dependency ready for', 'dependency ready for ai',
    'dependency reused', 'dependency search',
    'check', 'check staleness',
    'workspace', 'workspace init', 'workspace inspect',
    'submit', 'submit proof',
    'verification', 'verification show', 'verification revoke',
    'render'
  ];
  const rootHelp = await run(['help']);
  assert.equal(rootHelp.error, null);
  assert.match(rootHelp.stdout, /^Usage:\n/);
  for (const command of commands) {
    const result = await run([...command.split(' '), 'help']);
    assert.equal(result.error, null, `${command} help failed: ${result.stderr}`);
    assert.match(result.stdout, /^Usage:\n/);
    assert.match(result.stdout, new RegExp(`qmd-prover ${command.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  }
  assert.equal((await run(['help', 'inspect', 'fact'])).error, null);
  assert.equal((await run(['inspect', 'fact', '--help'])).error, null);
  assert.equal((await run(['inspect', 'fact', '-h'])).error, null);
  const removed = await run(['inspect-project', '--help']);
  assert.equal(removed.error.code, 1);
  assert.match(removed.stderr, /Unknown command: inspect-project/);
  const removedDependency = await run(['dependency', 'alternative-paths', '--help']);
  assert.equal(removedDependency.error.code, 1);
  assert.match(removedDependency.stderr, /Unknown command: dependency alternative-paths/);
  const removedInit = await run(['init', 'project', '--help']);
  assert.equal(removedInit.error.code, 1);
  assert.match(removedInit.stderr, /Unknown command: init project/);
});

test('skill requires a once-per-context versioned project contract preflight', async () => {
  const skillRoot = path.join(here, '..', 'skills', 'qmd-prover');
  const [skill, contract] = await Promise.all([
    readFile(path.join(skillRoot, 'SKILL.md'), 'utf8'),
    readFile(path.join(skillRoot, 'references', 'AGENTS.md'), 'utf8')
  ]);
  assert.match(skill, /current agent in the same project context/);
  assert.match(skill, /Do not reread the files before every QMD read/);
  assert.match(skill, /Every independent worker must perform this preflight/);
  assert.match(skill, /Never create, replace, or synchronize `AGENTS\.md` without user approval/);
  assert.match(skill, /Do not impose a fixed mathematical strategy/);
  assert.match(skill, /workspace init @thm-main-ID/);
  assert.match(skill, /asks to initialize qmd-prover/);
  assert.match(skill, /init --append-contract/);
  assert.match(skill, /init --sync-contract/);
  assert.match(contract, /<!-- qmd-prover-contract:start version=12 -->/);
  assert.match(contract, /\.qmd-prover\/\.external\.qmd/);
  assert.match(contract, /file absent \| External results are unrestricted/);
  assert.match(contract, /file present but whitespace-only \| Use no external mathematical results/);
  assert.match(contract, /<!-- qmd-prover-contract:end -->/);
  assert.match(contract, /name="Uniform index theorem"/);
  assert.match(contract, /\.proof of="thm-main-uniform-index"/);
  assert.match(contract, /qmd-prover:\n  imports:/);
  assert.match(contract, /\| `\.definition` \| `def-\*` \|/);
  assert.match(contract, /\| `\.lemma` \| `lem-\*` \|/);
  assert.match(contract, /\| `\.proposition` \| `prp-\*` \|/);
  assert.match(contract, /\| `\.theorem` \| `thm-\*` \|/);
  assert.match(contract, /\| `\.corollary` \| `cor-\*` \|/);
  assert.match(contract, /\| `\.theorem \.goal` \| `thm-main-\*` \|/);
  assert.match(contract, /ISO introduction `date`/);
  assert.match(contract, /`OPEN`/);
  assert.match(contract, /`REJECTED`/);
  assert.match(contract, /`REVOKED`/);
  assert.match(contract, /configured external independent verifier/);
  assert.match(contract, /Prefer `inspect fact` or `inspect path`/);
  assert.match(contract, /last nonempty paragraph of the definition block/);
  assert.match(contract, /`workspace-verified` result is established only inside that provisional workspace snapshot/);
  assert.match(contract, /does not prescribe a fixed proof workflow/);
  assert.match(contract, /does not establish compliance by itself/);
  assert.match(contract, /qmd-prover\.mjs" init/);
  assert.match(contract, /intent-required/);
  assert.match(contract, /\.qmd-prover\/workspaces\/<thm-main-ID>\//);
  assert.match(contract, /canonical QMD as read-only/);
  assert.doesNotMatch(contract, /For each requested goal:/);
  assert.doesNotMatch(contract, /### Uses/);
  assert.match(contract, /Project-specific additions/);
});
