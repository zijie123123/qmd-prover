# Inspector design

## Role

The inspector checks mathematical facts in QMD at four scopes: one fact, a
file or folder, the mathematical workspace, and the dependency graph. A fact is
a theorem, lemma, or definition with a semantic ID.

For every inspected fact, the inspector performs two different checks:

- a programmatic check establishes that semantic references exist, are unique,
  are available in scope, and have usable status; and
- an independent AI check judges whether the referenced facts are sufficient
  for the definition construction or proof in which they are used.

The inspector uses Pandoc JSON to parse QMD and extracts dependency edges only
from semantic references in a definition construction or linked proof.
Ordinary exposition and bibliographic citations do not create dependency
edges.

Inspection returns stable JSON by default. The optional `--print` flag selects
a human-readable dependency report. It changes presentation only: the facts
checked, diagnostics produced, graph constructed, and verification decision
must be identical with or without the flag.

`VERIFIED` is record-backed. The inspector may cause qmd-prover to add it only
after all programmatic checks pass, the AI check reports no critical error or
gap, and the exact check is stored. A source marker without its matching record
has no authority. `REVOKED` likewise requires a matching revocation record and
concrete reason.

## 1. Inspect a theorem, lemma, or definition

Single-fact inspection accepts one semantic ID and returns the check result for
that fact together with the part of the dependency graph needed to explain the
result.

### Select and parse the fact

- Resolve the requested ID to exactly one theorem, lemma, or definition.
- Record its kind, title, statement or construction, linked proof when
  applicable, source file, and source location.
- Reject a missing or ambiguous ID instead of guessing from a similar title.
- Preserve the exact semantic identities used by verification and later stale
  checks.

### Check references programmatically

For every semantic reference in the definition construction or proof, check
that:

- the referenced ID exists and is unique;
- its kind and semantic block are valid;
- it is local or explicitly imported from an exported source;
- its `VERIFIED` marker, when required, matches its current record and cached
  identity; and
- it is not rejected, revoked, stale, cyclic, or otherwise unavailable.

Missing, ambiguous, unavailable, and insufficiently verified references are
blocking diagnostics. The inspector must still retain their unresolved graph
edges so the failure can be explained.

### Check sufficiency with AI

After programmatic checks succeed, send the exact fact and its referenced facts
to an independent AI checker.

For a definition, the checker determines whether the cited definitions and
results make the construction meaningful, supply every required object or
operation, and avoid an unjustified circular construction.

For a theorem or lemma, the checker determines whether:

- each cited fact applies under the stated hypotheses;
- the proof uses the cited conclusion correctly;
- the cited facts and explicit reasoning cover every case and quantifier; and
- the proof establishes the exact statement rather than a weakened variant.

The AI result must distinguish critical errors, gaps, and nonblocking comments.
Any critical error or gap prevents `VERIFIED`. If the AI checker is unavailable
or returns malformed output, inspection fails closed and leaves the fact
unverified.

### Record the result and marker

If both checks pass, qmd-prover:

- stores the exact statement or construction, proof, referenced fact
  identities, dependency snapshot, and AI report;
- adds `VERIFIED` to the inspected fact through the protected write path; and
- reinspects the result to confirm that the marker and record match.

A failed check stores its diagnostic report but must not add `VERIFIED`.
`REJECTED` may be used for a retained failed attempt. Explicit withdrawal of a
previous acceptance uses `REVOKED`, not ordinary staleness invalidation.

### Construct the related dependency graph

The single-fact graph contains:

- the inspected fact;
- its direct referenced facts;
- the transitive dependency closure needed to judge those references;
- unresolved references as broken edges;
- the status and source location of every node; and
- the nearest reverse dependencies needed to show immediate impact.

An edge points from the fact being constructed or proved to the fact it cites.
Each edge records whether existence, scope, status, and AI sufficiency checks
passed.

### `--print` report

With `--print`, display:

- the inspected fact and its final status;
- programmatic and AI check results;
- direct and transitive dependencies;
- unresolved, stale, rejected, or revoked facts;
- dependency paths explaining every blocker; and
- the related graph as a readable tree or edge list.

## 2. Inspect a file or folder

File and folder inspection applies single-fact inspection to every theorem,
lemma, and definition discovered in the requested path.

### Source discovery

- A file request inspects that QMD file only.
- A folder request recursively discovers QMD files below the folder.
- Configured generated directories, machine state, and ignored paths are
  excluded.
- Discovery order is deterministic so repeated inspection produces stable
  output.

### Aggregate checks

- Parse every discovered file through Pandoc JSON.
- Detect duplicate IDs, malformed semantic blocks, ambiguous proof links,
  invalid imports or exports, and cycles spanning multiple files.
- Run the programmatic reference check for every fact.
- Run the AI sufficiency check for each fact whose programmatic checks succeed.
- Keep each fact's result independent so one failure does not hide diagnostics
  for the remaining facts.
- Report the overall operation as unsuccessful when any blocking diagnostic
  remains.

### Aggregate dependency graph

Combine the per-fact graphs into one graph for the requested path. Preserve
cross-file edges and external edges to facts outside the path. An external node
is included as context but is not reinspected unless it falls within the
requested scope.

### `--print` report

With `--print`, display:

- files and facts inspected;
- counts by kind and status;
- verified, open, rejected, revoked, and stale facts;
- missing or unavailable references;
- dependency cycles and cross-file edges;
- the unresolved proof frontier within the requested path; and
- a dependency summary grouped by file and semantic ID.

## 3. Inspect the workspace

Workspace inspection runs file inspection over every mathematical QMD file in
the selected workspace and combines the results with the canonical facts made
available to that workspace.

### Workspace discovery

- Discover every visible workspace QMD file recursively.
- Exclude hidden machine-managed workspace state, verification records,
  generated indexes, and rendered output from mathematical source discovery.
- Read the protected canonical target and cached workspace base identities as
  machine state rather than ordinary mathematics.
- Distinguish canonical facts from workspace facts in every result and graph
  node.

### Workspace checks

- Run the staleness check before treating any `VERIFIED` fact as usable.
- Run file inspection for every discovered workspace file.
- Check workspace IDs for collisions with canonical IDs, except for an
  intentional proof linked to its protected canonical target.
- Check that every canonical fact used by workspace mathematics is explicitly
  available and current.
- Allow provisional workspace facts to appear in the graph, but never treat an
  open, candidate, rejected, revoked, or stale fact as an established premise.
- Preserve diagnostics for abandoned or alternative routes without allowing
  them to block unrelated active mathematics.

### Workspace dependency graph

The workspace graph combines:

- workspace definitions, lemmas, and theorems;
- imported canonical facts;
- active proof and construction dependencies;
- unresolved references; and
- verification and staleness state.

The graph is rebuilt as one complete snapshot. A failed rebuild must not
replace the last valid snapshot.

### `--print` report

With `--print`, display:

- workspace-wide counts and diagnostics;
- all active proof obligations;
- the verified and provisional dependency closures;
- unresolved and stale dependency chains;
- the current proof frontier for each active goal;
- canonical facts imported by workspace mathematics; and
- dependency information grouped by file, goal, or semantic ID.

## 4. Analyze and search the dependency graph

Graph analysis derives useful information from the most recent complete graph
snapshot. Queries must identify the snapshot they used.

### Dependency queries

For a selected fact, support:

- direct dependencies;
- transitive dependency closure;
- direct and transitive reverse dependencies;
- paths between two facts;
- cycle detection with the complete cycle path; and
- impact analysis showing which verified facts rely on a selected fact.

### Find the proof frontier

For a selected theorem or lemma:

1. Traverse its active dependency closure.
2. Find every fact that is open, candidate, rejected, revoked, stale, missing,
   or otherwise unusable.
3. Remove a blocked fact from the frontier when a lower unresolved dependency
   already explains why it is blocked.
4. Return the lowest unresolved claims together with paths from the selected
   result to each claim.

The frontier is the set of useful next proof obligations, not merely every
unverified node in the transitive closure.

### Additional graph findings

The inspector may derive:

- unused imports and exports;
- isolated or unreachable workspace facts;
- verified facts depending on an invalid marker or stale record;
- candidate results whose dependency closure is otherwise ready for AI check;
- heavily reused facts whose change would have broad impact; and
- alternative dependency paths to the same target.

### Search

Search facts by:

- exact or partial semantic ID;
- title;
- statement, construction, or proof text;
- theorem, lemma, or definition kind;
- source file or folder;
- current status; and
- canonical or workspace origin.

Search also supports graph-aware filters, including:

- facts used directly or transitively by a selected result;
- facts that directly or transitively depend on a selected result;
- unresolved facts on a selected proof frontier;
- stale facts affected by a selected change; and
- facts participating in dependency cycles.

Search results include source locations and may be passed directly to the
single-fact, file, folder, frontier, or impact operations. With `--print`, graph
queries and search produce readable paths, tables, and edge summaries rather
than only raw JSON.

## 5. Check staleness

Staleness checking ensures that `VERIFIED` never survives a change to the exact
mathematics or dependency snapshot that was checked.

### Cache accepted identities

When a fact becomes verified, atomically cache:

- its exact statement or definition construction;
- its exact proof when applicable;
- its semantic identity and source location;
- every direct referenced fact and that fact's checked identity;
- the imports and scope used to resolve those references;
- the relevant dependency graph snapshot;
- the AI check result and checker identity; and
- the matching verification record identity.

The cache is evidence for comparison, not an alternative source of canonical
mathematics.

### Compare current mathematics with the cache

On a staleness check, reparse the requested scope and compare current identities
with the cache. A verified fact is stale if any of the following changed or is
missing:

- statement or definition construction;
- proof;
- semantic ID or source association;
- a referenced fact's statement, construction, proof, or verification status;
- the dependency edge set;
- imports or scope;
- the matching verification record; or
- the checker contract required by project policy.

A corrupt or incomplete cache is stale. The inspector must never reconstruct a
missing accepted identity by guessing.

### Invalidate `VERIFIED` transitively

When a checked fact is stale:

1. Remove `VERIFIED` from the changed fact.
2. Mark its retained verification record stale without deleting its history.
3. Follow reverse-dependency edges to every fact that directly or transitively
   relied on it.
4. Remove `VERIFIED` from every affected dependent fact and mark each matching
   record stale.
5. Rebuild the graph and report the exact invalidation paths.

The direction is important: if B depends on A and A changes, B is invalidated.
A is not invalidated merely because B changes. In this document, “invalidate
all dependencies” therefore means invalidate all dependent facts reached
through the reverse-dependency graph, not unrelated upstream premises.

Staleness removes `VERIFIED`; it does not add `REVOKED`. `REVOKED` is reserved
for an explicit withdrawal with a recorded concrete reason.

### Atomicity and failure behavior

- Compute the complete invalidation set before changing any source marker.
- Acquire the protected project write lock.
- Update source markers, stale records, caches, and graph data atomically.
- Roll back every change if any write or post-write inspection fails.
- If safe marker removal cannot be completed, fail closed and report all
  affected facts as unusable.

### `--print` report

With `--print`, display:

- each changed identity and the reason it is stale;
- previous and current identities;
- every fact that lost `VERIFIED`;
- the reverse-dependency path explaining each invalidation;
- records retained as stale history; and
- the facts that must be inspected again before `VERIFIED` can return.

### Agent contract requirement

The canonical mathematical-project `AGENTS.md` contract must require agents to:

- run staleness checking before relying on `VERIFIED` mathematics;
- permit qmd-prover to remove stale markers transitively;
- never add or restore `VERIFIED` manually;
- treat missing or corrupt caches and records as unverified; and
- repeat the complete programmatic and AI checks before `VERIFIED` returns.
