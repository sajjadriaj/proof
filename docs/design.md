# Design

[← back to README](../README.md)

Why `proof` works the way it does, what it will not do, and how to work on it.

## Principles

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

The baseline is also the previous run *of the same contract*, **on this commit's lineage**.
Every contract's runs share one `.proof/runs` directory and so does every branch, so without
those restrictions "passed in run 0001" could be a claim about a different contract that names
a check the same way — or about another branch, where the feature exists and here it never has.
Switching branches and running the contract used to report the other branch's work as a
regression on this one.

Comparable means the baseline's commit is in this commit's history: that is what "it used to
work" asserts. The run at *this* commit wins when there is one, which is the ordinary
edit-and-rerun loop; otherwise the search widens to the lineage, so a branch run becomes
comparable again the moment it is merged. Outside a repository there are no branches to
confuse and the previous run is the baseline as before. With no comparable run, proof says
nothing rather than something wrong.

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

## Do not trust the contract either

Every principle above is about distrusting the implementation. The contract is the other place
a verdict can go wrong, and it goes wrong silently: a check that passes on code that never had
the feature reports DONE for a branch that did nothing.

`proof falsify` checks the base commit out into a temporary worktree, runs the **current**
contract against it, and reports whether anything failed. Three answers, not two — a base that
would not boot, a runner that crashed, or a command that exits 127 makes the contract "fail"
for a reason that says nothing about the change, and calling that *discriminates* would be the
same false confidence the rest of this refuses to give.

It also produces the distinction a test suite cannot: which checks carry the requirement, and
which are regression guards that would pass either way.

## An implementation agent's claim of completion is untrusted

Everything here follows from one rule: **DONE is not declared by the implementation agent, it
is derived from independently executable evidence.** That gives four questions a verdict has to
answer, and each command exists to answer exactly one of them.

| Question | Command | Failure it catches |
| --- | --- | --- |
| **Coverage** — does the contract represent every stated criterion? | `criteria:` / `satisfies:`, reported by `check` and `lint` | Four green checks about the happy path, and nothing about token expiry |
| **Discrimination** — would the contract reject the code from before the change? | `falsify` | `expect: {status: 200}` on a route that already existed |
| **Strength** — would it catch a plausible wrong implementation? | `challenge` | The endpoint answers, the guard it was supposed to have was never exercised |
| **Integrity** — is this the contract that was agreed, and is the evidence about this code? | `seal`, `diff`, and the freshness rules in `done` | A check quietly relaxed until it passed |

`proof done` is where the four meet, and it runs nothing itself: every input is a record an
earlier command wrote, each stamped with the commit and the contract hash it was produced
under. Evidence never carries across a change to the contract — a verdict recorded under a
different definition of "done" is evidence about something else.

The fault probes are deliberately the ones you write down rather than generated mutations. A
syntactic mutation (`>` becomes `>=`) is cheap to produce and rarely describes anything a
requirement cares about; "allow the token to be reused" does. `challenge --from <command>` is
the seam for anything smarter — a semantic prober derived from a criterion, an adversarial
agent hypothesising how the change could be wrong, a language-specific mutation tool. Whatever
proposes the faults, proof is what applies them and decides whether the contract noticed. A
model can strengthen verification; it is never the root of trust.

## An attack is asymmetric, and says so

`proof attack` can never prove an implementation correct, and nothing it prints pretends
otherwise. It does not have to: one reproducible scenario showing that a claim of correctness is
unjustified is worth more than any number of runs that found nothing, and the asymmetry is the
whole design.

That is why the result model has five states rather than two, why a search that finds nothing
reports its strategies, its candidate count and its seed instead of a verdict, and why a 5xx is
a `COUNTEREXAMPLE_CANDIDATE` and never a `CLAIM_VIOLATION` — a defect is not the claim being
broken, and only a deterministic invariant can say that it was.

The finding worth the most is not a bug in the code:

```
IMPLEMENTATION  appears correct
CONTRACT        passes
REQUIREMENT     violated
```

Which is only findable because two judges are allowed to disagree. The contract oracle is the
checks that carry the criterion, run against the app in the state the scenario left it. The
requirement oracle is an invariant — one comparison, counted over what was observed. If the
contract could also define what "violated" means, an attack could only ever rediscover what the
contract already asserts, and the interesting half would be invisible by construction.

A model may propose scenarios (`--from`) and may never establish one: the executor only runs
actions the criterion declared, and only a deterministic oracle turns an observation into a
finding. That is the same trust boundary the rest of this tool keeps, in the one place where it
would be most tempting to give it up.

## The contract has to be readable

The contract is the definition of "done", which makes it something a human reviews. A file
nobody can read is a file nobody reviews, so `proof lint` reads it back as what each check
asserts — from the same strings the run records as `asserted`, rather than a second description
of the language that can drift from the first.

That is also why the contract is not written in English. A natural-language spec a machine
executes is either a model interpreting it — which puts a model back in the judging seat, the
one thing this tool exists to remove — or an English-shaped grammar whose glue code becomes the
real test while the prose becomes decoration. English is the *input*: `proof init "<requirement>"`
takes a sentence, and `infer`, `lint` and `falsify` are how you find out whether the checks it
became mean anything.

## Not a place to put logic

No fixtures, no factories, no mocks, no parameterized cases, no setup and teardown. The moment
a check needs code, that check is a test, and the right way to reach it from here is
`run: npx playwright test smoke.spec.ts`. A contract that grew an expression language would be
a worse test framework beside two good ones.

## Non-goals

Not a coding agent, not an IDE, not a replacement for unit tests or Playwright, not a CI
platform, not an MCP server. `proof` sits one layer above your existing tools and asks one
narrower question: does the implemented change actually satisfy the requirement?

The value of that scales with how much you are delegating. With a careful human writing the
code and a review culture that catches weak tests, most of this is buying you very little. In
an agent loop, where the suite is the thing the agent already passes while being wrong, it is
buying you the verdict.

## Development

```bash
npm test
```

MIT.
