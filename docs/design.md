# qmd-prover design

## Purpose

qmd-prover is a skill and tool set for disciplined mathematical proof
development in Quarto Markdown. It describes the discipline an agent must
follow, provides tools for checking that discipline and discovering logical
dependencies, helps the agent construct and independently verify proof
candidates, and makes proof progress observable through ordinary Quarto
rendering.

A user asks Codex, Claude Code, or another compatible coding agent to use the
skill. The host follows project policy, writes mathematical workspace QMD, reads structured
diagnostics and verifier reports, and explains results in natural language.

`AGENTS.md` supplies the agent-facing contract; it does not establish
compliance by itself. The compiler turns Pandoc JSON into facts, dependency
edges, and machine diagnostics. An optional external verifier supplies a local
conditional mathematical judgment. The inspector composes those independent
products into global verification state.

The design is workspace-centric. User QMD remains notes and protected
main-goal storage. All complete agent-created definitions, intermediate
results, and proofs remain under `.qmd-prover/workspaces/`, including after
verification. qmd-prover no longer promotes proof text or status markers into
user QMD.

## Components

The maintainable TypeScript runtime and dependency direction are documented in
[Runtime architecture](architecture.md).

The project has four components:

1. [Discipline](design-discipline.md) defines the rules for mathematical QMD
   and for agents working on it, including the user-note/main-goal boundary,
   workspace semantic QMD, global identity, external basis, and agent conduct.
2. [Inspector](design-inspector.md) builds the project index, checks facts,
   paths, workspaces, and the project, runs optional local AI checks, composes
   global status, and exposes dependency analysis and read-only staleness.
3. [Proving utilities](design-proving.md) protect the goal context, create
   bounded direct-dependency verifier packets, retain exact local decisions,
   and publish local and globally composed evidence safely.
4. [Rendering](design-rendering.md) uses Quarto to present the QMD project and
   any generated observability material.

The skill ties these components together. Node is an execution mechanism for
the utilities, not a separately designed user-facing CLI. A person may run a
script with `node`, but the normal interaction is to ask Codex or Claude Code
in natural language.

## System boundary

```text
user
  |
  v
Codex / Claude Code                                (outside qmd-prover)
  |
  | loads skill and project policy
  v
+-------------------------------------------------------+
| qmd-prover skill                                      |
|                                                       |
| discipline                                            |
|  + inspector (machine graph + local AI + composition) |
|  + agent workspaces                                   |
|                  |                                    |
|                  +------> proving utilities           |
|                                 | retained evidence   |
|                                 v                     |
|                         goal workspaces               |
+-------------------------------------------------------+
                                  |
                                  v
                              Quarto render        (outside qmd-prover)
```

Codex or Claude Code is not a qmd-prover component. It decides how to reason,
how long to continue, and whether to use host-provided sub-agents. Every such
agent must load the skill and project contract for itself.

Quarto is also outside qmd-prover. It renders user notes, optional workspace
previews, and generated observability inputs. A successful render does not
establish proof correctness.

The optional verifier is an external boundary process. qmd-prover owns the
packet contract, cache identity, freshness checks, and interpretation of the
structured result, not the verifier's implementation. Its verdict answers one
conditional question only: assuming the supplied direct dependency
conclusions, does the submitted proof establish this fact? It does not certify
those dependencies. qmd-prover computes whole-proof status separately.

## Mathematical project model

A managed project has three different kinds of mathematical material:

1. **User notes** are QMD outside `.qmd-prover/`. They may contain arbitrary
   prose, theorem-like blocks, informal proofs, metadata, equations, figures,
   and bibliography. qmd-prover does not impose its full schema on them.
2. **Protected main goals** are the `thm-main-* .theorem .goal` blocks inside
   user notes. Their IDs, captions, classes, hypotheses, quantifiers, and
   statements are locked.
3. **Goal-workspace mathematics** is complete semantic QMD under
   `.qmd-prover/workspaces/<thm-main-ID>/`. It contains agent-created
   definitions, intermediate results, linked proofs, and the proof overlay for
   that workspace's protected main goal.

The separation is about ownership and verification scope, not authorship.
User-note text can be written by a person or an agent at the user's request,
but qmd-prover treats it as notes unless it is a protected main goal.
Workspace QMD receives the complete machine-enforced contract.

Verified workspace mathematics and independently confirmed refutations are
persistent project state. They remain available for later inspection,
dependency analysis, resuming proof work, and future paper tooling. They are
not copied into user notes and do not acquire a verifier-authored source
marker.

Derived state under `.qmd-prover/` includes:

- statement locks for protected main goals;
- workspace metadata and target snapshots;
- exact verified, disproved, and rejected verifier records;
- workspace manifests, graphs, and immutable snapshots;
- aggregate project manifest, graph, diagnostics, and snapshots; and
- generated Quarto observability inputs.

Old project-level verification records and old `VERIFIED` or `REVOKED` markers
may still exist. They are legacy read-only state: inspection warns about them
but neither migrates nor deletes them.

### Example: one theorem after prolonged work

Suppose a user note contains `@thm-main-uniform-index`:

```text
uniform-index-project/
├── AGENTS.md
├── _quarto.yml
├── index.qmd
├── notation.qmd
├── background.qmd
├── uniform-index.qmd                      # protected main goal, no managed proof
└── .qmd-prover/
    ├── .external.qmd                      # optional external-basis policy
    ├── statement-locks.json
    ├── manifest.json                      # aggregate schema-v4 manifest
    ├── graph.json                         # aggregate all-workspace graph
    ├── diagnostics.json
    ├── graphs/
    │   ├── latest.json
    │   └── <snapshot>.json
    ├── generated/
    │   ├── proof-status.qmd
    │   └── dependencies.svg
    └── workspaces/
        └── thm-main-uniform-index/
            ├── workspace.json             # target and protected identity
            ├── target.qmd                 # initialization snapshot, inactive
            ├── progress.qmd               # maintained route and frontier
            ├── manifest.json
            ├── graph.json
            ├── latest.json
            ├── snapshots/
            │   └── <snapshot>.json
            ├── verification/
            │   ├── checks/
            │   └── failures/
            ├── reductions/
            │   ├── reduce-to-strata.qmd
            │   ├── generic-fiber.qmd
            │   └── specialization.qmd
            ├── local-theory/
            │   ├── local-class-groups.qmd
            │   ├── exponent-bounds.qmd
            │   └── completion-comparison.qmd
            ├── global-theory/
            │   ├── finite-stratification.qmd
            │   ├── constructibility.qmd
            │   └── lcm-argument.qmd
            ├── examples/
            │   ├── quotient-singularities.qmd
            │   └── possible-counterexamples.qmd
            └── main-proof.qmd              # proof overlay only
```

This is an illustrative workspace, not a required directory taxonomy. A short
proof may use one subject file plus `main-proof.qmd`. A large proof may grow
into a substantial development.

`workspace.json` and `target.qmd` protect the starting goal. Active semantic
discovery excludes `target.qmd` and `progress.qmd`. The former is state, not a
second declaration; the latter is strategic prose maintained by the agent or
user and is never overwritten by inspection.

The subject files contain ordinary semantic QMD. A declaration normally stays
beside its linked proof. Attempts and counterexamples need no special file
type. `OPEN` and `REJECTED` distinguish incomplete and inactive proof blocks.
`DISPROVED` begins a proposed counterexample or refutation in a theorem-like
linked proof; it remains a candidate until independently checked.

### Workspace dependency model

The inspector treats each goal workspace as an isolated mathematical project.
Its graph may contain:

- current workspace-verified definitions and results;
- independently confirmed workspace-disproved statements with their
  refutation evidence;
- candidates that are mechanically ready but await verification;
- open dependencies with incomplete proofs;
- retained rejected attempts;
- unresolved references needed to explain a failure; and
- the protected main-goal overlay.

For example:

```text
@thm-main-uniform-index
  -> @lem-finite-stratification
  -> @lem-local-exponent-bound
  -> @lem-completion-preserves-index
  -> @def-local-class-group
```

Every edge stays inside the same goal workspace. A dependency in another
workspace is not imported automatically, even if it has the same subject and a
workspace-verified status. The agent must adopt and prove the needed claim in
the current workspace, or state a permitted outside theorem in the external
basis without creating a cross-workspace `@id` edge.

Cross-file scope within the workspace remains explicit. The producer exports
the exact ID, the consumer imports it from a relative path, and the
construction or proof cites the ID at its point of use.

The aggregate project graph merges the isolated workspace graphs by globally
unique node ID. It records workspace and goal provenance but omits forbidden
cross-scope edges.

### Retention instead of canonical promotion

The earlier design promoted accepted proofs and new results into a canonical
QMD project. That model caused user notes to serve simultaneously as notes,
proof database, and machine status store. It also made inspection depend on
marker writes and canonical destination selection.

The v16 model removes that boundary crossing, separates machine and AI state,
and adds explicit retained disproof evidence:

1. The user statement remains in its note.
2. The agent creates complete mathematics in the goal workspace.
3. The compiler builds the dependency graph without consulting AI state.
4. The optional verifier checks each selected fact against only its direct
   dependency statements, and exact local decisions are cached.
5. The inspector deterministically composes global status over the graph;
   confirmed false statements carry conditional or global evidence explicitly.
6. The aggregate project graph exposes all three layers for search, dependency
   analysis, progress reporting, and future paper selection.

`submit proof` and `verification revoke` remain parseable only for compatibility
and return structured `retired` results without modifying any file.

Statement locks, exact dependency edges, external basis, checker contract,
source freshness, rejection safety, and atomic writes are still checked. The
machine graph does not become more or less valid when an AI verdict changes.
The safest canonical write is now no proof write at all.

The files therefore have distinct ownership:

- `AGENTS.md` is project-owned policy with one managed block and optional local
  additions.
- QMD outside `.qmd-prover/` is user-owned notes and protected goals.
- `_quarto.yml` is ordinary project configuration.
- goal workspaces are persistent mathematical developments and evidence.
- workspace and project JSON snapshots are derived machine state.
- generated QMD and SVG files are disposable observability inputs.

## Semantic QMD and inspection

The compiler has explicit modes.

`project-goals` parses user QMD through Pandoc JSON but retains only protected
main goals. Other theorem-like content, note imports, and proof-like prose do
not produce semantic diagnostics.

`workspace` applies the complete declaration/proof/import/export/ID contract to
active workspace QMD. A linked proof may target the workspace's own main goal
through its protected overlay. Every other fact must be an explicit local
declaration.

Within workspace semantic QMD, an `@id` citation in a definition construction
or linked proof is a dependency. The inspector first checks existence, global
uniqueness, local ownership, import scope, and cycles without consulting AI.
For a selected fact, it can then send the exact candidate and the exact
statements of its direct dependencies to the optional verifier. Dependency
proofs, dependency verdicts, and transitive proof text are deliberately absent.

### Complete workspace QMD example

The following is a complete active workspace file, not merely an isolated
block. Suppose it is stored as
`.qmd-prover/workspaces/thm-main-even-square/parity-results.qmd`, next to a
producer file named `foundations.qmd`:

```markdown
---
title: "Parity results"
qmd-prover:
  imports:
    - from: foundations.qmd
      use:
        - def-even-integer
---

This file develops the local parity facts needed by the protected main goal.

::: {#lem-square-of-even .lemma name="Square of an even integer" date="2026-07-14" export="lem-square-of-even"}
For every even integer \(n\), there is an integer \(k\) such that
\(n^2=4k^2\).
:::

::: {.proof of="lem-square-of-even"}
By @def-even-integer, write \(n=2k\) for an integer \(k\). Squaring gives
\(n^2=(2k)^2=4k^2\).
:::

::: {#cor-even-square-divisible-by-four .corollary name="Even squares are divisible by four" date="2026-07-14" export="cor-even-square-divisible-by-four"}
For every even integer \(n\), the integer \(n^2\) is divisible by \(4\).
:::

::: {.proof of="cor-even-square-divisible-by-four"}
By @lem-square-of-even, write \(n^2=4k^2\) for an integer \(k\). Therefore
\(4\mid n^2\).
:::
```

This one file demonstrates the complete workspace format:

- the YAML front matter imports one exact exported ID from a path relative to
  this consumer file;
- each declaration has one globally unique ID, exactly one semantic class, a
  human-readable `name`, an ISO introduction `date`, and a nonempty body;
- each non-definition declaration has one separate, nonempty `.proof` linked
  by `of` and carrying no ID;
- `@def-even-integer` is a cross-file dependency made available by the import;
- `@lem-square-of-even` is a same-file dependency and needs no import; and
- each `export` value is identical to the declaration's semantic ID, allowing
  another file in this workspace to import it explicitly.

The protected theorem itself is not repeated in the workspace. Its complete
`main-proof.qmd` overlay can import the corollary from the file above:

```markdown
---
qmd-prover:
  imports:
    - from: parity-results.qmd
      use:
        - cor-even-square-divisible-by-four
---

::: {.proof of="thm-main-even-square"}
The conclusion is exactly @cor-even-square-divisible-by-four.
:::
```

Here `thm-main-even-square` is resolved only through this workspace's protected
main-goal snapshot. The proof block is an overlay, not a second theorem
declaration. Neither inspection nor successful verification copies this proof
into the user-owned QMD file.

If the exact theorem-like statement is false, its linked proof instead begins
with `DISPROVED` and supplies the counterexample or refutation after that
marker. This changes the independent review mode; it does not itself establish
falsity. Definitions cannot use the marker. A verifier may also discover a
counterexample while checking an unmarked proof, and derived state records that
outcome without editing the workspace source.

### Inspection scopes

The public scopes are:

- `inspect fact @ID` for one auto-located fact and its transitive local
  dependencies;
- `inspect path PATH` for selected workspace facts or protected goals in a user
  path;
- `inspect workspace @thm-main-ID` for one complete initialized workspace;
- `inspect project` for all notes, goals, workspaces, full workspace results,
  and aggregate graph; and
- `dependency ...` for analysis and search over the current aggregate
  schema-v4 snapshot.

`workspace inspect` is a compatibility alias. No inspect command initializes a
workspace. An ordinary user-note path returns no facts rather than being
diagnosed under the workspace contract.

One malformed workspace does not hide healthy workspace results in project
inspection. The top-level project result is still unsuccessful until every
main goal has a current initialized workspace and all full workspace checks
pass.

### Three inspection layers

Every current result exposes separate `mechanical`, `local_verification`, and
`global_verification` fields. The `workspace-*` status string is a compact
presentation of the composed state, not an input to dependency analysis.

Mechanical state covers parsing, declaration and proof shape, ID ownership,
exact imports and exports, reference existence and scope, cycles, protected
goal freshness, and source freshness. It is computed without an AI verifier.

Local verification checks the exact submitted proof or refutation while
assuming the exact conclusions of only its direct dependencies. A rejected,
unverified, or cyclic upstream proof does not prevent this local check when
the dependency statements can be materialized. Without a configured verifier,
local state is `not-run` rather than a machine failure.

Global verification is deterministic. A result is globally `verified` only if
its machine state passes, its local proof is accepted, and every direct
dependency is globally `verified`. Otherwise it is `blocked`, `unverified`,
`rejected`, `invalid`, or `disproved` as appropriate. Operational `ok` says
whether inspection and configured verifier execution completed; it is not the
mathematical answer.

The composed workspace presentation includes:

- `workspace-open`: a required proof is absent or begins with `OPEN`;
- `workspace-candidate`: complete unmarked mathematics awaits checking;
- `workspace-disproof-candidate`: a `DISPROVED` proof proposes a counterexample
  or refutation and awaits checking;
- `workspace-rejected`: an exact verifier decision rejected the candidate, or
  the active proof begins with `REJECTED`;
- `workspace-disproof-rejected`: the independent verifier rejected a proposed
  refutation;
- `workspace-verified`: the exact current candidate has an accepted local
  verifier record and every direct dependency is globally verified;
- `workspace-disproved`: local verification established a refutation and every
  direct dependency is globally verified, so the exact theorem-like statement
  is globally false with retained structured evidence;
  and
- unavailable or stale state: mechanical, source, protected-context, or cache
  checks prevent use.

`workspace-verified` is informal globally composed AI evidence, not formal
proof and not human review. It is never inferred from the agent's confidence
and never written as a source marker.

`workspace-disproved` has the same freshness requirement. It is conclusive
evidence about a false statement, not an available premise. Global composition
blocks any dependent fact that cites it, and frontier queries expose it as an
obstruction. The machine edge remains present and independent of the verdict.

`VERIFIED` and `REVOKED` remain recognized only so old projects can be reported
without destructive migration.

### Dependency analysis and search

An edge points from a workspace definition or result to a local fact cited by
its construction or proof. From the aggregate graph, qmd-prover provides:

- direct and transitive dependencies;
- reverse dependencies and impact;
- shortest and alternative paths;
- complete cycle paths;
- proof frontiers;
- unused imports and exports;
- isolated and unreachable facts;
- candidates ready for AI;
- heavily reused facts; and
- text and graph-aware search.

Queries without a target cover every initialized workspace. Search can filter
by ID, title, text, kind, status, source path, origin, graph relationship,
frontier membership, stale impact, directness, or cycle participation.

Every ID is globally unique. A duplicate across project scopes stops all
inspect and dependency operations before verifier invocation and leaves the
previous aggregate snapshot untouched. A duplicate confined to one workspace
blocks that workspace without suppressing healthy workspace results.

### Staleness and transitive invalidation

Exact local decisions include the target statement or construction, proof or
refutation, verification mode, exact direct dependency statements, semantic
context, external basis, checker contract, and protocol. They exclude upstream
proof text, upstream verdicts, and the transitive proof closure. Workspace
snapshots add a source signature covering active workspace QMD, protected goal
identity, external basis, and checker contract.

Changing an upstream proof without changing its statement invalidates that
upstream local decision but preserves downstream local cache hits; global state
is recomputed over the changed graph. Changing a direct dependency statement
invalidates the dependent local decision. Narrow inspection merges current
previous outcomes for unchanged facts so unrelated nodes are not downgraded.

`check staleness` is now read-only. It scans protected goal snapshots,
workspace sources, external basis, checker contract, caches, and legacy state,
then reports changes and affected facts. It does not remove or add markers,
rewrite user QMD, or overwrite progress notes.

## How agents use the infrastructure

qmd-prover does not prescribe a proof loop. After preflight, the host follows
the user's mathematical direction. The user may provide one theorem, many
related goals, an existing development, or an informal idea.

The infrastructure is available to:

- initialize or compare project policy;
- create or resume an explicitly requested goal workspace;
- inspect facts, paths, workspaces, or the whole project;
- discover missing imports, cycles, and proof frontiers;
- search retained workspace mathematics;
- locally verify exact candidates against direct dependency conclusions;
- retain and expose independently checked counterexamples and refutations;
- retain rejection reports and repair hints;
- audit current source and cache freshness;
- query the aggregate all-workspace graph; and
- prepare Quarto observability inputs.

Only the safety gates are mandatory. The agent keeps user statements unchanged,
uses the goal workspace, follows unproved dependencies, responds to every
verification gap, and never declares its own work verified.

The external basis can evolve with the requested proof context, but the agent
states the change and accepts that affected cache keys will miss.

## Installation and requirements

The skill and runtime are self-contained under `skills/qmd-prover/`. TypeScript
source under `src/` is authoritative; `npm run build` emits Node-compatible ESM
under `scripts/`. The generated runtime has no third-party Node dependency.

The environment provides:

- Node.js 20 or later;
- Pandoc on `PATH`, or `QMD_PROVER_PANDOC`;
- optionally, an external verifier command through `QMD_PROVER_VERIFIER` or
  project configuration; and
- Quarto only when rendered output is wanted.

From a source checkout:

```bash
npm run install:skill
```

This copies the complete installable skill to
`${CODEX_HOME:-~/.codex}/skills/qmd-prover`.

## Starting a mathematical project

The user normally asks the host to initialize the current project. The host
runs:

```bash
node "${CODEX_HOME:-$HOME/.codex}/skills/qmd-prover/scripts/qmd-prover.js" init
```

The command inventories policy, QMD, Quarto configuration, qmd-prover state,
and external-basis mode before writing. It never creates `.external.qmd`.

If a project already contains material or divergent policy, the host summarizes
it and asks before using `--adopt-existing`, `--append-contract`, or
`--sync-contract`. Successful setup ensures the workspace root exists but
creates no main goal or goal-specific workspace.

The user may later provide protected goals or ask the agent to formulate them.
Goal workspaces are created only by explicit `workspace init`.

## Using qmd-prover through Codex or Claude Code

Natural language is the normal interface:

```text
Initialize qmd-prover in this project.
```

```text
Use qmd-prover to prove @thm-main-even-square. Keep the statement unchanged,
develop every intermediate result in its workspace, and independently verify
the complete dependency closure.
```

```text
Inspect @def-hilbert-calculus and explain exactly which local dependencies were
checked.
```

```text
Inspect the complete project, show malformed or missing workspaces, and print
the aggregate proof frontier.
```

```text
Render the current proof-status and dependency views with Quarto.
```

The host loads `SKILL.md`, performs contract preflight, invokes the dispatcher,
writes workspace QMD, and translates JSON into ordinary language.

Host-provided sub-agents belong to the host environment. qmd-prover does not
maintain a worker runtime. Each independent agent must load the contract and
external basis itself.

## Using the Node utilities directly

Let the installed dispatcher be:

```bash
QMD_PROVER="${CODEX_HOME:-$HOME/.codex}/skills/qmd-prover/scripts/qmd-prover.js"
```

Initialize:

```bash
node "$QMD_PROVER" init
```

Inspect the complete project:

```bash
node "$QMD_PROVER" inspect project --print
```

Inspect one auto-located fact:

```bash
node "$QMD_PROVER" inspect fact @def-hilbert-calculus --print
```

Inspect one workspace path or a user-note path:

```bash
node "$QMD_PROVER" inspect path .qmd-prover/workspaces/thm-main-even-square/foundations.qmd
node "$QMD_PROVER" inspect path notes.qmd
```

Inspect a complete goal workspace:

```bash
node "$QMD_PROVER" inspect workspace @thm-main-even-square --print
```

Query the aggregate graph:

```bash
node "$QMD_PROVER" dependency frontier @thm-main-even-square --print
node "$QMD_PROVER" dependency search "local exponent" --kind lemma --print
node "$QMD_PROVER" dependency cycles --print
```

Audit staleness without writing:

```bash
node "$QMD_PROVER" check staleness --print
```

The old commands remain visible but retired:

```bash
node "$QMD_PROVER" submit proof path/to/proposal.qmd
node "$QMD_PROVER" verification revoke @thm-main-even-square --reason "reason"
```

Both return structured `retired` results and modify no file.

These operations expose a stable tool protocol. Inspection/domain failures use
JSON plus exit code 2. Syntax errors use exit code 1.

## Rendering with Quarto

Prepare generated status and graph inputs:

```bash
node "$QMD_PROVER" render
```

Render the configured project normally:

```bash
quarto render
```

qmd-prover does not render an alternative website. User notes remain ordinary
Quarto input. A project may also render workspace or generated pages to expose
proof progress.

Future paper tooling may consume selected workspace-verified mathematics and
produce a separate paper artifact. That workflow does not turn inspection into
a source-rewriting operation.

## Further design documents

- [Discipline design](design-discipline.md) explains policy ownership,
  semantic regimes, rule categories, block types, and contract evolution.
- [Inspector design](design-inspector.md) explains fact, path, workspace,
  project, aggregate dependency, and read-only staleness operations.
- [Proving utilities design](design-proving.md) explains candidate preflight,
  bounded verification, exact caches, rejection, freshness, and workspace
  acceptance.
- [Rendering design](design-rendering.md) explains user-note rendering,
  workspace observability, dependency navigation, and future paper boundaries.
