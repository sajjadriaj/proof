---
name: proof
description: Use when implementing a requirement, feature, bugfix or ticket in a repository that has proof installed, or when asked to verify that a change actually satisfies what was asked. Writes the acceptance contract from the requirement BEFORE the code, confirms it fails without the change, then implements until it passes.
---

# Writing and satisfying an acceptance contract

`proof` is a verification layer that sits above the test suite. It executes a contract —
`.proof/spec.yaml` — against the running application and produces a verdict backed by evidence.

The point of this skill is **sequence**. You may write the contract, but only *before* the code
exists. Once there is an implementation, every check you write is shaped by what you happened to
build, which is the self-judging this tool exists to remove.

## The loop

**1 · Write the contract first, from the requirement alone.**

Before reading implementation files, before planning the change, write down what would convince a
sceptic the requirement is met. Ask yourself: *what would a person do to check this?* Then write
that.

```bash
proof init "<the requirement, in the user's words>"
```

Then edit `.proof/spec.yaml`. Read `docs/writing-a-contract.md` in the repository if it is there;
its rules are the ones below.

**2 · Read it back.**

```bash
proof lint
```

This prints every check as the sentence it asserts, and tells you what a passing run would and
would not prove. Fix anything that reads wrong. `UNFINISHED` means a placeholder is still in the
file and `proof check` will refuse it.

**3 · Confirm it fails without the change. This step is not optional.**

```bash
proof falsify
```

- `DISCRIMINATES` — good. At least one check needs the change. Continue.
- `DOES NOT DISCRIMINATE` — **stop and fix the contract.** Every check passes on the code from
  before the change, so the contract would report DONE for a branch that did nothing. This is the
  single most common failure and it is always the same cause: you asserted that an endpoint
  *answered* rather than what it *returned*. Go back to step 1.
- `INCONCLUSIVE` — the base commit would not run, so the question was not answered. Read the
  reason; do not treat it as a pass.

**4 · Implement.**

Now read the code and make the change.

**5 · Verify, and iterate on the evidence.**

```bash
proof check
```

Exit `0` passed, `1` failed, `2` the contract itself is wrong. On a failure, read `expected` and
`observed` and the evidence path — do not guess. `proof check --only "<text>"` runs one check
while iterating; it reports `INCOMPLETE`, never `DONE`, so finish with a full run.

## Rules for the contract itself

**Assert what the app returned, not that it answered.** This is the rule that matters most.
`expect: {status: 200}` passes on an empty body, the wrong record, or `null`.

```yaml
# proves almost nothing
- name: orders endpoint
  http: {path: /api/orders, expect: {status: 200}}

# proves the requirement
- name: the order comes back with its total
  http:
    path: "/api/orders/${order_id}"
    expect: {status: 200, json: {id: "${order_id}", total: "<number>", items: "<array>"}}
```

**Never hardcode an id.** A check on `/orders/17` passes only where order 17 exists. Make the
contract create what it later reads:

```yaml
- name: an order is accepted
  http: {method: POST, path: /orders, body: {sku: ABC-1}, expect: {status: 201}}
  capture: {order_id: json.id}
- name: and it reads back at the id it was given
  http: {path: "/orders/${order_id}", expect: {status: 200, body_contains: "ABC-1"}}
```

**Name each check as a claim, not a command.** `FAIL — test` tells the next reader nothing.
`FAIL — a wrong password does not create a session` tells them everything.

**Pair every absence with a presence.** `body_not_contains` proves a stack trace is gone; it is
no evidence the response is right.

**One line for the existing suite.** `run: npm test` covers regressions. If the suite writes a
JUnit report, name it and failures arrive by test name: `results: report.xml`.

**Do not put logic in the contract.** No fixtures, factories, mocks or parameterized cases. The
moment a check needs code it is a test — write the test and reach it with
`run: npx playwright test smoke.spec.ts`.

## Things that will stop you, and what they mean

| What proof says | What to do |
| --- | --- |
| `DOES NOT DISCRIMINATE` | The contract does not test the change. Assert content, not status. |
| `UNFINISHED` / placeholder | Replace the scaffolded command with a real one, or delete the check. |
| `INCOMPLETE` | A `--only` subset or a `skip:` — neither can claim completion. Run the full contract. |
| `still has the route pattern` | `/orders/:id` was generated from a route definition. Use `capture`, or a real value. |
| `uses ${x}, which no check captures` | A typo, or a check ordered before the one that produces the value. |
| `nothing asserts what the app returned` | The run passed and proves less than it looks. Add `body_contains` or `json`. |
| `has not agreed with itself` | A check has been flaky. Find the nondeterminism or make the check wait — `retry_for_ms`. |

## What not to do

- **Do not edit the contract to make a failing check pass.** It is the definition of done. If it
  is genuinely wrong, say so to the user and explain why rather than quietly relaxing it. Every
  run reports when the same diff changed the contract, so this is visible anyway.
- **Do not delete a check you cannot satisfy.** Use `skip: "<reason>"`, which keeps it in the file
  and makes the run report `INCOMPLETE` instead of `DONE`.
- **Do not add checks for things the ticket did not ask for.** A contract is about one
  requirement. Breadth belongs in the suite.
- **Do not report the work as complete on anything but a full `proof check` exiting 0.**

## Other commands

| Command | Use |
| --- | --- |
| `proof infer` | Routes, environment variables and migrations in the diff that nothing verifies; `--write` appends them as checks — then tighten each one to assert content |
| `proof changed` | What the diff touches, what imports it, and which checks name each file |
| `proof report` | The last run rendered as markdown, with evidence linked |
| `proof check --json` | The verdict as `{status, checks, failures: [{check, expected, observed, evidence, was, since}]}` |

`was: "passed"` on a failure means the change broke something that used to work. Treat that
differently from a check that has never passed.
