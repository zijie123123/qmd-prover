import type { ResultKind } from './types.js';

export const AUX = '.qmd-prover';

export const CONTROL_MARKERS = ['OPEN', 'REJECTED', 'VERIFIED', 'REVOKED'] as const;
export type ControlMarker = typeof CONTROL_MARKERS[number];
export const CONTROL_MARKER_SET: ReadonlySet<string> = new Set(CONTROL_MARKERS);

export function isControlMarker(value: unknown): value is ControlMarker {
  return typeof value === 'string' && CONTROL_MARKER_SET.has(value);
}

export const SEMANTIC_PREFIX_PATTERN = /^(def|lem|thm|prp|cor)-/;
export const SEMANTIC_ID_PATTERN = /^(def|lem|thm|prp|cor)-[A-Za-z0-9._:-]+$/;
export const RESULT_KINDS: readonly ResultKind[] = [
  'definition', 'lemma', 'theorem', 'proposition', 'corollary'
];
export const KIND_BY_PREFIX: Readonly<Record<string, ResultKind>> = {
  def: 'definition',
  lem: 'lemma',
  thm: 'theorem',
  prp: 'proposition',
  cor: 'corollary'
};
