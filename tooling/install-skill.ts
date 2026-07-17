#!/usr/bin/env tsx

// Install the self-contained qmd-prover skill into a host agent's skills directory.
//
// Usage: install-skill [--local|--global] [--codex|--claude] [--dir <project>]
//   --local   (default) install into a project, under <project>/.claude or <project>/.codex
//   --global  install into the host's home skills directory
//   --claude  (default) target Claude Code (.claude/skills/qmd-prover)
//   --codex   target Codex (.codex/skills/qmd-prover)
//   --dir     project directory for a local install (default: current directory)

import { cp, mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repository = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const source = path.join(repository, 'skills', 'qmd-prover');

const argv = process.argv.slice(2);
let scope: 'local' | 'global' = 'local';
let host: 'codex' | 'claude' = 'claude';
let projectDir = process.cwd();

for (let index = 0; index < argv.length; index += 1) {
  const arg = argv[index];
  if (arg === '--local' || arg === '--global') {
    scope = arg.slice(2) as 'local' | 'global';
  } else if (arg === '--codex' || arg === '--claude') {
    host = arg.slice(2) as 'codex' | 'claude';
  } else if (arg === '--dir') {
    const value = argv[index + 1];
    if (!value) {
      process.stderr.write('--dir requires a path\n');
      process.exit(1);
    }
    projectDir = path.resolve(value);
    index += 1;
  } else {
    process.stderr.write(`Unknown option "${arg}". Usage: install-skill [--local|--global] [--codex|--claude] [--dir <project>]\n`);
    process.exit(1);
  }
}

const home = os.homedir();
const configDir = host === 'codex' ? '.codex' : '.claude';
let base: string;
if (scope === 'global') {
  base = host === 'codex'
    ? process.env.CODEX_HOME || path.join(home, '.codex')
    : process.env.CLAUDE_CONFIG_DIR || path.join(home, '.claude');
} else {
  base = path.join(projectDir, configDir);
}
const destination = path.join(base, 'skills', 'qmd-prover');

await mkdir(path.dirname(destination), { recursive: true });
await rm(destination, { recursive: true, force: true });
await cp(source, destination, { recursive: true });

process.stdout.write(`${destination}\n`);
if (host === 'claude') {
  process.stderr.write(`Installed for Claude Code (${scope}). It is discovered automatically; the skill resolves its own dispatcher.\n`);
} else {
  process.stderr.write(`Installed for Codex (${scope}). Set QMD_PROVER_HOME="${destination}" if it is not on the default path.\n`);
}
