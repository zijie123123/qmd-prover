# Mathematical project discipline

## Semantic QMD format

Write every mathematical declaration as a fenced Div with one stable ID, one kind class, a descriptive `name`, and an ISO introduction `date`.

| Declaration | Required form | Use |
|---|---|---|
| Definition | `#def-* .definition` | Introduce a term, object, construction, or notation. |
| Lemma | `#lem-* .lemma` | State an auxiliary result used later. |
| Proposition | `#prp-* .proposition` | State a useful standalone result. |
| Theorem | `#thm-* .theorem` | State a principal result. |
| Corollary | `#cor-* .corollary` | State a direct consequence of earlier results. |
| Main goal | `#thm-main-* .theorem .goal` | State a theorem supplied by the user. |

Keep each proof in a separate block with no ID:

```markdown
::: {#lem-example .lemma name="Example lemma" date="2026-07-12"}
State the lemma precisely, including its hypotheses and quantifiers.
:::

::: {.proof of="lem-example"}
Use @def-example at the point where the definition is needed.
:::
```

The `of` attribute must name exactly one declaration. Cite every logical dependency with `@id` at its point of use in a definition construction or proof. Do not add a separate dependency list. Ordinary exposition, examples, computations, figures, and bibliographic citations remain ordinary QMD content.

## Mathematical discipline

- Preserve every `thm-main-*` ID, `name`, hypothesis, quantifier, and statement body exactly. Do not weaken or repair a main goal without explicit user approval.
- If a main goal appears false, preserve it and give a precise counterexample or refutation.
- Introduce notation before using it. State the scope of every variable and every nontrivial hypothesis.
- State agent-created definitions and results precisely enough to be reused independently.
- Justify reductions, existence and uniqueness claims, finiteness arguments, case splits, and limit passages.
- Identify any external theorem precisely and check all of its hypotheses. Do not use the desired conclusion or an equivalent result as a black box.
- Do not treat an unproved intermediate claim as established. Follow its dependencies until every required result has a proof.
- Distinguish examples, computations, and intuition from proofs of general statements.
- Prefer a useful reusable intermediate result over hiding a substantial argument inside prose, but do not fragment a proof into vacuous lemmas.
- Keep mathematical declarations and proofs readable. Keep planning notes, search logs, confidence claims, and process commentary outside them.
- Organize definitions, results, and proofs in project QMD files according to their mathematical subject. The order of exploration and proof development is otherwise flexible.

## Project-specific requirements

- Develop Gödel's completeness theorem from explicit foundations of first-order logic: signatures, terms, formulas, substitution, proof calculus, structures, assignments, satisfaction, and semantic consequence.
- State useful intermediate definitions and results as semantic QMD blocks and cite every logical dependency at its point of use.
- Do not assume completeness, compactness, or an equivalent model-existence theorem as an unproved black box.
