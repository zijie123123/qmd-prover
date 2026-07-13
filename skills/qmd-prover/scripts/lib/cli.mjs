import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { AUX, cleanId, readJson } from './files.mjs';
import { analyzeDependencies, inspectFact, inspectPath, inspectProject, printReport } from './inspector.mjs';
import { renderProject } from './render.mjs';
import { initializeProject } from './project.mjs';
import { checkStaleness } from './staleness.mjs';
import { revokeVerification, showVerification, submitProof } from './verification.mjs';
import { initializeWorkspace, inspectWorkspace } from './workspace.mjs';

const usage = `Usage:
  qmd-prover init-project [--adopt-existing|--append-contract|--sync-contract]
  qmd-prover inspect-project [--print]
  qmd-prover inspect-fact @ID [--print]
  qmd-prover inspect-theorem @ID [--print]
  qmd-prover inspect-path FILE_OR_FOLDER [--print]
  qmd-prover dependency dependencies|reverse-dependencies|impact|frontier @ID [--print]
  qmd-prover dependency path @FROM @TO [--print]
  qmd-prover dependency alternative-paths @FROM @TO [--limit N] [--max-depth N] [--print]
  qmd-prover dependency cycles [--print]
  qmd-prover dependency findings|unused-imports|unused-exports|isolated|unreachable|ready-for-ai [--print]
  qmd-prover dependency reused [--limit N] [--print]
  qmd-prover dependency search QUERY [--kind KIND] [--status STATUS] [--origin ORIGIN] [--path PATH]
      [--used-by @ID|--depends-on @ID|--affected-by @ID|--stale-affected-by @ID]
      [--frontier-of @ID] [--cycle-participant] [--direct] [--print]
  qmd-prover check-staleness [--print]
  qmd-prover workspace init @thm-main-ID
  qmd-prover workspace inspect @thm-main-ID [--print]
  qmd-prover submit-proof PROPOSAL_FILE [--to CANONICAL_QMD]
  qmd-prover verification show SUBMISSION_ID
  qmd-prover verification revoke @thm-ID --reason "..."
  qmd-prover render`;

function output(value) { process.stdout.write(`${JSON.stringify(value, null, 2)}\n`); }

function presentation(args) {
  return { print: args.includes('--print'), args: args.filter((item) => item !== '--print') };
}

function emit(value, print) {
  if (print) process.stdout.write(printReport(value));
  else output(value);
  if (value.ok === false) process.exitCode = 2;
}

function optionValues(args, names, flags = new Set()) {
  const options = {};
  const positionals = [];
  for (let index = 0; index < args.length; index += 1) {
    const name = args[index];
    if (!name.startsWith('--')) { positionals.push(name); continue; }
    const key = name.slice(2);
    if (flags.has(key)) {
      if (options[key.replaceAll('-', '')] === true) throw new Error(`Duplicate option ${name}`);
      options[key.replaceAll('-', '')] = true;
      continue;
    }
    if (!names.has(key) || !args[index + 1] || args[index + 1].startsWith('--')) throw new Error(`Invalid or missing value for ${name}`);
    if (Object.hasOwn(options, key.replaceAll('-', ''))) throw new Error(`Duplicate option ${name}`);
    options[key.replaceAll('-', '')] = args[index + 1];
    index += 1;
  }
  return { positionals, options };
}

async function history(root, id) {
  const directory = path.join(root, AUX, 'verification');
  try {
    const records = [];
    for (const selected of [directory, path.join(directory, 'checks')]) {
      let entries = [];
      try { entries = await readdir(selected); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      for (const name of entries.filter((entry) => entry.endsWith('.json')).sort()) {
        const record = await readJson(path.join(selected, name));
        if (record.target === id && typeof record.verdict === 'string') records.push(record);
      }
    }
    return records.sort((left, right) => `${left.verified_at ?? ''}\0${left.submission_id ?? ''}`.localeCompare(`${right.verified_at ?? ''}\0${right.submission_id ?? ''}`));
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

export async function main(args, { root = process.cwd(), pandoc = process.env.QMD_PROVER_PANDOC } = {}) {
  const [command, ...rest] = args;
  const options = pandoc ? { pandoc } : {};
  if (!command || command === '--help' || command === '-h') { process.stdout.write(`${usage}\n`); return; }
  if (command === 'init-project') {
    const allowed = new Set(['--adopt-existing', '--append-contract', '--sync-contract']);
    if (rest.some((item) => !allowed.has(item)) || new Set(rest).size !== rest.length || rest.length > 1) {
      throw new Error('init-project accepts only one of --adopt-existing, --append-contract, or --sync-contract');
    }
    emit(await initializeProject(root, {
      adoptExisting: rest.includes('--adopt-existing'),
      appendContract: rest.includes('--append-contract'),
      syncContract: rest.includes('--sync-contract')
    }), false);
    return;
  }
  if (command === 'inspect-project') {
    const parsed = presentation(rest);
    if (parsed.args.length) throw new Error('inspect-project accepts only --print');
    emit(await inspectProject(root, options), parsed.print);
    return;
  }
  if (command === 'inspect-theorem' || command === 'inspect-fact') {
    const parsed = presentation(rest);
    if (parsed.args.length !== 1) throw new Error(`${command} requires one semantic ID and optional --print`);
    const result = await inspectFact(root, parsed.args[0], options);
    result.verification_history = await history(root, result.fact.id);
    emit(result, parsed.print);
    return;
  }
  if (command === 'inspect-path') {
    const parsed = presentation(rest);
    if (parsed.args.length !== 1) throw new Error('inspect-path requires one QMD file or folder and optional --print');
    emit(await inspectPath(root, parsed.args[0], options), parsed.print);
    return;
  }
  if (command === 'dependency') {
    const parsed = presentation(rest);
    const [subcommand, ...tail] = parsed.args;
    if (!subcommand) throw new Error('dependency requires an operation');
    if (subcommand === 'search') {
      const extracted = optionValues(
        tail,
        new Set(['kind', 'status', 'origin', 'path', 'related-to', 'frontier-of', 'used-by', 'depends-on', 'affected-by', 'stale-affected-by']),
        new Set(['reverse', 'direct', 'cycle-participant'])
      );
      if (extracted.positionals.length !== 1) throw new Error('dependency search requires one query');
      const queryOptions = {
        ...options,
        kind: extracted.options.kind,
        status: extracted.options.status,
        origin: extracted.options.origin,
        path: extracted.options.path,
        relatedTo: extracted.options.relatedto,
        frontierOf: extracted.options.frontierof,
        usedBy: extracted.options.usedby,
        dependsOn: extracted.options.dependson,
        affectedBy: extracted.options.affectedby,
        staleAffectedBy: extracted.options.staleaffectedby,
        reverse: extracted.options.reverse === true,
        direct: extracted.options.direct === true,
        cycleParticipant: extracted.options.cycleparticipant === true
      };
      emit(await analyzeDependencies(root, subcommand, extracted.positionals, queryOptions), parsed.print);
      return;
    }
    if (subcommand === 'alternative-paths') {
      const extracted = optionValues(tail, new Set(['limit', 'max-depth']));
      if (extracted.positionals.length !== 2) throw new Error('dependency alternative-paths requires two semantic IDs');
      emit(await analyzeDependencies(root, subcommand, extracted.positionals, {
        ...options,
        maxPaths: extracted.options.limit,
        maxDepth: extracted.options.maxdepth
      }), parsed.print);
      return;
    }
    if (subcommand === 'reused') {
      const extracted = optionValues(tail, new Set(['limit']));
      if (extracted.positionals.length) throw new Error('dependency reused accepts only --limit N and --print');
      emit(await analyzeDependencies(root, subcommand, [], { ...options, limit: extracted.options.limit }), parsed.print);
      return;
    }
    const noArgument = new Set(['cycles', 'findings', 'unused-imports', 'unused-exports', 'isolated', 'unreachable', 'ready', 'ready-for-ai']);
    const required = noArgument.has(subcommand) ? 0 : subcommand === 'path' ? 2 : 1;
    if (tail.length !== required) throw new Error(`dependency ${subcommand} requires ${required} semantic ID${required === 1 ? '' : 's'}`);
    emit(await analyzeDependencies(root, subcommand, tail, options), parsed.print);
    return;
  }
  if (command === 'check-staleness') {
    const parsed = presentation(rest);
    if (parsed.args.length) throw new Error('check-staleness accepts only --print');
    emit(await checkStaleness(root, options), parsed.print);
    return;
  }
  if (command === 'submit-proof') {
    const destinationIndex = rest.indexOf('--to');
    const proposal = rest[0];
    const destination = destinationIndex >= 0 ? rest[destinationIndex + 1] : undefined;
    if (!proposal || (rest.length !== 1 && !(rest.length === 3 && destinationIndex === 1 && destination))) throw new Error('submit-proof requires one proposal QMD file and optional --to CANONICAL_QMD');
    output(await submitProof(root, proposal, { ...options, destination }));
    return;
  }
  if (command === 'workspace') {
    const parsed = presentation(rest);
    const [subcommand, value, ...tail] = parsed.args;
    if (!value || tail.length) throw new Error('workspace requires init or inspect and one thm-main-* ID');
    if (subcommand === 'init') { output(await initializeWorkspace(root, value, options)); return; }
    if (subcommand === 'inspect') {
      const result = await inspectWorkspace(root, value, options);
      result.operation = 'workspace-inspect';
      emit(result, parsed.print);
      return;
    }
    throw new Error('Invalid workspace command');
  }
  if (command === 'verification') {
    const [subcommand, value, ...tail] = rest;
    if (subcommand === 'show' && value && tail.length === 0) { output(await showVerification(root, value)); return; }
    if (subcommand === 'revoke' && value) {
      const index = tail.indexOf('--reason');
      const reason = index >= 0 ? tail[index + 1] : '';
      output(await revokeVerification(root, cleanId(value), reason, options));
      return;
    }
    throw new Error('Invalid verification command');
  }
  if (command === 'render') { output(await renderProject(root, options)); return; }
  throw new Error(`Unknown command: ${command}\n${usage}`);
}
