import { mkdir, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { compileProject, findCycles, theoremBundle } from './compiler.js';
import { externalPolicyHash, readExternalPolicy } from './external.js';
import { atomicJson, atomicWrite, AUX, cleanId, exists, readJson, relativePosix, sha256, stableJson } from './files.js';
import { deriveGraphFindings } from './inspector.js';
import { readLocatedBlock, readLocatedProof } from './source.js';
import type { LocatedBlock } from './source.js';
import { checkStaleness } from './staleness.js';
import { accepted, buildVerifierPacket, checkerContract, invokeVerifier, verificationKey, verifierErrorDetails } from './verifier.js';
import { CONTROL_MARKER_SET } from './constants.js';
import { asErrorLike, hasErrorCode } from './errors.js';
import { asRecord, asStringArray, isRecord } from './guards.js';
import type {
  AiCheck, CheckStatus, Compilation, DependencyGraph, Diagnostic, GraphEdge, GraphNode, ImportDeclaration,
  JsonObject, Manifest, OperationResult, ReferenceCheck, RuntimeOptions, SemanticResult, UnknownRecord,
  VerifierPacket, VerifierReport, InitializeWorkspaceResult, WorkspaceInspectResult
} from './types.js';

interface WorkspaceMetadata {
  schema_version: number;
  target: string;
  status: string;
  created_at: string;
  canonical: {
    file: string;
    statement_hash: string;
    title_hash: string;
    proof_hash: string;
    status: string;
    dependencies: Record<string, { statement_hash: string; proof_hash: string; status: string }>;
  };
}

interface WorkspaceReferenceCheck extends ReferenceCheck { origin: 'workspace' | 'canonical' | 'unresolved' }
interface WorkspaceProgrammaticCheck {
  status: 'pass' | 'fail';
  verification_mode: 'definition-construction' | 'proof';
  references: WorkspaceReferenceCheck[];
  diagnostics: string[];
  reason?: string;
}
interface WorkspaceOutcome extends AiCheck {
  verification_key?: string;
  failed_target?: string;
  failure_report?: string;
}
interface WorkspaceVerification {
  eligible: number;
  verifier_calls: number;
  cache_hits: number;
  cache_misses: number;
  invalid_cache_entries: number;
  passed: number;
  rejected: number;
  errors: number;
  not_run: number;
  stopped_after: string | null;
  facts: Array<{ id: string } & WorkspaceOutcome>;
}
interface WorkspaceCacheRecord extends JsonObject {
  workspace: string;
  target: string;
  verification_key: string;
  packet_hash: string;
  checker_contract: JsonObject;
  report: VerifierReport;
  accepted: boolean;
}
interface WorkspaceCacheLookup {
  location: { relative: string; file: string };
  record: WorkspaceCacheRecord | null;
  invalid: boolean;
}

function cleanVerifierText(value: unknown, markerPosition: 'first' | 'last' | null = null): string {
  const lines = String(value ?? '').split(/\r?\n/);
  if (markerPosition === 'first') {
    const index = lines.findIndex((line) => line.trim() !== '');
    if (index >= 0 && CONTROL_MARKER_SET.has(lines[index].trim())) lines.splice(index, 1);
  } else if (markerPosition === 'last') {
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      if (!lines[index].trim()) continue;
      if (CONTROL_MARKER_SET.has(lines[index].trim())) lines.splice(index, 1);
      break;
    }
  }
  return lines.join('\n').trim();
}

function workspaceStatus(result: SemanticResult, marker = result.marker): string {
  if (marker === 'OPEN') return 'workspace-open';
  if (marker === 'REJECTED') return 'workspace-rejected';
  if (marker === 'REVOKED') return 'workspace-revoked';
  return result.kind === 'definition' || result.proof_present
    ? 'workspace-candidate'
    : 'workspace-open';
}

function normalizeImports(imports: ImportDeclaration[] = []): ImportDeclaration[] {
  return imports.map((item) => ({
    from: String(item.from ?? ''),
    use: [...new Set((item.use ?? []).map(String))].sort()
  })).sort((left, right) => `${left.from}:${left.use.join(',')}`.localeCompare(`${right.from}:${right.use.join(',')}`));
}

function topologicalOrder(results: SemanticResult[]): SemanticResult[] {
  const ids = new Set<string>(results.map((result) => result.id));
  const byId = new Map<string, SemanticResult>(results.map((result) => [result.id, result]));
  const pending = new Map<string, Set<string>>(results.map((result) => [
    result.id,
    new Set(result.dependencies.filter((dependency) => ids.has(dependency)))
  ]));
  const dependents = new Map<string, string[]>(results.map((result) => [result.id, []]));
  for (const result of results) {
    for (const dependency of pending.get(result.id) ?? []) dependents.get(dependency)?.push(result.id);
  }
  for (const values of dependents.values()) values.sort();
  const ready = [...pending].filter(([, dependencies]) => dependencies.size === 0).map(([id]) => id).sort();
  const scheduled = new Set<string>(ready);
  const ordered: SemanticResult[] = [];
  while (ready.length) {
    const id = ready.shift();
    if (!id) continue;
    const selected = byId.get(id);
    if (!selected) continue;
    ordered.push(selected);
    for (const dependent of dependents.get(id) ?? []) {
      pending.get(dependent)?.delete(id);
      if (pending.get(dependent)?.size === 0 && !scheduled.has(dependent)) {
        ready.push(dependent);
        scheduled.add(dependent);
        ready.sort();
      }
    }
  }
  const seen = new Set(ordered.map((result) => result.id));
  ordered.push(...results.filter((result) => !seen.has(result.id)).sort((left, right) => left.id.localeCompare(right.id)));
  return ordered;
}

function cacheLocation(directory: string, key: string): { relative: string; file: string } {
  const digest = key.replace(/^sha256:/, '');
  return {
    relative: `verification/checks/${digest}.json`,
    file: path.join(directory, 'verification', 'checks', `${digest}.json`)
  };
}

function verifierReport(value: unknown): VerifierReport | null {
  if (!isRecord(value) || (value.verdict !== 'correct' && value.verdict !== 'incorrect')) return null;
  return {
    verdict: value.verdict,
    summary: typeof value.summary === 'string' ? value.summary : '',
    critical_errors: asStringArray(value.critical_errors),
    gaps: asStringArray(value.gaps),
    nonblocking_comments: asStringArray(value.nonblocking_comments),
    repair_hints: typeof value.repair_hints === 'string' ? value.repair_hints : ''
  };
}

async function cachedWorkspaceDecision(directory: string, workspace: string, target: string, key: string, packet: VerifierPacket): Promise<WorkspaceCacheLookup> {
  const location = cacheLocation(directory, key);
  let record: UnknownRecord;
  try { record = await readJson<UnknownRecord>(location.file); } catch (error) {
    return { location, record: null, invalid: !hasErrorCode(error, 'ENOENT') };
  }
  const report = verifierReport(record.report);
  if (!report || typeof record.accepted !== 'boolean') return { location, record: null, invalid: true };
  const valid = record.workspace === workspace
    && record?.target === target
    && record?.verification_key === key
    && record?.packet_hash === sha256(stableJson(packet, 0))
    && stableJson(record?.checker_contract ?? {}, 0) === stableJson(packet.checker_contract ?? {}, 0)
    && record.accepted === accepted(report);
  const cached: WorkspaceCacheRecord | null = valid && report ? {
    ...record,
    workspace,
    target,
    verification_key: key,
    packet_hash: String(record.packet_hash),
    checker_contract: asRecord(record.checker_contract),
    report,
    accepted: record.accepted
  } : null;
  return { location, record: cached, invalid: !valid };
}

async function workspaceSourceFingerprint(directory: string): Promise<string> {
  const files = await discoverActive(directory);
  const entries: Array<[string, string]> = [];
  for (const file of files) entries.push([relativePosix(directory, file), sha256(await readFile(file, 'utf8'))]);
  return sha256(stableJson(entries, 0));
}

function canonicalContextFingerprint(compilation: Compilation, target: string, available: string[], externalBasis: JsonObject): string {
  const byId = new Map<string, SemanticResult>(compilation.manifest.results.map((result) => [result.id, result]));
  const selected = [target, ...available].filter((value, index, values) => values.indexOf(value) === index).sort();
  return sha256(stableJson({
    complete: compilation.complete,
    facts: selected.map((id) => {
      const result = byId.get(id);
      return result ? {
        id, statement_hash: result.statement_hash, proof_hash: result.proof_hash,
        title_hash: result.title_hash, status: result.status, file: result.file
      } : { id, status: 'missing' };
    }),
    checker_contract: checkerContract(compilation.config),
    external_basis_hash: externalPolicyHash(externalBasis)
  }, 0));
}

function verifierFailure(error: unknown, target: string, inherited = false): WorkspaceOutcome {
  const failure = asErrorLike(error);
  const details = inherited ? failure.details : verifierErrorDetails(error);
  return {
    status: 'error',
    code: String(failure.code ?? 'WORKSPACE_VERIFIER_FAILED'),
    error: inherited
      ? `Independent verification stopped after the verifier command failed while checking @${target}`
      : failure.message,
    remediation: 'Repair verification.command or QMD_PROVER_VERIFIER, then rerun workspace inspect. The workspace fact remains unverified; never add VERIFIED manually.',
    ...(isRecord(details) ? { details } : {}),
    fatal: true,
    ...(inherited ? { inherited: true, failed_target: target } : {})
  };
}

async function discoverActive(directory: string, output: string[] = []): Promise<string[]> {
  const excluded = new Set(['attempts', 'dead-ends', 'proposals', 'verification', 'context', 'snapshots', 'generated', 'rendered', '_site']);
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name))) {
    if (entry.name.startsWith('.') || excluded.has(entry.name)) continue;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) await discoverActive(absolute, output);
    else if (entry.isFile() && entry.name.endsWith('.qmd') && !['target.qmd', 'progress.qmd'].includes(entry.name)) output.push(absolute);
  }
  return output;
}

function workspaceDirectory(root: string, requested: string): { id: string; directory: string } {
  const id = cleanId(requested);
  if (!/^thm-main-[A-Za-z0-9._:-]+$/.test(id)) throw new Error('A goal workspace requires a thm-main-* ID');
  return { id, directory: path.join(path.resolve(root), AUX, 'workspaces', id) };
}

export async function initializeWorkspace(root: string, requested: string, options: RuntimeOptions = {}): Promise<InitializeWorkspaceResult> {
  root = path.resolve(root);
  const { id, directory } = workspaceDirectory(root, requested);
  const compilation = await compileProject(root, options);
  if (!compilation.ok) throw new Error('Project has structural errors; repair them before creating a goal workspace');
  const target = compilation.manifest.results.find((result) => result.id === id);
  if (!target) throw new Error(`Unknown theorem: @${id}`);
  if (target.origin !== 'user') throw new Error(`@${id} is not a protected main goal`);
  const metadataFile = path.join(directory, 'workspace.json');
  if (await exists(metadataFile)) {
    return { schema_version: 1, status: 'resumed', workspace: relativePosix(root, directory), metadata: await readJson(metadataFile) };
  }
  const located = await readLocatedBlock(path.join(root, target.file), id);
  if (!located) throw new Error(`Canonical source block for @${id} was not found`);
  const targetFile = compilation.manifest.files.find((file) => file.path === target.file);
  const availableIds = new Set([
    ...theoremBundle(compilation, id).dependencies.map((result) => result.id),
    ...(targetFile?.imports ?? []).flatMap((declaration) => declaration.use)
  ]);
  const dependencySnapshot = Object.fromEntries(compilation.manifest.results.filter((result) => availableIds.has(result.id)).map((result) => [result.id, {
    statement_hash: result.statement_hash,
    proof_hash: result.proof_hash,
    status: result.status
  }]));
  await Promise.all(['context', 'attempts', 'dead-ends', 'proposals', 'verification'].map((name) => mkdir(path.join(directory, name), { recursive: true })));
  const metadata = {
    schema_version: 1,
    target: id,
    status: 'active',
    created_at: new Date().toISOString(),
    canonical: {
      file: target.file,
      statement_hash: target.statement_hash,
      title_hash: target.title_hash,
      proof_hash: target.proof_hash,
      status: target.status,
      dependencies: dependencySnapshot
    }
  };
  await Promise.all([
    atomicJson(metadataFile, metadata),
    atomicWrite(path.join(directory, 'target.qmd'), `${located.raw.trim()}\n`),
    atomicWrite(path.join(directory, 'progress.qmd'), `---\ntitle: "Workspace: ${target.title}"\n---\n\n## Current frontier\n\n- @${id}: ${target.status}\n\n## Active route\n\nRecord the current proof route here.\n\n## Abandoned routes\n\nKeep detailed dead ends under \`dead-ends/\`.\n`)
  ]);
  return { schema_version: 1, status: 'created', workspace: relativePosix(root, directory), metadata };
}

export async function inspectWorkspace(root: string, requested: string, options: RuntimeOptions = {}): Promise<WorkspaceInspectResult> {
  root = path.resolve(root);
  const { id, directory } = workspaceDirectory(root, requested);
  let staleness;
  let stalenessFailure: ReturnType<typeof asErrorLike> | null = null;
  try { staleness = await checkStaleness(root, options); }
  catch (error) {
    stalenessFailure = asErrorLike(error);
    staleness = {
      schema_version: 2,
      operation: 'check-staleness',
      ok: false,
      changed: [],
      invalidated: [],
      error: asErrorLike(error).message
    };
  }
  if (!await exists(path.join(directory, 'workspace.json'))) await initializeWorkspace(root, id, options);
  const [metadata, canonical, files] = await Promise.all([
    readJson<WorkspaceMetadata>(path.join(directory, 'workspace.json')),
    compileProject(root, options),
    discoverActive(directory)
  ]);
  const canonicalById = new Map<string, SemanticResult>(canonical.manifest.results.map((result) => [result.id, result]));
  const currentTarget = canonicalById.get(id);
  const targetStale = !currentTarget
    || currentTarget.statement_hash !== metadata.canonical.statement_hash
    || currentTarget.title_hash !== metadata.canonical.title_hash
    || currentTarget.proof_hash !== metadata.canonical.proof_hash
    || currentTarget.status !== metadata.canonical.status;
  const dependencyStale = Object.entries<JsonObject>(metadata.canonical.dependencies ?? {}).some(([dependency, snapshot]) => {
    const result = canonicalById.get(dependency);
    return !result || result.statement_hash !== snapshot.statement_hash || result.proof_hash !== snapshot.proof_hash || result.status !== snapshot.status;
  });
  const stale = targetStale || dependencyStale;
  const provisional: Compilation = files.length
    ? await compileProject(root, { ...options, files, externalTargets: canonical.manifest.results.map((result) => result.id), write: false })
    : {
        root,
        config: canonical.config,
        manifest: { schema_version: 2, files: [], results: [], proofs: [] },
        graph: { schema_version: 2, nodes: [], edges: [], cycles: [] },
        diagnostics: [],
        summary: { files: 0, results: 0, errors: 0, warnings: 0 },
        ok: true,
        complete: true
      };
  const provisionalIds = new Set(provisional.manifest.results.map((result) => result.id));
  const diagnostics = provisional.diagnostics.filter((item) => {
    if (item.code === 'DEPENDENCY_STATUS_INSUFFICIENT') {
      const referenced = item.message.match(/@((?:def|lem|thm|prp|cor)-[^\s,]+)/)?.[1];
      if (referenced && provisionalIds.has(referenced)) return false;
    }
    if (!['DEPENDENCY_UNKNOWN', 'IMPORT_FILE_MISSING', 'IMPORT_ID_MISSING'].includes(item.code)) return true;
    const referenced = item.message.match(/@((?:def|lem|thm|prp|cor)-[^\s,]+)/)?.[1];
    return !referenced || !canonicalById.has(referenced);
  });
  if (stale) diagnostics.push({
    severity: 'error', code: 'WORKSPACE_STALE',
    message: `The protected canonical snapshot for @${id} is stale`,
    file: relativePosix(root, path.join(directory, 'workspace.json')), id
  });
  if (stalenessFailure) diagnostics.push({
    severity: 'error', code: 'STALENESS_CHECK_FAILED',
    message: stalenessFailure.message ?? 'Staleness check failed',
    file: relativePosix(root, path.join(directory, 'workspace.json')), id,
    remediation: 'Repair canonical parsing or protected verification state, then rerun workspace inspect before using any VERIFIED fact.'
  });

  const sourceRootById = new Map<string, string>();
  const localResultById = new Map<string, SemanticResult>();
  const sourceMarkerById = new Map<string, string | null | undefined>();
  const workspaceResults: SemanticResult[] = provisional.manifest.results.map((result) => {
    sourceRootById.set(result.id, result.file);
    localResultById.set(result.id, result);
    sourceMarkerById.set(result.id, result.marker);
    return {
      ...result,
      origin: 'workspace',
      workspace: id,
      file: relativePosix(directory, path.resolve(root, result.file)),
      status: workspaceStatus(result)
    };
  });
  let workspaceIds = new Set<string>(workspaceResults.map((result) => result.id));
  const availableCanonical = new Set<string>(Object.keys(metadata.canonical.dependencies ?? {}));
  const targetProofs = provisional.manifest.proofs.filter((proof) => proof.target === id);
  for (const proof of provisional.manifest.proofs.filter((item) => canonicalById.has(item.target) && item.target !== id)) {
    diagnostics.push({
      severity: 'error', code: 'WORKSPACE_CANONICAL_PROOF_FORBIDDEN',
      message: `Workspace @${id} may provide a proof only for its protected target, not canonical @${proof.target}`,
      file: relativePosix(directory, path.resolve(root, proof.file)), line: proof.line, id: proof.target
    });
  }
  if (!workspaceIds.has(id) && currentTarget) {
    const targetProof = targetProofs.length === 1 ? targetProofs[0] : null;
    const marker = targetProof?.marker ?? null;
    if (targetProof) sourceRootById.set(id, targetProof.file);
    sourceMarkerById.set(id, marker);
    workspaceResults.push({
      ...currentTarget,
      origin: 'workspace',
      workspace: id,
      file: targetProof ? relativePosix(directory, path.resolve(root, targetProof.file)) : 'target.qmd',
      line: targetProof?.line ?? 1,
      proof_file: targetProof?.file,
      proof_line: targetProof?.line,
      proof_hash: targetProof?.proof_hash ?? sha256(stableJson([], 0)),
      proof_present: targetProof?.proof_present ?? false,
      proof_text: targetProof?.proof_text ?? '',
      dependencies: [...new Set(targetProof?.dependencies ?? [])].sort(),
      uses: [...new Set(targetProof?.dependencies ?? [])].sort(),
      marker,
      status: workspaceStatus({ ...currentTarget, proof_present: targetProof?.proof_present ?? false }, marker)
    });
  }
  workspaceResults.sort((left, right) => left.id.localeCompare(right.id));
  workspaceIds = new Set(workspaceResults.map((result) => result.id));

  for (const result of workspaceResults) {
    if (localResultById.has(result.id) && canonicalById.has(result.id)) diagnostics.push({
      severity: 'error', code: result.id === id ? 'WORKSPACE_TARGET_REDECLARED' : 'WORKSPACE_CANONICAL_COLLISION',
      message: result.id === id
        ? `Workspace @${id} must provide only a linked proof for its protected target; it must not redeclare the target`
        : `Workspace result @${result.id} collides with canonical mathematics`,
      file: result.file, line: result.line, id: result.id
    });
    if (sourceMarkerById.get(result.id) === 'VERIFIED' || sourceMarkerById.get(result.id) === 'REVOKED') diagnostics.push({
      severity: 'error', code: 'WORKSPACE_PROTECTED_MARKER_FORBIDDEN',
      message: `Workspace fact @${result.id} must not contain ${sourceMarkerById.get(result.id)}; only protected canonical acceptance may write that marker`,
      file: result.file, line: result.proof_line ?? result.line, id: result.id
    });
    for (const dependency of result.dependencies) {
      const canonicalDependency = canonicalById.get(dependency);
      if (!canonicalDependency || workspaceIds.has(dependency)) continue;
      if (!availableCanonical.has(dependency)) diagnostics.push({
        severity: 'error', code: 'WORKSPACE_DEPENDENCY_UNAVAILABLE',
        message: `Workspace fact @${result.id} cites canonical @${dependency}, which was not imported by the protected target`,
        file: result.file, line: result.proof_line ?? result.line, id: result.id
      });
      else if (canonicalDependency.status !== 'verified') diagnostics.push({
        severity: 'error', code: 'WORKSPACE_DEPENDENCY_STATUS_INSUFFICIENT',
        message: `Workspace fact @${result.id} cites canonical @${dependency}, whose current status is ${canonicalDependency.status}`,
        file: result.file, line: result.proof_line ?? result.line, id: result.id
      });
    }
  }

  const fileByRootPath = new Map(provisional.manifest.files.map((file) => [file.path, file]));
  const provisionalEdges = new Map<string, GraphEdge>(provisional.graph.edges.map((edge) => [`${edge.from}\0${edge.to}`, edge]));
  const workspaceById = new Map<string, SemanticResult>(workspaceResults.map((result) => [result.id, result]));
  const dependencyAdjacency = new Map<string, string[]>(workspaceResults.map((result) => [
    result.id,
    result.dependencies.filter((dependency) => workspaceIds.has(dependency))
  ]));
  const workspaceCycles = findCycles(dependencyAdjacency);
  const cycleEdges = new Set<string>();
  for (const cycle of workspaceCycles) {
    for (let index = 0; index < cycle.length - 1; index += 1) cycleEdges.add(`${cycle[index]}\0${cycle[index + 1]}`);
  }

  function localScopeCheck(result: SemanticResult, dependency: string): CheckStatus {
    if (dependency === id && !localResultById.has(id)) return 'fail';
    const compiledEdge = provisionalEdges.get(`${result.id}\0${dependency}`);
    if (compiledEdge) return compiledEdge.checks?.scope ?? 'fail';
    const source = sourceRootById.get(result.id);
    const dependencySource = sourceRootById.get(dependency);
    if (!source || !dependencySource) return 'fail';
    if (source === dependencySource) return 'pass';
    const imports = fileByRootPath.get(source)?.imports ?? [];
    return imports.some((declaration) => declaration.use.includes(dependency)) ? 'pass' : 'fail';
  }

  function referenceChecks(result: SemanticResult): WorkspaceReferenceCheck[] {
    return result.dependencies.map((dependency): WorkspaceReferenceCheck => {
      const workspaceDependency = workspaceById.get(dependency);
      if (workspaceDependency) return {
        dependency,
        origin: 'workspace',
        existence: 'pass',
        scope: localScopeCheck(result, dependency),
        status: workspaceDependency.status === 'workspace-verified' ? 'pass' : 'fail',
        cycle: cycleEdges.has(`${result.id}\0${dependency}`) ? 'fail' : 'pass',
        ai_sufficiency: result.status === 'workspace-verified'
          ? 'pass'
          : result.status === 'workspace-rejected' ? 'fail' : 'not-run'
      };
      const canonicalDependency = canonicalById.get(dependency);
      if (canonicalDependency) return {
        dependency,
        origin: 'canonical',
        existence: 'pass',
        scope: availableCanonical.has(dependency) ? 'pass' : 'fail',
        status: canonicalDependency.status === 'verified' ? 'pass' : 'fail',
        cycle: 'pass',
        ai_sufficiency: result.status === 'workspace-verified'
          ? 'pass'
          : result.status === 'workspace-rejected' ? 'fail' : 'not-run'
      };
      return {
        dependency,
        origin: 'unresolved',
        existence: 'fail', scope: 'fail', status: 'fail', cycle: 'pass', ai_sufficiency: 'not-run'
      };
    }).sort((left, right) => left.dependency.localeCompare(right.dependency));
  }

  for (const result of workspaceResults) {
    for (const check of referenceChecks(result)) {
      if (check.existence === 'fail' && !diagnostics.some((item) => item.id === result.id && item.code === 'WORKSPACE_DEPENDENCY_UNKNOWN' && item.dependency === check.dependency)) diagnostics.push({
        severity: 'error', code: 'WORKSPACE_DEPENDENCY_UNKNOWN', dependency: check.dependency,
        message: `Workspace fact @${result.id} cites unresolved @${check.dependency}`,
        file: result.file, line: result.proof_line ?? result.line, id: result.id
      });
      if (check.origin === 'workspace' && check.scope === 'fail') diagnostics.push({
        severity: 'error', code: 'WORKSPACE_DEPENDENCY_UNAVAILABLE', dependency: check.dependency,
        message: `Workspace fact @${result.id} cites workspace @${check.dependency}, which is neither local to its file nor explicitly imported`,
        file: result.file, line: result.proof_line ?? result.line, id: result.id
      });
    }
  }

  const mechanicalDiagnostics = diagnostics.slice();
  function relevantErrors(result: SemanticResult): Diagnostic[] {
    const sourceRoot = sourceRootById.get(result.id);
    return mechanicalDiagnostics.filter((item) => item.severity === 'error' && (
      item.id
        ? item.id === result.id
        : item.file === result.file || (sourceRoot && item.file === sourceRoot)
    ));
  }

  function programmaticCheck(result: SemanticResult): WorkspaceProgrammaticCheck {
    const references = referenceChecks(result);
    const errors = relevantErrors(result);
    let reason: string | null = null;
    const marker = sourceMarkerById.get(result.id);
    if (stalenessFailure) reason = 'staleness-check-failed';
    else if (stale) reason = 'workspace-snapshot-stale';
    else if (!canonical.complete || provisional.complete === false) reason = 'semantic-parse-incomplete';
    else if (marker === 'OPEN') reason = 'explicitly-open';
    else if (marker === 'REJECTED') reason = 'explicitly-rejected';
    else if (marker === 'VERIFIED' || marker === 'REVOKED') reason = 'protected-marker-forbidden';
    else if (result.kind !== 'definition' && !result.proof_present) reason = 'proof-missing';
    else if (errors.length) reason = 'programmatic-check-failed';
    else if (references.some((check) => (
      check.existence !== 'pass' || check.scope !== 'pass' || check.status !== 'pass' || check.cycle !== 'pass'
    ))) reason = 'reference-check-failed';
    return {
      status: reason ? 'fail' : 'pass',
      verification_mode: result.kind === 'definition' ? 'definition-construction' : 'proof',
      references,
      diagnostics: errors.map((item) => item.code).sort(),
      ...(reason ? { reason } : {})
    };
  }

  const locatedBlocks = new Map<string, LocatedBlock>();
  async function located(result: SemanticResult, origin: 'canonical' | 'workspace'): Promise<LocatedBlock> {
    const key = `${origin}:${result.id}:${result.file}`;
    const cached = locatedBlocks.get(key);
    if (cached) return cached;
    const file = origin === 'canonical'
      ? path.join(root, result.file)
      : path.join(root, sourceRootById.get(result.id) ?? result.file);
    const value = await readLocatedBlock(file, result.id);
    if (!value) throw Object.assign(new Error(`Source block for @${result.id} disappeared during workspace inspection`), { code: 'WORKSPACE_SOURCE_STALE' });
    locatedBlocks.set(key, value);
    return value;
  }

  const externalBasis = await readExternalPolicy(root);
  const protectedScope = [...availableCanonical].sort().map((dependency) => {
    const result = canonicalById.get(dependency);
    return result ? {
      id: dependency,
      status: result.status,
      identity: { statement_hash: result.statement_hash, proof_hash: result.proof_hash }
    } : { id: dependency, status: 'missing', identity: null };
  });

  async function packetFor(result: SemanticResult, outcomes: Map<string, WorkspaceOutcome>): Promise<VerifierPacket> {
    const local = localResultById.get(result.id);
    let statement;
    let proof = '';
    if (local) {
      const block = await located(local, 'workspace');
      statement = cleanVerifierText(block.statement?.text, result.kind === 'definition' ? 'last' : null);
      proof = cleanVerifierText(block.proof?.text, 'first');
    } else {
      if (!currentTarget) throw Object.assign(new Error(`Canonical target @${id} disappeared`), { code: 'WORKSPACE_SOURCE_STALE' });
      const block = await located(currentTarget, 'canonical');
      statement = cleanVerifierText(block.statement?.text, currentTarget.kind === 'definition' ? 'last' : null);
      const proofFile = sourceRootById.get(result.id);
      if (proofFile) {
        const proofBlock = await readLocatedProof(path.join(root, proofFile), result.id);
        if (!proofBlock) throw Object.assign(new Error(`Workspace proof of @${result.id} disappeared during inspection`), { code: 'WORKSPACE_SOURCE_STALE' });
        proof = cleanVerifierText(proofBlock.proof?.text, 'first');
      }
    }

    const dependencies: JsonObject[] = [];
    for (const dependency of [...new Set(result.dependencies)].sort()) {
      const workspaceDependency = workspaceById.get(dependency);
      if (workspaceDependency) {
        const localDependency = localResultById.get(dependency);
        if (!localDependency) throw Object.assign(new Error(`Workspace dependency @${dependency} disappeared`), { code: 'WORKSPACE_SOURCE_STALE' });
        const dependencyBlock = await located(localDependency, 'workspace');
        const outcome = outcomes.get(dependency);
        dependencies.push({
          id: dependency,
          kind: workspaceDependency.kind,
          title: workspaceDependency.title,
          semantic_text: cleanVerifierText(dependencyBlock.statement?.text, workspaceDependency.kind === 'definition' ? 'last' : null),
          statement: cleanVerifierText(dependencyBlock.statement?.text, workspaceDependency.kind === 'definition' ? 'last' : null),
          status: workspaceDependency.status,
          origin: 'workspace',
          identity: {
            statement_hash: workspaceDependency.statement_hash,
            proof_hash: workspaceDependency.proof_hash,
            verification_key: outcome?.verification_key ?? null
          },
          source: { file: workspaceDependency.file }
        });
        continue;
      }
      const canonicalDependency = canonicalById.get(dependency);
      if (!canonicalDependency) continue;
      const dependencyBlock = await located(canonicalDependency, 'canonical');
      dependencies.push({
        id: dependency,
        kind: canonicalDependency.kind,
        title: canonicalDependency.title,
        semantic_text: cleanVerifierText(dependencyBlock.statement?.text, canonicalDependency.kind === 'definition' ? 'last' : null),
        statement: cleanVerifierText(dependencyBlock.statement?.text, canonicalDependency.kind === 'definition' ? 'last' : null),
        status: canonicalDependency.status,
        origin: 'canonical',
        identity: { statement_hash: canonicalDependency.statement_hash, proof_hash: canonicalDependency.proof_hash },
        source: { file: canonicalDependency.file }
      });
    }
    const sourceRoot = sourceRootById.get(result.id);
    const sourceFile = sourceRoot ? fileByRootPath.get(sourceRoot) : undefined;
    const scope = {
      type: 'selected-workspace',
      workspace: id,
      source_file: result.file,
      workspace_imports: normalizeImports(sourceFile?.imports ?? []),
      protected_canonical: protectedScope
    };
    return buildVerifierPacket({
      target: {
        id: result.id,
        kind: result.kind,
        title: result.title,
        semantic_text: statement,
        ...(result.kind === 'definition' ? { construction: statement } : { statement }),
        proof,
        cited_dependencies: [...new Set(result.dependencies)].sort(),
        identity: { statement_hash: result.statement_hash, proof_hash: result.proof_hash },
        source: { file: result.file },
        workspace: id
      },
      dependencies,
      externalBasis,
      scope,
      config: canonical.config
    });
  }

  const outcomes = new Map<string, WorkspaceOutcome>();
  const verification: WorkspaceVerification = {
    eligible: 0,
    verifier_calls: 0,
    cache_hits: 0,
    cache_misses: 0,
    invalid_cache_entries: 0,
    passed: 0,
    rejected: 0,
    errors: 0,
    not_run: 0,
    stopped_after: null,
    facts: []
  };
  let fatal: WorkspaceOutcome | null = stalenessFailure ? verifierFailure({ code: 'STALENESS_CHECK_FAILED', message: stalenessFailure.message }, id) : null;
  if (stale && !fatal) fatal = {
    status: 'error', code: 'WORKSPACE_STALE',
    error: `The protected canonical snapshot for @${id} is stale`,
    remediation: 'Refresh or recreate this goal workspace from current canonical mathematics before rerunning inspection.',
    fatal: true
  };
  const initialWorkspaceFingerprint = await workspaceSourceFingerprint(directory);
  const initialCanonicalFingerprint = canonicalContextFingerprint(canonical, id, [...availableCanonical], externalBasis);

  for (const result of topologicalOrder(workspaceResults)) {
    const programmatic = programmaticCheck(result);
    if (programmatic.status !== 'pass') {
      outcomes.set(result.id, {
        status: 'not-run',
        reason: programmatic.reason === 'proof-missing'
          ? 'No complete proof is present.'
          : programmatic.reason === 'explicitly-open'
            ? 'The active workspace attempt is explicitly OPEN.'
            : programmatic.reason === 'explicitly-rejected'
              ? 'The active workspace attempt is explicitly REJECTED.'
              : `Independent verification did not run because ${programmatic.reason}.`
      });
      continue;
    }
    verification.eligible += 1;
    if (fatal) {
      outcomes.set(result.id, fatal.failed_target
        ? verifierFailure(fatal, fatal.failed_target, true)
        : { ...fatal, inherited: true });
      continue;
    }

    let packet;
    try { packet = await packetFor(result, outcomes); }
    catch (error) {
      fatal = verifierFailure(error, result.id);
      fatal.code = String(asErrorLike(error).code ?? 'WORKSPACE_SOURCE_STALE');
      fatal.failed_target = result.id;
      outcomes.set(result.id, fatal);
      verification.stopped_after = result.id;
      continue;
    }
    const key = verificationKey(packet);
    const cached = await cachedWorkspaceDecision(directory, id, result.id, key, packet);
    if (cached.invalid) verification.invalid_cache_entries += 1;
    let report: VerifierReport;
    let source: string;
    let cachedResult = false;
    if (cached.record) {
      report = cached.record.report;
      source = 'workspace-verification-cache';
      cachedResult = true;
      verification.cache_hits += 1;
    } else {
      verification.cache_misses += 1;
      verification.verifier_calls += 1;
      try { report = await invokeVerifier(packet, canonical.config); }
      catch (error) {
        const failure = verifierFailure(error, result.id);
        failure.failed_target = result.id;
        const now = new Date().toISOString();
        const digest = key.replace(/^sha256:/, '');
        const failureFile = path.join(directory, 'verification', 'failures', digest, `${now.replace(/[-:.TZ]/g, '')}.json`);
        try {
          await atomicJson(failureFile, {
            schema_version: 1,
            operation: 'workspace-independent-verification-failed',
            workspace: id,
            target: result.id,
            failed_at: now,
            verification_key: key,
            checker_contract: checkerContract(canonical.config),
            error: failure.details ?? { code: failure.code, message: failure.error },
            remediation: failure.remediation
          });
          failure.failure_report = relativePosix(directory, failureFile);
        } catch { /* The structured command error remains the primary result. */ }
        fatal = failure;
        outcomes.set(result.id, failure);
        verification.stopped_after = result.id;
        continue;
      }

      let contextCurrent = false;
      try {
        const [workspaceFingerprint, currentCanonical, currentExternalBasis] = await Promise.all([
          workspaceSourceFingerprint(directory),
          compileProject(root, { ...options, write: false }),
          readExternalPolicy(root)
        ]);
        contextCurrent = workspaceFingerprint === initialWorkspaceFingerprint
          && canonicalContextFingerprint(currentCanonical, id, [...availableCanonical], currentExternalBasis) === initialCanonicalFingerprint;
      } catch { contextCurrent = false; }
      if (!contextCurrent) {
        fatal = verifierFailure(Object.assign(new Error(`Workspace or canonical verification context changed while @${result.id} was being checked`), { code: 'WORKSPACE_SOURCE_STALE' }), result.id);
        fatal.failed_target = result.id;
        outcomes.set(result.id, fatal);
        verification.stopped_after = result.id;
        continue;
      }

      const record = {
        schema_version: 2,
        operation: 'workspace-independent-verification',
        workspace: id,
        target: result.id,
        verified_at: new Date().toISOString(),
        accepted: accepted(report),
        report,
        statement_hash: result.statement_hash,
        proof_hash: result.proof_hash,
        dependency_snapshot: Object.fromEntries(packet.dependencies.map((dependency) => [String(dependency.id), {
          origin: dependency.origin,
          status: dependency.status,
          identity: dependency.identity
        }])),
        scope: packet.scope,
        external_basis_hash: externalPolicyHash(externalBasis),
        checker_contract: checkerContract(canonical.config),
        verification_key: key,
        packet_hash: sha256(stableJson(packet, 0)),
        packet
      };
      try { await atomicJson(cached.location.file, record); }
      catch (error) {
        fatal = verifierFailure(Object.assign(new Error(`Verifier result for @${result.id} could not be cached safely: ${asErrorLike(error).message}`), { code: 'WORKSPACE_CACHE_WRITE_FAILED' }), result.id);
        fatal.failed_target = result.id;
        outcomes.set(result.id, fatal);
        verification.stopped_after = result.id;
        continue;
      }
      source = 'independent-verifier';
    }

    const pass = accepted(report);
    const outcome: WorkspaceOutcome = {
      status: pass ? 'pass' : 'fail',
      source,
      cached: cachedResult,
      verification_key: key,
      report
    };
    outcomes.set(result.id, outcome);
    result.status = pass ? 'workspace-verified' : 'workspace-rejected';
  }

  for (const result of workspaceResults) {
    if (!outcomes.has(result.id)) outcomes.set(result.id, {
      status: 'not-run',
      reason: 'Independent verification did not run because the workspace fact was not eligible.'
    });
    const outcome = outcomes.get(result.id);
    if (!outcome) throw new Error(`Workspace outcome for @${result.id} was not recorded`);
    if (outcome.status === 'fail') diagnostics.push({
      severity: 'error', code: 'WORKSPACE_AI_CHECK_REJECTED',
      message: `Independent verification rejected @${result.id}: ${outcome.report?.summary || 'critical errors or gaps remain'}`,
      file: result.file, line: result.proof_line ?? result.line, id: result.id,
      repair_hints: outcome.report?.repair_hints ?? ''
    });
    if (outcome.status === 'error') diagnostics.push({
      severity: 'error', code: outcome.code ?? 'WORKSPACE_AI_CHECK_FAILED',
      message: `Independent verification could not check @${result.id}: ${outcome.error}`,
      file: result.file, line: result.proof_line ?? result.line, id: result.id,
      remediation: outcome.remediation
    });
  }

  const citedCanonicalIds = new Set(workspaceResults.flatMap((result) => result.dependencies)
    .filter((dependency) => canonicalById.has(dependency) && !workspaceIds.has(dependency)));
  const canonicalNodes: GraphNode[] = [...citedCanonicalIds].sort().flatMap((dependency) => {
    const result = canonicalById.get(dependency);
    return result ? [{
      id: result.id, title: result.title, kind: result.kind, status: result.status,
      file: result.file, line: result.line, origin: 'canonical',
      identity: { statement_hash: result.statement_hash, proof_hash: result.proof_hash }
    }] : [];
  });
  const knownIds = new Set([...workspaceResults.map((result) => result.id), ...canonicalNodes.map((result) => result.id)]);
  const unresolvedNodes = [...new Set(workspaceResults.flatMap((result) => result.dependencies).filter((dependency) => !knownIds.has(dependency)))].sort()
    .map((dependency) => ({ id: dependency, title: '', kind: 'unknown', status: 'missing', origin: 'unresolved' }));
  const graph: DependencyGraph = {
    schema_version: 2,
    nodes: [
      ...workspaceResults.map(({ id: resultId, title, kind, status, file, line, statement_hash, proof_hash }) => ({
        id: resultId, title, kind, status, file, line, origin: 'workspace',
        identity: { statement_hash, proof_hash },
        ai: { status: outcomes.get(resultId)?.status ?? 'not-run' }
      })),
      ...canonicalNodes,
      ...unresolvedNodes.map((node) => ({ ...node, kind: 'unknown' as const }))
    ],
    edges: workspaceResults.flatMap((result) => result.dependencies.map((dependency): GraphEdge => {
      const check = referenceChecks(result).find((item) => item.dependency === dependency);
      return {
        from: result.id,
        to: dependency,
        checks: check ? {
          existence: check.existence,
          scope: check.scope,
          status: check.status,
          cycle: check.cycle,
          ai_sufficiency: check.ai_sufficiency
        } : { existence: 'fail', scope: 'fail', status: 'fail', cycle: 'pass', ai_sufficiency: 'not-run' }
      };
    })).sort((left, right) => `${left.from}:${left.to}`.localeCompare(`${right.from}:${right.to}`)),
    cycles: workspaceCycles
  };
  graph.snapshot_id = sha256(stableJson(graph, 0));
  const facts = workspaceResults.map((result) => ({
    id: result.id,
    kind: result.kind,
    status: result.status,
    file: result.file,
    line: result.line,
    programmatic: programmaticCheck(result),
    ai: outcomes.get(result.id) ?? { status: 'not-run' as const, reason: 'No outcome was recorded.' }
  }));
  verification.passed = facts.filter((fact) => fact.ai.status === 'pass').length;
  verification.rejected = facts.filter((fact) => fact.ai.status === 'fail').length;
  verification.errors = facts.filter((fact) => fact.ai.status === 'error').length;
  verification.not_run = facts.filter((fact) => fact.ai.status === 'not-run').length;
  verification.facts = facts.map(({ id: factId, ai }) => ({ id: factId, ...ai }));
  const manifest: Manifest = {
    schema_version: 2,
    snapshot_id: graph.snapshot_id,
    target: id,
    stale,
    files: provisional.manifest.files.map((file) => ({
      ...file,
      path: relativePosix(directory, path.resolve(root, file.path))
    })),
    results: workspaceResults.map((result) => ({ ...result, ai: outcomes.get(result.id) })),
    proofs: provisional.manifest.proofs,
    canonical_results: canonicalNodes
  };
  diagnostics.sort((left, right) => `${left.file ?? ''}:${left.line ?? 0}:${left.code}:${left.id ?? ''}`.localeCompare(`${right.file ?? ''}:${right.line ?? 0}:${right.code}:${right.id ?? ''}`));
  const findings = deriveGraphFindings({ graph, manifest, diagnostics });
  const complete = canonical.complete && provisional.complete !== false;
  if (complete) {
    const snapshot = {
      schema_version: 2,
      snapshot_id: graph.snapshot_id,
      workspace: id,
      manifest,
      graph,
      diagnostics
    };
    const snapshotFile = path.join(directory, 'snapshots', `${graph.snapshot_id.replace(/^sha256:/, '')}.json`);
    await atomicJson(snapshotFile, snapshot);
    await Promise.all([
      atomicJson(path.join(directory, 'manifest.json'), manifest),
      atomicJson(path.join(directory, 'graph.json'), graph)
    ]);
    await atomicJson(path.join(directory, 'latest.json'), {
      schema_version: 2,
      snapshot_id: graph.snapshot_id,
      file: relativePosix(directory, snapshotFile)
    });
  }
  const mechanicalOk = complete && !stale && !stalenessFailure && mechanicalDiagnostics.every((item) => item.severity !== 'error');
  const aiOk = facts.every((fact) => fact.ai.status === 'pass');
  const statuses: Record<string, number> = {};
  const kinds: Record<string, number> = {};
  for (const result of workspaceResults) {
    statuses[result.status] = (statuses[result.status] ?? 0) + 1;
    kinds[result.kind] = (kinds[result.kind] ?? 0) + 1;
  }
  return {
    schema_version: 2,
    ok: mechanicalOk && aiOk,
    complete,
    snapshot_id: graph.snapshot_id,
    snapshot_published: complete,
    workspace: relativePosix(root, directory),
    target: currentTarget ?? { id, status: 'missing' },
    stale,
    staleness,
    workspace_staleness: {
      stale,
      target_stale: targetStale,
      dependency_stale: dependencyStale
    },
    summary: {
      files: files.length,
      facts: workspaceResults.length,
      kinds,
      statuses,
      errors: diagnostics.filter((item) => item.severity === 'error').length,
      mechanical_ok: mechanicalOk,
      ai_ok: aiOk
    },
    verification,
    facts,
    findings,
    manifest,
    graph,
    diagnostics
  };
}
