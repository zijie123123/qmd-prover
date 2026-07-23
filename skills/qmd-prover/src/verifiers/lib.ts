// Shared helpers for qmd-prover independent-verifier adapters.
//
// An adapter is a small program that qmd-prover spawns for one local conditional
// check. It receives ONE JSON verification packet on stdin and must print ONE JSON
// verdict object on stdout, conforming to the protocol in references/cli.md:
//   { verdict: "correct"|"incorrect"|"disproved", summary, critical_errors[],
//     gaps[], nonblocking_comments[], repair_hints, refutation }
//
// These helpers turn that contract into a one-liner for a concrete model CLI:
// build the prompt from the packet, run the CLI, pull the verdict JSON back out.
// Runtime is dependency-free: Node builtins only. The two imports below are
// `import type`, so they erase at compile time and add no runtime coupling — the
// emitted .js still imports nothing but node:child_process.

import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { VerifierPacket } from '../core/verification/protocol.js';
import type { VerifierReport, VerifierUsage } from '../core/shared/verdicts.js';

/** Flags parsed from argv: `--name value` yields a string, a bare `--flag` yields true. */
export type AdapterOptions = Record<string, string | boolean>;

/** What an adapter returns: the raw model text, or that text plus token usage the backend reported. */
export type AdapterResult = string | { text: string; usage?: VerifierUsage };

/** The invoke callback each adapter supplies: prompt in, raw model text (and optional usage) out. */
export type AdapterInvoke = (prompt: string, options: AdapterOptions) => Promise<AdapterResult>;

export interface ProcessResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

/** Parse `--name value` / `--flag` pairs from argv. */
export function parseArgs(argv: string[] = process.argv.slice(2)): AdapterOptions {
  const options: AdapterOptions = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) continue;
    const next = argv[index + 1];
    options[token.slice(2)] = next !== undefined && !next.startsWith('--') ? argv[(index += 1)] : true;
  }
  return options;
}

/** Read the whole verification packet from stdin. */
export async function readPacket(): Promise<VerifierPacket> {
  let raw = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) raw += chunk;
  return JSON.parse(raw) as VerifierPacket;
}

/**
 * Compose the model prompt from the packet. `packet.instructions` is already a
 * complete reviewer prompt; we append the exact target/dependencies/basis and the
 * required output schema.
 */
export function buildPrompt(packet: VerifierPacket): string {
  const context = {
    target: packet.target,
    dependencies: packet.dependencies,
    external_basis: packet.external_basis,
    scope: packet.scope,
    checker_contract: packet.checker_contract
  };
  return [
    String(packet.instructions ?? '').trim(),
    '',
    'VERIFICATION PACKET (JSON):',
    JSON.stringify(context, null, 2),
    '',
    'OUTPUT SCHEMA — return one JSON object with exactly these fields (the values below describe each field):',
    JSON.stringify(packet.output_schema ?? {}, null, 2)
  ].join('\n');
}

/** Spawn a process, optionally feed it `input` on stdin, and collect its output. */
export function runProcess(command: string, args: string[], input?: string): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
    child.stdin.on('error', (error: NodeJS.ErrnoException) => { if (error && error.code !== 'EPIPE') reject(error); });
    child.stdin.end(input ?? '');
  });
}

/**
 * Repair the two ways a model reliably breaks JSON when its strings carry mathematics:
 * TeX escapes that are not valid JSON escapes (`\(`, `\xi`, …) and raw control characters
 * (literal newlines or tabs inside a string). Both are rewritten to their escaped forms;
 * every already-valid escape is left untouched, so valid JSON passes through byte-for-byte.
 */
export function repairJsonEscapes(candidate: string): string {
  let repaired = '';
  let inString = false;
  for (let index = 0; index < candidate.length; index += 1) {
    const char = candidate[index];
    if (!inString) {
      if (char === '"') inString = true;
      repaired += char;
      continue;
    }
    if (char === '\\') {
      const next = candidate[index + 1] ?? '';
      if ('"\\/bfnrt'.includes(next)) { repaired += char + next; index += 1; }
      else if (next === 'u' && /^[0-9a-fA-F]{4}$/.test(candidate.slice(index + 2, index + 6))) { repaired += candidate.slice(index, index + 6); index += 5; }
      else repaired += '\\\\';
      continue;
    }
    if (char === '"') { inString = false; repaired += char; continue; }
    if (char < ' ') {
      const short: Record<string, string> = { '\n': '\\n', '\r': '\\r', '\t': '\\t', '\b': '\\b', '\f': '\\f' };
      repaired += short[char] ?? `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`;
      continue;
    }
    repaired += char;
  }
  return repaired;
}

/** What scanning the model output for a verdict produced. */
export interface VerdictExtraction {
  verdict: Record<string, unknown> | null;
  /** Set when a balanced object mentioning "verdict" was found but could not be parsed even after repair. */
  malformed: { candidate: string; error: string } | null;
}

/**
 * Find the first balanced {...} object carrying a "verdict" field. Objects that are not strictly
 * valid JSON get one repair attempt (see repairJsonEscapes) before being given up on; a candidate
 * that still fails is reported as malformed rather than pretending no verdict was present.
 */
export function findVerdict(text: string): VerdictExtraction {
  const source = String(text ?? '');
  let malformed: VerdictExtraction['malformed'] = null;
  const attempt = (candidate: string): Record<string, unknown> | null => {
    try {
      const parsed: unknown = JSON.parse(candidate);
      if (parsed && typeof parsed === 'object' && 'verdict' in parsed) return parsed as Record<string, unknown>;
      return null;
    } catch (error) {
      if (!malformed && candidate.includes('"verdict"')) malformed = { candidate, error: (error as Error).message };
      return null;
    }
  };
  for (let start = 0; start < source.length; start += 1) {
    if (source[start] !== '{') continue;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let end = start; end < source.length; end += 1) {
      const char = source[end];
      if (inString) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') inString = false;
        continue;
      }
      if (char === '"') inString = true;
      else if (char === '{') depth += 1;
      else if (char === '}') {
        depth -= 1;
        if (depth === 0) {
          const candidate = source.slice(start, end + 1);
          const parsed = attempt(candidate) ?? attempt(repairJsonEscapes(candidate));
          if (parsed) return { verdict: parsed, malformed: null };
          break;
        }
      }
    }
  }
  return { verdict: null, malformed };
}

/** Back-compatible view of findVerdict: the parsed verdict object, or null. */
export function extractVerdict(text: string): Record<string, unknown> | null {
  return findVerdict(text).verdict;
}

function normalizeVerdict(object: Record<string, unknown>): VerifierReport {
  const list = (value: unknown): string[] => (Array.isArray(value) ? value.map(String) : []);
  const string = (value: unknown): string => (typeof value === 'string' ? value : '');
  return {
    // The adapter passes the verdict through verbatim; qmd-prover's normalizeReport
    // re-validates it against the allowed set, so a cast to the union is safe here.
    verdict: object.verdict as VerifierReport['verdict'],
    summary: string(object.summary),
    critical_errors: list(object.critical_errors),
    gaps: list(object.gaps),
    nonblocking_comments: list(object.nonblocking_comments ?? object.comments),
    repair_hints: string(object.repair_hints),
    refutation: string(object.refutation)
  };
}

/**
 * Recognize the Codex CLI failing to open its own state directory (usually `~/.codex`) because
 * the surrounding sandbox exposes it read-only, and return a short instruction the calling agent
 * can act on. Returns '' for any other failure.
 */
export function codexStateRemediation(stderr: string): string {
  const text = String(stderr ?? '');
  const statePattern = /attempt to write a readonly database|state[_\d]*\.sqlite|failed to initialize in-process app-server client/i;
  if (!statePattern.test(text)) return '';
  return [
    'Codex could not write its own state directory (usually ~/.codex); the mathematics was never reviewed.',
    'To fix: rerun with write access to that directory, or point Codex at a writable location by setting',
    'CODEX_HOME to a writable directory before invoking qmd-prover, e.g.: CODEX_HOME="$(mktemp -d)" qmd-prover inspect …'
  ].join(' ');
}

/**
 * Optional observability: when QMD_PROVER_VERIFIER_DEBUG names a directory, write the
 * exact prompt, the model's raw stdout, and the extracted verdict for each check, keyed
 * by target id. Purely diagnostic — any failure here is swallowed so it can never affect
 * the verdict qmd-prover records. Used to inspect and tune the reviewer prompt.
 */
function debugDump(packet: VerifierPacket, part: 'prompt' | 'output' | 'verdict', value: string): void {
  const dir = process.env.QMD_PROVER_VERIFIER_DEBUG?.trim();
  if (!dir) return;
  try {
    mkdirSync(dir, { recursive: true });
    const id = String((packet.target as { id?: unknown })?.id ?? 'unknown').replace(/[^\w.-]/g, '_') || 'unknown';
    const suffix = part === 'verdict' ? 'verdict.json' : `${part}.txt`;
    writeFileSync(join(dir, `${id}.${suffix}`), value);
  } catch { /* diagnostic only */ }
}

/**
 * Standard adapter runner: read the packet, hand `(prompt, options)` to a backend
 * `invoke` that returns the model's raw text, then extract and emit the verdict.
 * On any failure it exits non-zero so qmd-prover records a verifier error.
 */
export async function runAdapter(invoke: AdapterInvoke): Promise<void> {
  const fail = (message: string, extra = ''): never => {
    process.stderr.write(`${message}${extra ? `\n${extra}` : ''}\n`);
    process.exit(1);
  };
  let packet: VerifierPacket;
  try { packet = await readPacket(); }
  catch (error) { return fail(`verifier adapter: could not parse packet on stdin: ${(error as Error).message}`); }

  const options = parseArgs();
  const prompt = buildPrompt(packet);
  debugDump(packet, 'prompt', prompt);
  let result: AdapterResult;
  try { result = await invoke(prompt, options); }
  catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err && err.code === 'ENOENT') {
      return fail(`verifier adapter: executable not found: ${options.executable}. Install it or set verification.executable to its path.`);
    }
    return fail(`verifier adapter: ${err && err.message ? err.message : String(error)}`);
  }
  const output = typeof result === 'string' ? result : result.text;
  const usage = typeof result === 'string' ? undefined : result.usage;
  debugDump(packet, 'output', String(output ?? ''));

  const extraction = findVerdict(output);
  const verdict = extraction.verdict;
  if (!verdict) {
    // Distinguish "the model returned no verdict at all" from "it returned one we could not parse":
    // the second is an adapter-side serialization problem, and its payload is the evidence.
    if (extraction.malformed) {
      return fail(
        `verifier adapter: model output contained a JSON-shaped object with a "verdict" field, but it is not valid JSON even after escape repair (${extraction.malformed.error})`,
        extraction.malformed.candidate.slice(0, 2000)
      );
    }
    return fail('verifier adapter: model output contained no JSON object with a "verdict" field', String(output).slice(0, 2000));
  }
  // qmd-prover reads `usage` from the emitted JSON as metrics; it is not part of the verdict schema.
  const emitted = usage ? { ...normalizeVerdict(verdict), usage } : normalizeVerdict(verdict);
  debugDump(packet, 'verdict', JSON.stringify(emitted, null, 2));
  process.stdout.write(JSON.stringify(emitted));
}
