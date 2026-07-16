import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { sha256, stableJson } from '../infrastructure/files.js';
import { externalPolicyHash, readExternalPolicy } from '../infrastructure/external.js';
import { asErrorLike, asRecord, isRecord } from '../shared/core.js';
export const VERIFIER_PROTOCOL_VERSION = 6;
const PROTOCOL_NAME = 'qmd-prover-independent-verifier';
function verificationConfig(config = {}) {
    if (isRecord(config) && isRecord(config.verification))
        return config.verification;
    return isRecord(config) ? config : {};
}
function setting(config, hyphenated, underscored, fallback) {
    const verification = verificationConfig(config);
    if (verification[hyphenated] !== undefined)
        return verification[hyphenated];
    if (verification[underscored] !== undefined)
        return verification[underscored];
    return fallback;
}
export function checkerContract(config = {}) {
    const verification = verificationConfig(config);
    return {
        backend: String(verification.backend ?? 'none'),
        model: String(verification.model ?? 'configurable'),
        effort: String(verification.effort ?? 'high'),
        fresh_context: Boolean(setting(config, 'fresh-context', 'fresh_context', true)),
        require_zero_gaps: Boolean(setting(config, 'require-zero-gaps', 'require_zero_gaps', true)),
        definition_strictness: String(setting(config, 'definition-strictness', 'definition_strictness', 'off')),
        protocol: { name: PROTOCOL_NAME, version: VERIFIER_PROTOCOL_VERSION }
    };
}
export async function verificationContext(compilation) {
    const externalBasis = await readExternalPolicy(compilation.root);
    const contextHash = sha256(stableJson({
        external_basis_hash: externalPolicyHash(externalBasis),
        checker_contract: checkerContract(compilation.config)
    }, 0));
    return { externalBasis, contextHash };
}
export const VERIFIER_BACKENDS = ['none', 'claude', 'codex', 'command'];
/** Absolute path to a shipped verifier adapter (scripts/verifiers/<backend>.js). */
function builtinAdapter(backend) {
    return fileURLToPath(new URL(`../../verifiers/${backend}.js`, import.meta.url));
}
/** The concrete model id to pass to a CLI, or '' when the backend should pick its own default. */
function modelFlag(verification) {
    const model = typeof verification.model === 'string' ? verification.model.trim() : '';
    return model && model !== 'configurable' ? model : '';
}
/**
 * The reasoning-effort level to forward to a backend adapter, or '' when unset. Restricted to a
 * bare lowercase word so it is safe to splice into a CLI flag; the adapter maps it to whatever its
 * CLI expects (e.g. codex `-c model_reasoning_effort`). Keeping this in the checker contract too
 * means changing it re-keys the cache, so a different effort recomputes rather than reuses verdicts.
 */
function effortFlag(verification) {
    const effort = typeof verification.effort === 'string' ? verification.effort.trim().toLowerCase() : '';
    return /^[a-z]+$/.test(effort) ? effort : '';
}
function backendExecutable(verification, backend) {
    const configured = typeof verification.executable === 'string' ? verification.executable.trim() : '';
    return configured || backend;
}
function customCommand(command) {
    if (Array.isArray(command) && command.length > 0 && String(command[0]).trim()) {
        return { command: String(command[0]), args: command.slice(1).map(String) };
    }
    if (typeof command === 'string' && command.trim())
        return { command: command.trim(), args: [] };
    return null;
}
/**
 * The process to spawn for one verification. `claude`/`codex` backends run a shipped
 * adapter under Node that bridges the packet to that CLI, so no custom command is needed.
 * Precedence: QMD_PROVER_VERIFIER env > verification.backend claude|codex > verification.command.
 */
export function verifierCommand(config = {}) {
    const override = process.env.QMD_PROVER_VERIFIER?.trim();
    if (override)
        return { command: override, args: [], source: 'environment' };
    const verification = verificationConfig(config);
    const backend = String(verification.backend ?? 'none').trim();
    if (backend === 'claude' || backend === 'codex') {
        const model = modelFlag(verification);
        const effort = effortFlag(verification);
        const args = [
            builtinAdapter(backend), '--executable', backendExecutable(verification, backend),
            ...(model ? ['--model', model] : []),
            ...(effort ? ['--effort', effort] : [])
        ];
        return { command: process.execPath, args, source: `backend:${backend}` };
    }
    const custom = customCommand(verification.command);
    return custom ? { ...custom, source: 'config' } : null;
}
/**
 * The underlying tool whose availability doctor should probe and display. For claude/codex
 * this is the CLI itself (not the Node adapter that wraps it).
 */
export function verifierProbe(config = {}) {
    const override = process.env.QMD_PROVER_VERIFIER?.trim();
    if (override)
        return { command: override, backend: 'command' };
    const verification = verificationConfig(config);
    const backend = String(verification.backend ?? 'none').trim();
    if (backend === 'claude' || backend === 'codex')
        return { command: backendExecutable(verification, backend), backend };
    const custom = customCommand(verification.command);
    return custom ? { command: custom.command, backend: 'command' } : null;
}
export function configured(config = {}) {
    return verifierCommand(config) !== null;
}
export class VerifierError extends Error {
    code;
    constructor(code, message, details = {}) {
        super(message);
        this.name = 'VerifierError';
        this.code = code;
        Object.assign(this, details);
    }
}
function excerpt(value, limit = 4000) {
    const text = String(value ?? '').trim();
    return text.length <= limit ? text : `${text.slice(0, limit)}\n…[truncated]`;
}
export function verifierErrorDetails(error) {
    const value = asErrorLike(error);
    return {
        code: value.code ?? 'VERIFIER_FAILED',
        message: value.message ?? String(error),
        ...(value.command ? { command: value.command } : {}),
        ...(value.exit_code !== undefined ? { exit_code: value.exit_code } : {}),
        ...(value.signal ? { signal: value.signal } : {}),
        ...(value.stderr ? { stderr_excerpt: excerpt(value.stderr) } : {}),
        ...(value.stdout ? { stdout_excerpt: excerpt(value.stdout) } : {})
    };
}
function cloneJson(value, fallback) {
    if (value === undefined)
        return fallback;
    return JSON.parse(JSON.stringify(value));
}
function targetMode(target) {
    if (target.verification_mode === 'refutation')
        return 'refutation';
    return String(target?.kind ?? '').toLowerCase() === 'definition'
        ? 'definition-construction'
        : 'proof';
}
function normalizedTarget(target = {}) {
    const value = cloneJson(target, {});
    const kind = String(value.kind ?? 'theorem').toLowerCase();
    const mode = targetMode(value);
    const identity = asRecord(value.identity);
    const source = asRecord(value.source);
    const normalized = {
        ...value,
        id: String(value.id ?? ''),
        kind,
        proof: String(value.proof ?? ''),
        identity: { statement_hash: String(identity.statement_hash ?? ''), proof_hash: String(identity.proof_hash ?? '') },
        source: { file: String(source.file ?? '') },
        verification_mode: mode
    };
    // Protocol v6 dropped semantic_text (a write-only duplicate of statement/construction)
    // and cited_dependencies (the id list now lives once in scope.direct_dependency_ids).
    // Discard either if a caller passed it through the spread above; keep semantic_text as a
    // derivation fallback so legacy input carrying only that field still yields a body.
    delete normalized.semantic_text;
    delete normalized.cited_dependencies;
    if (mode === 'definition-construction') {
        normalized.construction = String(value.construction ?? value.statement ?? value.body ?? value.semantic_text ?? '');
        normalized.proof = String(value.proof ?? '');
    }
    else {
        normalized.statement = String(value.statement ?? value.semantic_text ?? '');
        normalized.proof = String(value.proof ?? '');
    }
    return normalized;
}
/**
 * The term-citation policy, gated on verification.definition-strictness. It governs only how
 * a specialized term used without a supplied definition is treated; it never relaxes checking
 * of the argument's actual logical steps. `off` is explicitly lenient (assume evident meaning),
 * `soft` flags genuine doubt, `strict` demands every load-bearing term be fixed by a citation.
 */
function termCitationRule(strictness) {
    if (strictness === 'strict') {
        return 'Term citations (strict): every specialized term, object, or notation the argument depends on must be fixed by a definition in the semantic context or by the external basis, unless it is unambiguously standard mathematical vocabulary. Report as a gap any load-bearing term whose precise meaning is not so fixed, even when the intended meaning seems clear.';
    }
    if (strictness === 'soft') {
        return 'Term citations (soft): if the argument leans on a specialized term, object, or notation whose precise meaning you genuinely doubt is standard, and that meaning is not fixed by the semantic context or the external basis, report it as a gap. Do not flag ordinary, unambiguously standard vocabulary, or a notion whose intended meaning is clear from context.';
    }
    return 'Term citations (lenient): do not treat the argument as defective merely because a specialized term, object, or notation is used without a supplied definition. When such a term is not fixed by the semantic context, assume its standard or contextually evident meaning and judge the argument on that basis. Report a defect only for an actual logical flaw, never for a missing citation alone.';
}
/** The mode-specific paragraph describing what kind of target is being checked. */
function modeParagraph(mode) {
    if (mode === 'definition-construction') {
        return 'The target is a definition: its construction introduces a term, object, or notation and normally carries no separate proof. Confirm that everything needed to make the construction meaningful is supplied or available from the semantic context, that every existence, uniqueness, or well-definedness obligation the construction itself claims is discharged (inline or in a linked justification), and that it is not circular through itself or its dependencies. Do not demand a theorem-style proof for a purely definitional stipulation, but do require justification for any nontrivial well-definedness claim the construction actually asserts.';
    }
    if (mode === 'refutation') {
        return 'The target is a theorem-like statement accompanied by a proposed counterexample or refutation. Confirm that the argument really falsifies the exact quantified statement, satisfies every stated hypothesis, and does not merely expose a gap in some proof attempt. If it succeeds, return verdict "disproved" with a self-contained refutation; otherwise return verdict "incorrect" and explain the defect.';
    }
    return 'The target is a theorem-like result (theorem, lemma, proposition, or corollary) with a submitted proof. Confirm that the proof establishes the exact stated result, and not a nearby, weaker, stronger, converse, or special-case claim.';
}
/** How to read the external_basis field: what background mathematics each mode permits. */
function externalBasisParagraph() {
    return [
        'The external_basis field fixes what mathematics you may use beyond the supplied dependencies:',
        '- mode "unrestricted": you may use standard, well-established mathematics as background (ordinary set theory, induction, elementary logic, and the like), but identify any nontrivial external result you invoke precisely enough to confirm its hypotheses; do not import project-specific results that are absent from the dependencies.',
        '- mode "declared": you may use only the external results or classes of results described in external_basis.content, together with unambiguously elementary reasoning; treat anything beyond that as unavailable.',
        '- mode "none": you may use no external mathematical results at all; every nonelementary fact must come from the supplied dependencies.'
    ].join('\n');
}
function reviewPrompt(mode, contract) {
    const zeroGaps = contract.require_zero_gaps !== false;
    const correctRule = zeroGaps
        ? '- verdict "correct": the submission fully and validly establishes the exact target; critical_errors and gaps must both be empty.'
        : '- verdict "correct": the submission fully and validly establishes the exact target; critical_errors and gaps must both be empty, so record any immaterial observation as a nonblocking_comment rather than a gap.';
    const sections = [
        'You are an independent mathematical verifier. Judge the submission strictly on its own merits: you did not write it, and you must neither assume it is correct nor repair it. Reason only from the material in this packet — do not read files, run commands, search, or rely on outside expectations about how this result is usually proved.',
        'This is a LOCAL, CONDITIONAL check. Assume every statement in dependencies is true exactly as written, and do not consider how or whether it was proved: dependency proofs and their verification states are withheld deliberately and composed separately. Your only question is whether the submitted argument (the proof, construction, or refutation in target) establishes the exact target from those assumed dependency statements, the semantic context, and the permitted external basis — and from nothing else.',
        modeParagraph(mode),
        'Among dependencies, entries with kind "definition" are the semantic context: each fixes the meaning of the terms and notation it introduces and may be unfolded. Every other dependency is a fact whose statement you may assume but not unfold. A citation like @some-id in the text refers to the dependency carrying that id.',
        externalBasisParagraph(),
        'Establish the exact target and nothing weaker, stronger, or adjacent. Check that every cited dependency is applied with the exact hypotheses, domains, directions, side conditions, and quantified variables its statement requires — naming a result is not evidence that it applies. Scrutinize quantifier order and scope, variable binding and capture, hidden existence, uniqueness, or well-definedness assumptions, degenerate and boundary cases, and whether every case the argument relies on is actually covered.',
        'Report a defect whenever a mathematically necessary step is missing, unjustified, or wrong — even when the conclusion is true, standard, or plausible — and never silently fill or replace it. Classify each defect: critical_errors are steps that are wrong, invalid, or depend on an undeclared or stronger-than-stated premise, so the argument fails as written; gaps are necessary steps that are missing or asserted without adequate justification, so the argument is incomplete though perhaps repairable; nonblocking_comments are remarks that do not affect validity.',
        'Keep leniency about the meaning of terms separate from the rigor demanded of steps: granting a term its standard or evident meaning never licenses an unjustified inference. Every load-bearing step must be genuinely justified even when its conclusion is plausible, standard, or true, and a cited definition, lemma, or hypothesis supports a step only when it applies exactly as stated — invoking one for a claim it does not actually entail, or appealing to a result whose hypotheses are not met, is itself a defect rather than acceptable shorthand.',
        termCitationRule(String(contract.definition_strictness ?? 'off')),
        [
            'Return exactly one JSON object matching output_schema, and nothing else — no prose, no markdown, no code fences.',
            correctRule,
            '- verdict "incorrect": the submission does not establish the target as written; list the specific critical_errors and/or gaps. This rejects the argument; it does not assert the target is false.',
            '- verdict "disproved": the exact target statement is itself false; provide a self-contained refutation and keep critical_errors and gaps empty.'
        ].join('\n')
    ];
    return sections.join('\n\n');
}
export function buildVerifierPacket({ target, dependencies = [], externalBasis = null, scope = null, config = {} }) {
    if (!target || typeof target !== 'object' || Array.isArray(target)) {
        throw new TypeError('buildVerifierPacket requires a target object');
    }
    const normalized = normalizedTarget(target);
    const mode = targetMode(normalized);
    const contract = checkerContract(config);
    return {
        schema_version: VERIFIER_PROTOCOL_VERSION,
        protocol: { name: PROTOCOL_NAME, version: VERIFIER_PROTOCOL_VERSION },
        task: 'local-conditional-mathematical-verification',
        checker_contract: contract,
        instructions: reviewPrompt(mode, contract),
        target: normalized,
        dependencies: cloneJson(Array.isArray(dependencies) ? dependencies : [], []),
        external_basis: cloneJson(externalBasis ?? { mode: 'none', content: '' }, { mode: 'none', content: '' }),
        scope: cloneJson(scope, null),
        output_schema: {
            verdict: 'correct | incorrect | disproved',
            summary: 'string: one or two sentences stating the overall judgement',
            critical_errors: ['string: each a wrong or invalid step that breaks the argument'],
            gaps: ['string: each a necessary step left missing or unjustified'],
            nonblocking_comments: ['string: each an observation that does not affect validity'],
            repair_hints: 'string: concrete guidance for fixing the errors and gaps, or empty',
            refutation: 'string: self-contained counterexample, nonempty iff verdict is disproved'
        }
    };
}
export function verificationKey(packetOrInput, config = undefined) {
    const input = asRecord(packetOrInput);
    const wrapped = Object.hasOwn(input, 'packet');
    const packet = wrapped ? input.packet : packetOrInput;
    const suppliedContract = wrapped ? input.checker_contract : undefined;
    const contract = suppliedContract ?? asRecord(packet).checker_contract ?? checkerContract(config ?? {});
    return sha256(stableJson({ packet, checker_contract: contract }, 0));
}
function listOfStrings(report, field, { optional = false } = {}) {
    const value = report[field];
    if (value === undefined && optional)
        return [];
    if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
        throw new VerifierError('schema', `Verifier field ${field} must be an array of strings`, { field });
    }
    return value;
}
function stringField(report, field) {
    if (report[field] === undefined)
        return '';
    if (typeof report[field] !== 'string') {
        throw new VerifierError('schema', `Verifier field ${field} must be a string`, { field });
    }
    return report[field];
}
function normalizeReport(value) {
    if (!isRecord(value)) {
        throw new VerifierError('schema', 'Verifier output must be a JSON object');
    }
    const report = value;
    if (report.verdict !== 'correct' && report.verdict !== 'incorrect' && report.verdict !== 'disproved') {
        throw new VerifierError('schema', 'Verifier verdict must be "correct", "incorrect", or "disproved"', { field: 'verdict' });
    }
    const commentsField = report.nonblocking_comments !== undefined
        ? 'nonblocking_comments'
        : report.comments !== undefined ? 'comments' : null;
    const normalized = {
        verdict: report.verdict,
        summary: stringField(report, 'summary'),
        critical_errors: listOfStrings(report, 'critical_errors'),
        gaps: listOfStrings(report, 'gaps'),
        nonblocking_comments: commentsField ? listOfStrings(report, commentsField) : [],
        repair_hints: stringField(report, 'repair_hints'),
        refutation: stringField(report, 'refutation')
    };
    if (normalized.verdict === 'disproved' && !normalized.refutation.trim()) {
        throw new VerifierError('schema', 'A disproved verdict requires a nonempty refutation', { field: 'refutation' });
    }
    return normalized;
}
export function accepted(report) {
    return report?.verdict === 'correct'
        && Array.isArray(report.critical_errors)
        && report.critical_errors.length === 0
        && Array.isArray(report.gaps)
        && report.gaps.length === 0;
}
export function disproved(report) {
    return report?.verdict === 'disproved'
        && typeof report.refutation === 'string'
        && report.refutation.trim().length > 0
        && Array.isArray(report.critical_errors)
        && report.critical_errors.length === 0
        && Array.isArray(report.gaps)
        && report.gaps.length === 0;
}
export function verificationOutcome(report, packetOrMode) {
    const mode = typeof packetOrMode === 'string'
        ? packetOrMode
        : targetMode(asRecord(packetOrMode.target));
    if (mode === 'refutation')
        return disproved(report) ? 'disproved' : 'rejected';
    if (accepted(report))
        return 'verified';
    if (mode === 'proof' && disproved(report))
        return 'disproved';
    return 'rejected';
}
function execute(command, args, packet) {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, {
            stdio: ['pipe', 'pipe', 'pipe'],
            env: {
                ...process.env,
                QMD_PROVER_FRESH_CONTEXT: '1',
                QMD_PROVER_VERIFIER_PROTOCOL: String(VERIFIER_PROTOCOL_VERSION)
            }
        });
        let stdout = '';
        let stderr = '';
        child.stdout.setEncoding('utf8');
        child.stderr.setEncoding('utf8');
        child.stdout.on('data', (chunk) => { stdout += chunk; });
        child.stderr.on('data', (chunk) => { stderr += chunk; });
        child.on('error', reject);
        child.on('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
        child.stdin.on('error', (error) => {
            if (asErrorLike(error).code !== 'EPIPE')
                reject(error);
        });
        child.stdin.end(`${JSON.stringify(packet)}\n`);
    });
}
export async function invokeVerifier(packet, config = {}) {
    const executable = verifierCommand(config);
    if (!executable) {
        throw new VerifierError('unconfigured', 'No verifier command configured. Set verification.command in .qmd-prover/config.yml or QMD_PROVER_VERIFIER.');
    }
    let result;
    try {
        result = await execute(executable.command, executable.args, packet);
    }
    catch (error) {
        const failure = asErrorLike(error);
        if (failure.code === 'ENOENT') {
            throw new VerifierError('not-found', `Verifier executable not found: ${executable.command}`, {
                command: executable.command
            });
        }
        throw new VerifierError('exit', `Verifier process could not run: ${failure.message ?? String(error)}`, {
            command: executable.command,
            cause: error
        });
    }
    if (result.code !== 0) {
        const suffix = result.stderr.trim() ? `: ${result.stderr.trim()}` : '';
        throw new VerifierError('exit', `Verifier failed with exit ${result.code ?? `signal ${result.signal}`}${suffix}`, {
            command: executable.command,
            exit_code: result.code,
            signal: result.signal,
            stderr: result.stderr
        });
    }
    let report;
    try {
        report = JSON.parse(result.stdout);
    }
    catch {
        throw new VerifierError('malformed', 'Verifier did not return valid JSON', {
            stdout: result.stdout,
            stderr: result.stderr
        });
    }
    return normalizeReport(report);
}
