# DESIGN.md — qmd-prover

## 1. Purpose

qmd-prover is a Quarto-based, agentic mathematical prover operated through
Codex, Claude, or another coding agent.

A qmd-prover project contains a dedicated `AGENTS.md` that defines how agents
must read, write, check, and submit mathematics. The user writes one or more
facts that need proofs as theorem blocks whose identifiers follow the
convention:

```text
thm-main-*
```

Examples:

```text
thm-main-uniform-index
thm-main-matroid-bound
thm-main-asymptotic-limit
```

The `main` prefix means that the statement is a user-given fact to be proved;
it does not mean that the fact is already known to be true. The user then asks
an agent in natural language to prove one theorem or all open theorems. The
agent follows the project instructions and repeatedly applies the centralized
`math-doc-reader` skill until it reaches a terminal state.

During this iterative proof-search workflow, agents may:

- Inspect the mathematical modules available to the project.
- Search definitions, lemmas, and theorems.
- Decompose goals into intermediate lemmas.
- Attempt constructive and refutational approaches.
- Add candidate lemmas.
- Submit candidate proofs for independent verification.
- Repair rejected proofs.
- Continue until each main theorem is proved, refuted, or explicitly stopped.

The system combines:

1. Human-readable QMD mathematical documents.
2. Explicit theorem imports and dependencies.
3. A compiler-like structural checker.
4. Persistent agent workflows and task state.
5. An independent mathematical verification gate.
6. Interactive theorem navigation and dependency graphs.

Humans are not expected to invoke scripts. Natural language is the human
interface. Deterministic operations are subcommands of one Node dispatcher
bundled with the globally installed `math-doc-reader` skill.

The system is an agentic informal prover, not initially a formal proof assistant such as Lean. "Verified" means accepted by the configured verification backend. The architecture should allow a formal backend to be added later.

---

## 2. Design principles

### 2.1 Human-readable mathematics is the canonical source

Definitions, lemmas, theorems, proofs, imports, motivation, examples, and diagrams live in QMD files.

The mathematical project should remain pleasant for humans to read and edit.

### 2.2 A small semantic layer exists inside unrestricted QMD

Authors may use arbitrary Quarto content. Only recognized blocks participate in dependency checking:

- Import blocks.
- Definitions.
- Lemmas.
- Theorems.
- Optionally propositions and corollaries.

Everything else remains visible to readers but is invisible to the semantic checker.

### 2.3 Main theorem statements are user-owned

An agent must never silently alter the statement, hypotheses, or identifier of a `thm-main-*` goal.

The system records a normalized statement hash and rejects unauthorized statement mutations.

### 2.4 Verification controls truth

Agents can propose mathematics, but they cannot mark their own work verified.

Only the verifier may transition a result to `verified`.

### 2.5 Parallel agents must not edit canonical files concurrently

Workers create isolated proposals. Accepted proposals are merged into canonical QMD files through one controlled, atomic write path.

### 2.6 Dependencies must be explicit

If a proof uses another result, it must cite it with a semantic `@` reference.

No proof may rely on assumptions supplied only by surrounding narrative prose.

### 2.7 The system should feel like a compiler

The centralized skill's project inspection command:

```bash
node ~/.codex/skills/math-doc-reader/scripts/qmd-prover.mjs inspect-project
```

includes a structural check that should play a role analogous to `tsc`:

- Parse every module.
- Resolve imports.
- Resolve semantic references.
- Build the dependency graph.
- Reject duplicate or missing identifiers.
- Reject cycles.
- Detect malformed semantic blocks.
- Detect illegal mutation of user goals.
- Produce precise, source-located diagnostics.

Agents invoke this dispatcher only after reading the skill. It is not part of
the normal human workflow, and the mathematical project does not contain its
own executable or skill folders.

### 2.8 Natural language is the user interface

The user should be able to say, for example:

```text
Prove all the open main theorems in this project. Use several workers, keep
the theorem statements unchanged, and continue repairing rejected proofs.
```

The agent interprets the request, reads `AGENTS.md`, loads the
`math-doc-reader` skill, and invokes its dispatcher when needed. Human-facing
documentation should describe goals and outcomes, not require the user to
learn script paths or arguments.

---

## 3. User experience

A project starts with a dedicated `AGENTS.md` and any mathematical files the
user already has. Project setup may itself be performed by an agent. The user
writes several goals, either at the root or in subject folders that make sense
for the mathematics:

```text
uniform-index.qmd
matroids/bound.qmd
asymptotics/limit.qmd
```

Each goal contains a `thm-main-*` theorem block with a statement and an empty
proof. The user then makes a natural-language request such as:

```text
Prove all the open main theorems. Work in parallel where the goals are
independent, verify every candidate proof, and keep going until each goal is
proved, refuted, or genuinely blocked.
```

For a single theorem, the user may say:

```text
Prove @thm-main-uniform-index. Try the local class-group approach first and
record useful failed approaches so a later session can continue.
```

The agent reads `AGENTS.md`, inspects the goals through the centralized skill,
runs structural checks, coordinates any workers, submits candidate proofs for
verification, and repairs rejected attempts. The user may ask for status,
reports, graphs, or a rendered site in ordinary language at any time.

When the user asks the agent to render the accepted work, the website provides:

- Readable mathematical exposition.
- Clickable theorem references.
- Hover previews.
- Goal status.
- Interactive dependency graphs.
- Links from graph nodes to theorem statements.

---

## 4. Project structure

The project reserves exactly one auxiliary directory: `.qmd-prover/`. It does
not require `goals/`, `modules/`, `generated/`, `.agents/`, or another fixed
content taxonomy.

```text
my-math-project/
├── AGENTS.md
├── uniform-index.qmd
├── matroids/                 # optional; created when useful
│   └── bound.qmd
├── asymptotics/              # optional; created when useful
│   └── limit.qmd
├── .qmd-prover/
│   ├── config.yml
│   ├── _quarto.yml
│   ├── manifest.json
│   ├── graph.json
│   ├── goal-locks.json
│   ├── events.jsonl
│   ├── tasks/
│   ├── workers/
│   │   ├── worker-1/
│   │   │   ├── TASK.md
│   │   │   ├── local-memory.jsonl
│   │   │   └── logs/
│   │   └── worker-2/
│   ├── proposals/
│   ├── verification/
│   ├── accepted/
│   ├── rejected/
│   ├── dead-ends/
│   ├── reports/
│   ├── graphs/
│   ├── site/
│   └── cache/
```

### 4.1 Canonical versus runtime content

Canonical, version-controlled content consists only of `AGENTS.md` and the
human-readable mathematical sources. Their organization is project-specific:

```text
AGENTS.md
*.qmd
optional subject folders created according to AGENTS.md
```

All configuration, indexes, worker state, proposals, verifier records,
generated graphs, reports, rendered output, and caches live under:

```text
.qmd-prover/
```

The agent may create a subject folder such as `matroids/` when several related
theorems should live together, but it must follow the organization rules in
`AGENTS.md` rather than a framework-imposed directory scheme. `.qmd-prover/`
should normally be ignored by Git unless the project explicitly preserves
proof-search traces or generated artifacts.

---

## 5. QMD semantic format

### 5.1 User-supplied goal

```markdown
---
title: "Uniform Cartier Index"
---

This problem asks whether a uniform index exists in the given family.

::: {#thm-main-uniform-index .theorem .goal}
## Uniform index theorem

### Statement

Let \(\pi\colon X\to B\) be a projective family satisfying the stated
hypotheses. There exists an integer \(I>0\) such that the total Cartier
index of every admissible fiber \(X_b\) divides \(I\).

### Proof

:::
```

An empty proof means the goal is open.

The statement is user-owned. Once indexed, its normalized hash is recorded:

```json
{
  "id": "thm-main-uniform-index",
  "statement_hash": "sha256:...",
  "origin": "user",
  "status": "open"
}
```

### 5.2 Definition

```markdown
::: {#def-total-cartier-index .definition export="total-cartier-index"}
## Total Cartier index

### Statement

The total Cartier index of a normal variety \(X\) is the least common
multiple of the Cartier indices of all \(\mathbb Q\)-Cartier Weil
divisors on \(X\).
:::
```

### 5.3 Lemma

```markdown
::: {#lem-local-exponent-bound .lemma export="local-exponent-bound"}
## Local exponent bound

### Uses

- @def-total-cartier-index
- @thm-local-class-group-finite

### Statement

The exponent of the local class group is bounded by \(N\).

### Proof

By @thm-local-class-group-finite, the local class group is finite.
Applying @lem-determinant-bound to its presentation matrix gives the
claimed bound.
:::
```

### 5.4 Proved main theorem

```markdown
::: {#thm-main-uniform-index .theorem .goal}
## Uniform index theorem

### Statement

Let \(\pi\colon X\to B\) be ...

### Uses

- @lem-local-exponent-bound
- @lem-finite-stratification

### Proof

Apply @lem-local-exponent-bound on each stratum supplied by
@lem-finite-stratification, and take the least common multiple of the
finitely many resulting bounds.
:::
```

The presence of a proof makes the block a candidate, not automatically verified.

---

## 6. Imports

```markdown
::: {.theorem-imports}
from: foundations/local-groups.qmd
use:
  - @def-local-class-group
  - @thm-local-class-group-finite
:::
```

Aliases may be supported:

```markdown
::: {.theorem-imports}
from: foundations/local-groups.qmd
use:
  - ref: @thm-local-class-group-finite
    as: @thm-local-finiteness
:::
```

Import rules:

1. Imports are explicit.
2. Wildcard imports are initially forbidden.
3. Imported IDs must exist and be exported.
4. Alias collisions are errors.
5. Missing modules are errors.
6. Import cycles are errors.
7. A theorem can depend only on:
   - results in its own module; or
   - explicitly imported results.
8. Imported verified results may be used as premises.
9. Imported open or rejected results may not support a verified proof.

---

## 7. Semantic references

Semantic references use reserved prefixes:

```text
@def-*
@lem-*
@thm-*
@prp-*
@cor-*
```

Inside a semantic block:

```text
@lem-local-bound
```

creates a logical dependency.

Outside a semantic block, the same reference is navigational only and does not create a dependency edge.

This paragraph therefore creates no proof dependency:

```markdown
For historical context, compare @thm-main-uniform-index.
```

This proof does create a dependency:

```markdown
### Proof

Apply @lem-local-bound.
```

Bibliographic citations remain separate:

```markdown
@kollar2016
```

Reserved semantic prefixes prevent ambiguity between theorem references and bibliography keys.

---

## 8. Semantic compiler

The semantic compiler reads QMD through Pandoc’s JSON AST or a Quarto/Pandoc Lua filter.

It must not parse QMD using regular expressions as its primary parser.

The compiler produces:

```text
.qmd-prover/manifest.json
.qmd-prover/graph.json
```

Example manifest entry:

```json
{
  "id": "thm-main-uniform-index",
  "kind": "theorem",
  "goal": true,
  "origin": "user",
  "file": "uniform-index.qmd",
  "title": "Uniform index theorem",
  "statement": "...",
  "statement_hash": "sha256:...",
  "proof": "...",
  "declared_uses": [
    "lem-local-exponent-bound",
    "lem-finite-stratification"
  ],
  "detected_references": [
    "lem-local-exponent-bound",
    "lem-finite-stratification"
  ],
  "status": "candidate"
}
```

### 8.1 Structural checking during project inspection

After loading the `math-doc-reader` skill, an agent invokes:

```bash
node ~/.codex/skills/math-doc-reader/scripts/qmd-prover.mjs inspect-project
```

As part of inspection, the dispatcher must validate:

- QMD parseability.
- Semantic block shape.
- Identifier prefixes.
- Duplicate identifiers.
- Missing imports.
- Missing exports.
- Alias collisions.
- Dependency cycles.
- References to unavailable results.
- Dependencies on rejected or revoked results.
- User-goal statement mutation.
- Candidate proofs missing cited dependencies.
- Declared `Uses` entries never used in the proof.
- Semantic references not declared in `Uses`.
- Open goals.
- Candidate proofs awaiting verification.

Example diagnostic:

```text
uniform-index.qmd:41:8 QMDP1004
Proof references @lem-local-bound, but that result is not imported into
this module.

Suggested fix:
  add @lem-local-bound to a theorem-imports block
```

Open goals are reported but do not necessarily make the structural check fail.
Structural errors must produce a nonzero script exit code that the invoking
agent can interpret and act on.

---

## 9. Goal state machine

Each theorem has one of these states:

```text
open
in-progress
candidate
verifying
verified
rejected
refuted
blocked
revoked
```

Transitions:

```text
open
  → in-progress
  → candidate
  → verifying
  → verified

candidate
  → verifying
  → rejected
  → in-progress

open or in-progress
  → refuted

verified
  → revoked
```

Only the verifier or verification service can set:

```text
verified
rejected
```

Only a controlled revocation operation can set:

```text
revoked
```

Agents may propose status changes but cannot write authoritative verification state directly.

---

## 10. Agent architecture

### 10.1 Main agent

The main agent coordinates all goals.

Responsibilities:

- Read the project `AGENTS.md` before changing mathematics.
- Run the centralized `inspect-project` command to check structure and status.
- Inspect every open `thm-main-*` goal.
- Decide which goals can be attempted independently.
- Decompose goals into subgoals.
- Assign workers to different directions.
- Avoid duplicated work.
- Monitor verification outcomes.
- Reassign workers after failures.
- Request final rendering once goals are verified.

The main agent should not directly mark mathematics verified.

### 10.2 Worker agents

Each worker receives:

```text
.qmd-prover/workers/<worker-id>/TASK.md
```

Example:

```markdown
# Assignment

Project: uniform-index
Target: @thm-main-uniform-index

Investigate whether the desired uniform bound follows from finiteness of
local class groups. Construct and prove any precise intermediate lemma
needed. Search existing project mathematics before creating a duplicate result.
```

Workers follow `AGENTS.md` and use the centralized skill and dispatcher to:

- Inspect the target.
- Inspect relevant mathematical files.
- View dependency closures.
- Search previous attempts and dead ends.
- Write isolated proposals.
- Submit proofs.
- Read verifier reports for rejected submissions.

### 10.3 Verifier agent

The verifier receives a clean, materialized verification bundle:

- Exact theorem statement.
- Candidate proof.
- Imported definitions.
- Statements of cited verified results.
- Source references.
- Declared hypotheses.
- No unrelated narrative content.
- No strategic instructions from the worker.

The verifier returns:

```json
{
  "verdict": "correct",
  "summary": "...",
  "critical_errors": [],
  "gaps": [],
  "repair_hints": ""
}
```

A theorem is accepted only when:

```text
critical_errors is empty
and
gaps is empty
and
verdict is correct
```

The verifier should be instantiated in a fresh context for every submission.

---

## 11. Agent workflow

After a natural-language proof request, the coordinating agent and each worker
follow this loop:

```text
1. Read AGENTS.md
2. Load the math-doc-reader skill
3. Run inspect-project
4. Inspect the assigned theorem and its dependency context
5. Review previous attempts and verifier reports
6. Develop the mathematics and write an isolated candidate proposal
7. Run submit-proof
8. If rejected, revise from the concrete verifier report and resubmit
9. If accepted, continue toward the parent theorem
10. Stop only when the target is verified, refuted, blocked, or cancelled
```

Workers should not restart from zero between sessions. Their local memory and the shared project event log provide continuity.

---

## 12. Centralized skill

qmd-prover is delivered as one standard Codex skill installed outside the
mathematical project:

```text
~/.codex/skills/math-doc-reader/
├── SKILL.md
├── agents/
│   └── openai.yaml
└── scripts/
    └── qmd-prover.mjs
```

`SKILL.md` tells the agent when to inspect a project, inspect one theorem,
submit a candidate, read verification output, or render results. All
deterministic behavior is centralized in `qmd-prover.mjs`; project directories
do not contain copies of the skill or its scripts.

---

## 13. Centralized command interface

The uniform invocation form is:

```bash
node ~/.codex/skills/math-doc-reader/scripts/qmd-prover.mjs <subcommand> [arguments]
```

The initial interface has five top-level subcommands:

```bash
node ~/.codex/skills/math-doc-reader/scripts/qmd-prover.mjs inspect-project
node ~/.codex/skills/math-doc-reader/scripts/qmd-prover.mjs inspect-theorem @thm-main-ID
node ~/.codex/skills/math-doc-reader/scripts/qmd-prover.mjs submit-proof PROPOSAL_FILE
node ~/.codex/skills/math-doc-reader/scripts/qmd-prover.mjs verification show SUBMISSION_ID
node ~/.codex/skills/math-doc-reader/scripts/qmd-prover.mjs render
```

- `inspect-project` discovers all QMD files regardless of folder layout,
  rebuilds the manifest and graph, performs structural validation, and returns
  goal and verification status.
- `inspect-theorem` returns a bounded context bundle containing the statement,
  imports, dependency closure, current proof, and verification history.
- `submit-proof` validates a candidate, materializes its dependencies, sends it
  to a fresh verifier, and atomically merges it only after acceptance.
- `verification show` returns the stored verifier report for a submission.
- `render` generates reports, dependency graphs, and the Quarto site under
  `.qmd-prover/`.

The `verification` namespace may also support controlled revocation without
adding another top-level command:

```bash
node ~/.codex/skills/math-doc-reader/scripts/qmd-prover.mjs verification revoke @thm-ID --reason "..."
```

Dispatcher requirements:

- Run from the project root.
- Accept explicit positional arguments or documented flags.
- Emit stable JSON on standard output when another operation consumes the
  result.
- Emit concise, source-located diagnostics on standard error.
- Return zero on success and nonzero on structural or operational failure.
- Write only documented runtime or proposal paths.
- Never modify a user-owned `thm-main-*` statement.
- Never set authoritative verification state directly.
- Be independently testable with Node.
- Keep all project-owned auxiliary output inside `.qmd-prover/`.

There is no separate `check`, `status`, `goals`, `deps`, `graph`, worker, or
`prove` command. Those behaviors are either folded into the five operations
above or remain part of the agent workflow described by `AGENTS.md`.

### 13.1 Goal-context operation

After loading the skill, an agent may invoke:

```bash
node ~/.codex/skills/math-doc-reader/scripts/qmd-prover.mjs inspect-theorem @thm-main-uniform-index
```

Output:

```text
Goal: @thm-main-uniform-index
Status: in-progress
Statement hash: sha256:...
Direct dependencies: 2
Verified dependencies: 1
Open dependencies: 1
Active workers: worker-1, worker-3
Latest rejection: missing justification in the codimension-three case
```

It should optionally emit a machine-readable JSON bundle:

```bash
node ~/.codex/skills/math-doc-reader/scripts/qmd-prover.mjs inspect-theorem @thm-main-uniform-index --json
```

### 13.2 Rendered dependency graph

`render` computes each main theorem's transitive dependency closure and writes:

```text
.qmd-prover/graphs/thm-main-uniform-index.qmd
```

---

## 14. Proposal and merge system

Workers must not directly edit canonical verified modules during parallel work.

A proposal contains:

```text
.qmd-prover/proposals/<proposal-id>/
├── proposal.qmd
├── metadata.json
└── supporting-notes.md
```

Example metadata:

```json
{
  "proposal_id": "proposal-20260711-0012",
  "worker": "worker-3",
  "target": "thm-main-uniform-index",
  "kind": "proof",
  "statement_hash": "sha256:...",
  "dependencies": [
    "lem-local-exponent-bound"
  ]
}
```

Submission flow:

```text
Worker proposal
    ↓
Structural checker
    ↓
Dependency materializer
    ↓
Fresh verifier
    ↓
Accepted or rejected
```

On acceptance:

- Existing theorem proof: atomically replace only the proof section.
- New lemma: create an appropriately named canonical QMD file in the location
  dictated by `AGENTS.md` and the surrounding mathematics.
- Record verification metadata separately.
- Rebuild the manifest and dependency graph.
- Preserve the user-owned statement exactly.

On rejection:

- Preserve the proposal.
- Store the verifier report.
- Return repair hints.
- Do not modify canonical mathematics.

---

## 15. Concurrency

Multiple workers may operate simultaneously, but:

- Each worker has a private workspace.
- Each proposal has a unique identifier.
- Canonical writes use file locks.
- Accepted results merge through one controlled path.
- A worker must rerun centralized `inspect-project` against the latest project
  state before submission.
- If a dependency changed after the proposal was created, submission is rejected as stale.
- Every state transition is appended to:

```text
.qmd-prover/events.jsonl
```

---

## 16. Dependency graphs and navigation

The rendered project must provide three connected views:

```text
Narrative exposition
        ↕
Definitions, lemmas, and theorems
        ↕
Interactive dependency graph
```

Ordinary references such as:

```markdown
@lem-local-bound
```

must use Quarto’s standard clickable cross-reference behavior.

For generated dependency graphs:

- Definitions, lemmas, and theorems use distinct node styles.
- Verified, candidate, rejected, and open nodes use distinct status styles.
- Clicking a node navigates to its semantic block.
- Hovering shows:
  - kind;
  - title;
  - statement;
  - status;
  - source module.
- HTML math should render in the popup when practical.
- Non-HTML formats receive a readable static graph and dependency list.

Do not assume Mermaid or Graphviz automatically turns `@thm-*` text into Quarto cross-references. The generator must emit explicit links and a stable project-owned hover implementation.

---

## 17. Configuration

Example `.qmd-prover/config.yml`:

```yaml
project:
  name: uniform-index
  root: ..
  discover-qmd-recursively: true
  exclude:
    - .qmd-prover

organization:
  source: AGENTS.md
  fixed-content-directories: false

goals:
  id-prefix: thm-main-
  protect-statements: true

semantic:
  definitions:
    - def-
  lemmas:
    - lem-
  theorems:
    - thm-
  propositions:
    - prp-
  corollaries:
    - cor-
  wildcard-imports: false
  require-declared-uses: true

verification:
  backend: codex
  model: configurable
  effort: high
  fresh-context: true
  require-zero-gaps: true

workers:
  default-count: 4
  round-timeout-seconds: 14400
  max-consecutive-failures: 5

render:
  graph-engine: graphviz
  hover-previews: true
  output-dir: .qmd-prover/site
```

Do not hardcode model names. Codex and Claude backends must be configurable.

---

## 18. `AGENTS.md` contract

Every project has a dedicated, version-controlled `AGENTS.md`. It is the
normative instruction file for any Codex, Claude, or other coding-agent session
working on the mathematics. A fresh agent must be able to operate the project
correctly by reading this file and the referenced skill instructions, without
requiring the user to explain script paths or arguments.

`AGENTS.md` also defines how canonical mathematics is organized. The agent may
create a new subject folder for a coherent group of related theorems, but no
folder taxonomy is imposed by qmd-prover.

At minimum, `AGENTS.md` must define the following contract.

### 18.1 Goal convention and ownership

- A semantic theorem whose identifier matches `thm-main-*` is a fact supplied
  by the user for the agent to prove or refute.
- `main` marks a top-level proof obligation, not an accepted premise.
- The theorem title, identifier, hypotheses, quantifiers, and statement body
  are user-owned and immutable during proof search.
- An empty `Proof` section means the goal is open.
- If the statement appears false, the agent must preserve it, construct a
  precise counterexample or obstruction, and submit a refutation report.
- Clarifying or changing a statement requires an explicit user decision.

### 18.2 Required proof-writing format

`AGENTS.md` must show agents the exact QMD shape to preserve and extend:

```markdown
::: {#thm-main-example .theorem .goal}
## Theorem title

### Statement

The user-owned statement. Do not edit this section.

### Uses

- @def-required-definition
- @lem-required-lemma

### Proof

Write a complete mathematical argument here. Introduce notation before use,
justify each nontrivial implication, and cite every logical dependency with a
semantic reference.
:::
```

For an agent-created reusable lemma:

```markdown
::: {#lem-descriptive-name .lemma export="descriptive-name"}
## Descriptive lemma title

### Uses

- @def-required-definition

### Statement

A precise statement with all hypotheses and quantifiers explicit.

### Proof

A complete proof that uses only declared, available results.
:::
```

Proof-writing rules:

1. Preserve the `Statement` section of every `thm-main-*` block byte-for-byte
   except for an explicitly authorized formatting-only normalization.
2. Put logical dependencies in `Uses` and cite them where they are applied in
   `Proof`; do not list merely related reading.
3. Use semantic blocks for reusable definitions, lemmas, propositions,
   corollaries, and theorems.
4. State all new intermediate results precisely, including hypotheses,
   domains, quantifiers, and exceptional cases.
5. Write proof prose that is self-contained relative to declared imports. Do
   not use surrounding exposition, intuition, examples, computation, or an
   unverified open goal as an unstated premise.
6. Distinguish a proof from evidence. Numerical checks and examples may guide
   proof search but cannot replace a general argument.
7. Cite external results precisely and record enough bibliographic information
   to check the quoted statement and its hypotheses.
8. Do not write `verified`, acceptance metadata, or verifier conclusions into
   the proof. Verification state is maintained separately.

### 18.3 Required agent loop

`AGENTS.md` must instruct the agent to:

1. Read `AGENTS.md` and load the centralized `math-doc-reader` skill before
   acting.
2. Run `inspect-project` to discover all QMD files, inspect status, and
   structurally validate the current tree.
3. Discover the requested open `thm-main-*` goals and protect their statements.
4. Search existing mathematical files, imports, accepted results, and prior failed
   approaches before introducing new mathematics.
5. Develop the proof using ordinary agent reasoning.
6. Create precise intermediate lemmas only when they advance a main goal.
7. Write work in an isolated proposal when concurrency or verification requires
   it.
8. Submit the proposal through the centralized `submit-proof` command for
   structural validation and independent verification.
9. Repair concrete gaps without discarding valid progress, and record
   meaningful dead ends for later sessions.
10. Continue until the assigned goal is verified, refuted, genuinely blocked,
    cancelled, or explicitly stopped by the user.

### 18.4 Skill and command boundary

`AGENTS.md` tells agents to use the globally installed `math-doc-reader` skill.
The skill may invoke its centralized `qmd-prover.mjs` dispatcher, but
`AGENTS.md` must not instruct the human to run that command. Agents translate
command output into concise natural-language status, decisions, and requests
for user input when needed.

The contract must also state that agents cannot mark their own mathematics
verified and cannot bypass the proposal, verification, or controlled merge
path.

---

## 19. Correctness and trust

The system must distinguish:

```text
structurally valid
mathematically candidate
LLM-verified
formally verified
human-reviewed
```

These statuses must never be conflated.

Suggested verification metadata:

```json
{
  "structural_status": "valid",
  "proof_status": "verified",
  "verification_backend": "codex",
  "formal_backend": null,
  "human_review": false
}
```

A future Lean or other formal backend should be able to upgrade a result without redesigning the QMD module system.

---

## 20. Testing requirements

Implement tests for:

- Semantic AST extraction.
- Ignoring arbitrary non-semantic QMD.
- Discovery and loading of the project `AGENTS.md` contract.
- Validation of the required proof-writing format documented by `AGENTS.md`.
- User goal discovery through `thm-main-*`.
- Empty goal proof detection.
- User statement mutation detection.
- Definition, lemma, and theorem extraction.
- Same-file references.
- Cross-file imports.
- Import aliases.
- Missing imports.
- Duplicate IDs.
- Alias collisions.
- Import cycles.
- Theorem dependency cycles.
- Logical references inside semantic blocks.
- Navigational references outside semantic blocks.
- Manifest determinism.
- Goal state transitions.
- Proposal isolation.
- Atomic accepted-proof merge.
- Rejected proposals not modifying canonical files.
- Concurrent proposal submission.
- Stale dependency rejection.
- Transitive graph generation.
- Clickable graph nodes.
- Hover-preview metadata.
- HTML escaping.
- Natural-language proof requests triggering the centralized skill.
- Centralized dispatcher invocation without requiring human command input.
- Recursive QMD discovery in arbitrary agent-organized subject folders.
- All auxiliary writes remaining inside `.qmd-prover/`.
- Agent workflow from open goal to accepted proof.

Provide a complete end-to-end fixture with:

- At least three QMD modules.
- At least two `thm-main-*` goals.
- Shared definitions.
- Several intermediate lemmas.
- One accepted proof.
- One rejected proof followed by a repair.
- A generated interactive graph.
- A rendered Quarto website.

---

## 21. Implementation phases

### Phase 1: Semantic compiler

Implement:

- Structured QMD parsing.
- Semantic blocks.
- Imports.
- Reference resolution.
- Manifest.
- Dependency graph.
- Centralized `qmd-prover.mjs` with `inspect-project` and `inspect-theorem`.

### Phase 2: Proposal and verification system

Implement:

- Proposal directories.
- Submission.
- Verification backend interface.
- Fresh verifier sessions.
- Accepted and rejected result storage.
- Atomic merge.
- Goal state machine.

### Phase 3: Agent workflow

Implement:

- A complete project `AGENTS.md`, including proof-writing format and workflow.
- The centralized `math-doc-reader` skill and dispatcher.
- Worker workspaces.
- Task assignment.
- Persistent local and shared state.
- Multi-worker orchestration.

### Phase 4: Quarto interface

Implement:

- Rendered theorem navigation.
- Dependency-graph pages.
- Clickable nodes.
- Full hover previews.
- Status styling.
- Reports.

### Phase 5: Hardening

Implement:

- Concurrency locks.
- Stale proposal detection.
- Revocation.
- Dependency invalidation.
- Security checks.
- Formal-verifier extension point.

---

## 22. Acceptance criteria

The implementation is complete when a user can:

1. Open a project that contains `AGENTS.md`, mathematical QMD files, and no
   required framework folders other than `.qmd-prover/`.
2. Write several facts needing proof as empty `thm-main-*` theorem blocks.
3. Ask Codex or Claude in natural language to prove one named goal or all open
   goals, without learning script paths or arguments.
4. Have the agent read `AGENTS.md`, load the centralized skill, inspect the
   project, and protect every user-owned theorem statement.
5. Ask the agent to use several workers when proof directions are independent.
6. Have workers create precisely formatted intermediate lemmas and candidate
   proofs with explicit semantic dependencies.
7. Have the agent structurally check and independently verify every candidate.
8. Merge only accepted mathematics and preserve rejected attempts for repair.
9. Continue proof search across fresh agent sessions without restarting from
   zero.
10. Ask for status, proof reports, dependency graphs, or site rendering in
    natural language.
11. Read a rendered Quarto website with clickable theorem references and hover
    previews.
12. Explore the dependency graph of any main theorem.
13. Clearly distinguish open, candidate, verified, rejected, refuted, and
    blocked results.

---

## 23. Instructions to the implementation agent

Inspect the existing repository before making architectural changes. Reuse existing conventions where appropriate.

Implement the system rather than only describing it.

Prioritize:

1. Correct semantic parsing.
2. Protected user goals.
3. Deterministic dependency checking.
4. Safe proposal and verification workflow.
5. A precise `AGENTS.md` proof-writing contract and one centralized skill.
6. Multi-agent resumability.
7. Readable Quarto output.
8. Interactive dependency navigation.

After implementation:

- Run all tests.
- Create the demonstration project.
- Launch at least one complete proof workflow using a test or mock verifier.
- Render the site.
- Verify graph clicking and hovering in a browser.
- Document natural-language usage for humans and dispatcher behavior for skill
  authors.
- Report remaining limitations honestly.

---

## 24. Future directions

Future versions may add optional proof-guidance tools:

- `decompose-goal` and `search-mathematics` for planning and literature search.
- `construct-examples` and `construct-counterexamples` for testing claims.
- `direct-proving` and `repair-proof` for drafting or revising arguments.

These tools are not part of the initial command interface or project structure.
They should be considered only after the centralized inspection, submission,
verification, and rendering workflow is reliable.
