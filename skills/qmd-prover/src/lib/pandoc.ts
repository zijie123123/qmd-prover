import { spawn } from 'node:child_process';
import { asErrorLike } from './errors.js';
import type { JsonObject } from './types.js';

function collect(child: ReturnType<typeof spawn>, input?: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    if (child.stdin) child.stdin.end(input);
  });
}

export async function readAst(file: string, { pandoc = process.env.QMD_PROVER_PANDOC || 'pandoc' }: { pandoc?: string } = {}): Promise<JsonObject> {
  let result;
  try {
    result = await collect(spawn(pandoc, ['--from=markdown+fenced_divs+citations', '--to=json', file], { stdio: ['ignore', 'pipe', 'pipe'] }));
  } catch (error) {
    if (asErrorLike(error).code === 'ENOENT') {
      throw new Error(`Pandoc is required to parse QMD. Install Pandoc or set QMD_PROVER_PANDOC (tried: ${pandoc}).`);
    }
    throw error;
  }
  if (result.code !== 0) throw new Error(`Pandoc could not parse ${file}: ${result.stderr.trim()}`);
  try { return JSON.parse(result.stdout); } catch {
    throw new Error(`Pandoc returned invalid JSON for ${file}`);
  }
}

export function walk(value: any, visit: (node: any) => void): void {
  if (!value || typeof value !== 'object') return;
  if (typeof value.t === 'string') visit(value);
  if (Array.isArray(value)) for (const item of value) walk(item, visit);
  else for (const child of Object.values(value)) walk(child, visit);
}

export function inlineText(inlines: any = []): string {
  let text = '';
  walk(inlines, (node) => {
    if (node.t === 'Str') text += node.c;
    else if (node.t === 'Space' || node.t === 'SoftBreak' || node.t === 'LineBreak') text += ' ';
    else if (node.t === 'Code' || node.t === 'Math') text += Array.isArray(node.c) ? node.c.at(-1) : '';
  });
  return text.replace(/\s+/g, ' ').trim();
}

export function references(value: any): string[] {
  const found = new Set<string>();
  walk(value, (node) => {
    if (node.t === 'Cite' && Array.isArray(node.c?.[0])) {
      for (const citation of node.c[0]) {
        const id = citation.citationId;
        if (/^(def|lem|thm|prp|cor)-/.test(id)) found.add(id);
      }
    }
  });
  return [...found].sort();
}

export function normalizedAst(value: any): any {
  if (Array.isArray(value)) return value.map(normalizedAst);
  if (!value || typeof value !== 'object') return value;
  if (value.t === 'Space' || value.t === 'SoftBreak' || value.t === 'LineBreak') return { t: 'Space' };
  const output: Record<string, any> = {};
  for (const key of Object.keys(value).sort()) output[key] = normalizedAst(value[key]);
  return output;
}
