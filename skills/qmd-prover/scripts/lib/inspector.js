import { stat } from 'node:fs/promises';
import path from 'node:path';
import { compileProject } from './compiler.js';
import { AUX, cleanId, readJson, relativePosix } from './files.js';
import { inspectCanonicalScope } from './inspection-verification.js';
import { readLocatedBlock } from './source.js';
import { indexBy } from './collections.js';
import { asRecord } from './guards.js';
const unusableStatuses = new Set([
    'open', 'candidate', 'rejected', 'revoked', 'stale', 'missing',
    'workspace-open', 'workspace-candidate', 'workspace-rejected', 'workspace-revoked', 'workspace-stale'
]);
function byId(items) {
    return indexBy(items, (item) => item.id);
}
function adjacency(graph, reverse = false) {
    const output = new Map(graph.nodes.map((node) => [node.id, []]));
    for (const edge of graph.edges) {
        const from = reverse ? edge.to : edge.from;
        const to = reverse ? edge.from : edge.to;
        if (!output.has(from))
            output.set(from, []);
        output.get(from)?.push(to);
    }
    for (const values of output.values())
        values.sort();
    return output;
}
function traverse(graph, start, reverse = false) {
    const links = adjacency(graph, reverse);
    const seen = new Set();
    const queue = [...(links.get(start) ?? [])];
    while (queue.length) {
        const current = queue.shift();
        if (!current)
            continue;
        if (seen.has(current))
            continue;
        seen.add(current);
        queue.push(...(links.get(current) ?? []));
    }
    return seen;
}
function boundedInteger(value, fallback, { name, min, max }) {
    if (value == null)
        return fallback;
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max)
        throw new Error(`${name} must be an integer from ${min} to ${max}`);
    return parsed;
}
function allSimplePaths(graph, start, goal, options = {}) {
    const maxPaths = boundedInteger(options.maxPaths, 5, { name: 'max paths', min: 1, max: 25 });
    const maxDepth = boundedInteger(options.maxDepth, Math.min(Math.max(graph.nodes.length - 1, 1), 64), { name: 'max depth', min: 1, max: 100 });
    const maxExplored = boundedInteger(options.maxExplored, 10000, { name: 'max explored paths', min: 1, max: 100000 });
    if (start === goal)
        return { paths: [[start]], truncated: false, explored: 1, limits: { max_paths: maxPaths, max_depth: maxDepth, max_explored: maxExplored } };
    const links = adjacency(graph);
    const queue = [[start]];
    const paths = [];
    let explored = 0;
    let generated = 1;
    let generationCapped = false;
    while (queue.length && paths.length < maxPaths && explored < maxExplored) {
        const current = queue.shift();
        if (!current)
            continue;
        explored += 1;
        if (current.length - 1 >= maxDepth)
            continue;
        for (const next of links.get(current[current.length - 1] ?? '') ?? []) {
            if (current.includes(next))
                continue;
            const candidate = [...current, next];
            if (next === goal)
                paths.push(candidate);
            else if (generated < maxExplored) {
                queue.push(candidate);
                generated += 1;
            }
            else
                generationCapped = true;
            if (paths.length >= maxPaths)
                break;
        }
    }
    return {
        paths,
        truncated: paths.length >= maxPaths || generationCapped || queue.length > 0 || (explored >= maxExplored && paths.length < maxPaths),
        explored,
        limits: { max_paths: maxPaths, max_depth: maxDepth, max_explored: maxExplored }
    };
}
function shortestPath(graph, start, goal, reverse = false) {
    if (start === goal)
        return [start];
    const links = adjacency(graph, reverse);
    const queue = [[start]];
    const seen = new Set([start]);
    while (queue.length) {
        const current = queue.shift();
        if (!current)
            continue;
        for (const next of links.get(current[current.length - 1] ?? '') ?? []) {
            if (seen.has(next))
                continue;
            const candidate = [...current, next];
            if (next === goal)
                return candidate;
            seen.add(next);
            queue.push(candidate);
        }
    }
    return null;
}
function subgraph(graph, ids) {
    const selected = new Set(ids);
    return {
        schema_version: graph.schema_version,
        snapshot_id: graph.snapshot_id,
        nodes: graph.nodes.filter((node) => selected.has(node.id)),
        edges: graph.edges.filter((edge) => selected.has(edge.from) && selected.has(edge.to)),
        cycles: (graph.cycles ?? []).filter((cycle) => cycle.every((id) => selected.has(id)))
    };
}
function aiCheck(result, inspected = null) {
    if (inspected)
        return inspected;
    if (result.status === 'verified')
        return { status: 'pass', source: 'verification-record' };
    if (result.status === 'rejected')
        return { status: 'fail', source: 'verification-record' };
    return { status: 'not-run', reason: 'The fact was not eligible for independent verification.' };
}
function factCheck(result, diagnostics, inspected = null) {
    const relevant = diagnostics.filter((item) => item.id ? item.id === result.id : item.file === result.file);
    const referenceFailure = (result.reference_checks ?? []).some((check) => (check.existence === 'fail' || check.scope === 'fail' || check.status === 'fail' || check.cycle === 'fail'));
    const programmatic = referenceFailure || relevant.some((item) => item.severity === 'error') ? 'fail' : 'pass';
    return {
        id: result.id,
        status: result.status,
        programmatic: { status: programmatic, references: result.reference_checks ?? [] },
        ai: aiCheck(result, inspected),
        diagnostics: relevant
    };
}
function resultSummary(results) {
    const kindCounts = new Map();
    const statusCounts = new Map();
    for (const result of results) {
        kindCounts.set(result.kind, (kindCounts.get(result.kind) ?? 0) + 1);
        statusCounts.set(result.status, (statusCounts.get(result.status) ?? 0) + 1);
    }
    const kinds = Object.fromEntries([...kindCounts].sort(([left], [right]) => left.localeCompare(right)));
    const statuses = Object.fromEntries([...statusCounts].sort(([left], [right]) => left.localeCompare(right)));
    return { facts: results.length, kinds, statuses };
}
function findingSelection(options = {}) {
    const ids = options.selectedIds ? new Set([...options.selectedIds].map(cleanId)) : null;
    const files = options.selectedFiles ? new Set(options.selectedFiles) : null;
    return {
        node: (node) => (!ids || ids.has(node.id)) && (!files || !node.file || files.has(node.file)),
        file: (file) => !files || files.has(file),
        result: (result) => (!ids || ids.has(result.id)) && (!files || files.has(result.file))
    };
}
function staleFactIds(snapshot) {
    const ids = new Set();
    for (const result of snapshot.manifest?.results ?? []) {
        if (result.status === 'stale' || (result.stale_reasons?.length ?? 0) > 0)
            ids.add(result.id);
    }
    const evidenceCodes = new Set(['VERIFIED_RECORD_INVALID', 'VERIFIED_MARKER_MISSING', 'VERIFIED_DEPENDENCY_INVALID']);
    for (const item of snapshot.diagnostics ?? [])
        if (item.id && evidenceCodes.has(item.code))
            ids.add(item.id);
    return ids;
}
function importTarget(importer, imported) {
    const target = path.posix.normalize(path.posix.join(path.posix.dirname(importer), imported));
    return target.startsWith('../') || path.posix.isAbsolute(target) ? null : target;
}
export function deriveGraphFindings(snapshot, options = {}) {
    const graph = snapshot.graph;
    const manifest = snapshot.manifest ?? { files: [], results: [] };
    const diagnostics = snapshot.diagnostics ?? [];
    const nodes = byId(graph.nodes);
    const selection = findingSelection(options);
    const outgoing = adjacency(graph);
    const incoming = adjacency(graph, true);
    const usedImports = new Set();
    for (const result of manifest.results ?? []) {
        for (const dependency of result.dependencies ?? [])
            usedImports.add(`${result.file}\0${dependency}`);
    }
    const resultAtFile = new Set((manifest.results ?? []).map((result) => `${result.file}\0${result.id}`));
    const unusedImports = [];
    const importedExports = new Set();
    for (const file of [...(manifest.files ?? [])].sort((left, right) => left.path.localeCompare(right.path))) {
        for (const declaration of file.imports ?? []) {
            const importedFile = importTarget(file.path, declaration.from);
            for (const id of [...(declaration.use ?? [])].sort()) {
                if (id === '*') {
                    for (const result of manifest.results ?? [])
                        if (result.file === importedFile && result.export)
                            importedExports.add(result.id);
                    continue;
                }
                if (importedFile && resultAtFile.has(`${importedFile}\0${id}`))
                    importedExports.add(id);
                if (selection.file(file.path) && importedFile && resultAtFile.has(`${importedFile}\0${id}`) && !usedImports.has(`${file.path}\0${id}`)) {
                    unusedImports.push({ file: file.path, from: declaration.from, imported_file: importedFile, id });
                }
            }
        }
    }
    const unusedExports = (manifest.results ?? []).filter((result) => result.export && !importedExports.has(result.id) && selection.result(result))
        .sort((left, right) => left.id.localeCompare(right.id))
        .map((result) => ({ id: result.id, export: result.export, file: result.file, line: result.line }));
    const mathematicalNodes = graph.nodes.filter((node) => node.origin !== undefined && ['canonical', 'workspace'].includes(node.origin));
    const isolatedFacts = mathematicalNodes.filter((node) => selection.node(node) && (outgoing.get(node.id)?.length ?? 0) === 0 && (incoming.get(node.id)?.length ?? 0) === 0)
        .sort((left, right) => left.id.localeCompare(right.id));
    const goalRoots = new Set();
    if (manifest.target && nodes.has(manifest.target))
        goalRoots.add(manifest.target);
    for (const result of manifest.results ?? []) {
        if (result.origin === 'user' || result.classes?.includes('goal') || result.id.startsWith('thm-main-'))
            goalRoots.add(result.id);
    }
    for (const node of graph.nodes)
        if (node.ownership === 'user' || node.id.startsWith('thm-main-'))
            goalRoots.add(node.id);
    const reachable = new Set(goalRoots);
    for (const root of goalRoots)
        for (const id of traverse(graph, root))
            reachable.add(id);
    const unreachableFacts = goalRoots.size === 0 ? [] : mathematicalNodes.filter((node) => selection.node(node) && !reachable.has(node.id))
        .sort((left, right) => left.id.localeCompare(right.id));
    const errorIds = new Set(diagnostics.filter((item) => item.severity === 'error' && item.id).map((item) => item.id));
    const errorFiles = new Set(diagnostics.filter((item) => item.severity === 'error' && !item.id && item.file).map((item) => item.file));
    const candidateStatuses = new Set(['candidate', 'workspace-candidate']);
    const candidateReadyForAi = mathematicalNodes.filter((node) => {
        if (!selection.node(node) || !candidateStatuses.has(node.status) || errorIds.has(node.id) || (node.file !== undefined && errorFiles.has(node.file)))
            return false;
        return graph.edges.filter((edge) => edge.from === node.id).every((edge) => (edge.checks?.existence === 'pass' && edge.checks.scope === 'pass'
            && edge.checks.status === 'pass' && edge.checks.cycle === 'pass'));
    }).sort((left, right) => left.id.localeCompare(right.id));
    const invalidRoots = staleFactIds({ manifest, diagnostics });
    const invalidEvidenceDependents = mathematicalNodes.filter((node) => selection.node(node) && [...invalidRoots].some((root) => traverse(graph, root, true).has(node.id)))
        .sort((left, right) => left.id.localeCompare(right.id))
        .map((node) => ({
        fact: node,
        invalid_sources: [...invalidRoots].filter((root) => traverse(graph, root, true).has(node.id)).sort()
    }));
    const heavilyReused = mathematicalNodes.filter((node) => selection.node(node)).map((node) => {
        const direct = new Set(incoming.get(node.id) ?? []);
        const transitive = traverse(graph, node.id, true);
        transitive.delete(node.id);
        const verified = [...transitive].filter((id) => nodes.get(id)?.status === 'verified').length;
        return { fact: node, direct_dependents: direct.size, transitive_dependents: transitive.size, verified_dependents: verified };
    }).filter((item) => item.transitive_dependents > 0)
        .sort((left, right) => right.transitive_dependents - left.transitive_dependents
        || right.direct_dependents - left.direct_dependents
        || left.fact.id.localeCompare(right.fact.id));
    return {
        definitions: {
            isolated: 'A canonical or workspace fact with no incoming or outgoing semantic dependency edge.',
            unreachable: 'A canonical or workspace fact outside the dependency closure of every protected main goal (or the selected workspace target).',
            candidate_ready_for_ai: 'A candidate with no fact-level programmatic error and with every direct edge passing existence, scope, status, and cycle checks.',
            heavily_reused: 'A fact ranked by the number of distinct transitive reverse dependencies, then direct reverse dependencies.'
        },
        unused_imports: unusedImports.sort((left, right) => `${left.file}\0${left.id}`.localeCompare(`${right.file}\0${right.id}`)),
        unused_exports: unusedExports,
        isolated_facts: isolatedFacts,
        unreachable: { applicable: goalRoots.size > 0, roots: [...goalRoots].sort(), facts: unreachableFacts },
        invalid_evidence_dependents: invalidEvidenceDependents,
        candidate_ready_for_ai: candidateReadyForAi,
        heavily_reused: heavilyReused
    };
}
function blockerPaths(graph, roots) {
    const output = [];
    const seen = new Set();
    for (const root of [...new Set(roots)].sort()) {
        if (!graph.nodes.some((node) => node.id === root))
            continue;
        for (const item of frontier(graph, root)) {
            const key = `${root}\0${item.fact.id}`;
            if (seen.has(key))
                continue;
            seen.add(key);
            output.push({ root, blocker: item.fact, path: item.path });
        }
    }
    return output;
}
export async function inspectProject(root = process.cwd(), options = {}) {
    const inspected = await inspectCanonicalScope(root, (compilation) => compilation.manifest.results, options);
    const { compilation } = inspected;
    const diagnostics = [...compilation.diagnostics, ...inspected.diagnostics];
    const facts = compilation.manifest.results.map((result) => factCheck(result, diagnostics, inspected.aiChecks.get(result.id)));
    const goals = compilation.manifest.results.filter((result) => result.origin === 'user' || result.classes?.includes('goal')).map((result) => result.id);
    return {
        schema_version: 2,
        operation: 'inspect-project',
        ok: compilation.complete && facts.every((fact) => fact.programmatic.status === 'pass' && fact.ai.status === 'pass'),
        snapshot_id: compilation.graph.snapshot_id,
        snapshot_published: compilation.complete && options.write !== false,
        scope: { type: 'project', path: '.' },
        summary: { ...compilation.summary, ...resultSummary(compilation.manifest.results), errors: diagnostics.filter((item) => item.severity === 'error').length },
        facts,
        graph: compilation.graph,
        staleness: inspected.staleness,
        verification: inspected.verification,
        blockers: blockerPaths(compilation.graph, goals.length ? goals : compilation.manifest.results.map((result) => result.id)),
        findings: deriveGraphFindings(compilation),
        diagnostics
    };
}
export async function inspectFact(root, requested, options = {}) {
    const id = cleanId(requested);
    const inspected = await inspectCanonicalScope(root, (compilation) => compilation.manifest.results.filter((result) => result.id === id), options);
    const { compilation } = inspected;
    const matches = compilation.manifest.results.filter((result) => result.id === id);
    if (matches.length === 0)
        throw new Error(`Unknown fact: @${id}`);
    if (matches.length > 1)
        throw new Error(`Ambiguous fact: @${id} is defined ${matches.length} times`);
    const target = matches[0];
    const dependencyIds = traverse(compilation.graph, id);
    const graphNodes = byId(compilation.graph.nodes);
    const directDependencies = adjacency(compilation.graph).get(id) ?? [];
    const reverse = adjacency(compilation.graph, true).get(id) ?? [];
    const selected = new Set([id, ...dependencyIds, ...reverse]);
    const located = await readLocatedBlock(path.join(path.resolve(root), target.file), id);
    const diagnostics = [
        ...compilation.diagnostics.filter((item) => item.id === id || item.file === target.file),
        ...inspected.diagnostics
    ];
    const check = factCheck(target, diagnostics, inspected.aiChecks.get(id));
    return {
        schema_version: 2,
        operation: 'inspect-fact',
        ok: check.programmatic.status === 'pass' && check.ai.status === 'pass',
        snapshot_id: compilation.graph.snapshot_id,
        scope: { type: 'fact', id },
        fact: target,
        check,
        source: { statement: located?.statement?.text ?? '', proof: located?.proof?.text ?? '' },
        graph: subgraph(compilation.graph, selected),
        direct_dependencies: directDependencies.map((dependency) => graphNodes.get(dependency)),
        transitive_dependencies: [...dependencyIds].sort().map((dependency) => graphNodes.get(dependency)),
        direct_reverse_dependencies: reverse,
        blockers: blockerPaths(compilation.graph, [id]),
        staleness: inspected.staleness,
        verification: inspected.verification,
        diagnostics
    };
}
function isWithinPath(file, selected, isDirectory) {
    return isDirectory ? file === selected || file.startsWith(`${selected}/`) : file === selected;
}
export async function inspectPath(root, requestedPath, options = {}) {
    root = path.resolve(root);
    const absolute = path.resolve(root, requestedPath);
    const relative = relativePosix(root, absolute);
    if (relative === '..' || relative.startsWith('../') || path.isAbsolute(relative))
        throw new Error('Inspection path must stay inside the project');
    const info = await stat(absolute);
    if (!info.isDirectory() && !(info.isFile() && absolute.endsWith('.qmd')))
        throw new Error('Inspection path must be a QMD file or directory');
    const select = (compilation) => compilation.manifest.results.filter((result) => isWithinPath(result.file, relative, info.isDirectory()));
    const inspected = await inspectCanonicalScope(root, select, options);
    const { compilation } = inspected;
    const selectedFiles = new Set(compilation.manifest.files.filter((file) => isWithinPath(file.path, relative, info.isDirectory())).map((file) => file.path));
    const selectedResults = compilation.manifest.results.filter((result) => selectedFiles.has(result.file));
    const selectedIds = new Set(selectedResults.map((result) => result.id));
    const contextIds = new Set(selectedIds);
    for (const id of selectedIds)
        for (const dependency of traverse(compilation.graph, id))
            contextIds.add(dependency);
    const diagnostics = [
        ...compilation.diagnostics.filter((item) => (item.id !== undefined && selectedIds.has(item.id)) || (item.file !== undefined && isWithinPath(item.file, relative, info.isDirectory()))),
        ...inspected.diagnostics
    ];
    const graph = subgraph(compilation.graph, contextIds);
    graph.nodes = graph.nodes.map((node) => ({ ...node, scope: selectedIds.has(node.id) ? 'selected' : 'external' }));
    const facts = selectedResults.map((result) => factCheck(result, diagnostics, inspected.aiChecks.get(result.id)));
    return {
        schema_version: 2,
        operation: 'inspect-path',
        ok: facts.every((fact) => fact.programmatic.status === 'pass' && fact.ai.status === 'pass') && diagnostics.every((item) => item.severity !== 'error'),
        snapshot_id: compilation.graph.snapshot_id,
        scope: { type: info.isDirectory() ? 'folder' : 'file', path: relative },
        summary: { files: selectedFiles.size, ...resultSummary(selectedResults), errors: diagnostics.filter((item) => item.severity === 'error').length },
        facts,
        graph,
        blockers: blockerPaths(compilation.graph, selectedResults.map((result) => result.id)),
        findings: deriveGraphFindings(compilation, { selectedIds, selectedFiles }),
        staleness: inspected.staleness,
        verification: inspected.verification,
        diagnostics
    };
}
async function latestSnapshot(root, options = {}) {
    root = path.resolve(root);
    let pointer = await readJson(path.join(root, AUX, 'graphs', 'latest.json'), null);
    if (!pointer) {
        const compilation = await compileProject(root, options);
        if (!compilation.complete)
            throw new Error('No complete dependency snapshot is available; repair parse failures and inspect again');
        pointer = await readJson(path.join(root, AUX, 'graphs', 'latest.json'));
    }
    if (!pointer)
        throw new Error('The latest dependency snapshot pointer is missing');
    const graphsRoot = path.join(root, AUX, 'graphs');
    const snapshotFile = typeof pointer.file === 'string' ? path.resolve(root, pointer.file) : '';
    if (!snapshotFile.startsWith(`${graphsRoot}${path.sep}`))
        throw new Error('The latest dependency snapshot pointer is corrupt');
    const snapshot = await readJson(snapshotFile);
    if (snapshot.snapshot_id !== pointer.snapshot_id || snapshot.graph.snapshot_id !== pointer.snapshot_id)
        throw new Error('The latest dependency snapshot pointer is corrupt');
    return snapshot;
}
function requireNode(graph, requested) {
    const id = cleanId(requested);
    const node = graph.nodes.find((item) => item.id === id);
    if (!node)
        throw new Error(`Unknown fact in dependency snapshot: @${id}`);
    return node;
}
function frontier(graph, requested) {
    const target = requireNode(graph, requested);
    const closure = new Set([target.id, ...traverse(graph, target.id)]);
    const nodes = byId(graph.nodes);
    const unresolved = [...closure].filter((id) => unusableStatuses.has(nodes.get(id)?.status ?? 'missing'));
    const cycleSets = (graph.cycles ?? []).map((cycle) => new Set(cycle.slice(0, -1)));
    const sameCycle = (left, right) => cycleSets.some((cycle) => cycle.has(left) && cycle.has(right));
    const lowest = unresolved.filter((id) => ![...traverse(graph, id)].some((dependency) => dependency !== id && unresolved.includes(dependency) && !sameCycle(id, dependency)));
    return lowest.sort().map((id) => ({ fact: nodes.get(id) ?? { id, status: 'missing' }, path: shortestPath(graph, target.id, id) }));
}
export async function analyzeDependencies(root, operation, args = [], options = {}) {
    const snapshot = await latestSnapshot(root, options);
    const { graph } = snapshot;
    const requested = args[0];
    let result;
    if (operation === 'dependencies' || operation === 'reverse-dependencies') {
        const node = requireNode(graph, requested);
        const reverse = operation === 'reverse-dependencies';
        const directIds = adjacency(graph, reverse).get(node.id) ?? [];
        const transitiveIds = [...traverse(graph, node.id, reverse)].sort();
        const nodes = byId(graph.nodes);
        result = {
            target: node,
            direct: directIds.map((id) => nodes.get(id)).filter((item) => item !== undefined),
            transitive: transitiveIds.map((id) => nodes.get(id)).filter((item) => item !== undefined)
        };
    }
    else if (operation === 'path') {
        requireNode(graph, requested);
        requireNode(graph, args[1]);
        result = { from: cleanId(requested), to: cleanId(args[1]), path: shortestPath(graph, cleanId(requested), cleanId(args[1])) };
    }
    else if (operation === 'alternative-paths') {
        requireNode(graph, requested);
        requireNode(graph, args[1]);
        const from = cleanId(requested);
        const to = cleanId(args[1]);
        const paths = allSimplePaths(graph, from, to, options);
        result = { from, to, ...paths, alternatives: paths.paths.slice(1) };
    }
    else if (operation === 'cycles') {
        result = { cycles: graph.cycles ?? [] };
    }
    else if (operation === 'impact') {
        const node = requireNode(graph, requested);
        const nodes = byId(graph.nodes);
        result = {
            target: node,
            affected: [...traverse(graph, node.id, true)].sort().map((id) => nodes.get(id)).filter((item) => item?.status === 'verified')
        };
    }
    else if (operation === 'frontier') {
        result = { target: requireNode(graph, requested), frontier: frontier(graph, requested) };
    }
    else if (['findings', 'unused-imports', 'unused-exports', 'isolated', 'unreachable', 'ready', 'ready-for-ai', 'reused'].includes(operation)) {
        const findings = deriveGraphFindings(snapshot);
        if (operation === 'findings')
            result = { findings };
        else if (operation === 'unused-imports')
            result = { unused_imports: findings.unused_imports };
        else if (operation === 'unused-exports')
            result = { unused_exports: findings.unused_exports };
        else if (operation === 'isolated')
            result = { definition: findings.definitions.isolated, facts: findings.isolated_facts };
        else if (operation === 'unreachable')
            result = { definition: findings.definitions.unreachable, ...findings.unreachable };
        else if (operation === 'ready' || operation === 'ready-for-ai')
            result = { definition: findings.definitions.candidate_ready_for_ai, candidates: findings.candidate_ready_for_ai };
        else {
            const limit = boundedInteger(options.limit, 20, { name: 'limit', min: 1, max: 1000 });
            result = { definition: findings.definitions.heavily_reused, facts: findings.heavily_reused.slice(0, limit), total: findings.heavily_reused.length, limit };
        }
    }
    else if (operation === 'search') {
        const query = String(requested ?? '').toLowerCase();
        const manifestById = byId(snapshot.manifest.results);
        const staleIds = staleFactIds(snapshot);
        let matches = graph.nodes.filter((node) => {
            const fact = manifestById.get(node.id);
            const haystack = [node.id, node.title, node.file, fact?.statement_text, fact?.proof_text].filter(Boolean).join('\n').toLowerCase();
            return haystack.includes(query)
                && (!options.kind || node.kind === options.kind)
                && (!options.status || node.status === options.status)
                && (!options.origin || node.origin === options.origin)
                && (!options.path || node.file === options.path || node.file?.startsWith(`${options.path}/`));
        });
        const relatedIds = (selected, reverse = false) => {
            const target = requireNode(graph, selected);
            return options.direct === true
                ? new Set(adjacency(graph, reverse).get(target.id) ?? [])
                : traverse(graph, target.id, reverse);
        };
        if (options.relatedTo) {
            const related = relatedIds(options.relatedTo, options.reverse === true);
            matches = matches.filter((node) => related.has(node.id));
        }
        if (options.usedBy) {
            const related = relatedIds(options.usedBy);
            matches = matches.filter((node) => related.has(node.id));
        }
        if (options.dependsOn) {
            const related = relatedIds(options.dependsOn, true);
            matches = matches.filter((node) => related.has(node.id));
        }
        if (options.affectedBy) {
            const related = relatedIds(options.affectedBy, true);
            matches = matches.filter((node) => related.has(node.id));
        }
        if (options.staleAffectedBy) {
            const related = relatedIds(options.staleAffectedBy, true);
            matches = matches.filter((node) => related.has(node.id) && staleIds.has(node.id));
        }
        if (options.frontierOf) {
            const ids = new Set(frontier(graph, options.frontierOf).map((item) => item.fact.id));
            matches = matches.filter((node) => ids.has(node.id));
        }
        if (options.cycleParticipant === true) {
            const ids = new Set((graph.cycles ?? []).flatMap((cycle) => cycle.slice(0, -1)));
            matches = matches.filter((node) => ids.has(node.id));
        }
        result = {
            query: requested ?? '',
            filters: {
                ...(options.kind ? { kind: options.kind } : {}),
                ...(options.status ? { status: options.status } : {}),
                ...(options.origin ? { origin: options.origin } : {}),
                ...(options.path ? { path: options.path } : {}),
                ...(options.relatedTo ? { related_to: cleanId(options.relatedTo), reverse: options.reverse === true } : {}),
                ...(options.usedBy ? { used_by: cleanId(options.usedBy) } : {}),
                ...(options.dependsOn ? { depends_on: cleanId(options.dependsOn) } : {}),
                ...(options.affectedBy ? { affected_by: cleanId(options.affectedBy) } : {}),
                ...(options.staleAffectedBy ? { stale_affected_by: cleanId(options.staleAffectedBy) } : {}),
                ...(options.frontierOf ? { frontier_of: cleanId(options.frontierOf) } : {}),
                ...(options.direct === true ? { direct: true } : {}),
                ...(options.cycleParticipant === true ? { cycle_participant: true } : {})
            },
            matches: matches.sort((left, right) => left.id.localeCompare(right.id))
        };
    }
    else {
        throw new Error(`Unknown dependency operation: ${operation}`);
    }
    return { schema_version: 2, operation: `dependency-${operation}`, snapshot_id: snapshot.snapshot_id, ...result };
}
function formatPath(ids) {
    return ids?.map((id) => `@${id}`).join(' -> ') ?? 'none';
}
function formatCounts(counts = {}) {
    const entries = Object.entries(counts).sort(([left], [right]) => left.localeCompare(right));
    return entries.map(([name, count]) => `${name}=${count}`).join(', ') || 'none';
}
function inspectedNodes(result) {
    if (!result.graph?.nodes)
        return [];
    const nodes = byId(result.graph.nodes);
    let ids = [];
    if (result.fact)
        ids = [result.fact.id];
    else if (result.facts?.some((item) => item.programmatic))
        ids = result.facts.map((item) => item.id);
    else if (result.manifest?.results)
        ids = result.manifest.results.map((item) => item.id);
    else
        ids = result.graph.nodes.filter((node) => node.scope !== 'external' && node.origin !== 'unresolved').map((node) => node.id);
    return [...new Set(ids)].map((id) => nodes.get(id))
        .filter((node) => node !== undefined)
        .sort((left, right) => left.id.localeCompare(right.id));
}
function reportFindings(lines, findings) {
    if (!findings)
        return;
    lines.push('graph findings:');
    if (findings.unused_imports !== undefined) {
        lines.push(`  unused imports: ${findings.unused_imports.length}`);
        for (const item of findings.unused_imports)
            lines.push(`    ${item.file}: @${item.id} from ${item.from}`);
    }
    if (findings.unused_exports !== undefined) {
        lines.push(`  unused exports: ${findings.unused_exports.length}`);
        for (const item of findings.unused_exports)
            lines.push(`    @${item.id} (${item.export}) ${item.file}:${item.line ?? '?'}`);
    }
    if (findings.isolated_facts !== undefined) {
        lines.push(`  isolated facts: ${findings.isolated_facts.length}`);
        for (const item of findings.isolated_facts)
            lines.push(`    @${item.id} [${item.status}] ${item.file ?? ''}`.trimEnd());
    }
    if (findings.unreachable !== undefined) {
        const unreachable = findings.unreachable;
        lines.push(`  unreachable facts: ${unreachable.applicable === false ? 'not applicable (no goal root)' : unreachable.facts.length}`);
        for (const item of unreachable.facts)
            lines.push(`    @${item.id} [${item.status}] ${item.file ?? ''}`.trimEnd());
    }
    if (findings.candidate_ready_for_ai !== undefined) {
        lines.push(`  candidates ready for AI: ${findings.candidate_ready_for_ai.length}`);
        for (const item of findings.candidate_ready_for_ai)
            lines.push(`    @${item.id} [${item.kind}] ${item.file ?? ''}`.trimEnd());
    }
    if (findings.invalid_evidence_dependents !== undefined) {
        lines.push(`  invalid-evidence dependents: ${findings.invalid_evidence_dependents.length}`);
        for (const item of findings.invalid_evidence_dependents)
            lines.push(`    @${item.fact.id} via ${item.invalid_sources.map((id) => `@${id}`).join(', ')}`);
    }
    if (findings.heavily_reused !== undefined) {
        lines.push(`  heavily reused facts: ${findings.heavily_reused.length}`);
        for (const item of findings.heavily_reused.slice(0, 20)) {
            lines.push(`    @${item.fact.id}: direct=${item.direct_dependents}, transitive=${item.transitive_dependents}, verified=${item.verified_dependents}`);
        }
    }
}
export function printReport(input) {
    const result = input;
    const lines = [`qmd-prover ${result.operation}`, `snapshot: ${result.snapshot_id ?? 'none'}`];
    if (typeof result.ok === 'boolean')
        lines.push(`status: ${result.ok ? 'ok' : 'failed'}`);
    if (result.scope)
        lines.push(`scope: ${result.scope.type} ${result.scope.id ? `@${result.scope.id}` : result.scope.path}`);
    if (result.workspace)
        lines.push(`workspace: ${result.workspace}`);
    if (result.target?.id)
        lines.push(`target: @${result.target.id} [${result.target.status ?? 'missing'}]`);
    if (result.workspace_staleness)
        lines.push(`workspace snapshot: ${result.workspace_staleness.stale ? 'stale' : 'current'} (target=${result.workspace_staleness.target_stale ? 'stale' : 'current'}, dependencies=${result.workspace_staleness.dependency_stale ? 'stale' : 'current'})`);
    if (result.summary) {
        lines.push(`files: ${result.summary.files ?? 0}`);
        lines.push(`facts: ${result.summary.facts ?? result.summary.results ?? 0}`);
        lines.push(`kinds: ${formatCounts(result.summary.kinds)}`);
        lines.push(`statuses: ${formatCounts(result.summary.statuses)}`);
        lines.push(`errors: ${result.summary.errors ?? result.diagnostics?.filter((item) => item.severity === 'error').length ?? 0}`);
    }
    if (result.verification) {
        lines.push(`verification: calls=${result.verification.verifier_calls ?? 0}, cache-hits=${result.verification.cache_hits ?? 0}, passed=${result.verification.passed ?? 0}, rejected=${result.verification.rejected ?? 0}, errors=${result.verification.errors ?? 0}, not-run=${result.verification.not_run ?? 0}`);
    }
    if (result.staleness) {
        lines.push(`staleness: ${result.staleness.ok ? 'checked' : 'failed'}, changed=${result.staleness.changed?.length ?? 0}, invalidated=${result.staleness.invalidated?.length ?? 0}`);
        for (const item of result.staleness.changed ?? []) {
            lines.push(`  changed @${item.id}: ${item.reasons.join(', ')}`);
            if (item.previous !== undefined)
                lines.push(`    previous: ${JSON.stringify(item.previous)}`);
            if (item.current !== undefined)
                lines.push(`    current: ${JSON.stringify(item.current)}`);
        }
        for (const item of result.staleness.invalidated ?? [])
            lines.push(`  invalidated @${item.id}: ${formatPath(item.path)}`);
    }
    if (result.fact)
        lines.push(`fact: @${result.fact.id} [${result.fact.kind}, ${result.fact.status}] ${result.fact.file}:${result.fact.line ?? '?'}`);
    const nodes = inspectedNodes(result);
    if (nodes.length) {
        if (!result.summary) {
            const kinds = {};
            const statuses = {};
            for (const node of nodes) {
                const kind = node.kind ?? 'unknown';
                kinds[kind] = (kinds[kind] ?? 0) + 1;
                statuses[node.status] = (statuses[node.status] ?? 0) + 1;
            }
            lines.push(`facts: ${nodes.length}`, `kinds: ${formatCounts(kinds)}`, `statuses: ${formatCounts(statuses)}`);
        }
        const byFile = new Map();
        for (const node of nodes) {
            if (!byFile.has(node.file ?? '(unknown)'))
                byFile.set(node.file ?? '(unknown)', []);
            byFile.get(node.file ?? '(unknown)')?.push(node);
        }
        lines.push('facts by file:');
        for (const [file, facts] of [...byFile].sort(([left], [right]) => left.localeCompare(right))) {
            lines.push(`  ${file}: ${facts.map((item) => `@${item.id} [${item.kind}, ${item.status}]`).join(', ')}`);
        }
    }
    if (result.manifest?.canonical_results?.length) {
        lines.push('canonical facts used by workspace:');
        for (const item of [...result.manifest.canonical_results].sort((left, right) => left.id.localeCompare(right.id))) {
            lines.push(`  @${item.id} [${item.kind}, ${item.status}] ${item.file}:${item.line ?? '?'}`);
        }
    }
    const checks = result.check ? [result.check] : (result.facts ?? []).filter((item) => item.programmatic !== undefined && item.ai !== undefined);
    if (checks.length) {
        lines.push('checks:');
        for (const check of [...checks].sort((left, right) => left.id.localeCompare(right.id))) {
            lines.push(`  @${check.id}: programmatic=${check.programmatic.status}, ai=${check.ai.status}${check.ai.source ? ` (${check.ai.source})` : ''}`);
            for (const reference of check.programmatic.references ?? []) {
                lines.push(`    -> @${reference.dependency}: existence=${reference.existence}, scope=${reference.scope}, status=${reference.status}, cycle=${reference.cycle}, ai=${reference.ai_sufficiency}`);
            }
            if (check.ai.reason)
                lines.push(`    AI: ${check.ai.reason}`);
            if (check.ai.error)
                lines.push(`    AI error${check.ai.code ? ` (${check.ai.code})` : ''}: ${check.ai.error}`);
            if (check.ai.details?.command)
                lines.push(`    verifier command: ${check.ai.details.command}`);
            if (check.ai.details?.exit_code !== undefined || check.ai.details?.signal)
                lines.push(`    verifier termination: exit=${check.ai.details.exit_code ?? 'none'}, signal=${check.ai.details.signal ?? 'none'}`);
            if (check.ai.details?.stderr_excerpt)
                lines.push(`    verifier stderr: ${check.ai.details.stderr_excerpt}`);
            if (check.ai.details?.stdout_excerpt)
                lines.push(`    verifier stdout: ${check.ai.details.stdout_excerpt}`);
            if (check.ai.remediation)
                lines.push(`    remediation: ${check.ai.remediation}`);
            if (check.ai.report) {
                if (check.ai.report.summary)
                    lines.push(`    summary: ${check.ai.report.summary}`);
                for (const error of check.ai.report.critical_errors ?? [])
                    lines.push(`    critical error: ${error}`);
                for (const gap of check.ai.report.gaps ?? [])
                    lines.push(`    gap: ${gap}`);
                for (const comment of check.ai.report.nonblocking_comments ?? [])
                    lines.push(`    comment: ${comment}`);
                if (check.ai.report.repair_hints)
                    lines.push(`    repair hints: ${check.ai.report.repair_hints}`);
            }
        }
    }
    if (result.direct_dependencies)
        lines.push(`direct dependencies: ${result.direct_dependencies.map((item) => `@${item.id}`).join(', ') || 'none'}`);
    if (result.transitive_dependencies)
        lines.push(`transitive dependencies: ${result.transitive_dependencies.map((item) => `@${item.id}`).join(', ') || 'none'}`);
    if (result.direct_reverse_dependencies)
        lines.push(`direct reverse dependencies: ${result.direct_reverse_dependencies.map((id) => `@${id}`).join(', ') || 'none'}`);
    const blockers = result.blockers ?? (result.graph && result.manifest?.target ? blockerPaths(result.graph, [result.manifest.target]) : []);
    if (blockers.length) {
        lines.push('blocking dependency paths:');
        for (const item of blockers)
            lines.push(`  @${item.root}: @${item.blocker.id} [${item.blocker.status}] via ${formatPath(item.path)}`);
    }
    if (result.frontier) {
        lines.push('frontier:');
        for (const item of result.frontier)
            lines.push(`  @${item.fact.id} [${item.fact.status}] via ${formatPath(item.path)}`);
    }
    if (result.changed?.length) {
        lines.push('stale identities:');
        for (const item of result.changed) {
            lines.push(`  @${item.id}: ${item.reasons.join(', ')}`);
            if (item.previous !== undefined)
                lines.push(`    previous: ${JSON.stringify(item.previous)}`);
            if (item.current !== undefined)
                lines.push(`    current: ${JSON.stringify(item.current)}`);
        }
        for (const item of result.invalidated ?? [])
            if (!result.changed.some((changed) => changed.id === item.id))
                lines.push(`  @${item.id}: via ${formatPath(item.path)}`);
        lines.push(`invalidated facts (stale history retained when present): ${(result.invalidated ?? []).map((item) => `@${item.id}`).join(', ') || 'none'}`);
    }
    else if (result.changed)
        lines.push('stale identities: none');
    if (result.direct)
        lines.push(`direct: ${result.direct.map((item) => `@${item.id}`).join(', ') || 'none'}`);
    if (result.transitive)
        lines.push(`transitive: ${result.transitive.map((item) => `@${item.id}`).join(', ') || 'none'}`);
    if (Object.hasOwn(result, 'path'))
        lines.push(`path: ${formatPath(result.path)}`);
    if (result.paths) {
        lines.push(`paths (${result.paths.length}${result.truncated ? ', truncated' : ''}):`);
        for (const [index, item] of result.paths.entries())
            lines.push(`  ${index + 1}. ${formatPath(item)}`);
    }
    if (result.cycles) {
        lines.push('cycles:');
        if (result.cycles.length === 0)
            lines.push('  none');
        for (const cycle of result.cycles)
            lines.push(`  ${formatPath(cycle)}`);
    }
    if (result.affected)
        lines.push(`affected verified facts: ${result.affected.map((item) => `@${item.id}`).join(', ') || 'none'}`);
    if (result.matches) {
        lines.push(`matches: ${result.matches.length}`);
        for (const item of result.matches)
            lines.push(`  @${item.id} [${item.kind}, ${item.status}] ${item.file ?? ''}:${item.line ?? '?'}`);
    }
    const reportDerivedFindings = result.findings ?? (result.operation === 'workspace-inspect' && result.graph && result.manifest
        ? deriveGraphFindings({ graph: result.graph, manifest: result.manifest, diagnostics: result.diagnostics ?? [] })
        : null);
    reportFindings(lines, reportDerivedFindings);
    if (result.unused_imports)
        reportFindings(lines, { unused_imports: result.unused_imports });
    if (result.unused_exports)
        reportFindings(lines, { unused_exports: result.unused_exports });
    if (result.candidates) {
        lines.push('candidates ready for AI:');
        for (const item of result.candidates)
            lines.push(`  @${item.id} [${item.kind}, ${item.status}] ${item.file ?? ''}`.trimEnd());
    }
    if (result.operation === 'dependency-isolated' || result.operation === 'dependency-unreachable') {
        lines.push(`${result.operation.slice('dependency-'.length)} facts:`);
        for (const item of result.facts ?? [])
            lines.push(`  @${item.id} [${item.kind}, ${item.status}] ${item.file ?? ''}`.trimEnd());
    }
    if (result.operation === 'dependency-reused') {
        lines.push(`heavily reused facts (${result.total} total):`);
        for (const item of result.facts ?? [])
            if (item.fact)
                lines.push(`  @${item.fact.id}: direct=${item.direct_dependents}, transitive=${item.transitive_dependents}, verified=${item.verified_dependents}`);
    }
    if (result.graph?.edges?.length) {
        const graphNodes = byId(result.graph.nodes);
        lines.push('dependencies:');
        for (const edge of result.graph.edges) {
            const checks = edge.checks;
            lines.push(`  @${edge.from} -> @${edge.to} [existence=${checks?.existence}, scope=${checks?.scope}, status=${checks?.status}, cycle=${checks?.cycle}, ai=${checks?.ai_sufficiency}]`);
        }
        const crossFile = result.graph.edges.filter((edge) => {
            const from = graphNodes.get(edge.from)?.file;
            const to = graphNodes.get(edge.to)?.file;
            return from && to && from !== to;
        });
        if (crossFile.length) {
            lines.push('cross-file dependencies:');
            for (const edge of crossFile)
                lines.push(`  ${graphNodes.get(edge.from)?.file} @${edge.from} -> ${graphNodes.get(edge.to)?.file} @${edge.to}`);
        }
    }
    if (result.diagnostics?.length) {
        lines.push('diagnostics:');
        for (const item of result.diagnostics)
            lines.push(`  ${item.severity} ${item.code}${item.id ? ` @${item.id}` : ''}: ${item.message}`);
    }
    return `${lines.join('\n')}\n`;
}
