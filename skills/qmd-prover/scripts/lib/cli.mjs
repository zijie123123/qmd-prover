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
  qmd-prover help [COMMAND...]
  qmd-prover init [--adopt-existing|--append-contract|--sync-contract]
  qmd-prover inspect project [--print]
  qmd-prover inspect fact @ID [--print]
  qmd-prover inspect theorem @ID [--print]
  qmd-prover inspect path FILE_OR_FOLDER [--print]
  qmd-prover dependency dependencies|impact|frontier @ID [--print]
  qmd-prover dependency reverse dependencies @ID [--print]
  qmd-prover dependency path @FROM @TO [--print]
  qmd-prover dependency alternative paths @FROM @TO [--limit N] [--max-depth N] [--print]
  qmd-prover dependency cycles [--print]
  qmd-prover dependency findings|isolated|unreachable [--print]
  qmd-prover dependency unused imports|exports [--print]
  qmd-prover dependency ready for ai [--print]
  qmd-prover dependency reused [--limit N] [--print]
  qmd-prover dependency search QUERY [--kind KIND] [--status STATUS] [--origin ORIGIN] [--path PATH]
      [--used-by @ID|--depends-on @ID|--affected-by @ID|--stale-affected-by @ID]
      [--frontier-of @ID] [--cycle-participant] [--direct] [--print]
  qmd-prover check staleness [--print]
  qmd-prover workspace init @thm-main-ID
  qmd-prover workspace inspect @thm-main-ID [--print]
  qmd-prover submit proof PROPOSAL_FILE [--to CANONICAL_QMD]
  qmd-prover verification show SUBMISSION_ID
  qmd-prover verification revoke @thm-ID --reason "..."
  qmd-prover render`;

const help = new Map([
  ['', usage],
  ['init', `Usage:\n  qmd-prover init [--adopt-existing|--append-contract|--sync-contract]`],
  ['inspect', `Usage:\n  qmd-prover inspect project [--print]\n  qmd-prover inspect fact @ID [--print]\n  qmd-prover inspect theorem @ID [--print]\n  qmd-prover inspect path FILE_OR_FOLDER [--print]`],
  ['inspect project', `Usage:\n  qmd-prover inspect project [--print]`],
  ['inspect fact', `Usage:\n  qmd-prover inspect fact @ID [--print]`],
  ['inspect theorem', `Usage:\n  qmd-prover inspect theorem @ID [--print]`],
  ['inspect path', `Usage:\n  qmd-prover inspect path FILE_OR_FOLDER [--print]`],
  ['dependency', usage.split('\n').filter((line) => line.includes('qmd-prover dependency')).reduce((text, line) => `${text}\n${line}`, 'Usage:')],
  ['dependency dependencies', `Usage:\n  qmd-prover dependency dependencies @ID [--print]`],
  ['dependency reverse', `Usage:\n  qmd-prover dependency reverse dependencies @ID [--print]`],
  ['dependency reverse dependencies', `Usage:\n  qmd-prover dependency reverse dependencies @ID [--print]`],
  ['dependency impact', `Usage:\n  qmd-prover dependency impact @ID [--print]`],
  ['dependency frontier', `Usage:\n  qmd-prover dependency frontier @ID [--print]`],
  ['dependency path', `Usage:\n  qmd-prover dependency path @FROM @TO [--print]`],
  ['dependency alternative', `Usage:\n  qmd-prover dependency alternative paths @FROM @TO [--limit N] [--max-depth N] [--print]`],
  ['dependency alternative paths', `Usage:\n  qmd-prover dependency alternative paths @FROM @TO [--limit N] [--max-depth N] [--print]`],
  ['dependency cycles', `Usage:\n  qmd-prover dependency cycles [--print]`],
  ['dependency findings', `Usage:\n  qmd-prover dependency findings [--print]`],
  ['dependency unused', `Usage:\n  qmd-prover dependency unused imports [--print]\n  qmd-prover dependency unused exports [--print]`],
  ['dependency unused imports', `Usage:\n  qmd-prover dependency unused imports [--print]`],
  ['dependency unused exports', `Usage:\n  qmd-prover dependency unused exports [--print]`],
  ['dependency isolated', `Usage:\n  qmd-prover dependency isolated [--print]`],
  ['dependency unreachable', `Usage:\n  qmd-prover dependency unreachable [--print]`],
  ['dependency ready', `Usage:\n  qmd-prover dependency ready for ai [--print]`],
  ['dependency ready for', `Usage:\n  qmd-prover dependency ready for ai [--print]`],
  ['dependency ready for ai', `Usage:\n  qmd-prover dependency ready for ai [--print]`],
  ['dependency reused', `Usage:\n  qmd-prover dependency reused [--limit N] [--print]`],
  ['dependency search', usage.slice(usage.indexOf('  qmd-prover dependency search'), usage.indexOf('  qmd-prover check staleness')).trimEnd().replace(/^/, 'Usage:\n')],
  ['check', `Usage:\n  qmd-prover check staleness [--print]`],
  ['check staleness', `Usage:\n  qmd-prover check staleness [--print]`],
  ['workspace', `Usage:\n  qmd-prover workspace init @thm-main-ID\n  qmd-prover workspace inspect @thm-main-ID [--print]`],
  ['workspace init', `Usage:\n  qmd-prover workspace init @thm-main-ID`],
  ['workspace inspect', `Usage:\n  qmd-prover workspace inspect @thm-main-ID [--print]`],
  ['submit', `Usage:\n  qmd-prover submit proof PROPOSAL_FILE [--to CANONICAL_QMD]`],
  ['submit proof', `Usage:\n  qmd-prover submit proof PROPOSAL_FILE [--to CANONICAL_QMD]`],
  ['verification', `Usage:\n  qmd-prover verification show SUBMISSION_ID\n  qmd-prover verification revoke @thm-ID --reason "..."`],
  ['verification show', `Usage:\n  qmd-prover verification show SUBMISSION_ID`],
  ['verification revoke', `Usage:\n  qmd-prover verification revoke @thm-ID --reason "..."`],
  ['render', `Usage:\n  qmd-prover render`]
]);

const helpGroups = new Set([
  'inspect', 'dependency', 'dependency reverse', 'dependency alternative',
  'dependency unused', 'dependency ready', 'dependency ready for', 'check',
  'workspace', 'submit', 'verification'
]);

const helpPositionals = new Set([
  'inspect fact', 'inspect theorem', 'inspect path',
  'dependency dependencies', 'dependency reverse dependencies', 'dependency impact',
  'dependency frontier', 'dependency path', 'dependency alternative paths', 'dependency search',
  'workspace init', 'workspace inspect', 'submit proof', 'verification show', 'verification revoke'
]);

function emitHelp(args) {
  let pathArgs;
  const direct = args[0] === 'help';
  if (direct) pathArgs = args.slice(1);
  else {
    const index = args.findIndex((item) => item === 'help' || item === '--help' || item === '-h');
    if (index < 0) return false;
    pathArgs = args.slice(0, index);
  }
  let selected = '';
  for (let length = 1; length <= pathArgs.length; length += 1) {
    const candidate = pathArgs.slice(0, length).join(' ');
    if (help.has(candidate)) selected = candidate;
  }
  const requested = pathArgs.join(' ');
  const extra = pathArgs.slice(selected ? selected.split(' ').length : 0);
  const hasUnexpectedPositional = extra.some((item) => !item.startsWith('--')) && !helpPositionals.has(selected);
  if (pathArgs.length && (!selected || (direct && !help.has(requested)) || (helpGroups.has(selected) && requested !== selected) || hasUnexpectedPositional)) {
    throw new Error(`Unknown command: ${pathArgs.join(' ')}\n${usage}`);
  }
  process.stdout.write(`${help.get(selected)}\n`);
  return true;
}

function dependencyOperation(args) {
  const compound = [
    [['reverse', 'dependencies'], 'reverse-dependencies'],
    [['alternative', 'paths'], 'alternative-paths'],
    [['unused', 'imports'], 'unused-imports'],
    [['unused', 'exports'], 'unused-exports'],
    [['ready', 'for', 'ai'], 'ready-for-ai']
  ];
  for (const [tokens, operation] of compound) {
    if (tokens.every((token, index) => args[index] === token)) return { operation, tail: args.slice(tokens.length) };
  }
  return { operation: args[0], tail: args.slice(1), retired: args[0]?.includes('-') === true };
}

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
  if (!command) { process.stdout.write(`${usage}\n`); return; }
  if (emitHelp(args)) return;
  if (command === 'init') {
    const allowed = new Set(['--adopt-existing', '--append-contract', '--sync-contract']);
    if (rest.some((item) => !allowed.has(item)) || new Set(rest).size !== rest.length || rest.length > 1) {
      throw new Error('init accepts only one of --adopt-existing, --append-contract, or --sync-contract');
    }
    emit(await initializeProject(root, {
      adoptExisting: rest.includes('--adopt-existing'),
      appendContract: rest.includes('--append-contract'),
      syncContract: rest.includes('--sync-contract')
    }), false);
    return;
  }
  if (command === 'inspect') {
    const parsed = presentation(rest);
    const [subcommand, ...tail] = parsed.args;
    if (subcommand === 'project') {
      if (tail.length) throw new Error('inspect project accepts only --print');
      emit(await inspectProject(root, options), parsed.print);
      return;
    }
    if (subcommand === 'theorem' || subcommand === 'fact') {
      if (tail.length !== 1) throw new Error(`inspect ${subcommand} requires one semantic ID and optional --print`);
      const result = await inspectFact(root, tail[0], options);
      result.verification_history = await history(root, result.fact.id);
      emit(result, parsed.print);
      return;
    }
    if (subcommand === 'path') {
      if (tail.length !== 1) throw new Error('inspect path requires one QMD file or folder and optional --print');
      emit(await inspectPath(root, tail[0], options), parsed.print);
      return;
    }
    throw new Error('inspect requires project, fact, theorem, or path');
  }
  if (command === 'dependency') {
    const parsed = presentation(rest);
    const { operation: subcommand, tail, retired } = dependencyOperation(parsed.args);
    if (!subcommand) throw new Error('dependency requires an operation');
    const operations = new Set(['dependencies', 'reverse-dependencies', 'impact', 'frontier', 'path', 'alternative-paths', 'cycles', 'findings', 'unused-imports', 'unused-exports', 'isolated', 'unreachable', 'ready-for-ai', 'reused', 'search']);
    if (retired || !operations.has(subcommand)) throw new Error(`Unknown dependency command: ${parsed.args.join(' ')}`);
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
      if (extracted.positionals.length !== 2) throw new Error('dependency alternative paths requires two semantic IDs');
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
    const noArgument = new Set(['cycles', 'findings', 'unused-imports', 'unused-exports', 'isolated', 'unreachable', 'ready-for-ai']);
    const required = noArgument.has(subcommand) ? 0 : subcommand === 'path' ? 2 : 1;
    if (tail.length !== required) throw new Error(`dependency ${subcommand.replaceAll('-', ' ')} requires ${required} semantic ID${required === 1 ? '' : 's'}`);
    emit(await analyzeDependencies(root, subcommand, tail, options), parsed.print);
    return;
  }
  if (command === 'check') {
    const parsed = presentation(rest);
    const [subcommand, ...tail] = parsed.args;
    if (subcommand !== 'staleness' || tail.length) throw new Error('check staleness accepts only --print');
    emit(await checkStaleness(root, options), parsed.print);
    return;
  }
  if (command === 'submit') {
    const [subcommand, ...tail] = rest;
    if (subcommand !== 'proof') throw new Error('submit requires the proof subcommand');
    const destinationIndex = tail.indexOf('--to');
    const proposal = tail[0];
    const destination = destinationIndex >= 0 ? tail[destinationIndex + 1] : undefined;
    if (!proposal || (tail.length !== 1 && !(tail.length === 3 && destinationIndex === 1 && destination))) throw new Error('submit proof requires one proposal QMD file and optional --to CANONICAL_QMD');
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
  if (command === 'render') {
    if (rest.length) throw new Error('render accepts no arguments');
    output(await renderProject(root, options));
    return;
  }
  throw new Error(`Unknown command: ${command}\n${usage}`);
}
