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

Or with nothing installed: `npx github:sajjadriaj/proof init "<requirement>"`. Requires Node 20+
and one runtime dependency (`yaml`). The `browser:` verb additionally needs Playwright:
`npm i -D playwright && npx playwright install chromium`.

## Quick start

`init` seeds the contract from your repo's own build and test commands, and writes a live
`serve` block when it can tell how the project starts:

```bash
proof init "users can log in and see their profile"
```

Then describe "done" in `.proof/spec.yaml`. Checks run against the app `proof` starts for you:

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

```console
$ proof check

CHECKS
  app boots                        PASS
  it still builds                  PASS
  logging in sets a session        PASS
  the profile page shows the user  FAIL
  app still running                PASS

FAILURE
  Check:     the profile page shows the user
  Expected:  status 200
  Observed:  status 500

Evidence:
  .proof/runs/0001/result.json

VERDICT
  NOT DONE
  4 passed, 1 failed
```

`app boots` and `app still running` are checks `proof` adds itself for the `serve` block. Exit
`0` passed, `1` failed, `2` the contract itself is wrong. Every run records what it saw under
`.proof/runs/`; `proof report` renders the latest as markdown with the evidence linked.

That is the loop: **implement → `proof check` → read evidence → fix → `proof check` → DONE.**
New to this? [**Writing a contract**](docs/writing-a-contract.md) walks from a requirement to a
contract that means something.

## "Why not just write a test?"

A test suite answers *did I break anything?* A contract answers *did I do the thing I was asked
to do?* Those fail at different times — and an agent that implements **nothing** leaves your
entire suite green.

This is not "proof tests reality, tests test units": integration tests, supertest and Playwright
all exercise the running app too. Five things a suite structurally cannot do:

1. **Tell the requirement apart from the regression guards.** `proof falsify` on this very
   repository: *"7 of 42 check(s) fail without your change; 35 would pass either way."*
   Mechanical, not a judgement — and it kills `expect: {status: 200}` on a route that already
   existed, the exact check an agent writes to satisfy itself.
2. **Notice that the verification moved.** An agent that cannot make a test pass deletes the
   test, and in a 4,000-test suite nobody sees it. proof reports it *in the verdict*: checks
   removed, the suite edited by the same diff, a `skip:` that costs you the `DONE`.
3. **Refuse to overstate a pass.** *"Nothing here asserts what the app returned, only that it
   answered."* `INCOMPLETE` instead of `DONE`. Exit 1 for a stale report.
4. **Hand an agent something it can act on.** `{expected, observed, evidence, was, since}` —
   *"this passed in run 7, you broke it"* versus *"this never passed, you have not finished."*
5. **Be the loop's terminating condition.** With `proof hook --install`, the agent stops when
   the contract passes, not when it feels done.

**So use both.** The contract's first check *is* your suite, and `falsify` then tells you which
is which:

```yaml
- name: the suite still passes
  run: npm test                # your real tests, unchanged
- name: a reset link is emailed and the old password stops working
  http: {method: POST, path: /api/password-reset, body: {email: ada@example.com}, expect: {status: 200, json: {sent: true}}}
```

Factories, fixtures, mocks, parameterized cases and unit-level logic are a test's job, and
`proof` is not trying to take it. Point a check at your runner and name its report
(`results: results.xml`) and the failures arrive by test name.

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
`retry_for_ms` (a queued job, a webhook, a replica catching up), `parallel`, `skip` (quarantine
it, with the reason), and `capture` — so a contract creates what it later reads instead of
hardcoding a row someone saw in their own database once:

```yaml
- name: an order is created
  http: {method: POST, path: /orders, body: {sku: ABC-1}, expect: {status: 201}}
  capture: {order_id: json.id}
- name: the order is readable at the id it was given
  http: {path: "/orders/${order_id}", expect: {status: 200, body_contains: "ABC-1"}}
- name: only one of five simultaneous claims on an order wins
  http: {method: POST, path: "/orders/${order_id}/claim", concurrent: 5, expect: {statuses: {201: 1, 409: 4}}}
```

That last one is the check no sequence of requests can write: ask twice in a row and you get
201 then 409 whether the lock works or not.

`run:`, `file:` and `env:` verify anything that runs in a shell — CLIs, pipelines, services in
any language. `infer` reads JavaScript, TypeScript, Python and Go, and any language at all
through an OpenAPI document. A complete REST contract, a Go API, a data pipeline, migrations
and a security fix: [docs/examples.md](docs/examples.md). Full reference:
[docs/contract.md](docs/contract.md).

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

**Coverage.** Name what was asked for, and say which check is evidence for each part. A
criterion nothing points at makes the run `INCOMPLETE` however green it is:

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
counting what actually happened — so a criterion declares what a search may compose:

```yaml
    attack:
      surfaces: [concurrency, sequence]
      actions:
        - name: redeem
          http: {method: POST, path: /redeem, body: {token: "${token}"}}
      invariants:
        - successful_redeem <= 1
```

Findings are minimized and kept; `proof replay ce-…` re-runs one until it stops reproducing, and
`proof promote ce-…` turns it into a permanent check. Every successful attack leaves the
contract stronger than the one that accepted it. A search that finds nothing reports its
strategies, candidate count and seed — it never reports correctness.

**The gate.** `proof done` runs nothing. It reads the records the other commands wrote — each
stamped with the commit and contract hash it was produced under — and is non-zero unless the
answer is `DONE`:

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
another commit or another contract. Syntax, strategies, budgets and boundaries:
[docs/commands.md](docs/commands.md).

## A verdict that means something

The point of a verification tool is that its green is trustworthy, so `proof` is explicit about
what a pass does *not* prove:

```
NOTE
  No http or browser check here asserts what the app actually returned, only that it
  answered — a 200 carrying the wrong body passes. Add `expect: {body_contains: ...}` or
  `expect: {json: ...}` to the checks that carry the requirement.
```

- **Strict validation.** An unrecognised key is rejected, never ignored — a silently dropped key
  is an assertion that never runs.
- **Regression vs. unfinished.** A failure says whether it passed in the previous run, compared
  against what that run actually *asserted*, so editing a check never reads as breaking code.
- **Never DONE for what it did not verify.** A subset run, a scaffolded placeholder, a
  quarantined `skip:`, an uncovered criterion, a contract edited after sealing — each reports
  `INCOMPLETE` rather than passing quietly.
- **Flakes are named, on green runs too.** Every run reads the last ten of the same contract; a
  check whose history holds both outcomes for the same assertion is called out.
- **Observed but not gated.** Followed redirects, console errors, a tree that changed mid-run, a
  contract the same diff rewrote — all reported, none of them silently.

[docs/evidence.md](docs/evidence.md) covers what a green run does and does not mean.

## For coding agents

```bash
proof hook --install
```

Every time Claude Code believes it is finished, the contract runs. A pass lets it stop; a
failure sends the evidence back as its next instruction and keeps it working. The hook is silent
in a project with no contract, so it is safe in your global settings too.

For the other half — teaching the agent to write the contract *before* the code, so the checks
are not shaped around what it happened to build — copy the skill in:

```bash
mkdir -p .claude/skills/proof && cp skills/proof/SKILL.md .claude/skills/proof/
```

Any other agent integrates through the CLI — no plugin, no SDK. `proof check --json` returns
`{status, checks, failures: [{check, expected, observed, evidence, was, since}]}`, and the
loop's terminating condition is the gate rather than a report on one run:

```bash
until proof done; do agent "make .proof/spec.yaml pass"; done
```

Or flip it around: `proof guard --max-attempts 5 -- claude -p "implement .proof/spec.yaml"` runs
the agent, then the contract, and relaunches with the evidence until it passes.
Details: [docs/agents.md](docs/agents.md).

## In CI

```yaml
- uses: sajjadriaj/proof@main
```

It runs the contract, writes JUnit XML your CI already knows how to annotate a pull request
from, appends the markdown report to the job summary, and exits with the verdict's own code.
`INCOMPLETE`, `STALE` and every "observed but not gated" line are carried into the XML — a CI
report that drops them is the one place the claim gets read as stronger than it is.

Where the whole chain matters, the gate is one line and one artifact:

```yaml
- run: proof done            # non-zero unless the verdict is DONE; writes .proof/report.json
```

To verify a deployment rather than start the app: `proof check --base-url https://staging.example.com`.

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
| [Contract reference](docs/contract.md) | Every verb, the `serve` block, criteria, attacks, challenges, strict validation |
| [Command reference](docs/commands.md) | Each command in depth, flags, exit codes, error codes, every `--json` field |
| [Verdicts and evidence](docs/evidence.md) | What a green run does and does not mean, evidence bundles, the verification chain |
| [Discovery](docs/discovery.md) | `changed` (blast radius) and `infer` (gap detection) in depth |
| [Working with agents](docs/agents.md) | The agent loop, `proof guard` and the completion gate |
| [Examples](docs/examples.md) | A REST API, a CLI, a Go service, a data pipeline, migrations, a security fix, a claim worth attacking |
| [Design](docs/design.md) | Principles, non-goals, development |

## Non-goals

Not a coding agent, not an IDE, not a test-framework replacement, not a CI platform, not an MCP
server. `proof` sits one layer above your existing tools and runs your project's own commands,
asserting on what the running application actually does.

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
