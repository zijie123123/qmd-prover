# Inspector design

## Role

The inspector checks mathematical state at four connected scopes: one fact, a
file or folder, one goal workspace or the complete project, and the aggregate
dependency graph. A protected main goal is declared in user QMD; every other
qmd-prover fact is an explicit declaration in an initialized goal workspace.

For every selected fact, the inspector exposes three deliberately separate
layers:

- `mechanical` establishes source shape, identity, exact dependency edges,
  reference existence, import scope, cycle freedom, and protected context
  without consulting AI;
- `local_verification` asks an optional AI verifier whether the submitted proof
  follows assuming only the exact conclusions of its direct dependencies; and
- `global_verification` deterministically composes machine validity, the local
  verdict, and the complete upstream dependency closure.

The inspector uses Pandoc JSON as its semantic parser. It extracts dependency
edges only from `@id` references in a workspace definition construction or
linked proof. Ordinary user-note exposition, theorem-like blocks other than
`thm-main-*`, and bibliographic citations do not enter the graph.

Inspection returns stable schema-v4 JSON by default. `--print` selects a
human-readable report but must not change selection, diagnostics, verification,
graph construction, or snapshot publication.

The shared project index is built before verifier work. It discovers notes,
protected goals, initialized workspaces, goal-like uninitialized directories,
orphan workspaces, explicit declarations, and forbidden cross-scope
dependencies. A duplicate ID across project scopes is fatal for every
inspection and dependency operation: no verifier call occurs and no aggregate
replacement is published. Other workspace failures remain local.

Local verification runs for selected facts whose exact target and direct
dependency statements can be materialized. It is not gated by upstream AI
verdicts, and machine scope or cycle findings remain separate diagnostics. The
exact local key covers the target statement or construction, submitted proof
or refutation, exact direct dependency statements, semantic context, external
basis, checker contract, and protocol. It excludes dependency proof text,
dependency verdicts, and the transitive proof closure. Verified, disproved,
and rejected local decisions are reusable. Without a verifier, machine
inspection remains operational and local checks are `not-run`.

### Diagnostics versus QMD source

Inspection diagnostics are structured output, not additions to the
mathematical source format. Their uppercase names occur only in the JSON
`diagnostics[].code` field, its `--print` presentation, and derived diagnostic
or snapshot JSON. The inspector never inserts one into `progress.qmd`,
`main-proof.qmd`, or another QMD file.

The project-level codes introduced by workspace-centric inspection are:

| Code | Meaning |
|---|---|
| `GLOBAL_DUPLICATE_ID` | One explicit ID is declared in more than one project scope. The project index is ambiguous, so inspection and dependency analysis stop before verification or aggregate publication. |
| `DUPLICATE_ID` | One workspace declares the same ID more than once. That workspace cannot compile, but healthy workspaces can still be reported by project inspection. |
| `WORKSPACE_UNINITIALIZED` | A goal-shaped workspace directory contains active QMD but has no `workspace.json`. Inspection reports it without initializing or rewriting the directory. |
| `WORKSPACE_MISSING` | A protected main goal has no initialized workspace. The user must explicitly request initialization before proof work starts. |
| `WORKSPACE_ORPHAN` | Workspace metadata names no current protected goal, or its target disagrees with the directory name. |
| `WORKSPACE_STALE` | The protected goal no longer matches the snapshot recorded when the workspace was initialized. |
| `WORKSPACE_SOURCE_STALE` | Workspace sources or verifier context changed while an independent check was running, so that result is not accepted or cached. |
| `WORKSPACE_AI_DISPROOF_REJECTED` | Independent review did not confirm a source-marked refutation. The diagnostic carries the verifier's explanation and repair hints. |
| `DEFINITION_DISPROVED_FORBIDDEN` | A definition uses a marker reserved for refuting theorem-like statements. |
| `PARSE_ERROR` | Pandoc could not launch or could not parse a relevant QMD file. This remains distinct from lookup failure. |
| `FACT_UNKNOWN` | Parsing and project indexing completed, but the requested ID does not name a protected goal or workspace declaration. |

More specific compiler and verifier diagnostics follow the same rule: the
code is a stable machine identifier, while the adjacent message, source
location, remediation, and repair hints explain what the user or agent should
do. QMD workflow markers are a separate concept described by the project
contract.

## 1. Inspect a theorem, lemma, or definition

`inspect fact @ID` accepts any protected main-goal or explicit workspace ID.
It automatically identifies the owning workspace and returns the selected fact,
its check result, source text, explanatory dependency closure, blockers,
diagnostics, verification counts, and staleness state.

### Select and parse the fact

Selection follows these rules:

- Compile user sources in `project-goals` mode. Only `thm-main-*` blocks are
  registered; unrelated theorem-like notes are ignored for semantic purposes.
- Compile every discovered workspace in `workspace` mode with the complete
  declaration, proof, import, export, and ID contract.
- Resolve the requested ID through the project-wide index. Do not require the
  caller to know which workspace owns it.
- If the ID names a protected goal, select the linked proof overlay in that
  goal's own workspace. The overlay is not a second declaration.
- If a goal-like directory contains QMD but lacks `workspace.json`, report the
  uninitialized workspace rather than pretending the fact is unknown.
- If Pandoc cannot launch or parse a relevant file, preserve that parse
  failure instead of falling through to an unknown-fact result.
- If the project compiled completely and no matching goal or workspace fact
  exists, return a structured unknown-fact diagnostic with exit code 2.

Inspection never calls workspace initialization and never copies or edits a
proof in user QMD.

### Build the mechanical graph

For every selected construction or proof, check that:

- the target declaration exists and is unique;
- the block kind, ID, class, name, date, and body satisfy the workspace
  contract;
- a theorem-like candidate has one nonempty linked proof;
- each referenced ID resolves to a declaration in the same workspace;
- same-file dependencies are local, while cross-file dependencies have a
  matching producer export and exact consumer import;
- no dependency resolves to another workspace or another protected main goal;
- dependency edges and cycle membership are reported exactly; and
- the protected main-goal snapshot, workspace files, external basis, and
  checker contract have not changed during the operation.

Missing and unavailable references remain as explanatory edges in the scoped
workspace graph. Forbidden cross-workspace or main-goal edges are diagnosed but
are omitted from the project aggregate graph.

Mechanical analysis never asks whether a dependency has been proved, rejected,
or checked by AI. Those labels cannot create, remove, or alter an edge.

### Check one conditional step with AI

When the target and its direct dependency statements are materializable, send
a bounded packet to the optional verifier. The packet supplies the exact
submitted proof and the exact conclusions of only the direct dependencies. It
does not supply dependency proofs, dependency AI states, or a transitive proof
bundle. The verifier must assume those conclusions and judge the proof actually
submitted, rather than solve the theorem by an unrelated route.

For a definition, ask whether the cited local facts and external basis make the
construction meaningful, provide all required objects and operations, and
justify any existence, uniqueness, or well-definedness claim.

For a theorem-like result, ask whether:

- every cited result applies under the stated hypotheses;
- the proof uses each conclusion correctly;
- explicit reasoning covers every case and quantifier;
- external theorems are allowed by the exact basis and used with their
  hypotheses; and
- the proof establishes the exact declaration, especially the protected
  main-goal statement.

If the proof begins with `DISPROVED`, change the verification mode from proof
to refutation. Ask whether the proposed counterexample satisfies every
hypothesis and actually falsifies the exact statement, rather than merely
showing that one proof attempt has a gap. An ordinary proof review may also
discover that the statement itself is false.

The verifier returns a verdict, summary, critical errors, gaps, nonblocking
comments, repair hints, and a refutation field. `correct` with no critical
errors or gaps verifies an ordinary proof. `disproved` with a nonempty
refutation and no critical errors or gaps establishes a disproof. A
source-marked refutation must receive that same conclusive verdict. Missing
configuration produces `not-run`, not an error. A configured verifier that
fails, times out, or returns malformed output produces a structured
infrastructure error and no local conclusion.

### Compose global state and record evidence

For every selected workspace graph, qmd-prover computes global status after
the local checks. A fact is globally verified exactly when its mechanical state
passes, its local proof is accepted, and all direct dependencies are globally
verified. A locally accepted fact with an unconcluded upstream dependency is
`blocked`; a fact without a local check is `unverified`; a machine-invalid fact
is `invalid`. This fold is deterministic and makes no AI calls.

For current local evidence, qmd-prover:

- stores the exact verifier packet and report under the goal workspace;
- records a decision keyed by the complete verification identity;
- reports local and global fields separately in the workspace manifest and
  graph;
- atomically publishes a current workspace snapshot; and
- refreshes the aggregate project graph when the operation owns publication.

For a conclusive refutation, the same safe publication path reports
`workspace-disproved` and stores structured evidence with the verifier summary,
refutation, source, and exact verification key. The verifier never inserts or
removes `DISPROVED` in QMD.

Verification summaries count local outcomes (`local_verified`,
`local_disproved`, `local_rejected`, `local_errors`, `local_not_run`) separately
from globally composed outcomes (`global_verified`, `global_disproved`,
`global_blocked`, `global_unverified`, `global_rejected`, `global_invalid`).
`ok` reports operational success, not the truth of the selected theorem.

If the verifier rejects the proof, qmd-prover caches the exact rejection and
reports `workspace-rejected` with the complete repair information. Rejection
never changes user QMD. A rejected source-marked refutation receives
`workspace-disproof-rejected` so it cannot be confused with either a false
statement or an ordinary failed proof.

Current inspection writes no `VERIFIED` or `REVOKED` marker. Those markers and
old project verification records are legacy read-only state. `submit proof` and
`verification revoke` remain command surfaces only to return structured
`retired` results.

### Construct the related dependency graph

The single-fact graph contains:

- the selected fact;
- its direct local dependencies;
- its complete transitive local dependency closure;
- unresolved references needed to explain failures;
- status, workspace, identity, and source location for each node;
- structured disproof evidence on every independently disproved node; and
- edge-level machine existence, scope, and cycle checks.

It deliberately excludes reverse dependencies and unrelated facts. Reverse
dependencies can be queried from the aggregate graph, but they are not part of
the verifier schedule for the selected fact.

Narrow inspection still updates durable state. To avoid degrading unrelated
facts, it merges current outcomes from an unchanged prior workspace snapshot.
The snapshot signature includes workspace sources, protected-goal identity,
external basis, and checker contract. The aggregate builder likewise uses
current snapshots from unselected workspaces.

### `--print` report

With `--print`, display:

- selected ID, kind, workspace, source, and composed status;
- mechanical, local-AI, and global-composition results;
- direct and transitive dependencies;
- exact blockers and paths;
- confirmed refutation evidence when the selected statement is disproved;
- relevant diagnostics and verifier repair hints; and
- the scoped graph as a readable tree or edge list.

## 2. Inspect a file or folder

Path inspection has different semantics inside and outside a goal workspace.
The distinction is essential: qmd-prover must not impose its complete schema on
arbitrary user notes.

### Source discovery

- Reject paths outside the project root.
- Reject missing paths and non-QMD files with structured domain diagnostics.
- A workspace file request selects declarations and proof overlays in that
  file.
- A workspace folder request recursively selects active QMD below that folder.
- Workspace discovery excludes `target.qmd`, `progress.qmd`, machine state,
  caches, snapshots, rendered output, and configured ignored paths.
- A user-note file or folder is parsed in `project-goals` mode and selects only
  protected main goals within that path.
- An ordinary user-note path with no main goals returns an empty successful
  fact result and no theorem-format findings.
- Discovery order is deterministic.

### Aggregate checks

For a workspace path:

- parse all active workspace files needed to establish imports, exports, IDs,
  proof links, and cycles;
- select facts declared or proved in the requested path;
- add each selected fact's transitive local dependency closure;
- locally check only that closure in deterministic order;
- report selected facts separately from external context nodes; and
- leave unrelated facts outside the verification count.

For a user path, inspect each selected protected main goal through its own
workspace overlay. A missing workspace, stale protected snapshot, or
uninitialized goal-like directory remains a structured failure.

### Aggregate dependency graph

The returned path graph contains the selected workspace facts and their local
dependency context. Nodes are marked `selected` or `external` relative to the
path selection. “External” here means outside the selected path but inside the
same workspace; it does not mean another workspace or an external-basis result.

After a complete narrow check, qmd-prover refreshes the selected workspace
snapshot and the publishable project graph. If any project compilation is
incomplete, publication is withheld rather than replacing a complete snapshot
with partial data.

### `--print` report

With `--print`, display:

- selected files and facts;
- counts by kind and status;
- context dependencies outside the selected path;
- missing imports, exports, references, or proofs;
- cycles and blockers in the selected closure; and
- local verification calls, cache hits, local outcomes, global outcomes,
  rejections, and errors.

## 3. Inspect the project or one workspace

`inspect workspace @thm-main-ID` performs one complete goal-workspace
inspection. `workspace inspect @thm-main-ID` is its compatibility alias.
`inspect project` discovers and checks the entire managed project.

### Workspace discovery

The shared project index classifies directories under
`.qmd-prover/workspaces/` as:

- `initialized` when `workspace.json` is valid and targets a current main goal;
- `uninitialized` when a goal-like directory contains active QMD but no
  metadata;
- `orphan` when metadata targets a missing goal or disagrees with the
  directory name; and
- `invalid` when discovery or metadata parsing fails.

Initialization is never inferred from a directory name. Uninitialized and
orphan workspaces are reported so the user can decide whether to initialize,
rename, move, or remove them.

The index compiles each workspace independently and registers every explicit
declaration globally. A linked proof of the workspace's own main goal is not a
declaration. A duplicate within one workspace remains local; duplicates across
scopes are project-fatal and report every project-relative declaration
location.

### Workspace checks

A full workspace inspection:

- compares the current protected main goal with `workspace.json`;
- parses every active workspace QMD file under the full contract;
- creates the protected-goal overlay from the user statement and linked
  workspace proof;
- rejects explicit redeclaration of the target;
- rejects proofs of other protected goals;
- rejects dependencies on another workspace or main goal;
- checks imports, exports, cycles, and proof completeness;
- schedules every selected local fact independently of upstream AI outcomes;
- reuses exact current local verified, disproved, or rejected decisions;
- computes global status over the complete workspace graph; and
- publishes a schema-v4 workspace snapshot when parsing is complete.

`inspect project` runs this operation for every initialized workspace. A
malformed workspace does not prevent healthy workspaces from being inspected
or included with full results. The top-level result is nevertheless `ok:false`
when any blocking diagnostic remains.

Project success is stricter than “all discovered workspaces passed.” Every
protected main goal must have a current initialized workspace whose complete
inspection passes. A goal without a workspace is listed with a specific
missing-workspace diagnostic. Here “passes” is operational: sources and machine
checks are valid and any configured verifier ran successfully. It does not mean
that every goal is globally verified; the aggregate summary and each fact's
`global_verification` field state that separately.

### Workspace and project dependency graphs

Each workspace graph contains its explicit declarations, protected-goal
overlay, local dependency edges, and unresolved references. It can retain an
invalid reference for explanation.

The aggregate project graph has one node per globally unique ID and records
workspace or main-goal origin, source, status, identity, and any confirmed
disproof evidence. A current overlay
replaces the open main-goal node. Cross-workspace and other-main-goal edges are
not published. The snapshot also contains:

- protected goal inventory;
- note paths and their contained goals;
- workspace status and staleness summaries;
- aggregate manifest and diagnostics;
- cycle paths; and
- a source signature independent of verifier result.

The source signature allows dependency analysis to reuse a saved graph only
while sources and context remain current. Local evidence has its own exact
cache identity; global status is recomputed from current graph and local state.

### `--print` report

For one workspace, show:

- target identity and staleness;
- files, facts, kinds, and statuses;
- complete verification totals;
- active proof obligations, blockers, and cycles;
- diagnostics grouped by source and semantic ID; and
- aggregate publication identity when refreshed.

For project inspection, also show:

- notes and protected goals;
- initialized, uninitialized, orphan, and invalid workspaces;
- each full workspace result, including healthy results beside failures;
- total graph findings and verifier counts; and
- why the overall project result is or is not complete.

## 4. Analyze and search the dependency graph

Dependency operations use the latest current schema-v4 aggregate snapshot.
They never rebuild a graph from user-note theorem-like content.

### Dependency queries

For selected facts, support:

- direct and transitive dependencies;
- direct and transitive reverse dependencies;
- shortest and bounded alternative paths;
- impact analysis;
- proof-frontier discovery; and
- graph-aware search filters.

Without a target, support complete-project cycles, findings, unused imports and
exports, isolated facts, unreachable facts, ready-for-AI candidates, and
heavily reused facts.

Every target ID is validated against the aggregate graph. Unknown IDs return a
structured lookup diagnostic. A global duplicate prevents graph analysis
rather than allowing a query to choose one owner arbitrarily.

Impact analysis reports reverse dependents from the machine graph regardless
of their AI state. Changing a dependency proof with the same statement changes
global composition but does not invalidate downstream local AI cache entries;
changing the dependency statement does both. A disproved node remains unusable
as a globally established premise.

### Find the proof frontier

For a selected fact:

1. Traverse its local aggregate dependency closure.
2. Find open, candidate, rejected, disproved, stale, missing, malformed, or
   otherwise unusable facts.
3. Remove a blocked fact from the frontier when a lower unresolved dependency
   already explains the block.
4. Return the lowest unresolved claims with paths from the selected result.

The frontier is a useful next-obligation set, not merely every unverified node.

### Additional graph findings

The inspector derives:

- unused workspace imports and exports;
- isolated and unreachable facts;
- unresolved or invalid dependency edges;
- candidates whose dependency closure is otherwise ready for AI;
- heavily reused facts whose change has broad impact; and
- alternative dependency paths to the same target.

Findings cover every workspace in the aggregate snapshot, not only the most
recently inspected one.

### Search

Search matches semantic ID, title, statement or construction text, proof text,
kind, status, source path, and main-goal or workspace origin. Graph-aware
filters restrict matches to facts used by, depending on, affected by, or on the
frontier of another fact; directness and cycle participation can be requested.

Search results carry source and workspace provenance and can be passed to fact,
path, frontier, or impact operations.

## 5. Check staleness

Staleness checking is an audit. It does not edit QMD, remove markers, initialize
workspaces, or publish a proof into user notes.

### Cache accepted identities

An exact workspace decision records:

- target ID, kind, statement or construction, proof or refutation identity,
  and verification mode;
- every direct local dependency's exact statement identity;
- normalized semantic and source context;
- external-basis hash and exact verifier packet context;
- checker contract and protocol;
- verifier report and verified, disproved, or rejected outcome; and
- source and workspace ownership.

Workspace snapshots additionally carry a signature over active workspace
sources, protected-goal identity, external basis, and checker contract. The
aggregate snapshot carries its own project source signature.

### Compare current mathematics with the cache

`check staleness` scans:

- current protected main-goal identities against `workspace.json`;
- active workspace source fingerprints;
- external-basis identity;
- checker contract;
- current workspace snapshot signatures;
- exact cache records; and
- old project verification records and legacy markers.

A cache is unusable when required data is missing, corrupt, stale, or no longer
matches its exact verification key. The audit reports previous and current
evidence when available; it does not guess a replacement identity.

### Report transitive invalidation

If a direct dependency statement changes, the dependent local cache key no
longer matches; that may continue through facts whose direct input statements
also changed. If only a dependency proof or AI verdict changes, downstream
local cache keys remain current and only deterministic global composition
changes. The audit reports the affected workspace and source/cache reasons,
and subsequent inspection reuses every unaffected local decision.

This is logical invalidation, not source-marker mutation. `VERIFIED` and
`REVOKED` in old user files remain untouched legacy text and do not establish
current workspace status.

### Atomicity and failure behavior

- Staleness auditing performs no writes.
- Workspace inspection writes each exact cache record atomically.
- After a verifier returns, inspection rechecks workspace sources, protected
  goal context, external basis, and checker contract before caching the result.
- Workspace snapshot publication is atomic.
- Aggregate publication is atomic and is refused for global duplicates or
  incomplete compilation.
- A failure leaves the previous complete pointer usable.

### `--print` report

With `--print`, display:

- each changed protected goal, workspace, source, basis, checker, or cache;
- previous and current identities when available;
- workspace-level invalidation entries and reasons;
- invalid or missing cache records;
- legacy canonical records or markers as warnings; and
- the facts that require another inspection.

### Agent contract requirement

The project contract requires agents to:

- inspect current global state before relying on workspace-verified mathematics or
  reporting a statement as established false;
- never use a workspace-disproved statement as a dependency;
- treat missing, corrupt, or stale caches as unverified;
- rerun the narrowest affected inspection after a source or context change;
- never add or restore `VERIFIED` manually;
- never delete or rewrite legacy state merely to migrate a project; and
- never confuse a local conditional AI pass with global verification, and
  never bypass mechanical checks or global composition.
