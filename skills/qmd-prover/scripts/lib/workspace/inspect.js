import path from 'node:path';
import { compileProject, findCycles } from '../semantic/compiler.js';
import { externalPolicyHash, readExternalPolicy } from '../infrastructure/external.js';
import { atomicJson, exists, readJson, relativePosix, sha256, stableJson } from '../infrastructure/files.js';
import { deriveGraphFindings } from '../inspection/findings.js';
import { buildAggregateSnapshot, publishAggregateSnapshot } from '../inspection/aggregate.js';
import { buildProjectInspectionIndex } from '../inspection/index.js';
import { readLocatedBlock, readLocatedProof } from '../semantic/source.js';
import { buildVerifierPacket, checkerContract, configured, invokeVerifier, verificationKey, verificationOutcome } from '../verification/protocol.js';
import { asErrorLike } from '../shared/core.js';
import { cachedWorkspaceDecision, cleanVerifierText, discoverActive, protectedGoalContextFingerprint, topologicalOrder, verifierFailure, workspaceDirectory, workspaceSourceFingerprint, workspaceSnapshotSourceSignature, workspaceStatus } from './support.js';
async function readCurrentSnapshot(directory, sourceSignature) {
    try {
        const pointer = await readJson(path.join(directory, 'latest.json'));
        const snapshotsRoot = path.join(directory, 'snapshots');
        const snapshotFile = path.resolve(directory, pointer.file);
        if (!snapshotFile.startsWith(`${snapshotsRoot}${path.sep}`))
            return null;
        const snapshot = await readJson(snapshotFile);
        if (pointer.schema_version !== 4 || snapshot.schema_version !== 4
            || snapshot.snapshot_id !== pointer.snapshot_id
            || snapshot.source_signature !== sourceSignature
            || !Array.isArray(snapshot.manifest?.results))
            return null;
        return snapshot;
    }
    catch {
        return null;
    }
}
function unavailableWorkspace(root, id, directory, diagnostics) {
    const graph = { schema_version: 4, nodes: [], edges: [], cycles: [] };
    const manifest = { schema_version: 4, target: id, files: [], results: [], proofs: [] };
    return {
        schema_version: 4,
        operation: 'workspace-inspect',
        ok: false,
        complete: false,
        snapshot_published: false,
        workspace: relativePosix(root, directory),
        target: { id, status: 'missing' },
        stale: true,
        staleness: { schema_version: 4, operation: 'check-staleness', ok: false, changed: [], invalidated: [] },
        summary: { files: 0, facts: 0, errors: diagnostics.filter((item) => item.severity === 'error').length, mechanical_ok: false, globally_verified: false },
        verification: {
            available: false, eligible: 0, verifier_calls: 0, cache_hits: 0, cache_misses: 0, invalid_cache_entries: 0,
            local_verified: 0, local_disproved: 0, local_rejected: 0, local_errors: 0, local_not_run: 0,
            global_verified: 0, global_disproved: 0, global_blocked: 0, global_unverified: 0,
            global_rejected: 0, global_invalid: 0, stopped_after: null, facts: []
        },
        facts: [],
        findings: deriveGraphFindings({ graph, manifest, diagnostics }),
        manifest,
        graph,
        diagnostics
    };
}
export async function inspectWorkspace(root, requested, options = {}) {
    root = path.resolve(root);
    const { id, directory } = workspaceDirectory(root, requested);
    let projectIndex = null;
    if (!options.skipProjectPreflight) {
        projectIndex = await buildProjectInspectionIndex(root, options);
        if (projectIndex.fatal)
            return unavailableWorkspace(root, id, directory, projectIndex.globalDiagnostics);
        const indexed = projectIndex.workspaces.find((workspace) => workspace.id === id);
        if (!indexed || indexed.status !== 'initialized') {
            const diagnostics = indexed?.diagnostics ?? [{
                    severity: 'error',
                    code: 'WORKSPACE_MISSING',
                    message: `No initialized workspace exists for @${id}`,
                    file: relativePosix(root, directory), id,
                    remediation: `Run workspace init @${id} explicitly before inspecting it.`
                }];
            return unavailableWorkspace(root, id, directory, diagnostics);
        }
    }
    if (!await exists(path.join(directory, 'workspace.json')))
        return unavailableWorkspace(root, id, directory, [{
                severity: 'error', code: 'WORKSPACE_UNINITIALIZED',
                message: `Workspace @${id} has no workspace.json; inspect never initializes or overwrites a workspace`,
                file: relativePosix(root, directory), id,
                remediation: `Run workspace init @${id} explicitly.`
            }]);
    const [metadata, projectGoals, files, externalBasis] = await Promise.all([
        readJson(path.join(directory, 'workspace.json')),
        compileProject(root, { ...options, semanticMode: 'project-goals', write: false }),
        discoverActive(directory),
        readExternalPolicy(root)
    ]);
    const projectGoalById = new Map(projectGoals.manifest.results.map((result) => [result.id, result]));
    const currentTarget = projectGoalById.get(id);
    const targetStale = !currentTarget
        || currentTarget.statement_hash !== metadata.canonical.statement_hash
        || currentTarget.title_hash !== metadata.canonical.title_hash
        || currentTarget.proof_hash !== metadata.canonical.proof_hash
        || currentTarget.status !== metadata.canonical.status;
    const dependencyStale = false;
    const stale = targetStale;
    const staleness = {
        schema_version: 4,
        operation: 'check-staleness',
        ok: !stale,
        changed: stale ? [{ id, reasons: [
                    ...(targetStale ? ['main-goal-snapshot-changed'] : []),
                    ...(dependencyStale ? ['protected-dependency-snapshot-changed'] : [])
                ] }] : [],
        invalidated: []
    };
    const provisional = files.length
        ? await compileProject(root, { ...options, semanticMode: 'workspace', files, externalTargets: [id], write: false })
        : {
            root,
            config: projectGoals.config,
            manifest: { schema_version: 4, files: [], results: [], proofs: [] },
            graph: { schema_version: 4, nodes: [], edges: [], cycles: [] },
            diagnostics: [],
            summary: { files: 0, results: 0, errors: 0, warnings: 0 },
            ok: true,
            complete: true
        };
    const diagnostics = provisional.diagnostics.filter((item) => {
        if (!['DEPENDENCY_UNKNOWN', 'IMPORT_FILE_MISSING', 'IMPORT_ID_MISSING'].includes(item.code))
            return true;
        const referenced = item.message.match(/@((?:def|lem|thm|prp|cor)-[^\s,]+)/)?.[1];
        return !referenced || referenced !== id;
    });
    if (stale)
        diagnostics.push({
            severity: 'error', code: 'WORKSPACE_STALE',
            message: `The protected main-goal snapshot for @${id} is stale`,
            file: relativePosix(root, path.join(directory, 'workspace.json')), id
        });
    if (Object.keys(metadata.canonical.dependencies ?? {}).length)
        diagnostics.push({
            severity: 'warning', code: 'LEGACY_WORKSPACE_PROTECTED_DEPENDENCIES',
            message: `Workspace @${id} has legacy protected-dependency metadata; it is read-only and no longer grants access to user-note facts`,
            file: relativePosix(root, path.join(directory, 'workspace.json')), id
        });
    const sourceRootById = new Map();
    const localResultById = new Map();
    const sourceMarkerById = new Map();
    const workspaceResults = provisional.manifest.results.map((result) => {
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
    let workspaceIds = new Set(workspaceResults.map((result) => result.id));
    const targetProofs = provisional.manifest.proofs.filter((proof) => proof.target === id);
    for (const proof of provisional.manifest.proofs.filter((item) => projectGoalById.has(item.target) && item.target !== id)) {
        diagnostics.push({
            severity: 'error', code: 'WORKSPACE_MAIN_GOAL_PROOF_FORBIDDEN',
            message: `Workspace @${id} may provide a proof only for its own protected target, not main goal @${proof.target}`,
            file: relativePosix(directory, path.resolve(root, proof.file)), line: proof.line, id: proof.target
        });
    }
    if (!workspaceIds.has(id) && currentTarget) {
        const targetProof = targetProofs.length === 1 ? targetProofs[0] : null;
        const marker = targetProof?.marker ?? null;
        if (targetProof)
            sourceRootById.set(id, targetProof.file);
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
    const initialWorkspaceFingerprint = await workspaceSourceFingerprint(directory);
    const workspaceContextHash = sha256(stableJson({
        external_basis_hash: externalPolicyHash(externalBasis),
        checker_contract: checkerContract(projectGoals.config)
    }, 0));
    const sourceSignature = workspaceSnapshotSourceSignature(initialWorkspaceFingerprint, metadata, currentTarget, workspaceContextHash);
    const previousSnapshot = await readCurrentSnapshot(directory, sourceSignature);
    const previousById = new Map((previousSnapshot?.manifest.results ?? []).map((result) => [result.id, result]));
    for (const result of workspaceResults) {
        const previous = previousById.get(result.id);
        if (!previous || previous.statement_hash !== result.statement_hash || previous.proof_hash !== result.proof_hash
            || stableJson(previous.dependencies, 0) !== stableJson(result.dependencies, 0))
            continue;
        if (previous.global_verification) {
            result.status = previous.status;
            result.global_verification = previous.global_verification;
            if (previous.disproof)
                result.disproof = previous.disproof;
        }
    }
    for (const result of workspaceResults) {
        if (localResultById.has(result.id) && projectGoalById.has(result.id))
            diagnostics.push({
                severity: 'error', code: result.id === id ? 'WORKSPACE_TARGET_REDECLARED' : 'WORKSPACE_MAIN_GOAL_COLLISION',
                message: result.id === id
                    ? `Workspace @${id} must provide only a linked proof for its protected target; it must not redeclare the target`
                    : `Workspace result @${result.id} collides with a protected main goal`,
                file: result.file, line: result.line, id: result.id
            });
        if (sourceMarkerById.get(result.id) === 'VERIFIED' || sourceMarkerById.get(result.id) === 'REVOKED')
            diagnostics.push({
                severity: 'error', code: 'WORKSPACE_PROTECTED_MARKER_FORBIDDEN',
                message: `Workspace fact @${result.id} must not contain the legacy ${sourceMarkerById.get(result.id)} marker; inspection records verification in workspace state`,
                file: result.file, line: result.proof_line ?? result.line, id: result.id
            });
        for (const dependency of result.dependencies) {
            if (!projectGoalById.has(dependency) || workspaceIds.has(dependency))
                continue;
            diagnostics.push({
                severity: 'error', code: 'WORKSPACE_EXTERNAL_FACT_DEPENDENCY', dependency,
                message: `Workspace fact @${result.id} may not cite protected main goal @${dependency}; adopt and prove the needed claim locally or state the permitted premise in the external basis`,
                file: result.file, line: result.proof_line ?? result.line, id: result.id
            });
        }
    }
    const fileByRootPath = new Map(provisional.manifest.files.map((file) => [file.path, file]));
    const provisionalEdges = new Map(provisional.graph.edges.map((edge) => [`${edge.from}\0${edge.to}`, edge]));
    const workspaceById = new Map(workspaceResults.map((result) => [result.id, result]));
    const requestedIds = options.selectedIds
        ? new Set([...options.selectedIds].map((selected) => String(selected).replace(/^@/, '')))
        : null;
    const verificationIds = requestedIds ? new Set() : new Set(workspaceResults.map((result) => result.id));
    function selectDependencyClosure(selected) {
        if (verificationIds.has(selected))
            return;
        const result = workspaceById.get(selected);
        if (!result)
            return;
        verificationIds.add(selected);
        for (const dependency of result.dependencies)
            if (workspaceById.has(dependency))
                selectDependencyClosure(dependency);
    }
    for (const selected of requestedIds ?? [])
        selectDependencyClosure(selected);
    if (requestedIds && previousSnapshot)
        diagnostics.push(...previousSnapshot.diagnostics.filter((item) => (item.id !== undefined && !verificationIds.has(item.id) && item.code.startsWith('WORKSPACE_AI_'))));
    const dependencyAdjacency = new Map(workspaceResults.map((result) => [
        result.id,
        result.dependencies.filter((dependency) => workspaceIds.has(dependency))
    ]));
    const workspaceCycles = findCycles(dependencyAdjacency);
    const cycleEdges = new Set();
    for (const cycle of workspaceCycles) {
        for (let index = 0; index < cycle.length - 1; index += 1)
            cycleEdges.add(`${cycle[index]}\0${cycle[index + 1]}`);
    }
    function localScopeCheck(result, dependency) {
        if (dependency === id && !localResultById.has(id))
            return 'fail';
        const compiledEdge = provisionalEdges.get(`${result.id}\0${dependency}`);
        if (compiledEdge)
            return compiledEdge.checks?.scope ?? 'fail';
        const source = sourceRootById.get(result.id);
        const dependencySource = sourceRootById.get(dependency);
        if (!source || !dependencySource)
            return 'fail';
        if (source === dependencySource)
            return 'pass';
        const imports = fileByRootPath.get(source)?.imports ?? [];
        return imports.some((declaration) => declaration.use.includes(dependency)) ? 'pass' : 'fail';
    }
    function referenceChecks(result) {
        return result.dependencies.map((dependency) => {
            const workspaceDependency = workspaceById.get(dependency);
            if (workspaceDependency)
                return {
                    dependency,
                    origin: 'workspace',
                    existence: 'pass',
                    scope: localScopeCheck(result, dependency),
                    cycle: cycleEdges.has(`${result.id}\0${dependency}`) ? 'fail' : 'pass'
                };
            if (projectGoalById.has(dependency))
                return {
                    dependency,
                    origin: 'main-goal',
                    existence: 'pass',
                    scope: 'fail',
                    cycle: 'pass'
                };
            return {
                dependency,
                origin: 'unresolved',
                existence: 'fail', scope: 'fail', cycle: 'pass'
            };
        }).sort((left, right) => left.dependency.localeCompare(right.dependency));
    }
    for (const result of workspaceResults) {
        for (const check of referenceChecks(result)) {
            if (check.existence === 'fail' && !diagnostics.some((item) => item.id === result.id && item.code === 'WORKSPACE_DEPENDENCY_UNKNOWN' && item.dependency === check.dependency))
                diagnostics.push({
                    severity: 'error', code: 'WORKSPACE_DEPENDENCY_UNKNOWN', dependency: check.dependency,
                    message: `Workspace fact @${result.id} cites unresolved @${check.dependency}`,
                    file: result.file, line: result.proof_line ?? result.line, id: result.id
                });
            if (check.origin === 'workspace' && check.scope === 'fail')
                diagnostics.push({
                    severity: 'error', code: 'WORKSPACE_DEPENDENCY_UNAVAILABLE', dependency: check.dependency,
                    message: `Workspace fact @${result.id} cites workspace @${check.dependency}, which is neither local to its file nor explicitly imported`,
                    file: result.file, line: result.proof_line ?? result.line, id: result.id
                });
        }
    }
    const mechanicalDiagnostics = diagnostics.slice();
    function relevantErrors(result) {
        const sourceRoot = sourceRootById.get(result.id);
        return mechanicalDiagnostics.filter((item) => item.severity === 'error' && (item.id
            ? item.id === result.id
            : item.file === result.file || (sourceRoot && item.file === sourceRoot)));
    }
    function mechanicalCheck(result) {
        const references = referenceChecks(result);
        const errors = relevantErrors(result);
        const marker = sourceMarkerById.get(result.id);
        let reason = null;
        if (stale)
            reason = 'workspace-snapshot-stale';
        else if (!projectGoals.complete || provisional.complete === false)
            reason = 'semantic-parse-incomplete';
        else if (errors.length)
            reason = 'mechanical-check-failed';
        else if (references.some((check) => (check.existence !== 'pass' || check.scope !== 'pass' || check.cycle !== 'pass')))
            reason = 'reference-check-failed';
        return {
            status: reason ? 'fail' : 'pass',
            verification_mode: result.kind === 'definition'
                ? 'definition-construction'
                : marker === 'DISPROVED' ? 'refutation' : 'proof',
            references,
            diagnostics: errors.map((item) => item.code).sort(),
            ...(reason ? { reason } : {})
        };
    }
    function localEligibility(result) {
        const marker = sourceMarkerById.get(result.id);
        if (stale)
            return { ready: false, reason: 'workspace-snapshot-stale' };
        if (!projectGoals.complete || provisional.complete === false)
            return { ready: false, reason: 'semantic-parse-incomplete' };
        if (marker === 'OPEN')
            return { ready: false, reason: 'explicitly-open' };
        if (marker === 'REJECTED')
            return { ready: false, reason: 'explicitly-rejected' };
        if (marker === 'VERIFIED' || marker === 'REVOKED')
            return { ready: false, reason: 'protected-marker-forbidden' };
        if (result.kind !== 'definition' && !result.proof_present)
            return { ready: false, reason: 'proof-missing' };
        if (referenceChecks(result).some((check) => check.existence !== 'pass' || check.origin !== 'workspace')) {
            return { ready: false, reason: 'dependency-context-unavailable' };
        }
        const blockingErrors = relevantErrors(result).filter((item) => ![
            'DEPENDENCY_UNAVAILABLE', 'WORKSPACE_DEPENDENCY_UNAVAILABLE', 'DEPENDENCY_CYCLE', 'IMPORT_CYCLE'
        ].includes(item.code));
        if (blockingErrors.length)
            return { ready: false, reason: 'local-context-invalid' };
        return { ready: true };
    }
    const locatedBlocks = new Map();
    async function located(result, origin) {
        const key = `${origin}:${result.id}:${result.file}`;
        const cached = locatedBlocks.get(key);
        if (cached)
            return cached;
        const file = origin === 'main-goal'
            ? path.join(root, result.file)
            : path.join(root, sourceRootById.get(result.id) ?? result.file);
        const value = await readLocatedBlock(file, result.id);
        if (!value)
            throw Object.assign(new Error(`Source block for @${result.id} disappeared during workspace inspection`), { code: 'WORKSPACE_SOURCE_STALE' });
        locatedBlocks.set(key, value);
        return value;
    }
    const protectedScope = currentTarget ? {
        id: currentTarget.id,
        identity: { statement_hash: currentTarget.statement_hash }
    } : { id, identity: null };
    async function packetFor(result) {
        const local = localResultById.get(result.id);
        let statement;
        let proof = '';
        if (local) {
            const block = await located(local, 'workspace');
            statement = cleanVerifierText(block.statement?.text, result.kind === 'definition' ? 'last' : null);
            proof = cleanVerifierText(block.proof?.text, 'first');
        }
        else {
            if (!currentTarget)
                throw Object.assign(new Error(`Protected main goal @${id} disappeared`), { code: 'WORKSPACE_SOURCE_STALE' });
            const block = await located(currentTarget, 'main-goal');
            statement = cleanVerifierText(block.statement?.text, currentTarget.kind === 'definition' ? 'last' : null);
            const proofFile = sourceRootById.get(result.id);
            if (proofFile) {
                const proofBlock = await readLocatedProof(path.join(root, proofFile), result.id);
                if (!proofBlock)
                    throw Object.assign(new Error(`Workspace proof of @${result.id} disappeared during inspection`), { code: 'WORKSPACE_SOURCE_STALE' });
                proof = cleanVerifierText(proofBlock.proof?.text, 'first');
            }
        }
        const dependencies = [];
        for (const dependency of [...new Set(result.dependencies)].sort()) {
            const workspaceDependency = workspaceById.get(dependency);
            if (workspaceDependency) {
                const localDependency = localResultById.get(dependency);
                if (!localDependency)
                    throw Object.assign(new Error(`Workspace dependency @${dependency} disappeared`), { code: 'WORKSPACE_SOURCE_STALE' });
                const dependencyBlock = await located(localDependency, 'workspace');
                dependencies.push({
                    id: dependency,
                    kind: workspaceDependency.kind,
                    title: workspaceDependency.title,
                    semantic_text: cleanVerifierText(dependencyBlock.statement?.text, workspaceDependency.kind === 'definition' ? 'last' : null),
                    statement: cleanVerifierText(dependencyBlock.statement?.text, workspaceDependency.kind === 'definition' ? 'last' : null),
                    origin: 'workspace',
                    identity: {
                        statement_hash: workspaceDependency.statement_hash
                    },
                    source: { file: workspaceDependency.file }
                });
                continue;
            }
            // Non-workspace @IDs are rejected mechanically. Permitted outside mathematics
            // is supplied only through externalBasis, never as an implicit graph fact.
        }
        const scope = {
            type: 'local-conditional-check',
            workspace: id,
            source_file: result.file,
            direct_dependency_ids: dependencies.map((dependency) => dependency.id),
            semantic_context: {
                definitions: dependencies.filter((dependency) => dependency.kind === 'definition').map((dependency) => ({
                    id: dependency.id,
                    construction: dependency.statement,
                    identity: dependency.identity
                }))
            },
            protected_goal: { id: protectedScope.id, identity: protectedScope.identity }
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
                workspace: id,
                verification_mode: sourceMarkerById.get(result.id) === 'DISPROVED' ? 'refutation' : result.kind === 'definition' ? 'definition-construction' : 'proof'
            },
            dependencies,
            externalBasis,
            scope,
            config: projectGoals.config
        });
    }
    const outcomes = new Map();
    const verifierAvailable = configured(projectGoals.config);
    const verification = {
        available: verifierAvailable,
        eligible: 0,
        verifier_calls: 0,
        cache_hits: 0,
        cache_misses: 0,
        invalid_cache_entries: 0,
        local_verified: 0,
        local_disproved: 0,
        local_rejected: 0,
        local_errors: 0,
        local_not_run: 0,
        global_verified: 0,
        global_disproved: 0,
        global_blocked: 0,
        global_unverified: 0,
        global_rejected: 0,
        global_invalid: 0,
        stopped_after: null,
        facts: []
    };
    let fatal = null;
    const initialProtectedGoalFingerprint = protectedGoalContextFingerprint(projectGoals, id, externalBasis);
    for (const result of topologicalOrder(workspaceResults)) {
        if (!verificationIds.has(result.id)) {
            const previous = previousById.get(result.id);
            if (previous?.local_verification) {
                outcomes.set(result.id, previous.local_verification);
            }
            else {
                outcomes.set(result.id, {
                    status: 'not-run',
                    reason: 'Local verification was outside the selected fact/path dependency closure.'
                });
            }
            continue;
        }
        const eligibility = localEligibility(result);
        if (!eligibility.ready) {
            outcomes.set(result.id, {
                status: 'not-run',
                reason: eligibility.reason === 'proof-missing'
                    ? 'No complete proof is present.'
                    : eligibility.reason === 'explicitly-open'
                        ? 'The active workspace attempt is explicitly OPEN.'
                        : eligibility.reason === 'explicitly-rejected'
                            ? 'The active workspace attempt is explicitly REJECTED.'
                            : `Local conditional verification did not run because ${eligibility.reason}.`
            });
            continue;
        }
        verification.eligible += 1;
        if (!verifierAvailable) {
            outcomes.set(result.id, {
                status: 'not-run',
                reason: 'No verifier is configured; the machine dependency analysis remains available and this local result is unverified.'
            });
            continue;
        }
        let packet;
        try {
            packet = await packetFor(result);
        }
        catch (error) {
            const failure = verifierFailure(error, result.id);
            failure.code = String(asErrorLike(error).code ?? 'WORKSPACE_SOURCE_STALE');
            failure.failed_target = result.id;
            outcomes.set(result.id, failure);
            continue;
        }
        const key = verificationKey(packet);
        const cached = await cachedWorkspaceDecision(directory, id, result.id, key, packet);
        if (cached.invalid)
            verification.invalid_cache_entries += 1;
        let report;
        let source;
        let cachedResult = false;
        if (cached.record) {
            report = cached.record.report;
            source = 'workspace-verification-cache';
            cachedResult = true;
            verification.cache_hits += 1;
        }
        else if (fatal) {
            outcomes.set(result.id, fatal.failed_target
                ? verifierFailure(fatal, fatal.failed_target, true)
                : { ...fatal, inherited: true });
            continue;
        }
        else {
            verification.cache_misses += 1;
            verification.verifier_calls += 1;
            try {
                report = await invokeVerifier(packet, projectGoals.config);
            }
            catch (error) {
                const failure = verifierFailure(error, result.id);
                failure.failed_target = result.id;
                const now = new Date().toISOString();
                const digest = key.replace(/^sha256:/, '');
                const failureFile = path.join(directory, 'verification', 'failures', digest, `${now.replace(/[-:.TZ]/g, '')}.json`);
                try {
                    await atomicJson(failureFile, {
                        schema_version: 1,
                        operation: 'workspace-local-conditional-verification-failed',
                        workspace: id,
                        target: result.id,
                        failed_at: now,
                        verification_key: key,
                        checker_contract: checkerContract(projectGoals.config),
                        error: failure.details ?? { code: failure.code, message: failure.error },
                        remediation: failure.remediation
                    });
                    failure.failure_report = relativePosix(directory, failureFile);
                }
                catch { /* The structured command error remains the primary result. */ }
                fatal = failure;
                outcomes.set(result.id, failure);
                verification.stopped_after = result.id;
                continue;
            }
            let contextCurrent = false;
            try {
                const [workspaceFingerprint, currentProjectGoals, currentExternalBasis] = await Promise.all([
                    workspaceSourceFingerprint(directory),
                    compileProject(root, { ...options, semanticMode: 'project-goals', write: false }),
                    readExternalPolicy(root)
                ]);
                contextCurrent = workspaceFingerprint === initialWorkspaceFingerprint
                    && protectedGoalContextFingerprint(currentProjectGoals, id, currentExternalBasis) === initialProtectedGoalFingerprint;
            }
            catch {
                contextCurrent = false;
            }
            if (!contextCurrent) {
                fatal = verifierFailure(Object.assign(new Error(`Workspace or protected project-goal context changed while @${result.id} was being checked`), { code: 'WORKSPACE_SOURCE_STALE' }), result.id);
                fatal.failed_target = result.id;
                outcomes.set(result.id, fatal);
                verification.stopped_after = result.id;
                continue;
            }
            const record = {
                schema_version: 4,
                operation: 'workspace-local-conditional-verification',
                workspace: id,
                target: result.id,
                verified_at: new Date().toISOString(),
                outcome: verificationOutcome(report, packet),
                accepted: verificationOutcome(report, packet) !== 'rejected',
                report,
                statement_hash: result.statement_hash,
                proof_hash: result.proof_hash,
                dependency_snapshot: Object.fromEntries(packet.dependencies.map((dependency) => [String(dependency.id), {
                        origin: dependency.origin,
                        identity: dependency.identity
                    }])),
                scope: packet.scope,
                external_basis_hash: externalPolicyHash(externalBasis),
                checker_contract: checkerContract(projectGoals.config),
                verification_key: key,
                packet_hash: sha256(stableJson(packet, 0)),
                packet
            };
            try {
                await atomicJson(cached.location.file, record);
            }
            catch (error) {
                fatal = verifierFailure(Object.assign(new Error(`Verifier result for @${result.id} could not be cached safely: ${asErrorLike(error).message}`), { code: 'WORKSPACE_CACHE_WRITE_FAILED' }), result.id);
                fatal.failed_target = result.id;
                outcomes.set(result.id, fatal);
                verification.stopped_after = result.id;
                continue;
            }
            source = 'independent-verifier';
        }
        const decision = verificationOutcome(report, packet);
        const pass = decision !== 'rejected';
        const outcome = {
            status: pass ? 'pass' : 'fail',
            outcome: decision,
            source,
            cached: cachedResult,
            verification_key: key,
            report
        };
        outcomes.set(result.id, outcome);
        if (decision === 'disproved') {
            result.disproof = {
                status: 'conditional',
                summary: report.summary,
                refutation: report.refutation,
                source: 'local-verifier-evidence',
                verification_key: key
            };
        }
        else
            delete result.disproof;
    }
    for (const result of workspaceResults) {
        if (!outcomes.has(result.id))
            outcomes.set(result.id, {
                status: 'not-run',
                reason: 'Local conditional verification did not run because the workspace fact was not eligible.'
            });
        const outcome = outcomes.get(result.id);
        if (!outcome)
            throw new Error(`Workspace outcome for @${result.id} was not recorded`);
        if (outcome.status === 'fail')
            diagnostics.push({
                severity: 'warning', code: sourceMarkerById.get(result.id) === 'DISPROVED' ? 'WORKSPACE_AI_DISPROOF_REJECTED' : 'WORKSPACE_AI_CHECK_REJECTED',
                message: sourceMarkerById.get(result.id) === 'DISPROVED'
                    ? `Local conditional verification did not confirm the proposed refutation of @${result.id}: ${outcome.report?.summary || 'critical errors or gaps remain'}`
                    : `Local conditional verification rejected the submitted proof of @${result.id}: ${outcome.report?.summary || 'critical errors or gaps remain'}`,
                file: result.file, line: result.proof_line ?? result.line, id: result.id,
                repair_hints: outcome.report?.repair_hints ?? ''
            });
        if (outcome.status === 'error')
            diagnostics.push({
                severity: 'error', code: outcome.code ?? 'WORKSPACE_AI_CHECK_FAILED',
                message: `Local conditional verification could not check @${result.id}: ${outcome.error}`,
                file: result.file, line: result.proof_line ?? result.line, id: result.id,
                remediation: outcome.remediation
            });
    }
    const globalById = new Map();
    for (const result of topologicalOrder(workspaceResults)) {
        const mechanical = mechanicalCheck(result);
        const local = outcomes.get(result.id) ?? { status: 'not-run' };
        let global;
        if (mechanical.status !== 'pass') {
            const blockers = referenceChecks(result)
                .filter((check) => check.existence !== 'pass' || check.scope !== 'pass' || check.cycle !== 'pass')
                .map((check) => check.dependency).sort();
            global = { status: 'invalid', blockers, reason: mechanical.reason ?? 'mechanical-check-failed' };
        }
        else if (local.status === 'fail') {
            global = { status: 'rejected', blockers: [], reason: 'local-verification-rejected' };
        }
        else if (local.status !== 'pass' || !local.outcome || local.outcome === 'rejected') {
            global = { status: 'unverified', blockers: [], reason: local.reason ?? local.error ?? 'local-verification-unavailable' };
        }
        else {
            const blockers = result.dependencies.filter((dependency) => (workspaceById.has(dependency) && globalById.get(dependency)?.status !== 'verified')).sort();
            global = blockers.length
                ? { status: 'blocked', blockers, reason: 'dependency-closure-not-verified' }
                : { status: local.outcome === 'disproved' ? 'disproved' : 'verified', blockers: [] };
        }
        globalById.set(result.id, global);
        result.global_verification = global;
        result.local_verification = local.status === 'pass' || local.status === 'fail'
            ? {
                status: local.status,
                outcome: local.outcome,
                source: 'local-verifier-evidence',
                verification_key: local.verification_key,
                report: local.report
            }
            : local;
        result.status = `workspace-${global.status}`;
        if (verificationIds.has(result.id) && !(local.status === 'pass' && local.outcome === 'disproved'))
            delete result.disproof;
        if (result.disproof)
            result.disproof.status = global.status === 'disproved' ? 'global' : 'conditional';
    }
    const citedMainGoalIds = new Set(workspaceResults.flatMap((result) => result.dependencies)
        .filter((dependency) => projectGoalById.has(dependency) && !workspaceIds.has(dependency)));
    const mainGoalNodes = [...citedMainGoalIds].sort().flatMap((dependency) => {
        const result = projectGoalById.get(dependency);
        return result ? [{
                id: result.id, title: result.title, kind: result.kind, status: result.status,
                file: result.file, line: result.line, origin: 'main-goal',
                identity: { statement_hash: result.statement_hash, proof_hash: result.proof_hash }
            }] : [];
    });
    const knownIds = new Set([...workspaceResults.map((result) => result.id), ...mainGoalNodes.map((result) => result.id)]);
    const unresolvedNodes = [...new Set(workspaceResults.flatMap((result) => result.dependencies).filter((dependency) => !knownIds.has(dependency)))].sort()
        .map((dependency) => ({ id: dependency, title: '', kind: 'unknown', status: 'missing', origin: 'unresolved' }));
    const graph = {
        schema_version: 4,
        nodes: [
            ...workspaceResults.map(({ id: resultId, title, kind, status, file, line, statement_hash, proof_hash, disproof, global_verification }) => ({
                id: resultId, title, kind, status, file, line, origin: 'workspace',
                identity: { statement_hash, proof_hash },
                local_verification: workspaceById.get(resultId)?.local_verification ?? { status: 'not-run' },
                global_verification: global_verification ?? { status: 'unverified', blockers: [] },
                ...(disproof ? { disproof } : {})
            })),
            ...mainGoalNodes,
            ...unresolvedNodes.map((node) => ({ ...node, kind: 'unknown' }))
        ],
        edges: workspaceResults.flatMap((result) => result.dependencies.map((dependency) => {
            const check = referenceChecks(result).find((item) => item.dependency === dependency);
            return {
                from: result.id,
                to: dependency,
                checks: check ? {
                    existence: check.existence,
                    scope: check.scope,
                    cycle: check.cycle
                } : { existence: 'fail', scope: 'fail', cycle: 'pass' }
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
        mechanical: mechanicalCheck(result),
        local_verification: outcomes.get(result.id) ?? { status: 'not-run', reason: 'No outcome was recorded.' },
        global_verification: result.global_verification ?? { status: 'unverified', blockers: [] }
    }));
    const scopedFacts = facts.filter((fact) => verificationIds.has(fact.id));
    verification.local_verified = scopedFacts.filter((fact) => fact.local_verification.status === 'pass' && fact.local_verification.outcome === 'verified').length;
    verification.local_disproved = scopedFacts.filter((fact) => fact.local_verification.status === 'pass' && fact.local_verification.outcome === 'disproved').length;
    verification.local_rejected = scopedFacts.filter((fact) => fact.local_verification.status === 'fail').length;
    verification.local_errors = scopedFacts.filter((fact) => fact.local_verification.status === 'error').length;
    verification.local_not_run = scopedFacts.filter((fact) => fact.local_verification.status === 'not-run').length;
    verification.global_verified = scopedFacts.filter((fact) => fact.global_verification.status === 'verified').length;
    verification.global_disproved = scopedFacts.filter((fact) => fact.global_verification.status === 'disproved').length;
    verification.global_blocked = scopedFacts.filter((fact) => fact.global_verification.status === 'blocked').length;
    verification.global_unverified = scopedFacts.filter((fact) => fact.global_verification.status === 'unverified').length;
    verification.global_rejected = scopedFacts.filter((fact) => fact.global_verification.status === 'rejected').length;
    verification.global_invalid = scopedFacts.filter((fact) => fact.global_verification.status === 'invalid').length;
    verification.facts = scopedFacts.map(({ id: factId, local_verification, global_verification }) => ({
        id: factId, local_verification, global_verification
    }));
    const manifest = {
        schema_version: 4,
        snapshot_id: graph.snapshot_id,
        target: id,
        stale,
        files: provisional.manifest.files.map((file) => ({
            ...file,
            path: relativePosix(directory, path.resolve(root, file.path))
        })),
        results: workspaceResults,
        proofs: provisional.manifest.proofs,
        protected_goal_results: mainGoalNodes
    };
    diagnostics.sort((left, right) => `${left.file ?? ''}:${left.line ?? 0}:${left.code}:${left.id ?? ''}`.localeCompare(`${right.file ?? ''}:${right.line ?? 0}:${right.code}:${right.id ?? ''}`));
    const findings = deriveGraphFindings({ graph, manifest, diagnostics });
    const selectedSourceFiles = new Set([...verificationIds].map((selected) => sourceRootById.get(selected)).filter((file) => Boolean(file)));
    const scopedMechanicalDiagnostics = requestedIds
        ? mechanicalDiagnostics.filter((item) => item.id ? verificationIds.has(item.id) : !item.file || selectedSourceFiles.has(item.file) || item.code === 'WORKSPACE_STALE')
        : mechanicalDiagnostics;
    const complete = projectGoals.complete && (requestedIds
        ? scopedMechanicalDiagnostics.every((item) => item.code !== 'PARSE_ERROR')
        : provisional.complete !== false);
    if (complete && options.write !== false) {
        const snapshot = {
            schema_version: 4,
            snapshot_id: graph.snapshot_id,
            source_signature: sourceSignature,
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
            schema_version: 4,
            snapshot_id: graph.snapshot_id,
            file: relativePosix(directory, snapshotFile)
        });
    }
    const mechanicalOk = complete && !stale && scopedMechanicalDiagnostics.every((item) => item.severity !== 'error');
    const verificationOperational = scopedFacts.every((fact) => fact.local_verification.status !== 'error');
    const globallyVerified = scopedFacts.every((fact) => fact.global_verification.status === 'verified');
    const statuses = {};
    const kinds = {};
    for (const result of workspaceResults) {
        statuses[result.status] = (statuses[result.status] ?? 0) + 1;
        kinds[result.kind] = (kinds[result.kind] ?? 0) + 1;
    }
    const inspection = {
        schema_version: 4,
        operation: 'workspace-inspect',
        ok: mechanicalOk && verificationOperational,
        complete,
        snapshot_id: graph.snapshot_id,
        snapshot_published: complete && options.write !== false,
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
            verification_operational: verificationOperational,
            globally_verified: globallyVerified
        },
        verification,
        facts,
        findings,
        manifest,
        graph,
        diagnostics
    };
    if (projectIndex) {
        const aggregate = buildAggregateSnapshot(projectIndex, new Map([[id, inspection]]));
        inspection.project_snapshot_id = aggregate.snapshot_id;
        inspection.project_snapshot_published = await publishAggregateSnapshot(projectIndex, aggregate, options);
    }
    return inspection;
}
