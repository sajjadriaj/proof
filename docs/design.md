# Design

[← back to README](../README.md)

## Design

**Evidence over confidence.** `proof` reports what it observed. It never asks a model
whether something looks correct.

**Deterministic where possible.** A model can decide what *should* be checked. Whether the
check passes is decided by running it.

**Repository native.** `proof init` discovers the commands your project already has rather
than replacing them: npm scripts, `cargo`, `go`, `pytest`, `tox`, `bundle exec rake`, `mvn`,
`gradle`, and `make` — the last only for targets the Makefile actually defines, since
scaffolding `make test` into a Makefile without that target writes a check that fails on the
first run. A project manifest wins over a Makefile that wraps it. Nothing recognisable means
a placeholder, and `proof check` refuses to run a contract still holding one.

The same for how the project starts: an npm `dev`/`start`/`serve` script, a `dev`/`serve`/
`run`/`start` Makefile target, a Procfile's `web` process, `cargo run`, `go run .`, or
`python3 manage.py runserver`. What the project declares about itself — a script, a target, a
Procfile — beats anything guessed from the language. What it finds is scaffolded into the
contract as a commented `serve` block for you to confirm the port. A project with no obvious entry point is left without one rather than guessed at — a
serve block that fails to boot short-circuits every check after it.

When a check fails, proof says whether it passed in the previous run:

```
FAILURE
  Check:
    price is 100
  Regression:
    passed in run 0001, fails now
```

`Regression:` means this change broke it; `Not new:` means the last change did not fix it.
Rendered identically they read the same to an agent, and only one of them is about the edit
just made.

The comparison is like-for-like or it is not made at all. A check keeps its name when its
assertion is edited, so proof compares what each run *asserted*, not just the name: edit a
check and its next failure reads `Not comparable: this check asserted something else in run
0001` rather than blaming code that never moved.

The baseline is also the previous run *of the same contract*. Every contract's runs share one
`.proof/runs` directory, so without that restriction "passed in run 0001" could be a claim
about a different contract that happens to name a check the same way. With no comparable run,
proof says nothing rather than something wrong.

The same lines appear in `report.md`, and `--json` carries `was` and `since` on every failure
entry. It never changes the verdict or the exit code.

A fresh `init` plus `infer --write` can leave a contract needing several edits at once: an
uncommented `serve` block, a route pattern to replace, a placeholder command to fill in. Proof
knows about all of them on the first run, so it says all of them:

```
proof: .proof/spec.yaml is invalid:
  - check[1] "get /api/orders/[id]" › http › path: "/api/orders/[id]" still has the route
  pattern in it ([id]) — replace it with a real value...

Also, once the above are fixed: 1 check(s) still hold proof's own placeholder command (tests).
```

The placeholder is listed separately, and stays out of `problems`, because it is not a
validation error — `infer --write` has to keep working on a contract that holds one. It is the
next refusal, reported early rather than discovered after the others are fixed.

**Human inspectable.** The contract is readable YAML. No verification logic hides inside
opaque agent behavior.

## Non-goals

Not a coding agent, not an IDE, not a replacement for unit tests or Playwright, not a CI
platform, not an MCP server. `proof` sits one layer above your existing tools and asks one
narrower question: does the implemented change actually satisfy the requirement?

## Development

```bash
npm test
```

MIT.
