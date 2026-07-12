# qmd-prover design

## Purpose

qmd-prover is a skill and tool set for disciplined mathematical proof
development in Quarto Markdown. It describes the discipline an agent must
follow, provides tools for checking that discipline and discovering logical
dependencies, helps the agent construct and independently verify proof
candidates, and makes proof progress observable through ordinary Quarto
rendering.

A user asks Codex, Claude Code, or another compatible coding agent to use the
skill. The host agent follows the discipline, calls the supplied Node tools,
and edits the QMD project on the user's behalf.

Canonical mathematics remains ordinary, human-readable QMD, and Quarto remains
the renderer.

## Components

The project has four components:

1. [Discipline](design-discipline.md) defines the rules for mathematical QMD
   and for agents working on it.
2. [Inspector](design-inspector.md) checks individual facts, paths, and
   workspaces; combines programmatic reference checks with an independent AI
   sufficiency check; and supports dependency analysis, search, and staleness
   invalidation.
3. [Proving utilities](design-proving.md) prepare candidates and own protected
   verification records, marker updates, promotion, and atomic canonical
   writes.
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
  | loads the skill and runs the loop
  v
+-------------------------------------------------------+
| qmd-prover skill                                      |
|                                                       |
| discipline -> inspector -> agent goal workspace       |
|                  |              |                     |
|                  |              v                     |
|                  +------> proving utilities           |
|                                 | accepted work only   |
|                                 v                     |
|                         canonical QMD project          |
+-------------------------------------------------------+
                                  |
                                  v
                              Quarto render        (outside qmd-prover)
```

Codex or Claude Code is not a qmd-prover component. It decides how to reason,
how long to continue, and whether to use host-provided sub-agents. Quarto is
also not implemented by qmd-prover; it consumes the resulting QMD project.

## Mathematical project model

A qmd-prover project separates the canonical project workspace from one or
more agent workspaces.

The **canonical project workspace** contains the user-given statements and the
mathematics that has passed the project's acceptance rules. It is the ordinary
Quarto project that the user opens and renders. The agent reads it as its source
of truth and does not use it as a scratch directory.

An **agent workspace** is a persistent mathematical area for proof development.
It may serve one goal or a related family of goals. If the agent works on a
difficult theorem for a long time, it may introduce many tentative definitions,
reductions, intermediate theorems, examples, counterexamples, partial proofs,
and repair notes. Those files belong in the agent workspace until the relevant
mathematics is independently verified and accepted into the canonical project.

The separation is about authority, not about whether a file was physically
written by a person or a model:

- canonical QMD is accepted project mathematics;
- workspace QMD is agent-generated working mathematics; and
- generated indexes and reports describe one of those spaces but are not
  mathematics themselves.

In concrete terms, the canonical project workspace contains the QMD documents
with the project's definitions, statements, accepted proofs, exposition,
citations, and references, together with `AGENTS.md`, which defines the rules
agents must follow in that project. qmd-prover stores each agent workspace and
its supporting data inside the hidden `.qmd-prover/` directory. This directory
contains tentative mathematics, protected workspace state, semantic indexes,
dependency data, verification records, and generated inspection files; none of
these are canonical project mathematics. Generated indexes and rendered output
must be reproducible from the canonical QMD, retained agent workspaces, and
verification records.

### Example: one theorem after prolonged work

Suppose the canonical project gives the agent one open theorem,
`@thm-main-uniform-index`:

```text
uniform-index-project/                     # canonical project workspace
├── AGENTS.md
├── _quarto.yml
├── index.qmd
├── notation.qmd
├── background.qmd
├── uniform-index.qmd                      # contains @thm-main-uniform-index
└── .qmd-prover/
    ├── manifest.json
    ├── graph.json
    ├── verification/                       # accepted canonical records
    └── workspaces/                         # visible working mathematics
        ├── .workspaces/                    # machine-managed workspace state
        │   ├── workspace.json              # target, base hashes, and status
        │   ├── verification/
        │   │   ├── lem-local-exponent-bound.json
        │   │   └── thm-main-uniform-index.json
        │   ├── target.qmd                   # protected snapshot of the goal
        │   └── graph.json                   # workspace dependency graph
        ├── progress.qmd                    # overall plan and proved frontier
        ├── context/
        │   ├── progress.qmd
        │   ├── imported-results.qmd     # bounded canonical context
        │   └── external-results.qmd     # precisely recorded literature
        ├── reductions/
        │   ├── progress.qmd
        │   ├── reduce-to-strata.qmd
        │   ├── generic-fiber.qmd
        │   └── specialization.qmd
        ├── local-theory/
        │   ├── progress.qmd
        │   ├── local-class-groups.qmd
        │   ├── exponent-bounds.qmd
        │   └── completion-comparison.qmd
        ├── global-theory/
        │   ├── progress.qmd
        │   ├── finite-stratification.qmd
        │   ├── constructibility.qmd
        │   └── lcm-argument.qmd
        ├── examples/
        │   ├── progress.qmd
        │   ├── quotient-singularities.qmd
        │   └── possible-counterexamples.qmd
        └── main-proof.qmd
```

This is an illustrative workspace, not a required list of subject directories.
The visible files under `workspaces/` are ordinary mathematical QMD organized
by the development itself. The hidden `workspaces/.workspaces/` directory is
reserved for machine-managed state: the protected target, base identities,
workspace graph, and workspace verification records. Project-level
`.qmd-prover/verification/` records accepted canonical mathematics, while the
workspace-local verification directory retains checks of provisional work.

A short proof may need only the hidden target snapshot, a top-level
`progress.qmd`, and one mathematical working file. A long proof may grow into a
substantial mathematical development. Top-level `progress.qmd` records the
overall frontier; a subject directory may carry its own `progress.qmd` when a
local frontier is useful. Attempts, abandoned routes, and submission candidates
remain ordinary mathematical QMD; they do not require dedicated file types or
directories. Verification records are the only proof-development artifacts
with a dedicated non-QMD format.

The agent may group several closely related claims, partial proofs, rejected
proofs, and explanatory prose in one QMD file or split a large line of argument
across many files. It should follow the structure already present in the
workspace rather than creating one file for every transient thought.

### Workspace dependency model

The inspector treats the agent workspace as a provisional mathematical
project. Its graph may contain:

- verified results imported from the canonical project;
- new workspace results that have been proved and independently checked;
- conjectural intermediate results still awaiting proof;
- alternative approaches to the same subgoal; and
- a candidate proof of the original main theorem.

For example, the workspace may discover the following chain:

```text
@thm-main-uniform-index
  -> @lem-finite-stratification
  -> @lem-local-exponent-bound
  -> @lem-completion-preserves-index
  -> @thm-canonical-local-class-group-finite
```

The agent can work backward from an unproved dependency, replace a failed
intermediate claim, or preserve a dead end without disturbing canonical QMD.
The workspace graph makes the current proof frontier explicit after many
sessions.

### Promotion into the canonical project

Workspace files are not automatically part of the user's Quarto project. A
workspace result crosses the boundary only through the proving utilities:

1. Select one complete new result or one proof candidate from the workspace.
2. Check it against the discipline and the dependencies cited in its proof.
3. Verify it independently.
4. Reject it without changing canonical QMD, or accept it atomically.
5. Place an accepted new lemma in the canonical project according to project
   policy, or apply an accepted proof to its existing canonical theorem.
6. Reinspect both spaces so the workspace can depend on the newly accepted
   canonical result.

Not every workspace theorem needs promotion. Auxiliary experiments, abandoned
claims, and lemmas that are eventually inlined may remain in the workspace.
Every dependency cited by the final canonical proof, however, must also be
available in the canonical project and have the required verification status.

The files have different ownership:

- `AGENTS.md` is project-owned policy. It contains the unchanged managed
  qmd-prover contract plus optional local rules.
- QMD files outside `.qmd-prover/` are canonical mathematics and exposition.
- `_quarto.yml` is the project's normal Quarto configuration.
- `.qmd-prover/workspaces/` contains persistent but noncanonical mathematical
  work, with machine state isolated under its `.workspaces/` child.
- Project verification JSON records accepted canonical results; workspace
  verification JSON retains accepted and rejected checks of provisional work.
- Other `.qmd-prover/` files contain derived indexes and caches.

## Semantic QMD and inspection

The inspector parses ordinary canonical and workspace QMD through Pandoc JSON.
It recognizes definitions, lemmas, theorems, their linked proofs, semantic
imports and exports, and the reserved `OPEN`, `REJECTED`, `VERIFIED`, and
`REVOKED` markers. All other Quarto content remains ordinary document content.

A semantic `@` reference inside a definition construction or linked proof is a
logical dependency. The inspector first checks by program that the referenced
fact exists, is unique, is available through local scope or an explicit import,
and has usable status. It then asks an independent AI checker whether the
referenced facts are sufficient for that exact construction or proof. A
reference in ordinary exposition is navigational, and a bibliographic citation
is not a theorem dependency.

For example, the proof below has direct dependencies on both referenced facts:

```markdown
::: {#lem-square-of-double .lemma name="Square of a double" date="2026-07-12" export="square-of-double"}
If \(n=2k\) for integers \(n,k\), then \(n^2=4k^2\).
:::

::: {.proof of="lem-square-of-double"}
Using @def-even-integer and @lem-product-calculation, calculate
\(n^2=(2k)^2=4k^2\).
:::
```

Cross-file availability remains explicit and individual:

```yaml
qmd-prover:
  imports:
    - from: foundations.qmd
      use:
        - def-even-integer
        - lem-product-calculation
```

Wildcard imports are not supported. Imports determine availability; semantic
references determine the dependency edges actually used.

### Inspection scopes

The inspector supports four related scopes:

- one theorem, lemma, or definition;
- every fact in one file or recursively discovered folder;
- every mathematical QMD file in a workspace; and
- graph analysis and search over the latest complete snapshot.

Each broader scope runs the same fact-level programmatic and AI checks. Stable
JSON is the default output. `--print` selects a human-readable report containing
statuses, diagnostics, dependency paths, frontiers, and relevant graph edges;
it does not change the check result.

### Verification status

`OPEN` and `REJECTED` are conservative workflow markers. `VERIFIED` and
`REVOKED` are record-backed markers and are excluded from the mathematical
identity checked by AI.

- `open`: a required proof or construction is absent or begins with `OPEN`;
- `candidate`: complete unmarked mathematics awaits checking;
- `rejected`: the retained attempt begins with `REJECTED` or has a matching
  rejection report;
- `verified`: `VERIFIED` matches the exact statement or construction, proof,
  dependency snapshot, and accepted record; and
- `revoked`: `REVOKED` matches a prior acceptance and a revocation record with
  a concrete reason.

The inspector may cause `VERIFIED` to be added only after every reference check
passes, the independent AI check reports no critical errors or gaps, the exact
cache and record are stored, and post-write inspection confirms the result. A
missing, corrupt, stale, or nonmatching record makes a record-backed marker
unusable.

### Dependency analysis and search

An edge points from a definition or result to the fact cited by its construction
or proof. From the graph, the inspector provides direct and transitive
dependencies, reverse dependencies, paths, cycles, impact analysis, and proof
frontiers. The frontier of a selected theorem contains its lowest unresolved
claims, rather than every unverified node in its closure.

Search can match semantic ID, title, mathematical text, kind, file or folder,
status, and canonical or workspace origin. Graph-aware search can restrict
results to dependencies, reverse dependencies, frontier nodes, stale facts, or
cycle members.

### Staleness and transitive invalidation

Successful inspection caches the exact statement or definition construction,
proof, referenced fact identities, scope, dependency snapshot, AI check, and
verification record. Before relying on `VERIFIED`, the inspector reparses the
requested scope and compares the current mathematics with that cache.

If a checked fact changed, qmd-prover removes its `VERIFIED` marker and marks
its record stale. It then follows reverse-dependency edges and removes
`VERIFIED` from every fact that directly or transitively relied on the changed
fact. Upstream premises are not invalidated merely because a downstream fact
changed. Marker removals, stale-record updates, and graph publication are one
atomic operation and roll back together on failure.

Staleness does not add `REVOKED`; explicit revocation requires a concrete
recorded reason. The canonical mathematical-project `AGENTS.md` contract
requires the stale check before using verified mathematics and forbids agents
from manually adding or restoring `VERIFIED`.

## How proof work proceeds

For a typical request, the host agent follows this loop:

1. Load the qmd-prover skill.
2. Read the project's `AGENTS.md` and confirm that its managed qmd-prover
   contract matches the canonical contract shipped with the skill.
3. Run the stale check before relying on any `VERIFIED` fact.
4. Inspect the selected fact, file or folder, or complete workspace. Stop on
   programmatic reference errors or unsafe stale state.
5. Create or resume the workspace for the selected goal, recording the exact
   canonical target and dependency snapshot.
6. Use dependency search and frontier analysis to choose the lowest useful
   unresolved claim.
7. Develop its construction or proof in workspace QMD, citing each dependency
   with a semantic reference at its point of use.
8. Inspect that fact. The programmatic reference check must pass before the
   independent AI sufficiency check runs.
9. If the AI check reports a critical error or gap, preserve the report, retain
   the rejected attempt when useful, repair the mathematics, and inspect again.
10. If both checks pass, atomically cache the exact mathematics and dependency
    snapshot, store the matching record, add `VERIFIED`, and confirm the result
    by reinspection.
11. Use the proving utilities to promote accepted workspace mathematics into
    canonical QMD through the protected atomic write path.
12. Continue until the original main theorem is verified or the work reaches
    another legitimate stopping condition.
13. Run `quarto render` when the user wants a rendered document or project
    view.

This is a loop performed by the host agent under skill instructions. It is not
a loop implemented by a qmd-prover daemon or coordinator.

## Installation and requirements

The skill and runtime are self-contained under `skills/qmd-prover/`. The
runtime has no third-party Node dependencies.

The expected environment provides:

- Node.js 20 or later;
- Pandoc on `PATH`, or `QMD_PROVER_PANDOC` pointing to a compatible executable;
- Quarto when rendered output is wanted; and
- an independent verifier configured through `QMD_PROVER_VERIFIER` or the
  project's qmd-prover configuration.

From a source checkout, install the skill with:

```bash
npm run install:skill
```

This copies `skills/qmd-prover/` to
`${CODEX_HOME:-~/.codex}/skills/qmd-prover`. The installed skill contains its
instructions, canonical discipline reference, and Node utilities.

## Starting a mathematical project

To use qmd-prover in a Quarto project:

1. Create or choose the project's root `AGENTS.md`.
2. Copy the managed block from the installed skill's
   `references/AGENTS.md` into the project file unchanged.
3. Add any project-specific notation, writing, or organization rules outside
   the managed block.
4. Write one or more QMD files containing semantic definitions, results, and
   open `thm-main-*` goals.
5. Configure an independent verifier before asking for proof acceptance.

The host agent checks the contract before it mutates QMD or qmd-prover state.
If the contract is absent or different, it explains the mismatch and asks for
permission before creating or synchronizing project policy.

## Using qmd-prover through Codex or Claude Code

Natural language is the normal interface. Once the skill is installed and the
mathematical project is open, a user can ask:

```text
Use qmd-prover to inspect this project and prove @thm-main-even-square.
Preserve the statement, verify the candidate independently, and repair any
concrete gaps before accepting it.
```

For project status and dependency analysis:

```text
Use qmd-prover to inspect this workspace, print the dependency information, and
show the proof frontier of @thm-main-even-square.
```

For search:

```text
Use qmd-prover to find unverified lemmas used transitively by
@thm-main-even-square.
```

For presentation:

```text
Render the Quarto project and show me the current proof progress.
```

The host agent loads `SKILL.md`, performs the contract preflight, invokes the
Node utilities, interprets their JSON, writes mathematical workspace QMD, and
explains the result in ordinary language. The user does not need to memorize
script operations.

The host may use its own sub-agent mechanism for independent verification or
parallel mathematical exploration when the user requests it. Those sub-agents
belong to the host environment; qmd-prover does not maintain a worker runtime.

## Using the Node utilities directly

A user or maintainer may invoke the same operations directly with Node. From
the mathematical project root, let the installed skill path be:

```bash
QMD_PROVER_ROOT="${CODEX_HOME:-$HOME/.codex}/skills/qmd-prover"
```

Inspect the canonical project and print its dependency information:

```bash
node "$QMD_PROVER_ROOT/scripts/qmd-prover.mjs" inspect-project --print
```

Inspect one theorem, lemma, or definition:

```bash
node "$QMD_PROVER_ROOT/scripts/qmd-prover.mjs" \
  inspect-theorem @thm-main-even-square --print
```

Inspect one file or folder:

```bash
node "$QMD_PROVER_ROOT/scripts/qmd-prover.mjs" \
  inspect-path foundations/ --print
```

Inspect every mathematical file in the workspace:

```bash
node "$QMD_PROVER_ROOT/scripts/qmd-prover.mjs" \
  workspace inspect --print
```

Find a proof frontier or search the dependency graph:

```bash
node "$QMD_PROVER_ROOT/scripts/qmd-prover.mjs" \
  dependency frontier @thm-main-even-square --print
node "$QMD_PROVER_ROOT/scripts/qmd-prover.mjs" \
  dependency search "local exponent" --kind lemma --print
```

Check cached identities and invalidate stale verification transitively:

```bash
node "$QMD_PROVER_ROOT/scripts/qmd-prover.mjs" \
  check-staleness --print
```

Submit the selected candidate from workspace QMD:

```bash
node "$QMD_PROVER_ROOT/scripts/qmd-prover.mjs" \
  submit-proof .qmd-prover/workspaces/main-proof.qmd
```

Read a stored verification report:

```bash
node "$QMD_PROVER_ROOT/scripts/qmd-prover.mjs" \
  verification show SUBMISSION_ID
```

Revoke an accepted verification only with a concrete reason:

```bash
node "$QMD_PROVER_ROOT/scripts/qmd-prover.mjs" \
  verification revoke @thm-main-even-square --reason "The dependency was invalidated"
```

Revocation atomically replaces the proof's `VERIFIED` marker with `REVOKED`
and publishes the matching revocation record with its concrete reason.

These operations expose the skill's tool protocol; they are not a separately
designed interactive CLI. Their JSON output is stable so a host agent can call
them reliably. Structural diagnostics use a nonzero exit status.

Submitting a candidate is intentionally stronger than copying its proof into a
canonical QMD file: it checks structure and dependencies, invokes the
independent verifier, rejects stale work, and performs the canonical update
only after acceptance. "Proposal" names this submission action, not a distinct
file type.

## Rendering with Quarto

Render the mathematical project with its normal Quarto configuration:

```bash
quarto render
```

qmd-prover does not render an alternative site. The canonical theorem blocks,
proofs, equations, and cross-references remain part of the QMD documents that
Quarto reads.

When additional observability is desired, inspector data may be exposed as
generated QMD, a dependency-graph asset, or data consumed by a Quarto
extension. These are inputs to the same `quarto render` pipeline. HTML may
provide richer navigation than PDF, but correctness and verification do not
depend on rendering.

## Further design documents

- [Discipline design](design-discipline.md) explains policy ownership,
  categories of rules, and contract evolution.
- [Inspector design](design-inspector.md) explains fact, path, and workspace
  inspection; dependency analysis and search; and stale-marker invalidation.
- [Proving utilities design](design-proving.md) explains candidate submission,
  independent verification, rejection, stale checks, and atomic acceptance.
- [Rendering design](design-rendering.md) explains how observability integrates
  with the ordinary Quarto pipeline.
