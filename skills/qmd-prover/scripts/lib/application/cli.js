import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { renderHelp, rootUsage } from './help.js';
import { parseCommand } from './commands.js';
import { AUX, readJson } from '../infrastructure/files.js';
import { analyzeDependencies, inspectFact, inspectPath, inspectProject } from '../inspection/operations.js';
import { printReport } from '../inspection/report.js';
import { renderProject } from './render.js';
import { doctorProject } from './doctor.js';
import { initializeProject } from './project.js';
import { checkStaleness } from '../verification/staleness.js';
import { listVerifications, showVerification } from '../verification/submissions.js';
import { leanView } from '../inspection/lean.js';
import { asRecord, hasErrorCode } from '../shared/core.js';
// ---------------------------------------------------------------------------
// The CLI runtime. It parses argv into a Command (commands.ts), runs it, and
// writes output — the only module that touches the process, the disk, and the
// inspection/verification operations. --print renders the full internal result;
// the default JSON path emits the lean agent-facing projection (leanView), so
// report.ts and the on-disk snapshot keep the complete object.
// ---------------------------------------------------------------------------
function emit(value, print, view = {}) {
    if (print)
        process.stdout.write(printReport(value));
    else
        process.stdout.write(`${JSON.stringify(leanView(value, view), null, 2)}\n`);
    if (value.ok === false)
        process.exitCode = 2;
}
async function history(root, id) {
    const directory = path.join(root, AUX, 'verification');
    try {
        const records = [];
        for (const selected of [directory, path.join(directory, 'checks')]) {
            let entries = [];
            try {
                entries = await readdir(selected);
            }
            catch (error) {
                if (!hasErrorCode(error, 'ENOENT'))
                    throw error;
            }
            for (const name of entries.filter((entry) => entry.endsWith('.json')).sort()) {
                const record = await readJson(path.join(selected, name));
                if (record.target === id && typeof record.verdict === 'string')
                    records.push(record);
            }
        }
        return records.sort((left, right) => `${left.verified_at ?? ''}\0${left.submission_id ?? ''}`.localeCompare(`${right.verified_at ?? ''}\0${right.submission_id ?? ''}`));
    }
    catch (error) {
        if (hasErrorCode(error, 'ENOENT'))
            return [];
        throw error;
    }
}
// ---------------------------------------------------------------------------
// Dispatch. Pattern-match the parsed command and run it, rebuilding each
// operation's option bag from the command's explicit fields and merging the
// environment-derived pandoc option.
// ---------------------------------------------------------------------------
export async function main(args, { root = process.cwd(), pandoc = process.env.QMD_PROVER_PANDOC } = {}) {
    const command = parseCommand(args);
    const options = pandoc ? { pandoc } : {};
    switch (command.kind) {
        case 'usage':
            process.stdout.write(`${rootUsage}\n`);
            return;
        case 'help':
            process.stdout.write(`${renderHelp(command.of)}\n`);
            return;
        case 'doctor':
            emit(await doctorProject(root), command.print);
            return;
        case 'init':
            emit(await initializeProject(root, {
                adoptExisting: command.adoptExisting,
                appendContract: command.appendContract,
                syncContract: command.syncContract
            }), false);
            return;
        case 'render':
            emit(await renderProject(root, { ...options, allowErrors: command.allowErrors }), false);
            return;
        case 'inspect':
            switch (command.sub) {
                case 'project':
                    emit(await inspectProject(root, options), command.print, { graph: command.graph });
                    return;
                case 'fact': {
                    const result = await inspectFact(root, command.id, options);
                    result.verification_history = await history(root, String(asRecord(result.fact).id ?? ''));
                    emit(result, command.print, { graph: command.graph });
                    return;
                }
                case 'path':
                    emit(await inspectPath(root, command.target, options), command.print, { graph: command.graph });
                    return;
                default:
                    return command;
            }
        case 'dependency':
            switch (command.sub) {
                case 'search':
                    emit(await analyzeDependencies(root, 'search', command.query === undefined ? [] : [command.query], { ...options, ...command.filters }), command.print);
                    return;
                case 'alternative-paths':
                    emit(await analyzeDependencies(root, 'alternative-paths', [command.from, command.to], { ...options, maxPaths: command.maxPaths, maxDepth: command.maxDepth }), command.print);
                    return;
                case 'reused':
                    emit(await analyzeDependencies(root, 'reused', [], { ...options, limit: command.limit }), command.print);
                    return;
                case 'path':
                    emit(await analyzeDependencies(root, 'path', [command.from, command.to], options), command.print);
                    return;
                case 'dependencies':
                case 'reverse-dependencies':
                case 'impact':
                case 'frontier':
                    emit(await analyzeDependencies(root, command.sub, [command.id], options), command.print);
                    return;
                case 'cycles':
                case 'findings':
                case 'unused-imports':
                case 'unused-exports':
                case 'isolated':
                case 'unreachable':
                case 'ready-for-ai':
                    emit(await analyzeDependencies(root, command.sub, [], options), command.print);
                    return;
                default:
                    return command;
            }
        case 'check':
            emit(await checkStaleness(root, options), command.print);
            return;
        case 'verification':
            switch (command.sub) {
                case 'list':
                    emit(await listVerifications(root), false);
                    return;
                case 'show':
                    emit(await showVerification(root, command.submissionId), false);
                    return;
                default:
                    return command;
            }
        default:
            return command;
    }
}
