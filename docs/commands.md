# Command reference

[← back to README](../README.md)

## Commands

| Command | What it does |
| --- | --- |
| `proof init "<requirement>"` | Write an acceptance contract to `.proof/spec.yaml`, seeded from the repo's own build/test commands and its dev script |
| `proof infer` | Find verification gaps in the current diff; `--write` appends them to the contract |
| `proof changed` | Blast radius of the diff — reverse import graph plus which checks name each file |
| `proof lint` | What the contract would prove if every check passed — without booting or running anything |
| `proof seal` | Fingerprint the contract into `.proof/lock.json`, so a later edit to it is visible rather than silent |
| `proof diff` | What the contract has changed since it was sealed, and which criteria that leaves without current evidence |
| `proof falsify` | Run the contract against the code from **before** your change. It has to fail there, or it is not testing the change |
| `proof check` | Execute the contract and record the evidence |
| `proof challenge` | Inject each declared fault into a throwaway copy of your code; the contract has to fail on every one |
| `proof attack [<criterion>]` | Search for a scenario where the contract passes and the claim is violated |
| `proof replay <id>` | Execute a recorded counterexample again. Exit 0 once it no longer reproduces |
| `proof promote <id>` | Turn a counterexample — a fault or a scenario the contract accepted — into a check |
| `proof done` | The completion gate: coverage, falsification, challenges, integrity and freshness, in one verdict. Non-zero unless `DONE` |
| `proof report [run]` | Render the evidence for a run (default: the latest); `--list` shows recent runs, `--all` shows every one |
| `proof help` | The usage text; `--help` and `-h` are the same |
| `proof --version` | The installed version, read from `package.json` rather than a copy that can drift |
| `proof guard -- <agent...>` | Supervise a coding agent: run it, run the contract when it exits, and relaunch it with the failure evidence until the contract passes. `--max-attempts N` bounds the loop; Ctrl-C is the other override |
| `proof hook` | The same gate as a Claude Code Stop hook. `--install` adds it to `.claude/settings.json`; `--print` shows the snippet; run bare, it is the hook |

Flags: `--json` (machine-readable, on every command), `--force` (init), `--write` (infer),
`--only TEXT`, `--spec PATH` and `--base-url URL` (check), `--list`, `--all` and `--junit`
(report), `--depth N` and `--base REF` (changed, infer), `--from CMD` (challenge, attack),
`--budget T`, `--seed N` and `--strategy S` (attack).

`proof check` answers "did the contract pass". `proof done` answers "does the evidence justify
calling this finished", which is a different question with more inputs — and it is the one an
agent loop and a CI gate should branch on.

`--spec PATH` runs a contract kept somewhere other than `.proof/spec.yaml` — a release
contract, a contract per environment. It works on every command that touches a contract —
`init`, `check`, `changed` and `infer`: `init` creates it there (with `--force` keeping the
backup beside it), coverage and gap deduplication read the same contract you are checking, and
`infer --write` appends to it rather than to `.proof/spec.yaml`. Evidence and the lock still
live in `.proof` whatever the contract's path. Everything else still resolves against the directory
you run from, not the contract's: `file: dist/bundle.js` means `./dist/bundle.js`, `run:`
commands execute there, and the evidence goes to `./.proof/runs`. The contract is a document
proof reads; the working directory is the subject it reads it about.

`--base` must name a ref that resolves. A typo would otherwise make every git call fail and
produce an empty diff, which reads as "nothing changed" — reassurance rather than an error.

`--base main` means "what this branch changed", so the diff is taken from the **fork point**
(`git merge-base main HEAD`), not from main's tip. On any branch opened before main moved on,
diffing the tips attributes main's later commits to you — `changed` would name files your
branch never touched, and `infer --write` would append checks for someone else's code.
Uncommitted, unstaged and untracked work still counts.

Unrecognised flags and stray arguments stop the run rather than being ignored. `proof check
--dry-run` would otherwise execute for real, and `proof check alpha` would run the whole
contract and report DONE to someone who meant `--only alpha`. Errors name what the command
accepts and suggest the near miss.

Exit codes: `0` passed, `1` failed, `2` configuration error.

`proof report` exits `1` for a stale run as well as a failed one — results that describe a tree the repository has since moved past are not a green light, and the exit code is the part CI branches on.

### What a contract would prove

`proof lint` reads the contract and says what a passing run would mean, without starting the
app or running a check:

```
CONTRACT .proof/spec.yaml

  4 check(s); 2 exercise the running app; 1 assert what it returns; 1 process(es) started by a serve block

NOTE
  1 check(s) only assert a status (orders endpoint) — a 200 with the wrong body passes them.

STATUS
  OK — this is what a passing run would prove
```

It also reads the contract back as what each check asserts:

```
WHAT IT SAYS
  ada signs in
      POST /login, status 200, json matches {"ok":true,"user":"ada","access_token":"<string>"}
  another user's order is forbidden, not merely missing
      GET /orders/${order_id}, status 403, json matches {"error":"not yours"}
```

The contract is the definition of "done", which makes it something a human has to review — and
a file nobody can read is a file nobody reviews. These are the same strings the run records as
`asserted`, so what `lint` reads back is exactly what the evidence will claim rather than a
second description that can drift from it. `--json` carries them as `says`.

It carries the same advisories `check` gives on a pass, plus the per-check list of which
ones assert only a status. A contract still holding a placeholder is `UNFINISHED` with exit 2,
exactly as `check` would refuse it. Someone with the file open wants this answer now, not after
the two-minute run that would otherwise be the first time they heard it.

`--json` carries `says`, `checks`, `runtime_checks`, `content_checks`, `serve`, `advisory`,
`status_only`, `skipped`, `unfinished` and `status`.

### Reading another runner's results

A `run:` check can name the JUnit report its command wrote, and proof reads it instead of
guessing from the exit code:

```yaml
- name: the suite
  run: npx pytest --junitxml=report.xml
  results: report.xml
```

Failures then arrive by test name, a report of zero tests is a failure rather than a pass, and
the report is attached as evidence. See [the contract reference](contract.md) for the detail.

### Does the contract actually test the change?

Every other command asks whether the code satisfies the contract. `proof falsify` asks the
question underneath it: **would this contract have noticed if the change had never been made?**

```
$ proof falsify

FALSIFY

Requirement:
  users can log in and see their profile

  The contract was run against 8f3a2c1b9e04, the last commit — the code as it was before your
  change. Every check that carries the requirement has to fail there, or it is not testing it.

CHECKS AGAINST THE BASE
  it still builds                  PASS  would pass without your change
  logging in sets a session        FAIL  needs your change
  the profile page shows the user  FAIL  needs your change

VERDICT
  DISCRIMINATES
  2 of 3 check(s) fail without your change, so the contract is about it
  1 would pass either way (it still builds) — regression guards, not the requirement
```

It checks the base commit out into a temporary worktree, runs the **current** contract there,
and reads what happened. Your working tree is never touched — no stash, no checkout, nothing to
recover if it is interrupted.

The answer is three-valued, because two would be a lie:

| Verdict | Exit | Means |
| --- | --- | --- |
| `DISCRIMINATES` | 0 | At least one check fails without the change. The contract is about it |
| `DOES NOT DISCRIMINATE` | 1 | Every check passes on the old code. This contract would report DONE for a branch that did nothing |
| `INCONCLUSIVE` | 2 | It failed, but for a reason that says nothing about the change |

`INCONCLUSIVE` is the one that keeps the command honest. A checkout of the base commit that
will not boot, a runner that crashed, a command that exits 127 because it was not there — each
of those makes the contract "fail", and reporting that as *discriminates* would be exactly the
false confidence the rest of this tool refuses to give. Those failures are excluded from the
evidence and named separately.

**A failed precondition is one of them.** A contract's opening checks are usually not claims:
they sign somebody in, seed a row, start a fixture, and hand an id to everything below. When one
of those fails on the base commit, every check after it fails for want of a value — and the run
reads as a contract that discriminates beautifully, when what happened is that the base never
reached the state the contract is about. A check that captures a variable another check uses is
treated as a precondition, and its failure makes the run `INCONCLUSIVE` rather than evidence.
The fix is to seed in a way that runs on both commits — SQL, or a fixture that predates the
change — rather than in code the base does not have yet.

Two things are worth knowing about how the base is prepared:

- **`node_modules`, `.venv`, `venv` and `vendor` are linked from your working tree**, not
  installed for the base commit. Installing them would be more correct and would also take
  minutes; without them nothing would boot and every run would be inconclusive. The run says so,
  and it means a change that *is* a dependency change is not measured by this.
- **`--base main`** measures what the branch changed, from the fork point, exactly as `changed`
  and `infer` do. The default is `HEAD`, which is right for uncommitted work.

`--json` carries `status`, `commit`, `discriminating`, `regression_guards`, `suspicious`,
`checks` (with `about_the_change` per row), `linked_dependencies` and `reused_existing`.

This is the acceptance-level version of watching a test go red before you make it green — and
unlike that, it is mechanical rather than a thing you have to remember to do.

### Requirement coverage

A contract can be valid, green, and silent about half of what was asked for. `criteria:` names
the statements the change has to satisfy; `satisfies:` on a check says that check is the
evidence for one:

```yaml
goal: secure password reset
criteria:
  - id: AC1
    requirement: a reset token expires after 30 minutes
    source: {type: github_issue, reference: "#143"}
  - id: AC2
    requirement: a reset token cannot be reused
checks:
  - name: an expired token is refused
    satisfies: [AC1]
    run: npm run test:reset-expiry
  - name: a used token is refused
    satisfies: [AC2]
    run: npm run test:reset-reuse
```

Every run then reports what the requirement, rather than the check list, looks like:

```
REQUIREMENT COVERAGE
  AC1  a reset token expires after 30 minutes  VERIFIED
  AC2  a reset token cannot be reused          UNCOVERED
```

| Status | Means |
| --- | --- |
| `verified` | Every check that carries it passed in this run |
| `failed` | A check that carries it failed |
| `unverified` | A check carries it, and this run produced no result for it — skipped, or not selected by `--only` |
| `uncovered` | No check declares `satisfies` for it. Nothing in the run is evidence for it |

An uncovered criterion makes the run `INCOMPLETE`, however green it is — the same rule a
`skip:` follows, for the same reason. `proof lint` reports coverage from the file alone, before
a run is spent on it, and `proof guard` and the Stop hook refuse to start against a contract
with one: no amount of code can close a gap in the contract.

`source` is free text or `{type, reference}`. Nothing integrates with it; it is there so a
reader of a verdict months later can get from a criterion back to whoever asked for it.

### Sealing the contract, and seeing it move

The contract is the definition of "done", so an agent that cannot make a check pass can edit
the check instead. `proof seal` records what the contract was:

```console
$ proof seal

Contract sealed.
SHA256:
  7fd84b9c2a1163f0a04e2a0a0f0fb2d0d4f3c1d2a1b0e9f8d7c6b5a4938271605

3 criterion/criteria: AC1, AC2, AC3

Recorded in .proof/lock.json. Commit it: the seal is what says this contract was reviewed.
```

The fingerprint is over the contract's *content* — the parsed YAML, with key order normalised —
so reindenting a block or rewrapping a comment does not break it, and moving an assertion does.

After that, `proof check` compares the two on every run. A contract that has moved reports
`INCOMPLETE` with the reason, and `proof diff` says what moved:

```console
$ proof diff

CONTRACT CHANGES since 7fd84b9c2a11 (sealed 2025-03-02T11:04:19Z)

  + AC9
  ~ AC3
  - check "the legacy endpoint answers"

VERIFICATION AFFECTED
  AC9   UNVERIFIED
  AC3   REVERIFY
```

`UNVERIFIED` is a criterion no run has ever been about; `REVERIFY` is one whose own text or
whose checks have changed since the evidence was recorded. Sealing again accepts the new
contract and starts a new verification generation — evidence recorded under the old one is not
carried over, because it is evidence about a different definition of "done".

Nothing here forbids changing a contract. A tool that made that expensive would be worked
around; this one only makes it visible.

### Challenging the contract

`falsify` asks whether the contract can tell the old code from the new. `challenge` asks the
other question: **would this contract catch a wrong implementation?**

```yaml
challenges:
  - name: allow token reuse
    breaks: [AC2]
    apply: "sed -i 's/markTokenUsed(token)//' src/reset.js"
  - name: skip the database write
    breaks: [AC1]
    apply: "sed -i 's/await db.save(reset)//' src/reset.js"
```

Each `apply` command runs against a throwaway git worktree holding your code as it stands —
tracked changes and the files git has not seen yet, your own files never touched — and the
contract is run there. It has to fail:

```console
$ proof challenge

CONTRACT CHALLENGE

  2 fault(s) injected into a copy of your code as it stands (tracked changes at 47e2b80bea85),
  one at a time. The contract has to fail on each.

FAULT                                        DETECTION
  allow token reuse       DETECTED  a used token is refused
  skip the database write MISSED

WEAKNESS
  skip the database write — the contract passed with this fault applied, so it cannot report
  this class of wrong implementation.

  .proof/counterexamples/skip-the-database-write.yaml

VERDICT
  WEAKNESS FOUND
  1 detected, 1 missed, 0 inconclusive
```

| Outcome | Means |
| --- | --- |
| `DETECTED` | At least one check failed for a reason that is the fault |
| `MISSED` | Every check passed with the fault applied. A counterexample is written |
| `INCONCLUSIVE` | The fault command failed, it changed nothing in the copy, or the only failures were a crashed runner or a missing binary |

`INCONCLUSIVE` is what keeps the command honest, exactly as in `falsify`: a fault that never
applied says nothing about the contract, and counting it as detection would be false
reassurance in the place it costs most. Before any fault runs, the contract is run once
unmodified — a contract that already fails would make every fault look detected.

There is no quality score, deliberately. What is useful is *which* wrong implementations this
contract can report and which it cannot.

`--from "<command>"` adds challenges from any program that prints `{name, apply, breaks}`
objects as JSON on stdout — an adversarial agent, a criterion-aware semantic prober, a
language-specific mutation tool. They are held to exactly the rules a written challenge is
held to, and proof is what runs and judges them: the generator is never the root of trust.

### Counterexamples, and promoting one

Every missed fault is written to `.proof/counterexamples/<id>.yaml` — the fault, the criterion
it violates, the commit and the contract it was found against. `proof promote <id>` turns one
into a check:

```yaml
# This fault went unnoticed by every check: sed -i 's/await db.save(reset)//' src/reset.js
# Recorded 2025-03-02T12:41:08Z against 47e2b80bea85.
# Replace the command with the assertion that would have caught it.
- name: "counterexample: skip the database write"
  run: 'echo "TODO: assert the behaviour this fault broke"'
  satisfies:
    - AC1
```

It is written with proof's own placeholder command on purpose: proof knows which fault went
unnoticed and cannot know what assertion would have noticed it. `proof check` refuses a
contract holding a placeholder, so the promoted check cannot sit there passing and looking like
coverage. Write the assertion, and the contract is permanently stronger than the one that
missed it.

### Attacking a claim

`falsify` asks whether the contract can tell the old code from the new. `challenge` asks whether
it catches faults you named. `attack` asks the question underneath both:

> Can a scenario be found where the contract passes and the claim does not hold?

That finding has a name — a **verification gap** — and it is the only one in this tool that is
about the verifier rather than the code.

It needs two judges that can disagree:

| Oracle | Is |
| --- | --- |
| Contract oracle | The checks that carry the criterion, run against the app in the state the attack left it |
| Requirement oracle | An invariant: one comparison, counted over what the attack actually observed |

If only the first says yes, the contract has a hole in it.

```yaml
criteria:
  - id: AC3
    requirement: a reset token cannot be redeemed twice
    attack:
      surfaces: [concurrency, sequence, input]
      budget: {duration: 60, candidates: 50, concurrency: 4}
      permissions: {network: same-origin}
      setup:
        - name: issue
          http: {method: POST, path: /issue}
          capture: {token: json.token}
      actions:
        - name: redeem
          http: {method: POST, path: /redeem, body: {token: "${token}"}}
      invariants:
        - successful_redeem <= 1
```

| Key | Means |
| --- | --- |
| `setup` | Steps that run before every scenario — what makes each candidate independent of the last. They must succeed, or the attempt is an `ATTACK_ERROR` rather than a finding |
| `actions` | The operations an attack may compose. Named, because an invariant counts them by name. Exactly one `http` or `run` each, and **no `expect`** — an attack has no expectations, only observations |
| `invariants` | What must remain true. One comparison each: `<term> <op> <whole number>` |
| `surfaces` | Which strategies may run: `input`, `sequence`, `concurrency` |
| `budget` | `duration` in seconds, `candidates` evaluated, and the widest `concurrency` a parallel step builds |
| `permissions` | `network: same-origin` (the default) or `any`. An action pointed at another host is refused under the default |

Invariant terms are counted from the steps that ran: `successes`, `failures`, `steps`,
`successful_<action>`, `failed_<action>`, `status_<code>`, `status_2xx`, `status_4xx`,
`status_5xx`. "Successful" is a status below 400 for a request and exit 0 for a command — the
operation having actually happened, which is what an at-most-once claim counts.

It is deliberately one comparison and not an expression language. The moment an invariant needs
`&&` or a helper it is a test, and `run: npx playwright test` is how you reach one from here.

**The strategies:**

| Surface | Builds |
| --- | --- |
| `concurrency` | The same action *N* times at once — what a sequence of requests structurally cannot show |
| `sequence` | The same action twice, one action after another, and an action after the pair that should have ended it |
| `input` | One body field at a time replaced with an empty string, `null`, `0`, `-1`, a huge number, a 4096-character string, unicode, or the wrong type |

Concurrency is tried first: the cheapest strong attack should not wait behind four hundred
boundary values. Everything after it is shuffled with the run's seed, which is printed so the
same search can be run again.

```console
$ proof attack AC3 --budget 2m --seed 1974540407
```

**The five outcomes**, because two would be a lie:

| Result | Means |
| --- | --- |
| `NO_COUNTEREXAMPLE_FOUND` | The budget ran out. This is not correctness, and the report says so |
| `COUNTEREXAMPLE_CANDIDATE` | Something suspicious — a 5xx — with no invariant broken. A defect, not a proven claim violation |
| `CLAIM_VIOLATION` | The invariant was broken, and the contract noticed too |
| `VERIFICATION_GAP` | The invariant was broken and the contract passed. The strongest finding here |
| `ATTACK_ERROR` | The scenario could not be executed — usually setup that did not succeed |

Exit `1` on a gap or a violation, `0` otherwise, `2` for a contract that cannot be attacked at
all. `proof done` blocks on a gap or a violation whatever its policy says, and
`policy: {require_attack: true}` makes having searched a condition of `DONE`.

**Boundaries.** An attack executes only the actions the criterion declares, against the app the
contract starts. A declared action pointing at another host is refused unless
`permissions: {network: any}`. Nothing mutates the environment; nothing writes outside the
project. A generator cannot widen any of that — see below.

**Generated candidates.** `--from "<command>"` reads `{hypothesis, strategy, steps}` objects as
JSON on stdout, with `PROOF_ATTACK_CRITERION` and `PROOF_ATTACK_ACTIONS` in the environment. The
steps may only compose actions the criterion declares — a generator that names an operation the
contract never did is refused, by name. This is where an adversarial agent, a property-based
generator or a model-based explorer plugs in: it proposes, proof executes and judges. A
hypothesis is not evidence.

### Replaying a counterexample

```console
$ proof replay ce-17f09e06

REPLAY ce-17f09e06

Claim:
  a reset token cannot be redeemed twice

STEPS
  redeem                          200
  redeem                          200

Invariant:
  successful_redeem <= 1
Observed:
  successful_redeem = 2

VERDICT
  COUNTEREXAMPLE REPRODUCED
```

Exit `1` while it still reproduces, `0` once it does not — green means the claim holds, the same
way it does everywhere else here. That is what makes a promoted counterexample an ordinary
check: `proof promote ce-17f09e06` writes `run: proof replay ce-17f09e06` into the contract, and
it goes green the moment the bug is fixed and red again if it ever comes back.

If something is already answering at the contract's URL, replay uses it rather than starting a
second app — which is exactly what happens when a promoted counterexample runs inside
`proof check`. The outcome is written back beside the counterexample as `last_replay`; a
scenario that stops reproducing is never deleted, because "fixed" and "intermittent" look
identical from here and only one of them is good news.

### The completion gate

```console
$ proof done

PROOF DONE

Requirement:
  secure password reset

  Implementation          abc123def456
  Contract                SEALED
  Criteria                4/4 VERIFIED
  Checks                  9/9 PASS (run 0012)
  Falsification           PASS
  Challenges              COMPLETE
  Flakes                  NONE
  Evidence                CURRENT

VERDICT
  DONE
```

`done` runs nothing. Every input is a record some earlier command wrote — the latest run of
this contract, the seal, the falsification record, the challenge record — and the verdict is
derived from them:

| Verdict | Exit | Means |
| --- | --- | --- |
| `DONE` | 0 | Every condition the policy requires is satisfied by evidence on disk |
| `INCOMPLETE` | 1 | The evidence is not there yet. Each missing piece is named |
| `INVALID` | 1 | The chain cannot be trusted: evidence recorded for another commit or another contract, a baseline that no longer exists, a sealed contract that moved under a policy requiring one |

How much is required is the project's to choose, in the contract:

```yaml
policy:
  require_criteria_coverage: true         # default: a declared criterion needs evidence
  require_criteria_falsification: false   # every criterion must fail on the base commit
  require_falsification: true             # default: the contract must fail without the change
  require_sealed_contract: false          # the contract must match its seal
  require_challenges: false               # the declared faults must have been run and caught
  allow_flakes: false                     # default
  allow_skipped: false                    # default
```

A prototype can drop to `require_falsification` alone; a security-sensitive repository can
require all of it. Every run writes `.proof/report.json`, the verification manifest:

```json
{
  "verdict": "DONE",
  "implementation": {"git_commit": "abc123def456", "run": "0012"},
  "contract": {"hash": "7fd84b…", "sealed": true, "modified": false},
  "coverage": {"AC1": "verified", "AC2": "verified"},
  "falsification": {"baseline": "def456…", "result": "discriminates"},
  "challenges": {"detected": ["allow token reuse"], "missed": [], "inconclusive": []},
  "reasons": []
}
```

That file is the artifact for CI, a pull-request check, an audit trail or a deployment gate —
one place that says why this implementation was accepted. With `--spec`, a contract other than
`.proof/spec.yaml` writes its manifest beside it as `report-<contract>.json`.

### Verifying something already running

`proof check --base-url https://staging.example.com` points the run at an app proof did not
start — a preview deployment, staging, a stack someone else brought up.

The `serve` block is not started, so `app boots`, `app still running` and the log gate do not
run: they are claims about a process proof holds, and it holds nothing here. Three rows
disappearing silently would look like a contract that never had them, so the run says so:

```
OBSERVED BUT NOT GATED
  checks ran against https://staging.example.com, which proof did not start — `app boots`, `app
  still running` and the log gate were not run, `run:` and `file:` checks still ran here, and an
  `env:` check reads proof's own environment rather than that deployment's
```

`run:` and `file:` checks still execute **where you are**, not on the deployment — a build or
an artifact check means the same thing it always did, and a check that shells into the remote
host is yours to write. `--json` carries the URL as `against`.

The value must be an absolute `http(s)` URL, refused at load for the same reason
`serve.ready_url` is: a scheme-less value can never be fetched, and every check would then
fail blaming the deployment for a typo on the command line.

### Reporting into CI

`proof report --junit` renders a recorded run as JUnit XML on stdout — the one report format
every CI already annotates a pull request from:

```yaml
- run: proof check
- if: always()
  run: proof report --junit > proof-results.xml
- if: always()
  run: proof report >> "$GITHUB_STEP_SUMMARY"    # the markdown report, in the job summary
```

The caveats travel with it. `INCOMPLETE`, `STALE`, the advisory and every "observed but not
gated" line are carried as testsuite properties, because a CI report that drops them is the
one place the claim gets read as stronger than it is. Control characters are stripped, so an
ANSI escape in a build log cannot make the file unparseable — which a CI reads as "no results"
rather than as an encoding problem.

The repository also ships a composite action:

```yaml
- uses: sajjadriaj/proof@main
  with:
    base-url: ${{ steps.deploy.outputs.url }}   # optional
```

It runs the contract, writes the JUnit file, appends the markdown report to the job summary,
and exits with the verdict's own code.

### Running one criterion's evidence

`--only TEXT` selects checks by name. `--criterion AC3` selects them by the criterion they
declare they satisfy — the evidence for one requirement, which is usually what you want while
iterating on one acceptance criterion:

```console
$ proof check --criterion AC3

Subset run: --criterion AC3 selected 2 of 14 check(s).
```

Comma-separated for several (`--criterion AC3,AC4`). Like any subset it reports `INCOMPLETE`,
never `DONE`. A criterion no check satisfies is refused rather than run as an empty selection —
that gap is what `proof check` reports as an uncovered criterion.

`proof challenge` uses the same selection internally: a fault that declares `breaks: [AC3]` is
first judged against AC3's own evidence, which on a contract whose first check is the whole
test suite is the difference between seconds and minutes. A fault those checks do not catch is
then re-run against the entire contract before it is ever called `MISSED`, because a fault
caught by a check elsewhere is not a weakness this contract has.

### Iterating on one failure

`proof check --only "browser flow"` runs just the checks whose name contains that text —
useful when the full contract takes a minute and you are fixing one thing.

A subset run reports `INCOMPLETE`, never `DONE`, and its JSON `status` is `"partial"`
rather than `"passed"`. Completion is a claim about the whole contract, regressions
included, so only a full `proof check` can make it. A failure inside a subset still
reports `failed` and exits 1 — a real failure is never hidden behind partial.

A subset that selects nothing needing the app does not start the `serve` block at all, and
says so. Booting it anyway meant a dev server that would not start failed the run before the
selected check ever ran — blocking someone iterating on one unit test for an unrelated reason.
A full run always starts it: `app boots`, `app still running` and the log gate are checks in
their own right.

Checks run in order against one app and share a cookie jar, so a subset that skips earlier
checks starts from a different state — `--only profile` fails with a bare 401 when `login`
never ran. When a subset skips checks the contract lists before it, the run says so:

```
OBSERVED BUT NOT GATED
  1 check(s) earlier in the contract did not run (login) — whatever state they establish
  is absent here: a login, a cookie, a seeded database, a file an earlier command wrote.
  A failure in this subset may be the subset rather than the code
```

It is a caveat, not a gate: the verdict and exit code are whatever the checks earned.

A subset run carries no advisory. Every advisory is a statement about what the *whole*
contract proves, and a subset did not run the whole contract — `INCOMPLETE` already says the
run makes no completion claim.

### When a command fails before it runs

A configuration error (exit `2`) is reported as an object rather than a verdict:

```json
{
  "status": "error",
  "error": ".proof/spec.yaml is invalid:\n  - check[0] \"a\": unknown key \"expct\"\n  - …",
  "problems": [
    "check[0] \"a\": unknown key \"expct\"",
    "check[0] \"a\" › http: `path` and `url` are alternatives — …"
  ]
}
```

`code` says which kind, so an agent branches on a value rather than on the wording of a
sentence proof is free to reword:

| `code` | Meaning | What fixes it |
| --- | --- | --- |
| `ENOSPEC` | No contract at that path | `proof init "<requirement>"` |
| `EBADSPEC` | The contract does not validate or is not YAML | Fix the listed `problems`; `placeholders` names any check that will refuse in the next phase, so one pass fixes everything |
| `EUNFINISHED` | A check still holds a placeholder proof wrote | Replace or delete it |
| `ESPECREAD` | The contract exists but could not be read | Permissions, or a directory in its place |
| `ESPECEXISTS` | `init` would overwrite a contract | `--force`, which keeps a `.bak` |
| `EUSAGE` | The command line is wrong | Read the message; nothing about the project changed |
| `ENOMATCH` | `--only` matched no check | The message lists the names |
| `ENORUNS` / `ENORUN` | No runs recorded, or no such run | `proof check`, or `proof report --list` |
| `EBADREF` | `--base` names a ref that does not resolve | A branch, tag or commit that exists |
| `ENOREPO` | `changed` ran outside a git repository | Run inside a repository, or `git init` |
| `EWRITE` | Evidence or contract could not be written | Permissions, disk, a read-only mount, or a directory removed mid-run |
| `EBADRUN` | A run's `result.json` could not be read | `proof report --list` shows the readable ones |
| `EUNCOVERED` | `guard` or the Stop hook was pointed at a contract with a criterion nothing verifies | No run could report completion, so no loop can end. Add `satisfies:` to the check that proves it |
| `ENOSEAL` | `diff` was asked what changed, and the contract was never sealed | `proof seal` |
| `ENOCHALLENGES` | `challenge` has no faults to inject | Add a `challenges:` list, or pass `--from "<command>"` |
| `ECONTROL` | `challenge` found the contract already failing on your code | Get `proof check` green first: every fault would look detected by a failure that was there beforehand |
| `ENOCOUNTEREXAMPLE` | `promote` or `replay` was given an id that is not on disk, or one of the wrong kind | The message lists what there is |
| `ENOATTACK` | `attack` found no criterion declaring an attack surface | Add an `attack:` block; the message suggests surfaces from how each claim is worded |
| `ENOCRITERION` | `attack <id>` named a criterion that is not declared, or one with no attack surface | The message lists the declared ids |
| `ENOSERVE` | `attack` was run against a contract that starts nothing | An attack composes requests against a running app, so it needs a `serve` block |
| `ENOBASE` | `falsify` or `challenge` found no commit to work from | Commit the code as it was |

`problems` is present whenever proof has a list — a contract that does not validate, mainly.
An agent fixing a contract wants them one at a time; re-parsing `  - ` out of a multi-line
string is a parser nobody should have to write against a tool built for agents.

### Every field of `proof check --json`

| Field | Meaning |
| --- | --- |
| `status` | `passed`, `failed`, or `partial` — `partial` means a `--only` subset, never a completion |
| `goal` | The requirement from the contract |
| `spec` | The contract this verdict is about — several can share one `.proof/runs` |
| `run` | The evidence directory for this run |
| `at` | ISO timestamp of the run |
| `git` | `{head, branch, changed}` as they were when the run **started**, or `null` outside a repository |
| `tree` | Fingerprint of the tree at that moment; `proof report` uses it to mark a run stale |
| `partial` | True when `--only` selected a subset |
| `only` | The `--only` text, or `null` |
| `criterion` | The criterion ids `--criterion` selected, or `null`. Both narrow a run, and both make it `partial` |
| `serve_skipped` | True when a subset selected nothing that needs the app, so the `serve` block was not started |
| `skipped` | `{check, reason}` for each check switched off with `skip:` in the contract. One of these makes the run `partial` |
| `criteria` | `{id, requirement, source, checks, status}` per declared acceptance criterion: which checks are evidence for it and what this run says about them. `status` is `verified`, `failed`, `unverified` or `uncovered`. An `uncovered` one makes the run `partial` |
| `contract_hash` | Fingerprint of the contract this verdict is about. Evidence never carries across a change to it |
| `contract_integrity` | `valid`, `modified` or `unsealed` — whether the contract still matches `proof seal`. `modified` makes the run `partial` |
| `flaky` | `{check, failed, of}` for each check whose recent history holds both outcomes for the same assertion **on the same code**. History is compared by `tree` (HEAD plus a hash of the tracked modifications), so a run against a different working tree is a different experiment and does not count — without that, the first honest failure of a contract written before its implementation would sit in the ledger forever, because base and head share a commit while the work is uncommitted. Outside a git repository there is no fingerprint, and the comparison is dropped rather than the detection |
| `against` | The URL `--base-url` pointed the run at, or `null` when proof started the app itself |
| `advisory` | Set when a passing run proves less than it appears to, otherwise `null` |
| `warnings` | Things observed but not gated: console errors, redirects, a tree that changed mid-run |
| `contract_checks` | How many checks the contract declares |
| `selected_checks` | How many `--only` selected |
| `ran_checks` | How many contract checks actually ran (synthetic `serve` checks excluded) |
| `checks` | `{name: status}` for everything that ran, including `app boots` and friends |
| `results` | `{name, kind, asserted, status, observed, ms}` per check, plus `criteria` — the ids this check is evidence for — plus `expected` and `output` on a failure, `evidence`, `warnings`, `cookies_set`, `captured`, `output_clipped`, `body_clipped` where they apply. A `run` check carries `exit_code`; a retried check carries `attempts`; a check whose runner threw carries `crashed`, which is how a caller tells a failure about the code from one that never reached it. `status` is `passed`, `failed` or `skipped` |
| `failures` | `{check, expected, observed, output, evidence, unmet, was, since}` for each failure. `unmet` is true when the check never ran because a value it needed was never captured — the check that produces it failed, so this one is a consequence rather than a problem of its own, and summaries lead with the cause instead of counting these alongside it. `was` is that check's status in the most recent finished run before this one — `passed`, `failed`, `changed` if a check of that name ran but asserted something else, or `null` if it did not run there. `since` is that run's id |

`proof seal --json` carries `status`, `spec`, `contract_hash`, `previous_hash`, `sealed_at`,
`commit`, `criteria` and `lock`. `proof diff --json` carries `sealed_hash`, `contract_hash`,
`goal_changed`, `policy_changed`, `other_changed`, `criteria`, `checks` and `challenges` (each
`{added, changed, removed}`), `affected` and `unchanged`.

`proof falsify --json` additionally carries `criteria` (`{id, status, checks}`, where `status`
is `falsified`, `already-satisfied`, `inconclusive` or `uncovered`), `criteria_not_falsified`
and `contract_hash`; the same object is kept in `.proof/falsification.json`.

`proof challenge --json` carries `status`, `contract_hash`, `commit`, `state`, `results`
(`{name, source, breaks, apply, status, reason, detected_by, criteria_detected}`), `detected`,
`missed`, `inconclusive` and `counterexamples`; the same object is kept in
`.proof/challenges.json`.

`proof attack --json` carries `status`, `seed`, `contract_hash`, `commit`, `tree`, `criteria`
(`{criterion, result, strategy, hypothesis, invariant, observed, contract, counterexample,
candidates_evaluated, budget, strategies}`), `gaps`, `violations` and `counterexamples`; the same
object is kept in `.proof/attacks.json`. `proof replay --json` carries `counterexample`,
`criterion`, `reproduced`, `invariant`, `observed`, `attached`, `steps` and `error`.

`proof done --json` is the manifest written to `.proof/report.json`: `verdict`, `spec`, `goal`,
`implementation`, `contract`, `criteria`, `coverage`, `checks`, `falsification`, `challenges`,
`attack`, `flakes`, `policy` and `reasons` — plus `next`, `{run, why}`, the one command to run
now. The manifest on disk holds everything but `next`, which is about where you are rather than
about the run.

`proof report --json` returns the same object plus `stale`, and keeps each result's full
`output`; `proof check --json` omits it there to stay small, since the complete text is in
`commands.log` beside it.

### Every field of `proof report --json`

Everything `proof check --json` recorded for that run, read back from `result.json`, plus:

| Field | Meaning |
| --- | --- |
| `stale` | True when the working tree has moved since the run; the command exits `1` |

### Every field of `proof report --list --json`

| Field | Meaning |
| --- | --- |
| `runs` | `{id, dir, at, goal, spec, checks, failed, stale, bytes, status}` per run, oldest first |
| `shown` | How many runs are in `runs`; `--all` shows every one |
| `total_runs` | How many runs exist, whether shown or not |
| `bytes` | Total size of `.proof/runs` on disk |

When runs in the list come from more than one contract, each row is labelled with the
contract's name — `--spec` lets several share one `.proof/runs`, and two of them checking the
same requirement are otherwise identical rows. With a single contract the label is omitted.

`proof report <run>` takes the id in any form the tool itself prints or a shell completes:
`0002`, `2`, `.proof/runs/0002`, `.proof/runs/0002/`, or the `result.json` path from a run's
Evidence section.

`--list` labels each row with its contract when more than one has been run, and only then —
a label with nothing to disambiguate is noise. Two contracts both named `spec.yaml` get their
full paths as labels rather than an identical `[spec]` on both.

A run whose `result.json` cannot be read is listed with `status: "unreadable"`, and one that
never finished with `status: "incomplete"` — a gap in the sequence proof can explain is
better than a gap it hides. "Cannot be read" includes a file that parses but is not a run
record: a row only carries a verdict when `proof report <id>` can read that run, so the
listing is never the more trusting of the two.

The same for the contract itself. `.proof/` is excluded from the blast radius — correctly, it
is not code under test — which made a rewritten definition of "done" invisible. An agent that
cannot make `proof check` pass can delete the check instead and get a `DONE` verdict:

```
NOTE
  this diff also changes the contract — 1 check(s) removed (no debug logging); 1 changed
  (price is correct). The contract is the definition of "done", so a verdict from it is a
  verdict against expectations this diff set. Read those changes first: a check that was
  removed cannot fail.
```

Checks the diff only *adds* stay quiet: one that did not exist before cannot make a verdict
weaker, and `infer --write` adds checks as its whole job. They are still named when a removal,
a change or a rewritten goal has already triggered the note. `contract_changed` carries
`{removed, added, modified, goal}` in `--json`.

`proof check` says it too. `changed` is where you look for a blast radius, but the verdict is
what CI and agents gate on — and a verdict is a claim about a contract. The note travels into
`check --json` under `warnings` and into `report.md`, so it survives being read away from the
terminal. It never changes the verdict or the exit code: rewriting a contract is ordinary
work, and proof's job here is to make sure nobody misses that it happened.

An agent that relaxes an assertion and edits the code in one diff gets `OK — unit tests` on
both files and a `DONE` verdict: the check vouching for the code is running expectations the
same diff rewrote. `changed` says so, and lists the files in `tests_changed`:

```
NOTE
  this diff changes 1 existing test file(s) (test/cart.test.js). A check that runs the suite
  is asserting against expectations the same diff edited or removed, so a passing suite here
  means the current tests agree with the current code — not that the requirement holds. Read
  those changes before trusting the verdict.
```

Editing tests is normal and usually right, so this is a note rather than a failure. Test files
the diff *adds* are not counted — a new test cannot weaken existing coverage, and a warning
that fires on most good diffs is one people learn to scroll past.

`proof check` carries this one too, for the same reason it carries the contract note: the
verdict is what gets acted on, and "the suite passed" means less when this diff is also what
the suite now says.

### Every field of `proof changed --json`

| Field | Meaning |
| --- | --- |
| `base` | The ref the diff was taken from |
| `changed` | Files differing from the fork point with `base`, including untracked ones |
| `dependencies` | `{name, from, to, manifest}` per declared version that moved; `null` for added or removed |
| `unscannable` | Changed files whose imports could not be read, so their dependents are missing |
| `dependents` | One array per hop: direct importers first, then importers of those |
| `uncovered` | Application files in the blast radius that no check names and none reaches; tests and fixtures are excluded |
| `reached` | `{file, via}` for a file nothing names directly but that a file a check does name imports |
| `tests_changed` | Existing test files this diff edits or removes; added ones are not counted |
| `contract_changed` | `{removed, added, modified, goal}` — how this diff alters the contract; `null` outside a repository |
| `coverage` | `{file, checks}` — which check names point at each file in the radius, plus `via` when it was reached through one of them rather than named |
| `spec` | Whether a contract was found; coverage is `null` without one |
| `spec_invalid` | The first problem with the contract, when it exists but does not validate; `null` otherwise |
| `warnings` | Anything that made the scan less complete than it looks |

### Every field of `proof infer --json`

| Field | Meaning |
| --- | --- |
| `scope` | `diff` when there are changes, `repository` when the whole tree was scanned |
| `files` | How many files were in scope |
| `scanned` | How many of those could actually be read and scanned for gaps |
| `test_files` | How many were skipped as tests or fixtures — a route in a fixture is a scenario, not a surface |
| `gaps` | `{severity, title, at, note, check}` — `check` is the contract entry to add, or `null` |
| `needs_serve` | True when a generated http check needs a `serve` block to resolve its path |
| `serve_scaffold_line` | Line in the contract where `init`'s commented-out `serve:` block starts, so the instruction is "uncomment line 13" rather than a blank template; `null` when there is none |
| `unfinished` | Checks still holding a placeholder command; `proof check` refuses these |
| `spec_invalid` | The first problem with the contract, when it exists but does not validate; `null` otherwise |
| `spec_path` | The contract read, and the one `--write` appends to |
| `warnings` | Anything that made the scan less complete than it looks |
| `written` | How many checks `--write` appended, `0` without it |

`gaps[].severity` is `HIGH` for something reachable that nothing asserts, `MEDIUM` for a file
in the radius with no check naming it. `gaps[].note` carries the caveat that travels into the
contract as a comment when `--write` appends the check.
