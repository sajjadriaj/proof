# Working with coding agents

[← back to README](../README.md)

## The agent loop

```
Implement → proof check --json → PASS → done
                    │
                    └─ FAIL → read evidence → fix → proof check --json
```

Any agent that can run a shell command can use `proof`. There is no SDK and no integration.

```bash
proof check --json
```

```json
{
  "status": "failed",
  "goal": "Password reset works end-to-end",
  "run": ".proof/runs/0001",
  "checks": { "app boots": "passed", "browser flow": "failed" },
  "failures": [
    {
      "check": "browser flow",
      "expected": "POST /api/password-reset",
      "observed": "Expect POST /api/password-reset → no matching request in 5000ms — no network request was generated",
      "output": "Browser console:\n  resetPassword is not defined\n    at HTMLButtonElement.<anonymous> (/forgot-password:8:67)",
      "evidence": [".proof/runs/0001/browser-browser-flow.json", ".proof/runs/0001/screenshots/browser-flow.png"]
    }
  ]
}
```

A boolean is not enough for an autonomous agent. The failure names the route, the action,
what was expected, what was observed, and the console error that explains it — which is the
context the next iteration needs.

## Claude Code

Claude Code has a place for exactly the decision this tool makes: a **Stop hook** runs when
the agent believes it is finished, and can refuse to let it stop. One command installs proof
there:

```bash
proof hook --install
```

That writes a `Stop` entry into `.claude/settings.json` — merged into whatever is already
there, never overwriting it — and from then on every time Claude Code thinks it is done, the
contract runs. A pass lets it stop. A failure sends the evidence back as its next instruction
and keeps it working:

```
proof check: NOT DONE (attempt 1 of 5) — 1 check(s) failed: the profile page shows the user.

# Verification failed (attempt 1)

Requirement: users can log in and see their profile
...
```

The budget is the override, as `--max-attempts` is for `guard`: after five refusals (or
`--max-attempts N`) the agent may stop, with the evidence in `.proof/feedback.md` and the
reason on stderr. The counter resets on a pass and after the budget is spent, so no session
inherits another's refusals.

Three things make it safe to leave installed everywhere:

- **No contract, no opinion.** In a directory with no `.proof/spec.yaml` the hook exits
  silently, so it can live in your global `~/.claude/settings.json`.
- **A contract that can never complete does not hold the agent hostage.** A broken contract, a
  placeholder, or a skipped check lets the stop through with the reason on stderr — those are
  the human's to fix, and blocking every stop over them would burn the budget for nothing the
  agent did.
- **The hook's timeout is 900 seconds**, not Claude Code's 60-second default. A contract that
  boots an app and drives a browser is routinely longer than a minute, and a hook killed
  mid-run lets the agent stop with no verdict at all.

`proof hook --print` shows the snippet instead of installing it, for a settings file you
manage by hand or another tool that reads the same shape.

### Teaching an agent to write the contract

The hook enforces a contract. Something still has to write one, and an agent writing it *after*
the code shapes the checks around whatever it happened to build — the self-judging this whole
tool exists to remove.

`skills/proof/SKILL.md` in this repository is a Claude Code skill that fixes the order. Copy it
in:

```bash
mkdir -p .claude/skills/proof && cp /path/to/proof/skills/proof/SKILL.md .claude/skills/proof/
```

It tells the agent to write the contract from the requirement **before reading the
implementation**, read it back with `proof lint`, and confirm with `proof falsify` that it fails
without the change — refusing to continue on `DOES NOT DISCRIMINATE`. Then implement, then
`proof check`. Red before green, for acceptance criteria, enforced rather than remembered.

It also carries the rules that decide whether a contract means anything: assert content rather
than a status, never hardcode an id, quarantine with `skip:` instead of deleting, and never edit
the contract to make a failing check pass.

## `proof guard`

The completion gate: instead of the agent deciding when it is finished, the contract decides.

```bash
proof guard -- claude -p "implement the requirement in .proof/spec.yaml"
proof guard --max-attempts 5 -- aider --message "{feedback}"
```

Each cycle runs the agent to completion, then runs `proof check`. A pass ends the loop with
exit 0. A failure writes the evidence to `.proof/feedback.md` and relaunches the agent, which
finds it three ways:

- `{feedback}` in its arguments is replaced with the failure evidence inline, and
  `{feedback_file}` with the path (`(first attempt — no verification has run yet)` before any
  check has run)
- `PROOF_GUARD_ATTEMPT` and `PROOF_GUARD_FEEDBACK` in its environment
- the file itself, at a fixed path an agent can be told about once

The loop ends only on a pass or an explicit override — Ctrl-C, or `--max-attempts` (exit 1
when exhausted). Two things abort it early, both with exit 2: a contract that is missing,
invalid or still holding a placeholder is refused **before the agent first runs** — every
attempt would be refused, which from outside the loop looks like an agent that cannot
finish — and a contract broken *mid-loop* (an agent rewriting the definition of done) stops
the loop rather than iterating against it. The feedback file is deleted on success, so stale
evidence never sits beside a green verdict. Everything after `--` belongs to the agent
verbatim; proof never parses its flags.

`guard` is for every agent that is not Claude Code — or for running Claude Code non-interactively
from CI — since it needs nothing from the agent but an exit. Guard runs `proof check --json` as a subprocess — it is exactly the generic agent loop from
the Agent Integration section, on the same interface every other agent uses.
