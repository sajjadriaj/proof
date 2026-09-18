<div align="center">

# proof

**Don't trust your coding agent. Test its work.**

An independent verification layer between an agent's implementation and its claim of
completion — a readable acceptance contract in your repo, executed against the *running
application*, producing a verdict backed by evidence.

[![ci](https://github.com/sajjadriaj/proof/actions/workflows/ci.yml/badge.svg)](https://github.com/sajjadriaj/proof/actions/workflows/ci.yml)
[![node](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](https://nodejs.org)
[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![runtime deps](https://img.shields.io/badge/runtime%20deps-1-lightgrey)](package.json)

[Quick start](#quick-start) · [Why not just write a test?](#why-not-just-write-a-test) · [Writing a contract](docs/writing-a-contract.md) · [For agents](#for-coding-agents) · [Docs](#documentation)

</div>

---

Coding agents write code and then judge their own work. The unit tests pass, so they report
success — while the button is wired to nothing.

![proof demo — a failing check caught with evidence, fixed, and verified green](docs/demo.gif)

> **Passing the existing test suite is not the same as satisfying the requirement.**

`proof` closes that gap. You describe "done" once, in YAML your team can read. `proof` starts
your app, exercises it, and answers one question — *does the implemented change actually
satisfy the requirement?* — with the evidence attached.

## Install

```bash
npm i -g github:sajjadriaj/proof
```

Or with nothing installed: `npx github:sajjadriaj/proof init "<requirement>"`.

Browser checks additionally need Playwright — only if your contract uses the `browser:` verb:

```bash
npm i -D playwright && npx playwright install chromium
```

Requires Node 20+. One runtime dependency (`yaml`); Playwright is an optional peer.

## Quick start

### 1 · Create a contract

`init` seeds it from your repo's own build and test commands, reads the dev script and the
framework for the port, and writes a live `serve` block when it has evidence for one:

```bash
proof init "users can log in and see their profile"
```

### 2 · Describe "done" in `.proof/spec.yaml`

Checks run against the app `proof` starts for you:

```yaml
goal: users can log in and see their profile

serve:
  run: npm run dev
  ready_url: http://localhost:3000

checks:
  - name: it still builds
    run: npm run build

  - name: logging in sets a session
    http:
      method: POST
      path: /login
      body: {email: ada@example.com, password: hunter2}
      expect: {status: 200, json: {ok: true}}

  - name: the profile page shows the user
    http:
      path: /profile
      expect: {status: 200, body_contains: "ada"}
```

New to this? [**Writing a contract**](docs/writing-a-contract.md) walks from a requirement to
a contract that means something.

### 3 · Verify

```console
$ proof check

PROOF

Requirement:
  users can log in and see their profile

CHECKS
  app boots                        PASS
  it still builds                  PASS
  logging in sets a session        PASS
  the profile page shows the user  FAIL
  app still running                PASS

FAILURE
  Check:
    the profile page shows the user
  Expected:
    status 200
  Observed:
    status 500

Evidence:
  .proof/runs/0001/result.json
  .proof/runs/0001/commands.log

VERDICT
  NOT DONE
  4 passed, 1 failed
```

`app boots` and `app still running` are checks `proof` adds itself for the `serve` block — the
app answered when the run started, and was still answering when it ended. Exit `0` passed,
`1` failed, `2` the contract itself is wrong.

### 4 · Read the evidence

Every run records what it saw under `.proof/runs/`:

```bash
proof report          # render the latest run as markdown, with the evidence linked
proof report --list   # every recorded run and its verdict
```

That is the loop: **implement → `proof check` → read evidence → fix → `proof check` → DONE.**

## "Why not just write a test?"

The honest answer, because it is the first thing anyone asks.

A test suite answers *did I break anything?* A contract answers *did I do the thing I was asked
to do?* Those fail at different times — and an agent that implements **nothing** leaves your
entire suite green.

This is not "proof tests reality, tests test units". Integration tests, supertest and Playwright
all exercise the running app too. Five things a suite structurally cannot do:

**1 · Tell the requirement apart from the regression guards.** `proof falsify` on this very
repository:

```
9 of 33 check(s) fail without your change, so the contract is about it
24 would pass either way (unit tests, cli is executable, +21 more) — regression guards
```

Mechanical, not a judgement. No test runner knows which of its 4,000 tests are about the ticket
in front of you. It is red-before-green enforced by a machine, and it kills
`expect: {status: 200}` on a route that already existed — the exact check an agent writes to
satisfy itself.

**2 · Notice that the verification moved.** An agent that cannot make a test pass deletes the
test, and in a 4,000-test suite nobody sees it. proof reports it *in the verdict*: checks
removed, the suite edited by the same diff, a `skip:` that costs you the `DONE`. A contract is
fifteen reviewable lines in the pull request.

**3 · Refuse to overstate a pass.** No test runner has an opinion about a green run. This one
does — *"nothing here asserts what the app returned, only that it answered"*, *"this check
failed 1 of the last 2 runs"*, `INCOMPLETE` instead of `DONE`, exit 1 for a stale report.

**4 · Hand an agent something it can act on.** `{expected, observed, evidence, was, since}` —
including *"this passed in run 7, you broke it"* versus *"this never passed, you have not
finished."* Those render identically in any test runner, and only one is about the edit just
made.

**5 · Be the loop's terminating condition.** With `proof hook --install` the agent stops when
the contract passes, not when it feels done.

**When to just write a test:** you already have Playwright or pytest; you need factories,
fixtures, mocks or parameterized cases; it is unit-level logic; it is permanent regression
coverage. All of those are a test's job, and `proof` is not trying to take it. Point a check at
the runner and name its report, and the failures arrive with the test names attached:

```yaml
- name: the browser suite
  run: npx playwright test --reporter=junit
  results: results.xml       # `auth › rejects an expired token — expected 401, got 200`
```

**So use both** — the contract's first check *is* your suite:

```yaml
- name: the suite still passes
  run: npm test                # your real tests, unchanged
- name: a reset link is emailed and the old password stops working
  http:
    method: POST
    path: /api/password-reset
    body: {email: ada@example.com}
    expect: {status: 200, json: {sent: true}}
```

`falsify` then tells you which is which — and the suite check correctly shows up as a
regression guard.

## How it works

```
   requirement
        │
        ▼
  .proof/spec.yaml ──────┐
   (the contract)        │
                         ▼
   proof check ──▶ starts your app ──▶ runs every check ──▶ VERDICT + evidence
                    serve:                run:  http:          .proof/runs/0001/
                    ready_url / ready_log file: env: browser:   result.json
                                                                commands.log
                                                                screenshots/
```

Nothing is asked of a model. `proof` reports what it observed.

## Commands

| Command | What it does |
| --- | --- |
| `proof init "<requirement>"` | Write an acceptance contract, seeded from the repo's own commands |
| `proof lint` | Read the contract back in English, and what it would prove, without running it |
| `proof seal` | Fingerprint the contract, so an edit to it after the fact is visible rather than silent |
| `proof diff` | What the contract has changed since it was sealed, and which criteria that leaves unverified |
| `proof falsify` | Run the contract against the code before your change — it must fail, or it is not testing it |
| `proof check` | Execute the contract against the running app; record evidence |
| `proof challenge` | Inject faults into a copy of your code — the contract has to catch each one |
| `proof attack [<criterion>]` | Search for a scenario where the contract passes and the claim is violated |
| `proof replay <id>` | Run a recorded counterexample again; passes once it stops reproducing |
| `proof promote <id>` | Turn a counterexample into a check, so the contract cannot miss it twice |
| `proof done` | The completion gate: coverage, falsification, challenges and integrity, in one verdict |
| `proof report [run]` | Render a run's evidence; `--list` shows all runs, `--prune` cleans old ones |
| `proof infer` | Find verification gaps in the current diff; `--write` appends them as checks |
| `proof changed` | Blast radius of the diff — what changed, what depends on it, what covers it |
| `proof guard -- <agent...>` | Supervise a coding agent: rerun it with the failure evidence until the contract passes |
| `proof hook` | The same gate as a Claude Code Stop hook — `--install` wires it up |

Every command takes `--json`. Full flags, exit codes and JSON shapes:
[docs/commands.md](docs/commands.md).

## What it can assert

| Verb | Asserts |
| --- | --- |
| `run` | A command's exit code and output — builds, suites, migrations, CLIs. With `results:` it reads the runner's own JUnit report, so failures arrive by test name |
| `http` | A request's status, response headers, body and JSON shape; a shared session across checks; and races, via several simultaneous requests |
| `file` | An artifact exists, contains something, or no longer contains something |
| `env` | A variable the run depends on is actually set |
| `browser` | A real flow in Chromium — fill, click, navigate, and the requests it fires |

Any check can also carry `timeout`, `expect_under_ms` (a requirement phrased in time),
`retry_for_ms` (wait for a queued job, a webhook, a replica catching up), `parallel` (run
alongside its neighbours), `skip` (quarantine it, with the reason), and `capture` — values a
later check uses:

```yaml
- name: an order is created
  http: {method: POST, path: /orders, body: {sku: ABC-1}, expect: {status: 201}}
  capture: {order_id: json.id}
- name: the order is readable at the id it was given
  http: {path: "/orders/${order_id}", expect: {status: 200, body_contains: "ABC-1"}}
```

Without that last part every path has to be a literal, so contracts end up hardcoding a row
someone saw in their own database once — a check that passes on one machine and 404s on
every other.

And a race, which no sequence of requests can show — ask twice in a row and you get 201 then
409 whether the lock works or not:

```yaml
- name: only one of five simultaneous claims on an order wins
  http:
    method: POST
    path: "/orders/${order_id}/claim"
    concurrent: 5
    expect: {statuses: {201: 1, 409: 4}}
```

```
Expected:  5 at once: 1×201, 4×409
Observed:  5 at once: 5×201
```

That is a check-and-set straddling an `await`, an idempotency key nobody enforces, or two
writers on one row.

A complete REST contract — sign in, create, read back by captured id, another user forbidden,
delete, gone — is in [docs/examples.md](docs/examples.md). Full reference, including the
`serve` block, multi-process stacks, sessions and redirects:
[docs/contract.md](docs/contract.md).

## Not just web apps

`run:`, `file:` and `env:` verify anything that runs in a shell — CLIs, pipelines, services in
any language:

```yaml
goal: the export command produces a complete CSV

checks:
  - name: it builds
    run: cargo build --release

  - name: exporting succeeds and says so
    run: ./target/release/tool export --out data.csv
    expect_output: "exported"

  - name: the output has the header and no debug noise
    file: {path: data.csv, contains: "id,name,total", not_contains: "DEBUG"}
```

`infer` reads JavaScript, TypeScript, Python and Go — and any language at all through an
OpenAPI document. `changed` builds its import graph from JavaScript, TypeScript, Python and
Go. More worked examples — a Go API, a data pipeline, database migrations, a security fix, a
browser flow with sessions: [docs/examples.md](docs/examples.md).

## Four questions a passing run does not answer

`proof check` says the checks passed — a claim about the checks, not about the requirement.
Each question below has one command, and `proof done` is where they meet.

| Question | Command | What it catches |
| --- | --- | --- |
| Does the contract cover the whole requirement? | `criteria:` + `satisfies:`, reported by `check` and `lint` | Four green checks about the happy path, and nothing about token expiry |
| Would it fail on the code from before the change? | `proof falsify` | `expect: {status: 200}` on a route that already existed |
| Would it catch a wrong implementation? | `proof challenge` | The endpoint answers; the guard it was supposed to have is never exercised |
| Is there a way to be wrong that it would accept? | `proof attack` | Two requests at once, where the contract only ever asked twice in a row |
| Is this still the contract that was agreed? | `proof seal`, `proof diff` | A check quietly relaxed until it passed |

**Discrimination.** `proof falsify` checks out the commit your change started from, runs the
**current** contract against it, and reports what failed. Your working tree is never touched:

```
VERDICT
  DISCRIMINATES
  2 of 3 check(s) fail without your change, so the contract is about it
  1 would pass either way (it still builds) — regression guards, not the requirement
```

If every check passes there, the contract would report `DONE` for a branch that did nothing —
and it says so, and exits 1. It is red-before-green for acceptance criteria, made mechanical.

**Coverage.** Name what was asked for, and say which check is evidence for each part:

```yaml
goal: a user can reset a forgotten password, safely
criteria:
  - id: AC3
    requirement: a reset token cannot be reused
    source: issue#143
checks:
  - name: a used token is refused
    satisfies: [AC3]
    run: npm run test:reset-reuse
```

A criterion nothing points at makes the run `INCOMPLETE` however green it is — passing checks
are evidence for what the checks assert, not for what was asked for.

**Attack.** The strongest finding here is not a bug, it is a hole in the verification:

```
VERIFICATION GAP  AC3
  2 concurrent redeem requests may all succeed
  Invariant:  successful_redeem <= 1
  Observed:   successful_redeem was 2
  Contract:   redeeming the same token again is refused: PASSED
```

The contract asked twice in a row and got its `401`. Two at once both got `200`. Finding that
needs two judges able to disagree — the checks that carry the criterion, and an invariant
counting what actually happened — so a criterion can declare what a search may compose:

```yaml
    attack:
      surfaces: [concurrency, sequence]
      actions:
        - name: redeem
          http: {method: POST, path: /redeem, body: {token: "${token}"}}
      invariants:
        - successful_redeem <= 1
```

Findings are minimized, kept as counterexamples, and `proof replay ce-…` re-runs one until it
stops reproducing. `proof promote ce-…` turns it into a permanent check — every successful
attack leaves the contract stronger than the one that accepted it. A search that finds nothing
reports its strategies, candidate count and seed; it never reports correctness.

**The gate.** `proof done` runs nothing. It reads the records the other commands wrote — each
stamped with the commit and contract hash it was produced under — and answers the only question
that matters, non-zero unless the answer is `DONE`:

```
Criteria                4/4 VERIFIED
Checks                  9/9 PASS (run 0012)
Falsification           PASS
Challenges              COMPLETE
Attack                  COMPLETE — no counterexample found
Evidence                CURRENT
VERDICT  DONE
```

How much of that chain is required is the project's to choose (`policy: {require_attack: true}`
and friends). `INCOMPLETE` means the evidence is not there yet; `INVALID` means it is about
another commit or another contract.

Full syntax, strategies, budgets, seeds and boundaries:
[docs/commands.md](docs/commands.md) · [docs/contract.md](docs/contract.md).

## A verdict that means something

The point of a verification tool is that its green is trustworthy, so `proof` is explicit
about what a pass does *not* prove. On a run where nothing asserts content:

```
NOTE
  No http or browser check here asserts what the app actually returned, only that it
  answered — a 200 carrying the wrong body passes. Add `expect: {body_contains: ...}` or
  `expect: {json: ...}` to the checks that carry the requirement.
```

Alongside that:

- **Strict validation.** An unrecognised key is rejected, never ignored — a silently dropped
  key is an assertion that never runs, and a check that asserts nothing must never report PASS.
- **Regression vs. unfinished.** A failure says whether it passed in the previous run, compared
  against what that run actually *asserted*, so editing a check never reads as breaking code.
- **The contract is testable too.** `proof falsify` proves it fails without your change, so a
  contract that asserts nothing cannot hide behind a green run.
- **Never DONE for what it did not verify.** A subset run (`--only`) reports `INCOMPLETE`. A
  contract still holding a scaffolded placeholder is refused. A report about a tree the repo
  has moved past exits 1.
- **Flakes are named, on green runs too.** Every run reads the last ten of the same contract. A
  check whose history holds both outcomes for the same assertion is called out — a verdict
  resting on one means less than it looks. A check that always passed and fails now is a
  regression, not a flake, and is reported as one.
- **Coverage is part of the verdict.** A declared criterion with no check pointing at it makes
  a green run `INCOMPLETE` — passing checks are evidence for what the checks assert, not for the
  requirement.
- **The contract's own strength is measured.** `proof challenge` reports which plausible wrong
  implementations the contract catches and which it does not, and keeps every miss as a
  counterexample rather than a number.
- **A quarantined check still costs you the verdict.** `skip:` keeps it in the file with its
  reason and reports `INCOMPLETE`; deleting it would be invisible and report `DONE`.
- **Observed but not gated.** Followed redirects, console errors, a tree that changed mid-run,
  a contract the same diff rewrote — all reported, none of them silently.

[docs/evidence.md](docs/evidence.md) covers what a green run does and does not mean.

## For coding agents

### Claude Code — one command

```bash
proof hook --install
```

From then on, every time Claude Code believes it is finished, the contract runs. A pass lets
it stop. A failure sends the evidence back as its next instruction and keeps it working — up
to five times, then it may stop with the evidence in `.proof/feedback.md`. The hook is silent
in a project with no contract, so it is safe in your global settings too.

For the other half — teaching the agent to write the contract *before* the code, so the checks
are not shaped around what it happened to build — copy the skill in:

```bash
mkdir -p .claude/skills/proof && cp skills/proof/SKILL.md .claude/skills/proof/
```

It makes the agent write the contract from the requirement, confirm with `proof falsify` that it
fails without the change, and only then implement. Red before green, for acceptance criteria.

### Any other agent

Agents integrate through the CLI — no plugin, no SDK:

```bash
proof check --json    # {status, checks, failures: [{check, expected, observed, evidence, ...}]}
```

The stronger gate is `proof done`, which is the loop's terminating condition rather than a
report on one run:

```bash
until proof done; do agent "make .proof/spec.yaml pass"; done
```

Or flip the loop around and make `proof` the completion gate:

```bash
proof guard --max-attempts 5 -- claude -p "implement the requirement in .proof/spec.yaml"
```

Each cycle runs the agent, then runs the contract. A pass ends the loop; a failure writes the
evidence to `.proof/feedback.md` and relaunches the agent with it. The agent stops when the
contract passes — not when it feels done. Details: [docs/agents.md](docs/agents.md).

## In CI

```yaml
- uses: sajjadriaj/proof@main
```

It runs the contract, writes JUnit XML your CI already knows how to annotate a pull request
from, appends the markdown report to the job summary, and exits with the verdict's own code.
By hand it is three lines:

```yaml
- run: proof check
- if: always()
  run: proof report --junit > proof-results.xml
- if: always()
  run: proof report >> "$GITHUB_STEP_SUMMARY"
```

Where the whole chain matters — coverage, falsification, challenges, contract integrity — the
gate is one line and one artifact:

```yaml
- run: proof done            # non-zero unless the verdict is DONE; writes .proof/report.json
```

`INCOMPLETE`, `STALE` and every "observed but not gated" line are carried into the XML —
a CI report that drops them is the one place the claim gets read as stronger than it is.

To verify a deployment rather than start the app, `proof check --base-url https://staging.example.com`.

## Editor support

`.proof/spec.yaml` has a JSON Schema, generated from the same table the validator enforces:

```yaml
# yaml-language-server: $schema=https://raw.githubusercontent.com/sajjadriaj/proof/main/schema/spec.schema.json
```

It gives completion and catches unknown keys as you type. `proof check` remains what decides
whether a contract is valid — the schema cannot express rules like "exactly one verb per check".

## Documentation

| Doc | Covers |
| --- | --- |
| [**Writing a contract**](docs/writing-a-contract.md) | How to turn a requirement into checks that mean something |
| [Schema](schema/spec.schema.json) | The contract's JSON Schema, for editor completion |
| [Contract reference](docs/contract.md) | Every verb, the `serve` block, multi-process stacks, sessions, strict validation |
| [Command reference](docs/commands.md) | Each command in depth, flags, exit codes, error codes, every `--json` field |
| [Verdicts and evidence](docs/evidence.md) | What a green run does and does not mean, evidence bundles, reports, regression markers |
| [Discovery](docs/discovery.md) | `changed` (blast radius) and `infer` (gap detection) in depth |
| [Working with agents](docs/agents.md) | The agent loop and `proof guard` |
| [Examples](docs/examples.md) | A complete REST API contract, a CLI, a Go service, a data pipeline, migrations, a security fix |
| [Design](docs/design.md) | Principles, non-goals, development |

## Non-goals

Not a coding agent, not an IDE, not a test-framework replacement, not a CI platform, not an
MCP server. `proof` sits one layer above your existing tools and runs your project's own
commands, asserting on what the running application actually does.

It is deliberately not a place to put logic. No fixtures, no factories, no mocks, no
parameterized cases — the moment a check needs code, that check is a test, and
`run: npx playwright test smoke.spec.ts` is the right way to reach it from here.

## Development

```bash
npm test
```

The suite covers the browser verb, so it needs the same Chromium build that verb does:
`npx playwright install chromium`. Without it the browser tests fail on a clean clone — a
missing download rather than a broken project.

## License

[MIT](LICENSE).
