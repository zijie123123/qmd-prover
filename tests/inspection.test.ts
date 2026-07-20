import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { inspectFact, inspectPath, inspectProject } from '../skills/qmd-prover/src/commands/inspect/index.js';
import { analyzeDependencies } from '../skills/qmd-prover/src/commands/dependency/index.js';
import { checkStaleness } from '../skills/qmd-prover/src/commands/check/index.js';
import { document, must, options, project, proof, result, verifier } from './support.js';

async function folderFile(root: string, folder: string, name: string, body: string): Promise<string> {
  await mkdir(path.join(root, folder), { recursive: true });
  const file = path.join(root, folder, name);
  await writeFile(file, body);
  return file;
}

test('every QMD file is fully semantic while main-goal shape and statements stay protected', async () => {
  const root = await project();
  const note = path.join(root, 'notes.qmd');
  await writeFile(note, `---\nqmd-prover:\n  imports:\n    - from: missing.qmd\n---\n\n::: {#lem-note .wrong}\nArbitrary user notation.\n:::\n`);
  const noteInspection = await inspectPath(root, 'notes.qmd', options);
  assert.equal(noteInspection.ok, false);
  assert.deepEqual(noteInspection.facts.map((fact) => fact.id), ['lem-note']);
  const noteCodes = new Set(noteInspection.diagnostics.map((item) => item.code));
  assert.ok(noteCodes.has('IMPORT_USE_MISSING'));
  assert.ok(noteCodes.has('SEMANTIC_KIND_MISSING'));

  await writeFile(path.join(root, 'goal.qmd'), result('thm-main-shaped', 'Protected statement.').replace('.theorem .goal', '.theorem'));
  const projectInspection = await inspectProject(root, options);
  assert.ok(projectInspection.diagnostics.some((item) => item.code === 'MAIN_GOAL_SHAPE' && item.id === 'thm-main-shaped'));

  await writeFile(path.join(root, 'goal.qmd'), result('thm-main-shaped', 'Protected statement.'));
  await inspectProject(root, options);
  await writeFile(path.join(root, 'goal.qmd'), result('thm-main-shaped', 'Changed protected statement.'));
  assert.ok((await inspectProject(root, options)).diagnostics.some((item) => item.code === 'MAIN_STATEMENT_MUTATED'));
});

test('inspect path is uniform across folders and a goal without a proof is simply open', async () => {
  const root = await project();
  await writeFile(path.join(root, 'thm-main-path-scope.qmd'), result('thm-main-path-scope', 'thm-main-path-scope statement.'));
  await folderFile(root, 'workspace', 'work.qmd', [
    result('def-path-scope', 'A local construction.'),
    result('lem-path-scope', 'A local consequence.', { proofText: 'Use @def-path-scope.' }),
    proof('thm-main-path-scope', 'Use @lem-path-scope.')
  ].join('\n'));
  process.env.QMD_PROVER_VERIFIER = verifier;
  try {
    const selected = await inspectPath(root, 'workspace/work.qmd', options);
    assert.equal(selected.ok, true, JSON.stringify(selected.diagnostics));
    assert.deepEqual(selected.facts.map((fact) => fact.id).sort(), ['def-path-scope', 'lem-path-scope', 'thm-main-path-scope']);
    const folderSelected = await inspectPath(root, 'workspace', options);
    assert.deepEqual(folderSelected.facts.map((fact) => fact.id).sort(), ['def-path-scope', 'lem-path-scope', 'thm-main-path-scope']);
  } finally { delete process.env.QMD_PROVER_VERIFIER; }

  await writeFile(path.join(root, 'thm-main-unproved.qmd'), result('thm-main-unproved', 'No proof yet.'));
  const open = await inspectFact(root, '@thm-main-unproved', options);
  assert.equal(open.ok, true, JSON.stringify(open.diagnostics));
  assert.equal(open.fact.status, 'open');
  assert.equal(open.check.local_verification.status, 'not-run');
  assert.equal(open.check.local_verification.reason, 'nothing-to-check');
  assert.equal(open.check.global_verification.status, 'open');
});

test('project inspection separates proven folders from folders with unproved local facts', async () => {
  const root = await project();
  await writeFile(path.join(root, 'goals.qmd'), `${result('thm-main-healthy', 'Healthy goal.')}\n${result('thm-main-malformed', 'Unproved goal.')}`);
  await folderFile(root, 'healthy', 'work.qmd', `${result('lem-healthy', 'Healthy lemma.', { proofText: 'Argument.' })}\n${proof('thm-main-healthy', 'Use @lem-healthy.')}`);
  await folderFile(root, 'malformed', 'work.qmd', `${result('lem-malformed', 'Missing proof.')}\n${proof('thm-main-malformed', 'Use @lem-malformed.')}`);
  process.env.QMD_PROVER_VERIFIER = verifier;
  try {
    const inspected = await inspectProject(root, options);
    assert.equal(inspected.ok, true, JSON.stringify(inspected.diagnostics.filter((item) => item.severity === 'error')));
    const byId = new Map(inspected.facts.map((fact) => [fact.id, fact]));
    assert.equal(must(byId.get('lem-healthy')).global_verification.status, 'verified');
    assert.equal(must(byId.get('thm-main-healthy')).global_verification.status, 'verified');
    assert.equal(must(byId.get('lem-malformed')).global_verification.status, 'open');
    assert.equal(must(byId.get('thm-main-malformed')).global_verification.status, 'blocked');
  } finally { delete process.env.QMD_PROVER_VERIFIER; }
});

test('duplicate IDs anywhere in the project are structural errors that block dependency analysis', async () => {
  const root = await project();
  await folderFile(root, 'left', 'work.qmd', result('lem-duplicate', 'Left declaration.', { proofText: 'Argument.' }));
  await folderFile(root, 'right', 'work.qmd', result('lem-duplicate', 'Right declaration.', { proofText: 'Argument.' }));
  const inspected = await inspectProject(root, options);
  assert.equal(inspected.ok, false);
  assert.ok(inspected.diagnostics.some((item) => item.code === 'DUPLICATE_ID' && item.id === 'lem-duplicate'));
  const dependency = await analyzeDependencies(root, 'cycles', [], options);
  assert.equal(dependency.ok, false);
  assert.equal(dependency.computed, false);
  assert.ok((dependency.diagnostics as Array<{ code: string }>).some((item) => item.code === 'DUPLICATE_ID'));
});

test('citations across folders resolve through explicit imports and verify end to end', async () => {
  const root = await project();
  await folderFile(root, 'foundations', 'shared.qmd', result('lem-shared', 'The shared fact.', { proofText: 'Argument.', exported: true }));
  await folderFile(root, 'consumers', 'consumer.qmd', document(
    [{ from: '../foundations/shared.qmd', use: ['lem-shared'] }],
    result('lem-consumer', 'A cross-folder consequence.', { proofText: 'Use @lem-shared.' })
  ));
  await folderFile(root, 'consumers', 'bad.qmd', result('lem-unscoped', 'An unscoped citation.', { proofText: 'Use @lem-shared.' }));
  process.env.QMD_PROVER_VERIFIER = verifier;
  try {
    const inspected = await inspectProject(root, options);
    assert.ok(inspected.graph.edges.some((edge) => edge.from === 'lem-consumer' && edge.to === 'lem-shared' && edge.checks?.scope === 'pass'));
    const byId = new Map(inspected.facts.map((fact) => [fact.id, fact]));
    assert.equal(must(byId.get('lem-shared')).global_verification.status, 'verified');
    assert.equal(must(byId.get('lem-consumer')).global_verification.status, 'verified');
    assert.ok(inspected.diagnostics.some((item) => item.code === 'DEPENDENCY_UNAVAILABLE' && item.id === 'lem-unscoped'));
  } finally { delete process.env.QMD_PROVER_VERIFIER; }
});

test('narrow inspection preserves current verification state for unrelated facts', async () => {
  const root = await project();
  await folderFile(root, 'alpha', 'work.qmd', result('lem-preserve-a', 'A.', { proofText: 'Argument.' }));
  await folderFile(root, 'beta', 'work.qmd', result('lem-preserve-b', 'B.', { proofText: 'Argument.' }));
  process.env.QMD_PROVER_VERIFIER = verifier;
  try {
    const complete = await inspectProject(root, options);
    assert.equal(complete.ok, true, JSON.stringify(complete.diagnostics));
    const narrow = await inspectFact(root, '@lem-preserve-a', options);
    assert.equal(narrow.ok, true, JSON.stringify(narrow.diagnostics));
    assert.ok(!narrow.graph.nodes.some((node) => node.id === 'lem-preserve-b'));
    const published = JSON.parse(await readFile(path.join(root, '.qmd-prover', 'graph.json'), 'utf8')) as {
      nodes: Array<{ id: string; status: string }>;
    };
    assert.equal(published.nodes.find((node) => node.id === 'lem-preserve-b')?.status, 'verified');
    const dependency = await analyzeDependencies(root, 'dependencies', ['@lem-preserve-b'], options);
    assert.equal((dependency.target as { status?: string } | undefined)?.status, 'verified');
  } finally { delete process.env.QMD_PROVER_VERIFIER; }
});

test('citing a protected main goal is a legal dependency edge that stays blocked until the goal verifies', async () => {
  const root = await project();
  await writeFile(path.join(root, 'other.qmd'), result('thm-main-other-basis', 'Another protected goal.', { exported: true }));
  await folderFile(root, 'workspace', 'work.qmd', document(
    [{ from: '../other.qmd', use: ['thm-main-other-basis'] }],
    result('lem-goal-consumer', 'A consequence of the open goal.', { proofText: 'Use @thm-main-other-basis.' })
  ));
  process.env.QMD_PROVER_VERIFIER = verifier;
  try {
    const inspected = await inspectProject(root, options);
    assert.ok(inspected.graph.edges.some((edge) => edge.from === 'lem-goal-consumer' && edge.to === 'thm-main-other-basis' && edge.checks?.scope === 'pass'));
    const consumer = must(inspected.facts.find((fact) => fact.id === 'lem-goal-consumer'));
    assert.equal(consumer.mechanical.status, 'pass');
    assert.equal(consumer.local_verification.status, 'verified');
    assert.equal(consumer.global_verification.status, 'blocked');
    assert.deepEqual(consumer.global_verification.blockers, ['thm-main-other-basis']);
  } finally { delete process.env.QMD_PROVER_VERIFIER; }
});

test('dependency cycles cover project mathematics without a target argument', async () => {
  const root = await project();
  await writeFile(path.join(root, 'goal.qmd'), result('thm-main-cycle-aggregate', 'The cyclic target holds.'));
  await folderFile(root, 'workspace', 'cycle.qmd', [
    result('lem-cycle-aggregate-a', 'A.', { proofText: 'Use @lem-cycle-aggregate-b.' }),
    result('lem-cycle-aggregate-b', 'B.', { proofText: 'Use @lem-cycle-aggregate-a.' }),
    proof('thm-main-cycle-aggregate', 'Use @lem-cycle-aggregate-a.')
  ].join('\n'));
  const cycles = await analyzeDependencies(root, 'cycles', [], options);
  assert.equal(cycles.ok, false);
  assert.deepEqual(cycles.cycles, [['lem-cycle-aggregate-a', 'lem-cycle-aggregate-b', 'lem-cycle-aggregate-a']]);
});

test('parse failures remain PARSE_ERROR instead of becoming unknown facts', async () => {
  const root = await project();
  await writeFile(path.join(root, 'goal.qmd'), result('thm-main-parse', 'Parse target.'));
  const inspected = await inspectFact(root, '@def-not-found', { pandoc: path.join(root, 'missing-pandoc') });
  assert.equal(inspected.ok, false);
  assert.ok(inspected.diagnostics.length > 0);
  assert.ok(inspected.diagnostics.every((item) => item.code === 'PARSE_ERROR'));
});

test('inspection without a verifier leaves QMD source byte-for-byte untouched', async () => {
  const root = await project();
  const userFile = path.join(root, 'goal.qmd');
  await writeFile(userFile, result('thm-main-legacy', 'Legacy statement.', { proofText: 'Legacy proof.' }));
  const before = await readFile(userFile);
  const inspected = await inspectProject(root, options);
  assert.equal(inspected.ok, true);
  // No verifier is configured, so nothing is checked and no status attribute is projected back.
  const audit = await checkStaleness(root, options);
  assert.equal(audit.operation, 'check-staleness');
  assert.deepEqual(await readFile(userFile), before);
});

test('a mutated protected statement fails closed for the goal without blocking unrelated checks', async () => {
  const root = await project();
  const goalFile = path.join(root, 'thm-main-stale-structured.qmd');
  await writeFile(goalFile, result('thm-main-stale-structured', 'Original statement.'));
  await folderFile(root, 'workspace', 'work.qmd', `${result('lem-stale-structured', 'Lemma.', { proofText: 'Argument.' })}\n${proof('thm-main-stale-structured', 'Use @lem-stale-structured.')}`);
  const countFile = path.join(root, 'stale-verifier-calls.txt');
  process.env.QMD_PROVER_VERIFIER = verifier;
  process.env.QMD_PROVER_VERIFIER_COUNT = countFile;
  try {
    const first = await inspectProject(root, options);
    assert.equal(first.ok, true, JSON.stringify(first.diagnostics));
    const firstCalls = (await readFile(countFile, 'utf8')).trim().split('\n');
    assert.deepEqual(firstCalls.sort(), ['lem-stale-structured', 'thm-main-stale-structured']);

    await writeFile(goalFile, result('thm-main-stale-structured', 'Changed statement.'));
    const mutated = await inspectProject(root, options);
    assert.equal(mutated.ok, false);
    assert.ok(mutated.diagnostics.some((item) => item.code === 'MAIN_STATEMENT_MUTATED'));
    const goalCheck = must(mutated.facts.find((fact) => fact.id === 'thm-main-stale-structured'));
    assert.equal(goalCheck.local_verification.status, 'not-run');
    assert.equal(goalCheck.global_verification.status, 'broken');
    assert.deepEqual((await readFile(countFile, 'utf8')).trim().split('\n'), firstCalls);
  } finally {
    delete process.env.QMD_PROVER_VERIFIER;
    delete process.env.QMD_PROVER_VERIFIER_COUNT;
  }
});

test('a .draft proof is never sent, stays open, and becomes checkable when the mark is removed', async () => {
  const root = await project();
  const file = path.join(root, 'work.qmd');
  const countFile = path.join(root, 'draft-verifier-calls.txt');
  await writeFile(file, [
    result('lem-drafted', 'A half-written argument.', { proofText: 'A first step only.', draft: true }),
    result('lem-written', 'A finished argument.', { proofText: 'A complete argument.' })
  ].join('\n'));
  process.env.QMD_PROVER_VERIFIER = verifier;
  process.env.QMD_PROVER_VERIFIER_COUNT = countFile;
  try {
    const drafted = await inspectProject(root, options);
    assert.equal(drafted.ok, true, JSON.stringify(drafted.diagnostics));
    const draft = must(drafted.facts.find((fact) => fact.id === 'lem-drafted'));
    assert.equal(draft.mechanical.status, 'pass');
    assert.equal(draft.local_verification.status, 'not-run');
    assert.equal(draft.local_verification.reason, 'draft');
    assert.equal(draft.global_verification.status, 'open');
    // Only the finished proof reached the verifier; the draft cost nothing.
    assert.deepEqual((await readFile(countFile, 'utf8')).trim().split('\n'), ['lem-written']);

    await writeFile(file, [
      result('lem-drafted', 'A half-written argument.', { proofText: 'A first step only.' }),
      result('lem-written', 'A finished argument.', { proofText: 'A complete argument.' })
    ].join('\n'));
    const finished = await inspectProject(root, options);
    const promoted = must(finished.facts.find((fact) => fact.id === 'lem-drafted'));
    assert.equal(promoted.local_verification.status, 'verified');
    assert.equal(promoted.global_verification.status, 'verified');
  } finally {
    delete process.env.QMD_PROVER_VERIFIER;
    delete process.env.QMD_PROVER_VERIFIER_COUNT;
  }
});

test('an empty proof block warns and leaves the fact open rather than broken', async () => {
  const root = await project();
  await writeFile(path.join(root, 'work.qmd'), `${result('lem-empty', 'A stated but unproved fact.')}\n::: {.proof of="lem-empty"}\n:::\n`);
  process.env.QMD_PROVER_VERIFIER = verifier;
  try {
    const inspected = await inspectProject(root, options);
    assert.equal(inspected.ok, true, JSON.stringify(inspected.diagnostics));
    const empty = must(inspected.facts.find((fact) => fact.id === 'lem-empty'));
    assert.equal(empty.mechanical.status, 'pass');
    assert.equal(empty.global_verification.status, 'open');
    const warning = must(inspected.diagnostics.find((item) => item.code === 'PROOF_EMPTY'));
    assert.equal(warning.severity, 'warning');
  } finally { delete process.env.QMD_PROVER_VERIFIER; }
});

test('an abandoned attempt leaves the fact open; an abandoned fact resolves no references and blocks its citers', async () => {
  const root = await project();
  await writeFile(path.join(root, 'work.qmd'), [
    // .abandon on the proof detaches that attempt only: the result keeps no active proof.
    result('lem-dead-attempt', 'A fact whose only attempt was abandoned.', { proofText: 'A route that failed.', abandon: true }),
    // .abandon on the result retires the whole fact, citations and all.
    result('lem-dead-end', 'A route that went nowhere.', { proofText: 'Use @lem-never-existed.', extra: ' .abandon' }),
    result('lem-live', 'A finished fact.', { proofText: 'A complete argument.' }),
    result('lem-cites-dead', 'A fact leaning on the dead route.', { proofText: 'Use @lem-dead-end.' })
  ].join('\n'));
  process.env.QMD_PROVER_VERIFIER = verifier;
  try {
    const inspected = await inspectProject(root, options);
    const byId = new Map(inspected.facts.map((fact) => [fact.id, fact]));
    assert.equal(must(byId.get('lem-dead-attempt')).global_verification.status, 'open');
    // The abandoned fact cites something that does not exist; that is nobody's problem.
    assert.ok(!inspected.diagnostics.some((item) => item.id === 'lem-dead-end'));
    // ...and contributes no edges, so its dangling citation never reaches the graph.
    assert.ok(!inspected.graph.nodes.some((node) => node.id === 'lem-never-existed'));
    assert.ok(!inspected.graph.edges.some((edge) => edge.from === 'lem-dead-end'));
    assert.equal(must(byId.get('lem-dead-end')).global_verification.status, 'abandoned');
    assert.equal(must(byId.get('lem-live')).global_verification.status, 'verified');
    // An abandoned fact is not a premise, so citing it blocks.
    assert.equal(must(byId.get('lem-cites-dead')).global_verification.status, 'blocked');
  } finally { delete process.env.QMD_PROVER_VERIFIER; }
});
