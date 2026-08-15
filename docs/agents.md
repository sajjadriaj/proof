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

Guard runs `proof check --json` as a subprocess — it is exactly the generic agent loop from
the Agent Integration section, on the same interface every other agent uses.
