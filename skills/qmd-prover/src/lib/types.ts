/** JSON-compatible values persisted by qmd-prover's stable output protocol. */
export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = Record<string, any>;

export type DiagnosticSeverity = 'error' | 'warning';

export interface Diagnostic extends JsonObject {
  severity: DiagnosticSeverity;
  code: string;
  message: string;
  file?: string;
  line?: number;
  id?: string;
}

export type ResultKind = 'definition' | 'lemma' | 'theorem' | 'proposition' | 'corollary' | 'unknown';
export type CanonicalStatus = 'open' | 'candidate' | 'rejected' | 'verified' | 'revoked' | 'stale';

export interface ImportDeclaration extends JsonObject {
  from: string;
  use: string[];
}

export interface SourceFileRecord extends JsonObject {
  path: string;
  imports: ImportDeclaration[];
  results: string[];
  proofs: string[];
}

export interface ProofRecord extends JsonObject {
  target: string;
  file: string;
  dependencies: string[];
  proof_hash: string;
  proof_present: boolean;
}

export interface SemanticResult extends JsonObject {
  id: string;
  file: string;
  kind: ResultKind;
  title: string;
  status: string;
  statement_hash: string;
  proof_hash: string;
  dependencies: string[];
  uses: string[];
  origin: 'user' | 'agent' | 'workspace';
}

export interface Manifest extends JsonObject {
  schema_version: number;
  snapshot_id?: string;
  files: SourceFileRecord[];
  results: SemanticResult[];
  proofs: ProofRecord[];
}

export interface GraphNode extends JsonObject {
  id: string;
  status: string;
}

export interface GraphEdge extends JsonObject {
  from: string;
  to: string;
}

export interface DependencyGraph extends JsonObject {
  schema_version: number;
  snapshot_id?: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  cycles: string[][];
}

export interface QmdProverConfig extends JsonObject {
  project: JsonObject;
  goals: JsonObject;
  semantic: JsonObject;
  verification: JsonObject;
  render: JsonObject;
}

export interface CompilerOptions extends JsonObject {
  pandoc?: string;
  write?: boolean;
  files?: string[];
  excludeFiles?: string[];
  externalTargets?: string[];
  protectStatements?: boolean;
}

export interface Compilation extends JsonObject {
  root: string;
  config: QmdProverConfig;
  manifest: Manifest;
  graph: DependencyGraph;
  diagnostics: Diagnostic[];
  summary: JsonObject;
  ok: boolean;
  complete: boolean;
}

export interface VerifierReport extends JsonObject {
  verdict: 'correct' | 'incorrect';
  summary: string;
  critical_errors: string[];
  gaps: string[];
  nonblocking_comments: string[];
  repair_hints: string;
}

export interface VerifierPacketInput {
  target: JsonObject;
  dependencies?: JsonObject[];
  externalBasis?: JsonObject | null;
  scope?: JsonValue | null;
  config?: QmdProverConfig | JsonObject;
}

export type RuntimeOptions = CompilerOptions & JsonObject;
export type OperationResult = JsonObject & { ok?: boolean; operation?: string };
