# Proving utilities design

## Role

The proving utilities help Codex or Claude Code turn mathematical reasoning
into explicit workspace definitions, intermediate results, and proof
candidates, then submit each materializable candidate to an optional local AI
verifier. Globally composed mathematics remains in its goal workspace as
`workspace-verified` state; independently confirmed counterexamples and
refutations remain there as `workspace-disproved` evidence.

They do not form a proving agent. The host decides how to reason, which lemmas
to introduce, when to explore examples, and how to repair a proof. The runtime
provides protected goal context, machine-only semantic compilation, bounded
direct-dependency verifier packets, exact local decision caches, deterministic
global composition, feedback, and atomic workspace/project snapshots.

Earlier releases treated acceptance as promotion into user QMD. That path is
retired. User QMD now remains notes and protected main-goal storage; verifier
acceptance changes only workspace cache and snapshot state.

## Flexible proof development

The utilities do not prescribe a proof-development loop. The host may start
from one main goal, a related family of goals, an existing workspace, or an
informal idea that needs precise formulation. It may inspect, search, verify,
render, or reorganize the workspace whenever those operations help.

Only the safety gates are ordered:

1. establish current project and external-basis policy;
2. compile and pass project/global preflight;
3. build the selected machine dependency closure without consulting AI state;
4. materialize each selected fact and its direct dependency statements;
5. run the optional local verifier for exact cache misses;
6. recheck source and context freshness after each verifier return;
7. deterministically compose global status over the graph; and
8. publish cache and snapshot state atomically.

These gates do not choose the next mathematical idea.

## Mathematical agent workspace

Tentative and verified proof development takes place in persistent goal
workspaces, not in user Quarto sources. Proving `@thm-main-ID` requires
`.qmd-prover/workspaces/thm-main-ID/`.

For example, prolonged work on `@thm-main-uniform-index` may contain:

```text
.qmd-prover/workspaces/thm-main-uniform-index/
├── workspace.json
├── target.qmd
├── manifest.json
├── graph.json
├── latest.json
├── snapshots/
├── verification/
│   ├── checks/
│   └── failures/
├── progress.qmd
├── reductions/
│   ├── reduce-to-strata.qmd
│   └── specialization.qmd
├── local-theory/
│   ├── local-class-groups.qmd
│   └── exponent-bounds.qmd
├── examples/
│   └── possible-counterexamples.qmd
└── main-proof.qmd
```

The layout is illustrative, not mandatory. `workspace.json` records the
protected target identity. `target.qmd` preserves the initialization snapshot
but is excluded from active workspace semantic discovery. `progress.qmd` is
user/agent-maintained context; inspection never overwrites it. Subject QMD
contains complete semantic declarations and linked proofs.

`main-proof.qmd` contains only a linked proof overlay for the protected main
goal. It must not repeat the theorem. The overlay becomes a workspace graph
node with the protected statement from user QMD and the proof identity from the
workspace.

The visible QMD may contain definitions, lemmas, propositions, theorems,
corollaries, calculations, examples, partial proofs, rejected attempts, and
alternative routes. The agent groups coherent mathematics rather than creating
one file for every transient thought.

The workspace graph is isolated. A local result may depend on another
declaration in the same workspace, subject to same-file or explicit cross-file
scope. It may not cite a different goal workspace or another protected main
goal. Outside mathematics is supplied through the exact external basis, not as
an implicit graph fact.

## Preparing a candidate

A candidate is an ordinary semantic declaration and linked proof in active
workspace QMD. There is no proposal file type and no required proposal
directory.

An intermediate theorem-like result contains one dated declaration and one
linked proof. A definition's construction lives in its declaration body and
may have a linked proof for existence, uniqueness, or well-definedness. The
protected main-goal candidate contains only the linked proof.

A partial theorem-like proof begins with `OPEN`. A failed attempt retained for
history begins with `REJECTED`. A proposed counterexample or refutation begins
with `DISPROVED`; it is still a candidate until independently checked. An
unmarked complete proof is a proof candidate. Definitions cannot use
`DISPROVED`.

Current workspace verification does not write `VERIFIED` or `REVOKED` markers.
Those strings are recognized only as legacy state and are forbidden in new
workspace mathematics.

Useful preparation assistance includes:

- inspecting the selected fact and its exact local dependency closure;
- showing missing exports or imports;
- searching existing declarations by ID, title, text, kind, or status;
- calculating the proof frontier;
- comparing the current protected goal with `workspace.json`;
- reading exact prior rejections and repair hints; and
- checking whether the external basis permits a claimed outside theorem.

These are tools for the host agent, not an autonomous worker scheduler.

### Example candidate

Starting from an open protected goal, the host writes:

```markdown
::: {.proof of="thm-main-even-square"}
Let \(n\) be even. By @def-even-integer, there is an integer \(k\) such
that \(n=2k\). Hence \(n^2=(2k)^2=4k^2\), so \(4\mid n^2\).
:::
```

The protected statement comes from user QMD. The reference to
`@def-even-integer` is the proof's dependency declaration and must resolve to
a current local workspace definition.

## Candidate preflight

Before independent verification, the inspector confirms that:

- the selected ID resolves globally to one protected goal or workspace
  declaration;
- the owning workspace is initialized, current, and not orphaned;
- no global duplicate ID makes ownership ambiguous;
- the workspace result block has the correct ID prefix, class, name, date, and
  nonempty body;
- an intermediate result has exactly one appropriate linked proof;
- the protected target is supplied only through a proof overlay and was not
  redeclared;
- the proof is either an unmarked proof candidate or a theorem-like
  `DISPROVED` refutation candidate, and is not `OPEN`, `REJECTED`, `VERIFIED`,
  or `REVOKED`;
- every local dependency exists, is unique, and is in scope;
- every cross-file dependency has an exact producer export and consumer import;
- no dependency crosses a workspace or main-goal boundary;
- cycle membership is recorded as a machine finding; and
- every direct dependency statement needed for a local AI packet can be
  materialized exactly.

Preflight establishes machine validity and packet availability, not
mathematical correctness. A scope error or cycle can make global state invalid
while a separately materializable local conditional check still runs; the two
outcomes remain visibly separate.

### Example preflight failure

If the proof links to a misspelled target:

```markdown
::: {.proof of="thm-main-even-squares"}
Let \(n=2k\). Then \(n^2=4k^2\).
:::
```

the inspector does not guess the nearby ID. It reports that the proof target is
unknown or invalid. The host repairs `of` to name the exact protected target.

Similarly, a proof that cites `@lem-square-of-double` from another workspace is
not repaired by adding an import. The claim must be established locally or
represented as a permitted external premise without a cross-workspace ID edge.

## Local conditional verification

The verifier is an optional bounded external facility. It may be an LLM command, a fresh
review context, or a formal-checker adapter that implements the protocol.

An informal verifier packet contains:

- exact target ID, kind, title, statement or construction, proof or proposed
  refutation, and verification mode;
- the IDs and exact statements of cited direct local dependencies;
- normalized workspace imports and source association;
- protected-goal context for an overlay;
- exact external-basis mode and content;
- checker contract and verifier protocol; and
- an instruction to report errors and gaps independently.

It does not contain dependency proofs, dependency verification states, the
transitive proof closure, the author's confidence, hidden chain of thought,
persuasive commentary, or unrelated project narrative. The verifier assumes
the supplied direct statements and checks the exact submitted proof. It does
not decide whether those direct premises have themselves been established.

The verifier returns a verdict, summary, critical errors, gaps, nonblocking
comments, repair hints, and a refutation field. An ordinary proof is verified
only by `correct` with empty critical-error and gap lists. A false theorem-like
statement is recorded as disproved only with a nonempty, independently
checkable refutation and empty critical-error and gap lists. The cache record
preserves the full packet, outcome, and report so a later run can validate
exact reuse.

### Example verifier packet

An abbreviated packet can look like:

```json
{
  "target": {
    "id": "thm-main-even-square",
    "statement": "For every even integer n, 4 divides n^2.",
    "proof": "Let n be even. By @def-even-integer ...",
    "verification_mode": "proof",
    "cited_dependencies": ["def-even-integer"],
    "workspace": "thm-main-even-square"
  },
  "dependencies": [
    {
      "id": "def-even-integer",
      "statement": "n is even iff n=2k for some integer k.",
      "identity": { "statement_hash": "sha256:..." }
    }
  ],
  "external_basis": {
    "mode": "none",
    "content": ""
  },
  "verification": {
    "fresh_context": true,
    "require_zero_gaps": true
  }
}
```

### Refutation candidates and discovered counterexamples

If the host has a counterexample, it preserves the statement and makes the
linked proof explicit:

```markdown
::: {.proof of="thm-main-primes-odd"}
DISPROVED

The number \(2\) is prime, because its only positive divisors are \(1\) and
\(2\), but \(2\) is not odd. Hence it falsifies the universal statement.
:::
```

The marker selects `refutation` mode; it is not a verifier decision. A
successful independent check records `workspace-disproved` and structured
evidence containing the summary, exact refutation, source, and verification
identity. A failed proposed refutation records
`workspace-disproof-rejected` and repair information. The verifier may instead
discover a counterexample while checking an unmarked proof and return the same
conclusive disproved outcome.
Neither route edits the source marker.

A globally disproved fact is terminal evidence about a false statement, not a
premise. Its machine dependency edges remain intact, while global composition
blocks dependent facts and frontier analysis exposes it as the lowest relevant
obstruction. A merely local disproof is conditional until all of its direct
dependencies are globally verified.

## Rejection and repair

On mathematical rejection:

- user QMD is unchanged;
- the exact rejection is cached in the goal workspace;
- the fact is reported as `workspace-rejected` for that snapshot;
- the full critical-error, gap, and repair information remains available;
- the host repairs ordinary workspace QMD; and
- a changed candidate receives a new exact verification key.

The runtime does not erase an earlier rejection because a later candidate
passes. Exact decisions remain evidence keyed to their exact packet.

If the protected statement appears false, the host preserves it and develops a
counterexample or precise `DISPROVED` refutation for independent checking. It
must not weaken the statement to manufacture acceptance.

### Example rejection and repair

For “the product of two positive numbers is positive,” suppose a proof says
only “This is obvious.” The verifier may return:

```json
{
  "verdict": "incorrect",
  "summary": "The ordered-field step is not justified.",
  "critical_errors": [],
  "gaps": ["Justify why a>0 and b>0 imply ab>0."],
  "refutation": "",
  "repair_hints": "Cite or prove positivity under multiplication."
}
```

The host supplies the missing argument or local lemma and reinspects the
affected closure. Unrelated workspace facts remain outside that verifier
schedule.

## Safe acceptance

“Acceptance” now means acceptance into current workspace evidence, not
promotion into user QMD.

Before invoking the verifier, inspection records:

- active workspace source fingerprint;
- protected main-goal identity;
- target statement or construction and proof identity;
- exact direct dependency statement identities;
- semantic source context and import declarations;
- external-basis hash and content; and
- checker contract.

After a conclusive local verifier result, inspection recomputes workspace sources,
protected goal context, and external basis. If anything changed, it reports
stale workspace source context and does not cache the result as accepted.

For current context, inspection:

1. writes the exact decision record atomically;
2. records the result under `local_verification` without changing any machine
   edge or upstream state;
3. computes `global_verification` deterministically over the workspace graph;
4. constructs a complete schema-v4 workspace manifest and graph;
5. merges current local outcomes for unchanged facts outside a narrow
   selection;
6. atomically publishes the workspace snapshot; and
7. refreshes the aggregate project snapshot when publication is safe.

The host cannot bypass this path merely because it authored the proof. No step
writes proof text or a status marker into the user's note.

### Example stale acceptance

Assume the verifier accepted a proof using the exact statement of `@lem-bound`
under verification key `sha256:A`. Before the cache write, that statement
changes, producing key `sha256:B`. Inspection reports stale source context and
does not cache the local result because the assumed direct conclusion changed.

If only the proof of `@lem-bound` changes while its statement remains byte-for-
byte semantically identical, the dependent local decision remains reusable.
The lemma's own local decision is rechecked and the dependent's global status
is recomputed. This separation prevents upstream review mechanics from leaking
into the meaning of a local implication check.

An unrelated edit to user-note prose outside a protected main goal does not
change workspace mathematical identity. A change to the external basis or
checker contract does.

## Records

qmd-prover may retain under `.qmd-prover/`:

- protected workspace metadata and target snapshots;
- persistent mathematical workspace QMD;
- exact verified, disproved, and rejected verifier records;
- verifier infrastructure failure reports;
- workspace manifests, graphs, and immutable snapshots;
- the aggregate project manifest, graph, diagnostics, and snapshots;
- statement locks for protected main goals; and
- old project verification records as legacy read-only state.

This is mathematical working state and proof provenance, not an agent runtime.
qmd-prover has no worker registry, scheduler, or inter-agent message store.

## Invocation model

The utilities are dependency-free Node programs shipped inside the skill. The
skill tells the host which operation to run and how to interpret stable JSON. A
human may run the same command for debugging.

There is no separately installed binary. The dispatcher and schema are the
tool protocol.

### Example direct invocation

Inspect one candidate and its dependency closure:

```bash
node "${CODEX_HOME:-$HOME/.codex}/skills/qmd-prover/scripts/qmd-prover.js" \
  inspect fact @thm-main-uniform-index
```

Inspect the complete goal workspace:

```bash
node "${CODEX_HOME:-$HOME/.codex}/skills/qmd-prover/scripts/qmd-prover.js" \
  inspect workspace @thm-main-uniform-index
```

The old submission command remains parseable for compatibility:

```bash
node "${CODEX_HOME:-$HOME/.codex}/skills/qmd-prover/scripts/qmd-prover.js" \
  submit proof .qmd-prover/workspaces/thm-main-uniform-index/main-proof.qmd
```

It returns `status: "retired"` and changes no file. Current proof verification
is performed by `inspect fact`, `inspect path`, or `inspect workspace`.
