# Writing a contract

[← back to README](../README.md)

[`docs/contract.md`](contract.md) is the reference: every verb, every key, every rule.
This page is the other half — how to decide *what to put in the file*.

A contract is not a test suite. A test suite asks "did I break anything?"; a contract asks
"is this specific requirement satisfied?" They are different questions, they fail at
different times, and only one of them can end an agent's loop.

So this is not the place to re-test your application. It is the place to write down what the
ticket in front of you promised, in checks that fail without it. Everything your suite already
covers gets one line — `run: npm test` — and the rest of the file is about the change.

It is also not a place to put logic. No fixtures, factories or mocks: the moment a check needs
code, that check is a test, and `run: npx playwright test smoke.spec.ts` is how you reach it
from here.

---

## The one rule

> **Write down what a person would do to check that the requirement is met, then write that.**

Everything below is a consequence of it. If you find yourself writing a check because it is
easy to write rather than because it would convince a sceptic, delete it.

---

## 1. Start from the requirement, not from the diff

The goal comes first, and it is the thing a verdict is a verdict *about*. `proof check`
refuses a contract without one for that reason: `DONE` with no requirement attached is an
answer with no question.

A goal is good when someone who has not read the code can tell, from the goal alone, whether
a given behaviour counts as satisfying it.

| Weak goal | Why it fails | Stronger |
| --- | --- | --- |
| `fix the login bug` | Names a change, not an outcome. Any diff "fixes" it. | `A user with a valid password reaches /dashboard; a wrong password returns to /login with an error` |
| `add the /orders endpoint` | Satisfied by a route that returns `null`. | `POST /orders persists the order and returns its id; GET /orders/<id> returns the same order` |
| `make it faster` | Nothing observable. | `The dashboard responds in under 400 ms with 10,000 seeded rows` |
| `refactor the session module` | No user-visible outcome at all. | `Logging in, reloading, and logging out still work, and no route reads the old cookie name` |

Write the goal before the checks. If you cannot write a goal that a check could fail, the
requirement is not ready to implement — which is worth finding out now.

## 1b. Break the requirement into criteria, and point checks at them

A requirement is almost never one statement. "Implement secure password reset" is at least
four: the link is emailed, the token expires, the token is single use, and the flow does not
reveal whether an account exists. A contract made only of checks cannot say which of those it
covers — and the ones an agent forgets are exactly the ones nobody wrote a check for.

```yaml
criteria:
  - id: AC1
    requirement: a reset link is emailed
    source: issue#143
  - id: AC2
    requirement: a reset token expires after 30 minutes
  - id: AC3
    requirement: a reset token cannot be reused
  - id: AC4
    requirement: the reset flow does not reveal whether an account exists
    source: security-requirements.md
```

Then every check says which criterion it is evidence for:

```yaml
- name: a used token is refused
  satisfies: [AC3]
  http: {method: POST, path: "/api/password-reset/${used_token}", expect: {status: 401}}
```

A criterion nothing points at makes every run `INCOMPLETE`, with the id named — so the gap
shows up as a verdict rather than as something nobody thought of. Write the criteria from the
requirement, before the checks: it is the same discipline as writing the goal first, one level
down.

Two rules worth keeping:

- **A criterion is a statement about behaviour, not a task.** "Add a middleware" cannot be
  verified; "an unauthenticated request to /admin returns 403" can.
- **Do not invent criteria the requirement did not state.** A contract is about one
  requirement. Breadth belongs in the suite.

## 2. One check, one claim

The name of a check is what a failure will be called, in the terminal, in the report, in the
feedback an agent reads, and in `--only`. Name it after **the claim**, not the mechanism.

```yaml
# what failed?
- name: test
  run: npm test

# vs.
- name: the suite still passes
  run: npm test
- name: a wrong password does not create a session
  http:
    method: POST
    url: http://localhost:3000/login
    body: {email: ada@example.com, password: wrong}
    expect: {status: 401}
```

Proof enforces uniqueness because names key results and evidence filenames, but the reason to
care is narrower: `FAIL — api` tells the next reader nothing, and the next reader is often an
agent with no memory of writing the contract.

Splitting also buys you a real diagnosis. One check doing four things reports one failure and
hides which of the four broke.

## 3. Assert what the app *returned*, not that it answered

This is the mistake that costs the most, because the contract looks complete:

```yaml
# passes when the endpoint returns 200 with an empty body, the wrong order, or "null"
- name: orders endpoint
  http: {path: /api/orders, expect: {status: 200}}
```

A status code says the phone was picked up. Assert the content that carries the requirement:

```yaml
- name: an order is created
  http: {method: POST, path: /api/orders, body: {sku: ABC-1}, expect: {status: 201}}
  capture: {order_id: json.id}
- name: the order comes back with its id and total
  http:
    path: /api/orders/${order_id}
    expect:
      status: 200
      json:
        id: "${order_id}"
        total: "<number>"
        items: "<array>"
```

`proof check` says so on a pass when no `http` or `browser` check in the contract asserts
content — the run is green and the note is still there, because that is exactly where the
false confidence lives.

Use `json` over `body_contains` when the response is JSON: a substring match passes when the
right characters turn up anywhere in the body, including inside an error message. Use type
tokens (`<string>`, `<number>`, `<boolean>`, `<array>`, `<object>`, `<null>`, `<any>`) for
generated values — ids, timestamps — where the shape is the claim and the value is not.

## 4. Assert the absence too, but never *only* the absence

Half of what you check an agent on is a removal: the debug log, the hardcoded key, the stack
trace that should no longer leak, the TODO it promised to delete.

```yaml
- name: the response no longer leaks a stack trace
  http:
    path: /api/orders/does-not-exist
    expect: {status: 404, body_not_contains: "at Object."}
- name: the debug flag is gone from the bundle
  file: {path: dist/bundle.js, not_contains: "DEBUG_MODE"}
```

`body_not_contains` deliberately does **not** count as asserting content: proving a response
does not contain a stack trace is no evidence that the rest of it is right. Pair every
absence with a presence.

## 5. Pick the verb closest to the user

Reach for the first one that can actually show the requirement:

| Verb | Use it when | It cannot show |
| --- | --- | --- |
| `browser` | The requirement is something a person does in a page | Anything headless; needs Playwright |
| `http` | The requirement is an API's behaviour | Whether the button is wired to it |
| `run` | The requirement is a command, a build, a migration, a script | Whether the running app agrees |
| `file` | The requirement is an artifact's contents, or a removal | Anything about runtime |
| `env` | A secret or setting must be present for the run to mean anything | The *app's* environment, when the app starts elsewhere |

A contract made only of `run:` checks proves your test suite passes — which is the thing this
tool exists to distrust. It is the right answer when the requirement genuinely is about a
command (`the export CLI writes a complete CSV`), and the wrong one when the requirement is
about a running application.

`browser` is the strongest and the slowest. One browser check on the path the requirement
describes, plus `http` checks for the states around it, is usually the right mix.

## 6. Let the contract own its preconditions

A check that only passes on your machine is worse than no check: it fails for the next
person, and they spend the iteration on your environment rather than on the requirement.

```yaml
goal: An order placed through the API is persisted and readable
serve:
  - name: db
    run: docker compose up postgres
    ready_log: "database system is ready to accept connections"
  - name: api
    run: npm run dev
    ready_url: http://localhost:3000
checks:
  - name: the schema is current
    run: npx prisma migrate deploy
  - name: an order is accepted
    http: {method: POST, path: /orders, body: {sku: ABC-1}, expect: {status: 201, json: {id: "<number>"}}}
    capture: {order_id: json.id}
  - name: the order is readable at the id it was given
    http: {path: "/orders/${order_id}", expect: {status: 200, body_contains: "ABC-1"}}
```

Three habits do most of the work:

- **Seed, do not assume.** A `run:` check earlier in the contract that seeds a fixture makes
  the later checks true anywhere. Checks run in order.
- **Write the processes in dependency order.** `serve` as a list starts each one and waits for
  it before the next — the database before the API that needs it.
- **Create the value, then use it.** Never an id you happened to see in your local database:
  that check passes on your machine and 404s on every other. `capture` makes the contract
  produce what it later asserts on, which is the version that is true anywhere.

```yaml
- name: an order is accepted
  http: {method: POST, path: /orders, body: {sku: ABC-1}, expect: {status: 201, json: {id: "<number>"}}}
  capture: {order_id: json.id}
- name: the order is readable afterwards
  http: {path: "/orders/${order_id}", expect: {status: 200, body_contains: "ABC-1"}}
```

The full selector list is in [the contract reference](contract.md); `json.<path>`,
`header.<name>`, `status`, `output` and `match:<regex>` cover almost everything.

## 7. Make failures diagnosable

You are writing for the person — or the agent — reading the failure six iterations later,
with none of today's context.

- **Assert one step earlier than the symptom.** If the flow is login → dashboard → chart, a
  check on the chart alone reports a selector timeout. A check on the login response first
  reports `status 401`, which is the actual diagnosis.
- **Use `expect_request` for "is the button wired to anything?"** — it separates *no request
  fired* from *the wrong request fired*, and reports which.
- **Set `log_must_not_match`** when the failure mode is something the app logs rather than
  returns: `"unhandled rejection|ECONNREFUSED"`.
- **Give slow things a `timeout`** rather than letting the default expire with no explanation.
  It is the budget for the whole check, never per step.
- **Put a requirement phrased in time into `expect_under_ms`.** "The dashboard responds in
  under 400 ms" is a claim a check can make; leaving it in the goal alone means nothing is
  measuring it. One measurement is a smoke gate, not a benchmark, and the doc says so.

## 8. What does not belong in a contract

- **Assertions your unit tests already make well.** One check that runs the suite covers
  them, and it says so by name. If the runner writes a JUnit report, name it with `results:` and
  its failures arrive by test name rather than as `exit 1`.
- **Implementation details.** `file: {path: src/auth.ts, contains: "bcrypt"}` fails the next
  time someone changes library, without anything about the requirement changing.
- **Everything the app can do.** A contract is about *this* requirement. Breadth belongs in
  the test suite; a contract nobody reads is a contract nobody maintains.
- **Checks that cannot fail.** An empty `contains`, a `body_not_contains` for a string that
  was never there, a route pattern left as `/api/orders/:id`. Proof refuses the ones it can
  recognise; the rest are yours to notice.
- **A check you have stopped believing.** Quarantine it with `skip: "<reason>"` rather than
  delete it: a deletion is invisible in the blast radius and the next run reports `DONE`, while
  a skip makes the run report `INCOMPLETE` with the reason in the file and in the diff.

## 9. Treat it like source

The contract is the definition of "done", so changing it changes what passing means. Commit
it, review it in the diff, and read it before trusting a verdict from a change that also
edited it — `proof check` and `proof changed` both say when that has happened.

The specific thing to watch for: an agent that cannot make a check pass can delete the check
instead. The verdict that follows says `DONE`.

## 10. From a ticket to a contract

> *"Users can reset a forgotten password and log in with the new one."*

**What would a person do?** Open the forgot-password page, submit their email, see a
confirmation, then log in with a new password and land on the dashboard.

**What could pass while being broken?** The form submits nothing. The endpoint returns 200 and
sends no mail. The old password still works afterwards. The reset page throws in the console
and the button does nothing.

Each of those becomes a check:

```yaml
goal: Users can reset a forgotten password and log in with the new one

serve:
  run: npm run dev
  ready_url: http://localhost:3000
  timeout: 60
  log_must_not_match: "unhandled rejection|ECONNREFUSED"

checks:
  - name: the suite still passes
    run: npm test

  - name: the reset endpoint accepts a known address
    http:
      method: POST
      path: /api/password-reset
      body: {email: ada@example.com}
      expect:
        status: 200
        json: {sent: true}

  - name: requesting a reset actually sends the request
    browser:
      visit: /forgot-password
      flow:
        - fill: {email: ada@example.com}
        - click: "Send reset link"
        - expect_request: {method: POST, path: /api/password-reset, status: 200}
        - expect_text: "Check your email"
      expect_no_console_errors: true

  - name: the old password stops working
    http:
      method: POST
      path: /login
      body: {email: ada@example.com, password: old-password}
      expect: {status: 401}
```

Note what each one is doing: the suite check guards the rest of the app, the `http` check
pins the API's contract, the `browser` check proves the page is wired to that API, and the
last one proves the change had the effect that makes it a *reset* rather than an addition.

## 11. Prove the contract, not just the code

Every rule above is advice. One of them can be checked mechanically:

```bash
proof falsify
```

It runs the contract against the code from before your change and reports whether anything
failed. A check that passes without the change is not testing the change — it is decoration,
and it will report DONE for a branch that did nothing.

This catches the two most common empty contracts directly:

- `expect: {status: 200}` on a route that already existed. The endpoint answered before your
  change too, so it passes on the base, so it proves nothing about what you did.
- `file: <path>` for a file the change *edited* rather than created. It existed before.

Section 3 tells you to assert content rather than a status. `falsify` is how you find out
whether you actually did.

Run it once when the contract is written, and in CI on every branch. Whatever it says is a
fact about your contract, not an opinion about your code.

## 12. A short checklist

Before you trust a contract:

- [ ] The `goal` states an outcome someone could disagree with.
- [ ] Every check name reads as a claim, not as a command.
- [ ] At least one check exercises the running application.
- [ ] Every check that carries the requirement asserts **content**, not just a status.
- [ ] Every removal is paired with something that must still be present.
- [ ] Nothing depends on state only your machine has — ids the contract uses, it also created.
- [ ] Nothing is skipped that you have stopped intending to switch back on.
- [ ] You could hand the file to a stranger and they would agree it means "done".
- [ ] `proof falsify` says `DISCRIMINATES` — the contract fails on the code from before the change.

## Where proof helps you write it

- `proof init "<requirement>"` seeds the contract from the commands your repo already
  declares and scaffolds a `serve` block from its own dev script.
- `proof infer` reads the diff and lists what it can see going unverified — routes,
  environment variables, migrations — and `--write` appends them as checks, with the caveat
  for each one written into the file beside it. What it generates is a *starting point*: it
  can produce `expect: {status: 200}` because it cannot know the requirement. Sections 3 and
  4 are the part only you can write.
- `proof changed` shows the blast radius of the diff and which checks name each file, which
  is how you find the thing you forgot.

Both are covered in [docs/discovery.md](discovery.md).
