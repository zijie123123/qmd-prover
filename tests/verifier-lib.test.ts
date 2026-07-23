import assert from 'node:assert/strict';
import test from 'node:test';
import { codexStateRemediation, extractVerdict, findVerdict, repairJsonEscapes } from '../skills/qmd-prover/src/verifiers/lib.js';
import { must } from './support.js';

test('findVerdict repairs TeX escapes that are invalid JSON and recovers the verdict', () => {
  // The summary carries literal \( \) and \xi — invalid JSON escapes, as Codex actually emits them.
  const output = 'Review complete.\n{"verdict":"correct","summary":"The bound \\(x\\) controls \\xi as claimed.","critical_errors":[],"gaps":[],"repair_hints":""}';
  const extraction = findVerdict(output);
  assert.equal(extraction.malformed, null);
  const verdict = must(extraction.verdict);
  assert.equal(verdict.verdict, 'correct');
  assert.ok(String(verdict.summary).includes('\\(x\\)'));
  assert.ok(String(verdict.summary).includes('\\xi'));
});

test('findVerdict repairs raw control characters inside strings', () => {
  const output = '{"verdict":"incorrect","summary":"line one\nline two","critical_errors":["a\tmissing step"],"gaps":[],"repair_hints":""}';
  const verdict = must(findVerdict(output).verdict);
  assert.equal(verdict.verdict, 'incorrect');
  assert.equal(verdict.summary, 'line one\nline two');
});

test('repairJsonEscapes leaves already-valid JSON byte-for-byte untouched', () => {
  const valid = '{"a":"b\\\\c \\u00e9 tail\\n","d":"\\"quoted\\""}';
  assert.equal(repairJsonEscapes(valid), valid);
  assert.deepEqual(JSON.parse(repairJsonEscapes(valid)), JSON.parse(valid));
});

test('an irreparable verdict object is reported as malformed, not as absent', () => {
  const output = 'prose {"verdict": correct, "summary": "unquoted token"} prose';
  const extraction = findVerdict(output);
  assert.equal(extraction.verdict, null);
  const malformed = must(extraction.malformed);
  assert.ok(malformed.candidate.includes('"verdict"'));
  assert.ok(malformed.error.length > 0);
});

test('output with no verdict object at all stays distinct from the malformed case', () => {
  const extraction = findVerdict('some prose and {"other": 1} but nothing else');
  assert.equal(extraction.verdict, null);
  assert.equal(extraction.malformed, null);
  assert.equal(extractVerdict('no objects here'), null);
});

test('valid verdict objects still parse exactly as before', () => {
  const verdict = must(extractVerdict('noise {"verdict":"correct","summary":"fine"} noise'));
  assert.equal(verdict.verdict, 'correct');
});

test('codexStateRemediation recognizes the read-only state-directory failure', () => {
  const readonly = codexStateRemediation('error: attempt to write a readonly database');
  assert.ok(readonly.includes('CODEX_HOME'));
  const appServer = codexStateRemediation('failed to initialize in-process app-server client: Operation not permitted');
  assert.ok(appServer.includes('CODEX_HOME'));
  const stateFile = codexStateRemediation('cannot open /Users/someone/.codex/state_5.sqlite');
  assert.ok(stateFile.includes('CODEX_HOME'));
  assert.equal(codexStateRemediation('model stream timed out'), '');
});
