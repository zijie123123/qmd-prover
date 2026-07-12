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
2. [Inspector](design-inspector.md) parses the project, checks the mechanically
   enforceable discipline, and exposes theorem dependencies and status.
3. [Proving utilities](design-proving.md) help the host agent prepare,
   independently verify, repair, and safely accept a proof.
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
| discipline -> inspector -> proving utilities          |
|                        |                              |
|                        +----> QMD project             |
+-------------------------------------------------------+
                                  |
                                  v
                              Quarto render        (outside qmd-prover)
```

Codex or Claude Code is not a qmd-prover component. It decides how to reason,
how long to continue, and whether to use host-provided sub-agents. Quarto is
also not implemented by qmd-prover; it consumes the resulting QMD project.

## Mathematical project model

A qmd-prover project is an ordinary Quarto project with a mathematical
discipline and a small amount of derived proof state. A minimal project looks
like this:

```text
my-mathematics/
├── AGENTS.md
├── _quarto.yml
├── foundations.qmd
├── main-results.qmd
└── .qmd-prover/
    ├── manifest.json
    ├── graph.json
    ├── proposals/
    └── verification/
```

The user chooses the QMD filenames and directory organization. qmd-prover does
not prescribe subject directories. The project's local policy in `AGENTS.md`
may do so.

The files have different ownership:

- `AGENTS.md` is project-owned policy. It contains the unchanged managed
  qmd-prover contract plus optional local rules.
- QMD files are canonical mathematics and exposition.
- `_quarto.yml` is the project's normal Quarto configuration.
- `.qmd-prover/` contains derived indexes, isolated proposals, and verification
  records. It does not contain a second canonical copy of the mathematics.

## Semantic QMD

qmd-prover pays attention only to recognized semantic blocks. The rest of QMD
remains ordinary Quarto content, including prose, equations, figures, code
cells, and bibliographic citations.

### Open main goal

A user creates a top-level proof obligation with a protected `thm-main-*` ID.
An empty `Proof` section means that the goal is open:

```markdown
::: {#thm-main-even-square .theorem .goal}
## Even squares

### Statement

For every even integer \(n\), the integer \(n^2\) is divisible by \(4\).

### Proof

:::
```

The ID, title, hypotheses, quantifiers, and statement are user-owned. The host
agent may supply a proof but may not make the goal easier by changing any of
those protected parts.

### Reusable result

Definitions, lemmas, propositions, theorems, and corollaries use corresponding
semantic classes and ID prefixes. A reusable result declares every logical
premise in `Uses` and cites the premise where it is applied:

```markdown
::: {#lem-square-of-double .lemma export="square-of-double"}
## Square of a double

### Uses

- @def-even-integer

### Statement

If \(n=2k\) for integers \(n,k\), then \(n^2=4k^2\).

### Proof

Using the representation from @def-even-integer, calculate
\(n^2=(2k)^2=4k^2\).
:::
```

The `export` attribute makes the result eligible for explicit use from another
file. Results in the same file are locally available without an import.

### Cross-file dependency

A theorem imports individual exported results:

```markdown
::: {.theorem-imports}
from: foundations.qmd
use:
  - @def-even-integer
  - @lem-square-of-double
:::
```

Wildcard imports are not part of the semantic model. An imported ID must exist
in the named file and must be exported there.

### Candidate proof

A complete candidate preserves the main goal and makes its dependencies
explicit:

```markdown
::: {#thm-main-even-square .theorem .goal}
## Even squares

### Statement

For every even integer \(n\), the integer \(n^2\) is divisible by \(4\).

### Uses

- @def-even-integer
- @lem-square-of-double

### Proof

Let \(n\) be even. By @def-even-integer, write \(n=2k\) for an integer
\(k\). Then @lem-square-of-double gives \(n^2=4k^2\), so \(4\) divides
\(n^2\).
:::
```

This text is a candidate, not a verified proof. Acceptance requires a separate
verification step.

## Dependencies

A logical dependency must satisfy all of the following:

1. It appears in the result's `Uses` section.
2. It is cited with a semantic `@` reference at the point of use in the proof.
3. It is defined in the same file or individually imported from another file.
4. A proof being accepted relies only on dependencies with an acceptable
   verification status.

The inspector checks these conditions and constructs a directed graph. An edge
from theorem A to lemma B means that A uses B. From this graph the inspector
can provide both the dependency closure needed to understand A and the reverse
dependencies that may be affected if B changes.

Semantic references in ordinary exposition are navigational rather than
logical dependencies. Bibliographic citations remain Quarto citations and are
not confused with theorem IDs.

## Result status

Status is derived from the current QMD and retained verification records; it is
not a label that an author may assert in proof prose.

- `open` means no proof is present.
- `candidate` means a proof is present but has not been accepted for its current
  identity.
- `rejected` means an independently checked candidate failed; canonical QMD
  was not changed by that rejected submission.
- `verified` means the current statement and proof match an accepted
  verification record.
- `revoked` means an earlier acceptance was explicitly withdrawn with a
  recorded reason.

Formal verification and human review are recorded independently. An informal
LLM verdict must not be described as formal verification.

## How proof work proceeds

For a typical request, the host agent follows this loop:

1. Load the qmd-prover skill.
2. Read the project's `AGENTS.md` and confirm that its managed qmd-prover
   contract matches the canonical contract shipped with the skill.
3. Ask the inspector for the project state and the selected theorem's bounded
   context.
4. Stop on structural errors that make proof work unsafe, such as a changed
   protected statement or an unresolved dependency.
5. Reason about the theorem and write an isolated candidate proof.
6. Use the proving utilities to check the candidate's structure and declared
   dependencies.
7. Send the candidate and its bounded mathematical context to an independent
   verifier, which may itself be implemented with a fresh sub-agent.
8. If rejected, use the verifier's concrete feedback to repair the candidate
   and repeat.
9. If accepted, recheck that the statement and dependencies are current and
   apply the proof to canonical QMD atomically.
10. Run `quarto render` when the user wants a rendered document or project
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

For project status:

```text
Use qmd-prover to show the open goals and the dependency context of
@thm-main-even-square.
```

For presentation:

```text
Render the Quarto project and show me the current proof progress.
```

The host agent loads `SKILL.md`, performs the contract preflight, invokes the
Node utilities, interprets their JSON, writes isolated candidates, and explains
the result in ordinary language. The user does not need to memorize script
operations.

The host may use its own sub-agent mechanism for independent verification or
parallel mathematical exploration when the user requests it. Those sub-agents
belong to the host environment; qmd-prover does not maintain a worker runtime.

## Using the Node utilities directly

A user or maintainer may invoke the same operations directly with Node. From
the mathematical project root, let the installed skill path be:

```bash
QMD_PROVER_ROOT="${CODEX_HOME:-$HOME/.codex}/skills/qmd-prover"
```

Inspect the project:

```bash
node "$QMD_PROVER_ROOT/scripts/qmd-prover.mjs" inspect-project
```

Inspect one theorem and its bounded dependency context:

```bash
node "$QMD_PROVER_ROOT/scripts/qmd-prover.mjs" \
  inspect-theorem @thm-main-even-square
```

Submit an isolated candidate:

```bash
node "$QMD_PROVER_ROOT/scripts/qmd-prover.mjs" \
  submit-proof path/to/proposal.qmd
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

These operations expose the skill's tool protocol; they are not a separately
designed interactive CLI. Their JSON output is stable so a host agent can call
them reliably. Structural diagnostics use a nonzero exit status.

Submitting a proposal is intentionally stronger than copying its proof into a
QMD file: it checks structure and dependencies, invokes the independent
verifier, rejects stale work, and performs the canonical update only after
acceptance.

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

## Data ownership

The mathematical project's QMD files and its `AGENTS.md` are canonical.
Definitions, statements, proofs, exposition, citations, and semantic
references live there.

`.qmd-prover/` may contain derived or temporary artifacts such as:

- a semantic manifest and dependency graph;
- isolated proof proposals;
- independent verification reports;
- the verification record associated with an accepted proof; and
- generated QMD or data used for observability.

These artifacts support the skill but do not replace the mathematical source.
Generated indexes and rendered output must be reproducible from canonical QMD
and retained verification records.

## Verification and acceptance in detail

Before verification, the proving utilities validate the candidate and record
the identities of the target and every dependency. The verifier receives only
the exact statement, candidate proof, relevant definitions, and statements of
declared verified dependencies. It does not receive the proving agent's
confidence or unrelated narrative.

A typical informal verifier response contains:

```json
{
  "verdict": "correct",
  "summary": "The proof covers the quantified case.",
  "critical_errors": [],
  "gaps": [],
  "repair_hints": ""
}
```

Acceptance requires `verdict: correct` together with empty `critical_errors`
and `gaps`. Any other response is a rejection.

After an accepting verdict, the proving utilities inspect the project again.
If the protected target or any dependency changed while verification was
running, the candidate is stale and is not applied. Otherwise, only the
permitted proof content and its matching verification record are written. A
post-write inspection must confirm the accepted state; failure rolls the
canonical source back.

This mechanism separates authorship from judgment while keeping the host agent
responsible for the proof-development loop.

## Core invariants

Every component preserves the following invariants:

- A `thm-main-*` ID, title, hypotheses, quantifiers, and statement are
  user-owned and protected.
- Every logical dependency is explicit and available in the theorem's scope.
- A proof candidate is not accepted merely because its author considers it
  correct.
- Independent verification is based on the exact statement, candidate, and
  relevant dependencies.
- Rejection never changes canonical mathematics.
- Acceptance is rejected as stale if the target or a dependency changed during
  verification.
- Canonical proof updates are atomic.
- QMD remains readable and renderable by Quarto without qmd-prover becoming a
  second document system.

## Non-goals

qmd-prover does not define:

- a dedicated autonomous agent;
- a persistent worker or task model;
- a scheduling or messaging system for sub-agents;
- a public CLI product separate from the skill's Node utilities;
- a custom HTML, PDF, or website renderer; or
- a replacement for formal proof assistants.

An independent LLM verifier establishes only the configured verification
status. Formal verification and human review remain distinct claims.

## Further design documents

- [Discipline design](design-discipline.md) explains policy ownership,
  categories of rules, and contract evolution.
- [Inspector design](design-inspector.md) explains Pandoc parsing, scope
  resolution, dependency construction, diagnostics, and theorem bundles.
- [Proving utilities design](design-proving.md) explains proposals,
  independent verification, rejection, stale checks, and atomic acceptance.
- [Rendering design](design-rendering.md) explains how observability integrates
  with the ordinary Quarto pipeline.
