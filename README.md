<div align="center">

# proof

**Don't trust your coding agent. Test its work.**

Write down what "done" means once. `proof` starts your app, checks it, and tells you — with
evidence — whether the change actually does what was asked.

[![ci](https://github.com/sajjadriaj/proof/actions/workflows/ci.yml/badge.svg)](https://github.com/sajjadriaj/proof/actions/workflows/ci.yml)
[![node](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](https://nodejs.org)
[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![runtime deps](https://img.shields.io/badge/runtime%20deps-1-lightgrey)](package.json)

[Install](#install) · [Quick start](#quick-start) · [With your agent](#with-your-agent) · [In CI](#in-ci) · [Docs](#documentation)

</div>

---

Coding agents write code and then grade their own work. The unit tests pass, so they report
success — while the button is wired to nothing.

![proof demo — a failing check caught with evidence, fixed, and verified green](docs/demo.gif)

`proof` is the second opinion. You describe the requirement in a short YAML file, and `proof`
checks it against the **running app** — no model involved, only what it observed.

## Install

```bash
npm i -g github:sajjadriaj/proof
```

Needs Node 20+. Or run it without installing: `npx github:sajjadriaj/proof init "<requirement>"`.
Browser checks also need Playwright: `npm i -D playwright && npx playwright install chromium`.

## Quick start

**1. Create a contract** from the requirement. `proof` fills in your build and test commands, and
how to start the app when it can tell:

```bash
proof init "users can log in and see their profile"
```

**2. Say what "done" looks like** in `.proof/spec.yaml`:

```yaml
goal: users can log in and see their profile

serve:                          # how to start the app
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

**3. Check it:**

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

Fix, run `proof check` again, repeat until `DONE`. Exit code `0` passed, `1` failed, `2` the
contract itself is wrong. `proof report` renders the latest run as markdown.

New to contracts? [**Writing a contract**](docs/writing-a-contract.md) takes ten minutes.

## Is the contract any good?

A green run only means the checks passed. Two more commands tell you whether the checks mean
anything:

```bash
proof falsify   # run the contract against the code from BEFORE your change
proof done      # the final gate: DONE only if all the evidence adds up
```

`falsify` is the one to try first. A check that passes without your change is not testing your
change. On this repository it says: *"7 of 42 check(s) fail without your change; 35 would pass
either way."* It catches the `expect: {status: 200}` on a route that already existed — the exact
check an agent writes to satisfy itself.

<details>
<summary>More questions a passing run does not answer</summary>

| Question | Command |
| --- | --- |
| Does the contract cover every part of the requirement? | `criteria:` + `satisfies:` in the contract |
| Would it fail on the code from before the change? | `proof falsify` |
| Would it catch a wrong implementation? | `proof challenge` (injects faults) |
| Is there a way to be wrong that it would accept? | `proof attack` (races, odd sequences) |
| Is this still the contract that was agreed? | `proof seal`, then `proof diff` |

`proof done` reads all of these and answers `DONE`, `INCOMPLETE` (evidence missing) or `INVALID`
(evidence about another commit or contract). See [Verdicts and evidence](docs/evidence.md).

</details>

## With your agent

**Claude Code** — one command:

```bash
proof hook --install
```

Now whenever Claude thinks it is finished, the contract runs. Pass: it stops. Fail: the evidence
becomes its next instruction. The hook does nothing in a project without a contract, so it is
safe to install globally.

To teach the agent to write the contract *before* the code:

```bash
mkdir -p .claude/skills/proof && cp skills/proof/SKILL.md .claude/skills/proof/
```

**Any other agent** — use the CLI:

```bash
until proof done; do agent "make .proof/spec.yaml pass"; done
# or let proof drive it:
proof guard --max-attempts 5 -- claude -p "implement .proof/spec.yaml"
```

`proof check --json` gives the agent `{expected, observed, evidence}` for each failure. More in
[Working with agents](docs/agents.md).

## In CI

```yaml
- uses: sajjadriaj/proof@main
```

Runs the contract, writes JUnit XML for PR annotations, adds the report to the job summary, and
fails the job unless the verdict passes. Use `run: proof done` for the full gate, or
`proof check --base-url https://staging.example.com` to check a deployment instead of starting
the app.

## What a check can assert

| Verb | Asserts |
| --- | --- |
| `run` | A command's exit code and output — builds, test suites, migrations, CLIs |
| `http` | A request's status, headers, body and JSON shape — including races via simultaneous requests |
| `file` | A file exists, contains something, or no longer contains something |
| `env` | An environment variable the app needs is set |
| `browser` | A real flow in Chromium — fill, click, navigate |

Every check can also take `timeout`, `retry_for_ms`, `expect_under_ms`, `skip` and `capture`
(save a value for a later check). Your existing test suite fits in one line — `run: npm test` —
and the rest of the contract is about the change. Full reference: [The contract](docs/contract.md).

## Commands

| Everyday | |
| --- | --- |
| `proof init "<requirement>"` | Write a starter contract from your repo's own commands |
| `proof check` | Run the contract against the app and record evidence |
| `proof report` | Show a run's evidence as markdown |
| `proof lint` | Explain what the contract would prove, without running it |

| Trusting the result | |
| --- | --- |
| `proof falsify` | Run the contract against the old code — it should fail there |
| `proof done` | The final gate: coverage, falsification, challenges, freshness |
| `proof seal` / `proof diff` | Lock the contract, then see what changed in it since |
| `proof challenge` | Inject faults into a copy of your code; the contract must catch each |
| `proof attack` | Search for a scenario the contract passes but the claim fails |
| `proof replay <id>` / `proof promote <id>` | Re-run a found counterexample / turn it into a check |

| Agents and exploring | |
| --- | --- |
| `proof hook --install` | Gate Claude Code's "I'm done" on the contract |
| `proof guard -- <agent...>` | Re-run any agent with the failure evidence until it passes |
| `proof infer` | Find untested parts of the current diff |
| `proof changed` | Show what the diff touches, and which checks cover it |

Every command takes `--json`. Flags, exit codes and output fields: [Command reference](docs/commands.md).

## Why not just write a test?

Use both. A test suite answers *did I break anything?* A contract answers *did I do what was
asked?* An agent that implements **nothing** leaves your whole suite green. What `proof` adds:

- **It tells the requirement apart from the regression guards** — `proof falsify`.
- **It notices when the tests move.** Deleted checks, a suite edited in the same diff, a `skip:`
  — all reported in the verdict, and they cost you the `DONE`.
- **It won't overstate a pass.** A check that only proves the app *answered* gets flagged, and
  the run says `INCOMPLETE` instead of `DONE`.
- **It gives an agent something to act on** — expected, observed, and whether it ever passed.
- **It can end the agent's loop** — the agent stops when the contract passes, not when it feels
  done.

## Documentation

**Start here**

1. [Writing a contract](docs/writing-a-contract.md) — turn a requirement into checks that mean something
2. [Examples](docs/examples.md) — REST API, CLI, Go service, data pipeline, migrations, security fix
3. [Working with agents](docs/agents.md) — the hook, `proof guard`, the agent loop

**Reference**

- [The contract](docs/contract.md) — every verb and key, `serve`, criteria, attacks, editor schema
- [Commands](docs/commands.md) — flags, exit codes, every `--json` field
- [Verdicts and evidence](docs/evidence.md) — what green does and does not mean
- [Discovery](docs/discovery.md) — `proof changed` and `proof infer` in depth
- [Design](docs/design.md) — principles, non-goals, development

`proof` is not a coding agent, an IDE, a test framework or a CI platform. It runs your project's
own commands and reports what the running app actually did.
