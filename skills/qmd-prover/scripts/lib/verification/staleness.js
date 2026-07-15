import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { buildProjectInspectionIndex } from '../inspection/index.js';
import { externalPolicyHash, readExternalPolicy } from '../infrastructure/external.js';
import { AUX, readJson, stableJson } from '../infrastructure/files.js';
import { hasErrorCode, isRecord } from '../shared/core.js';
import { checkerContract, verificationOutcome } from './protocol.js';
async function jsonFiles(directory) {
    try {
        return (await readdir(directory, { withFileTypes: true }))
            .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
            .map((entry) => path.join(directory, entry.name))
            .sort();
    }
    catch (error) {
        if (hasErrorCode(error, 'ENOENT'))
            return [];
        throw error;
    }
}
export async function checkStaleness(root = process.cwd(), options = {}) {
    root = path.resolve(root);
    const index = await buildProjectInspectionIndex(root, { ...options, write: false });
    const [externalBasis, legacyIndex] = await Promise.all([
        readExternalPolicy(root),
        readJson(path.join(root, AUX, 'verification', 'index.json'), {})
    ]);
    const externalHash = externalPolicyHash(externalBasis);
    const contract = checkerContract(index.goalsCompilation.config);
    const changed = [];
    for (const workspace of index.workspaces) {
        const reasons = new Set();
        if (workspace.status === 'uninitialized')
            reasons.add('workspace-uninitialized');
        if (workspace.status === 'orphan')
            reasons.add('workspace-orphan');
        if (workspace.status === 'invalid')
            reasons.add('workspace-invalid');
        if (workspace.stale)
            reasons.add('main-goal-snapshot-changed');
        if (workspace.compilation?.complete === false)
            reasons.add('workspace-parse-incomplete');
        for (const file of await jsonFiles(path.join(workspace.directory, 'verification', 'checks'))) {
            let record;
            try {
                record = await readJson(file);
            }
            catch {
                reasons.add('workspace-cache-invalid');
                continue;
            }
            if (!isRecord(record.report) || !isRecord(record.packet) || !isRecord(record.packet.target)) {
                reasons.add('workspace-cache-invalid');
            }
            else {
                const outcome = verificationOutcome(record.report, record.packet);
                if (record.outcome !== outcome || record.accepted !== (outcome !== 'rejected'))
                    reasons.add('workspace-cache-invalid');
            }
            if (record.external_basis_hash !== externalHash)
                reasons.add('external-basis-changed');
            if (stableJson(record.checker_contract ?? {}, 0) !== stableJson(contract, 0))
                reasons.add('checker-contract-changed');
            const target = workspace.compilation?.manifest.results.find((result) => result.id === record.target);
            if (target && (record.statement_hash !== target.statement_hash || record.proof_hash !== target.proof_hash))
                reasons.add('workspace-source-changed');
            if (!target && record.target === workspace.id) {
                const goal = index.goals.find((result) => result.id === workspace.id);
                const proofs = workspace.compilation?.manifest.proofs.filter((proof) => proof.target === workspace.id) ?? [];
                const proof = proofs.length === 1 ? proofs[0] : null;
                if (!goal || record.statement_hash !== goal.statement_hash || record.proof_hash !== proof?.proof_hash)
                    reasons.add('workspace-source-changed');
            }
            const dependencySnapshot = isRecord(record.dependency_snapshot) ? record.dependency_snapshot : {};
            for (const [dependencyId, saved] of Object.entries(dependencySnapshot)) {
                const current = workspace.compilation?.manifest.results.find((result) => result.id === dependencyId);
                const identity = isRecord(saved) && isRecord(saved.identity) ? saved.identity : {};
                if (!current || identity.statement_hash !== current.statement_hash)
                    reasons.add('workspace-local-context-changed');
            }
        }
        if (reasons.size)
            changed.push({
                id: workspace.id,
                reasons: [...reasons].sort(),
                previous: workspace.metadata?.canonical ?? null,
                current: { status: workspace.status, stale: workspace.stale, files: workspace.files.length, external_basis_hash: externalHash, checker_contract: contract }
            });
    }
    for (const id of Object.keys(legacyIndex).sort())
        changed.push({
            id,
            reasons: ['legacy-canonical-verification-record'],
            previous: legacyIndex[id],
            current: { status: 'legacy-read-only', remediation: 'Use workspace inspection; qmd-prover will not migrate, delete, or rewrite this record or its user-QMD marker.' }
        });
    changed.sort((left, right) => left.id.localeCompare(right.id));
    return {
        schema_version: 4,
        operation: 'check-staleness',
        ok: !index.fatal && index.goalsCompilation.complete && index.workspaces.every((workspace) => workspace.compilation?.complete !== false),
        changed,
        invalidated: changed.map((item) => ({ id: item.id, path: [item.id], reasons: item.reasons })),
        snapshot_id: index.goalsCompilation.graph.snapshot_id
    };
}
