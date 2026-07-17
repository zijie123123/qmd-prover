# qmd-prover

**qmd-prover is a skill for your AI coding agent** (Codex or Claude Code) that develops and checks
real mathematics in [Quarto Markdown](https://quarto.org/). A `.qmd` file is a readable plain-text
document that combines ordinary Markdown prose, mathematical notation, and structured theorem and
proof blocks; Quarto can render it as a polished web page or PDF. qmd-prover works two ways. Give it
a goal and it can run **autonomously** — inventing the definitions, lemmas, and proofs the result
needs and building them up on its own. Or hand it **your own notes** — a proof sketch, a draft, a
pile of half-finished arguments — and it formalizes them, fills the gaps, and checks the result
against what you wrote. Either way, everything compiles into one dependency graph; the agent checks
the structure, optionally has each proof reviewed by an independent AI verifier, and tells you — in
plain language — what is proved, what is still open, and what is blocked.

You never operate the dependency graph by hand. After a one-time install — which the agent can
handle for you (see the Quickstart) — you simply describe what you want ("prove this theorem",
"formalize these notes", "find what's still unproved and complete the proof"), and the agent drives
the tool for you.

## What you get

- **Readable, linked mathematics.** The agent writes ordinary `.qmd` files, usually under
  `workspace/`, with each definition, lemma, and theorem in its own block and each justification in
  a separate, linked proof. Whenever a proof uses another result or a specialized definition, it
  cites that fact by `@id` at the point of use. Those citations make every assumption visible.
- **One project, one proof graph.** qmd-prover compiles every `.qmd` file together. Each citation
  becomes a dependency edge, so it can trace exactly what every result rests on, even across files.
- **Protected goals.** Your main theorem statements are locked. The agent can prove them and build
  on them, but it cannot quietly weaken or reword what you asked it to establish.
- **Mechanical checks plus independent review.** First, checks that use no AI validate structure,
  IDs, proof links, scope, cycles, and freshness. Then, if configured, an independent Claude or
  Codex process reviews each exact proof against its directly cited statements and reports errors or
  gaps. This second layer is AI review, not formal proof certification.
- **Honest end-to-end status.** A locally accepted proof is not enough: qmd-prover marks a result
  globally verified only when its mechanical checks pass and every result it depends on is globally
  verified too. That status is composed deterministically over the graph.
- **Useful output.** Generate theorem navigation and a dependency graph for exploring the project,
  then use Quarto to publish the mathematics as HTML or PDF.

## Requirements

- **Node.js 20 or later** — runs the tool.
- **Pandoc** — required; it is the parser for every `.qmd` file. On `PATH`, or configured (see
  below). If you have Quarto, Pandoc is already bundled inside it.
- **Quarto** — optional, only for producing final rendered HTML/PDF.
- **An AI verifier** — optional. The `claude` or `codex` command-line tool, installed and logged in.
  Without one, all the mechanical checks still work; proofs simply stay unverified.

---

## Quickstart

This whole flow is done by talking to your agent. The commands are shown so you know what's
happening, but you type English, not shell.

### 1. Install the skill

Open Codex or Claude Code in any folder and say:

> **"Install the qmd-prover skill from `github.com/powergiant/qmd-prover`. Check that Node, Pandoc,
> and Quarto are set up, then get it ready."**

The agent follows the recipe in [For agents: installing from GitHub](#for-agents-installing-from-github)
below — it fetches the repo, copies the skill into your agent's skills directory, checks your tools,
and wires up any paths.

Prefer to do the install by hand? Clone the repo and run the installer. It installs **per-project**
by default or **globally**, for either host:

```bash
git clone https://github.com/powergiant/qmd-prover
cd qmd-prover
npm install

# Global — available in every project:
npm run install:skill:global         # Claude Code → ~/.claude/skills/qmd-prover
npm run install:skill:codex:global   # Codex       → ~/.codex/skills/qmd-prover

# Per-project — vendored into one project (run from it, or pass --dir):
tsx tooling/install-skill.ts --local --dir /path/to/project           # Claude Code → <project>/.claude/skills/qmd-prover
tsx tooling/install-skill.ts --local --codex --dir /path/to/project   # Codex       → <project>/.codex/skills/qmd-prover
```

The runtime is dependency-free, so copying the `skills/qmd-prover/` folder into any of those skills
directories is also a complete install. Claude Code discovers the skill and resolves its own
dispatcher; Codex uses `~/.codex/skills/qmd-prover` by default. `QMD_PROVER_HOME` is the one override
that points any host at the skill, so no other environment variables are needed.

### 2. Start a project and state your first goal

Go to the folder where your mathematics will live and say:

> **"Initialize qmd-prover here, then state my main theorem: _every finite integral domain is a
> field_."**

The agent runs `init` (which writes a project contract into `AGENTS.md`), scaffolds
`.qmd-prover/config.yml`, and records your goal as a **protected** result — something like:

```markdown
::: {#thm-main-finite-domain-field .theorem .goal name="Finite integral domains are fields"}
Every finite integral domain is a field.
:::
```

No proof is needed yet; a goal with no proof is simply *open*.

### 3. Develop and check

> **"Prove `thm-main-finite-domain-field`. Introduce whatever lemmas you need, then inspect the
> project and tell me what's verified and what's still blocked."**

The agent writes definitions, lemmas, and the proof into files under `workspace/`, and after each
coherent edit runs the narrowest check it needs:

```bash
node "$QMD_PROVER" inspect fact @thm-main-finite-domain-field
node "$QMD_PROVER" inspect project
```

It repairs anything the mechanical layer flags and reports back in natural language. You never
memorize the commands.

### 4. Turn on independent verification (optional)

Machine checks run with no verifier — proofs just stay `not-run`. To have proofs independently
reviewed, tell the agent which verifier you have:

> **"Use Codex as the verifier — I'm logged in — then re-inspect and show me what actually
> verified."**

The agent sets the backend in `.qmd-prover/config.yml`:

```yaml
verification:
  backend: codex   # or: claude
  effort: high     # low | medium | high | xhigh | max
```

Re-inspecting now runs the verifier, and each proof moves from `not-run` to `verified`, `blocked`,
or `disproved`. **Heads up on cost:** every fresh check calls a real model, and higher `effort` or
`strict` settings spend more tokens and time.

### 5. Render (optional)

> **"Render the theorem navigation."**

The agent runs `render` to refresh generated status and a dependency-graph SVG. For final HTML or
PDF, run ordinary `quarto render` (needs Quarto).

---

## How you actually use it, day to day

- **Talk; don't type commands.** You describe intent; the agent inspects and translates the results
  back into plain language.
- **Small steps.** State → prove a little → inspect → repair → repeat. `inspect` is your debugger.
- **Trust only what's globally verified.** A result is safe to build on only when its whole
  dependency chain checks out. The agent will tell you when something is still blocked.
- **Your statements are safe.** Main-goal statements are locked; the agent won't change them without
  asking.
- **Watch verifier cost.** Independent checks call a real model. Ask the agent to check narrowly
  (one fact) while iterating, and do full-project verification when you want the whole picture.

---

## For agents: installing from GitHub

> **If you are an agent asked to install qmd-prover from GitHub, do the following.** Do not skip the
> environment checks, and never use a mutation flag or change project policy without explicit user
> approval.

1. **Get the runtime.** Clone or download `https://github.com/powergiant/qmd-prover`. The installable
   runtime is the self-contained `skills/qmd-prover/` folder; it has no package dependencies.

2. **Install it into the host agent's skills directory.** Per-project keeps the runtime inside the
   project; global makes it available everywhere.

   ```bash
   git clone https://github.com/powergiant/qmd-prover

   # Per-project (recommended when working inside one project) — Claude Code:
   mkdir -p "$PWD/.claude/skills"
   cp -R qmd-prover/skills/qmd-prover "$PWD/.claude/skills/qmd-prover"      # use .codex for Codex
   #   Equivalent: tsx qmd-prover/tooling/install-skill.ts --local [--codex] --dir "$PWD"

   # Global — Codex (default ~/.codex; honors $CODEX_HOME):
   mkdir -p "${CODEX_HOME:-$HOME/.codex}/skills"
   cp -R qmd-prover/skills/qmd-prover "${CODEX_HOME:-$HOME/.codex}/skills/qmd-prover"
   #   Claude Code global → "$HOME/.claude/skills/qmd-prover".
   ```

   Under Claude Code the skill is discovered automatically and resolves its own dispatcher. Under
   Codex, keep the default `~/.codex/skills/qmd-prover`, or set `QMD_PROVER_HOME` to wherever you
   installed it.

3. **Confirm Node 20+**, then point `QMD_PROVER` at the dispatcher you just installed:

   ```bash
   node --version   # must be >= 20
   # QMD_PROVER_HOME is the skill directory you installed (any host/scope); e.g. per-project
   # Claude Code: QMD_PROVER_HOME="$PWD/.claude/skills/qmd-prover"
   QMD_PROVER="${QMD_PROVER_HOME:-$HOME/.codex/skills/qmd-prover}/scripts/qmd-prover.js"
   ```

4. **Check that Pandoc and Quarto are installed, and set up their paths.** Run `doctor`; it reports
   Node, Pandoc, the optional verifier, and Quarto, plus the exact path it resolved for each:

   ```bash
   node "$QMD_PROVER" doctor --print
   ```

   - **Pandoc is required.** If `doctor` reports it unavailable, locate or install it. It ships
     inside Quarto, so if the user has Quarto you can point at that copy instead of a separate
     install — e.g. on Apple-Silicon macOS: `/Applications/quarto/bin/tools/aarch64/pandoc`.
   - **Quarto** is only needed for final rendering; leave it unset otherwise.
   - Record any path the tool cannot find on `PATH` in the project config (step 6), or via the
     `QMD_PROVER_PANDOC` / `QMD_PROVER_QUARTO` environment variables, which take precedence.

5. **Run `init`** from the project root:

   ```bash
   node "$QMD_PROVER" init
   ```

   Read the returned inventory. If the status is `intent-required` (existing `AGENTS.md`, QMD, or
   `.qmd-prover` state), summarize what exists and **ask** the user before running
   `init --adopt-existing`. For an `AGENTS.md` without the contract, ask before `--append-contract`;
   for a different contract version, ask before `--sync-contract`. For `already-initialized`, setup
   is current. `init` never edits mathematics and creates no theorem.

6. **Run one inspection to scaffold the config, then check it.** The first compile writes
   `.qmd-prover/config.yml` (with `backend: none` defaults) and a `.gitignore`:

   ```bash
   node "$QMD_PROVER" inspect project
   ```

   Open `.qmd-prover/config.yml` and confirm it. Set `tools.pandoc` / `tools.quarto` to the absolute
   paths from step 4 if either was not on `PATH`, and choose a verifier backend when the user wants
   independent checking:

   ```yaml
   tools:
     pandoc: /Applications/quarto/bin/tools/aarch64/pandoc
     quarto: ""
   verification:
     backend: none        # none | claude | codex | command
     model: configurable
     effort: high
   ```

   Every setting is documented in [the configuration reference](skills/qmd-prover/references/config.md).

7. **Re-run `doctor`** until each required tool reads `available`. The verifier must show
   `available` before you rely on any global verification result. Never declare your own work
   verified — only a configured, available verifier produces verification state.

---

## References

- [CLI reference](skills/qmd-prover/references/cli.md) — every command, filter, exit code, and the
  verifier protocol.
- [Configuration reference](skills/qmd-prover/references/config.md) — every `.qmd-prover/config.yml`
  setting.
- [Project contract](skills/qmd-prover/references/AGENTS.md) — the rules the agent follows inside a
  project (declarations, proofs, imports/exports, verification discipline).
- [Design docs](docs/design.md) — architecture and internals for maintainers.

## Project layout

```text
skills/qmd-prover/       the installable skill (SKILL.md, references, runtime, dispatcher)
  scripts/qmd-prover.js  the dependency-free Node dispatcher
tests/                   compiler, verification, concurrency, and rendering tests
tooling/                 development and installation tools
docs/                    maintainer design and architecture docs
examples/                a worked example project
```

## Development

```bash
npm install
npm run typecheck
npm test        # AST-producing Pandoc adapter + mock verifiers; no real Pandoc or credentials needed
```

`npm run install:skill` (and its `:global` / `:codex` variants) copies `skills/qmd-prover/` into the
chosen agent's skills directory via `tsx tooling/install-skill.ts`; the source checkout stays the
source of truth.

## License

MIT — see [LICENSE](LICENSE).
