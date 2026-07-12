# Canonical qmd-prover project contract

Copy the managed block below into the root `AGENTS.md` of every mathematical project that uses qmd-prover. Keep the block unchanged. Add project-specific organization, notation, and writing rules outside the managed block.

<!-- qmd-prover-contract:start version=3 -->

## Contents

- [qmd-prover contract](#qmd-prover-contract)
- [Agent workflow](#agent-workflow)
- [Correct and incorrect behavior](#correct-and-incorrect-behavior)

## qmd-prover contract

### Required QMD format

Write every definition or result as a fenced Div with a stable ID, a semantic class, and, for named results, `name`. Write its proof in a separate `.proof` block whose `of` names exactly that result:

```markdown
::: {#lem-local-exponent-bound .lemma name="Local exponent bound" export="local-exponent-bound"}
For every admissible point \(x\), the exponent of its local class group
divides the integer \(N\).
:::

::: {.proof of="lem-local-exponent-bound"}
Apply @thm-local-class-group-finite to the group defined in
@def-total-cartier-index.
:::
```

An open main goal is a result block with no linked proof. Preserve it exactly:

```markdown
::: {#thm-main-uniform-index .theorem .goal name="Uniform index theorem"}
Let \(\pi\colon X\to B\) satisfy the stated hypotheses. There exists an
integer \(I>0\) such that every admissible fiber has total Cartier index
dividing \(I\).
:::
```

In a proof or definition construction, cite each dependency with `@id` at the point of use. The citations are the dependency declaration; do not add a separate dependency list. To use a result from another file, import its exported ID explicitly in the target QMD front matter; wildcards are forbidden:

```yaml
---
qmd-prover:
  imports:
    - from: foundations/local-groups.qmd
      use:
        - def-local-class-group
        - thm-local-class-group-finite
---
```

A workspace proposal for an existing result contains only its linked proof. It remains a candidate until qmd-prover accepts it:

```markdown
::: {.proof of="thm-main-uniform-index"}
Apply @lem-finite-stratification, then use @lem-local-exponent-bound on each
of the finitely many strata and take the least common multiple.
:::
```

### Requirements

1. Preserve every `thm-main-*` ID, `name`, hypothesis, quantifier, and statement body exactly. If a main statement appears false, preserve it and produce a precise refutation; change it only with explicit user approval.
2. Use only results in the current file or individually imported results. 
3. State agent-created results precisely: introduce notation, scope every quantified variable, include every nontrivial hypothesis, and justify reductions, existence, finiteness, and limit passages.
4. Identify external theorems precisely enough to check their hypotheses. Keep examples, computations, and intuition distinct from a general proof.
5. Keep prose readable and mathematical. Except for reserved control markers, keep verifier metadata, worker strategy, search notes, and confidence claims out of results and proofs.
6. Never self-verify, add or restore `VERIFIED` manually, or merge a proposal directly into canonical QMD. Only qmd-prover may add `VERIFIED`, after programmatic reference checks and an independent AI sufficiency check both pass and the matching record is stored.
7. Before relying on any `VERIFIED` fact, run the staleness check. If a checked statement, proof, construction, dependency, scope, cache, or record changed, allow qmd-prover to remove `VERIFIED` from that fact and every direct or transitive dependent; re-run all checks before the marker returns.
8. Put related mathematics where nearby sources and local project policy indicate; qmd-prover imposes no subject-directory layout.

## Agent workflow

Load the globally installed `qmd-prover` skill before proof work. The user interacts in natural language; translate their request into dispatcher operations rather than requiring them to learn commands.

For each requested goal:

1. Check staleness, then inspect the canonical project and the target theorem.
2. Create or resume its goal workspace and read the protected target snapshot, imports, verified dependency closure, prior proposals, accepted mathematics, and verifier reports.
3. Develop mathematics only in the goal workspace. Never experiment by editing canonical QMD.
4. Inspect the workspace graph and do not treat an open, candidate, rejected, revoked, or stale workspace claim as established.
5. Inspect one linked proof, or one new definition or result with its linked proof, through qmd-prover. Programmatic reference checks and independent AI sufficiency checks must both pass.
6. If rejected, repair every concrete critical error and gap in workspace QMD, then inspect again.
7. Promote only exact mathematics whose `VERIFIED` marker still matches its current record and dependency snapshot.
8. Stop only when the goal is verified, precisely refuted, genuinely blocked, cancelled, or explicitly stopped.

Each independent worker must read this project `AGENTS.md`, load the skill, inspect its own target, and preserve useful notes in the goal workspace. Workers may propose mathematics but may not add, restore, or preserve `VERIFIED` against a staleness decision, and may not merge mathematics directly.

## Correct and incorrect behavior

### Dependencies and imports

Incorrect:

```markdown
::: {.proof of="thm-main-uniform-index"}
Apply @lem-local-exponent-bound.
:::
```

if that lemma is in another file but is not individually imported there. Add the exported ID to the target file's `qmd-prover.imports` metadata. Do not add a second `Uses` list: the proof reference already declares the dependency.

Also incorrect: mention a fact only in surrounding exposition and assume it becomes a dependency. Only references inside a definition construction or associated proof block create dependency edges.

### Main-statement protection

Incorrect: weaken “for every admissible fiber” to “for a general fiber,” add a missing hypothesis, change a quantifier, rename the `thm-main-*` ID, or silently rewrite its `name`.

Correct: preserve the main result block exactly. If it appears false, develop a precise counterexample or refutation in the workspace and report it to the user.

### Verification boundary

Incorrect: paste a plausible proof directly into canonical QMD and label it verified.

Correct: keep the linked proof in the goal workspace, submit it through qmd-prover, retain canonical QMD unchanged after rejection, and promote it only through the accepted submission path.

### Staleness and transitive invalidation

Incorrect: continue using `@lem-local-exponent-bound` because its source still says `VERIFIED` after its statement or one of its checked dependencies changed. Also incorrect: manually restore a removed marker.

Correct: run the staleness check before relying on verified mathematics. If a checked fact changed, qmd-prover removes its `VERIFIED` marker and follows reverse-dependency edges to remove the marker from every result that directly or transitively relied on it. Upstream premises are not invalidated merely because a downstream result changed. Reinspect the affected facts before `VERIFIED` returns.

### General proof versus evidence

Incorrect: present a numerical example, a computer experiment, or geometric intuition as if it proved a quantified theorem.

Correct: label such material as evidence or intuition, then give a complete argument covering every hypothesis and quantified case.

<!-- qmd-prover-contract:end -->

## Project-specific additions

Add local rules after the managed block without changing it. For example:

```markdown
## Local project policy

- Put algebraic-geometry sources under `geometry/`.
- Use `foundations/notation.qmd` for shared notation.
- Write theorem captions in English and surrounding exposition in Chinese.
- Do not introduce new subject folders without asking the user.
```

Local additions may strengthen organization and writing requirements, but they must not weaken or contradict the managed qmd-prover contract.
