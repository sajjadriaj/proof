# Verdicts and evidence

[← back to README](../README.md)

What each verdict means, what a green run does *not* prove, and what `proof` records for every run.

## Five verdicts, not two

| Verdict | Where | Means |
| --- | --- | --- |
| `PASS` / `FAIL` | per check | That check's own assertion held, or did not |
| `DONE` | `proof check` | Every check in the whole contract passed, and every declared criterion has evidence in that run |
| `NOT DONE` | `proof check` | At least one check failed |
| `INCOMPLETE` | `proof check`, `proof done` | The checks may have passed, and the evidence does not add up to a completion claim: a subset run, a switched-off check, a criterion nothing verifies, a contract that moved after being sealed, a falsification that never happened |
| `INVALID` | `proof done` | The chain cannot be trusted at all: evidence recorded for another commit or another contract, a baseline commit that no longer exists, a malformed run record |

An attack has five of its own, because "we looked and found nothing" is not "it is correct":

| Attack result | Means |
| --- | --- |
| `NO_COUNTEREXAMPLE_FOUND` | The budget ran out. The report states the strategies, the candidates evaluated and the seed |
| `COUNTEREXAMPLE_CANDIDATE` | A server error, with no invariant broken — a defect, not an established claim violation |
| `CLAIM_VIOLATION` | An invariant was broken, and the contract failed too |
| `VERIFICATION_GAP` | An invariant was broken while the contract passed. The verifier itself was wrong |
| `ATTACK_ERROR` | The scenario could not run, usually setup that did not succeed |

`PASS` is not `DONE`, and `DONE` from `proof check` is a claim about the contract, not about
the requirement. The claim about the requirement is `proof done`, which is derived from the
records below rather than from any single run.

## In short: what `proof` refuses to overstate

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

## What a green run does and does not mean

If nothing in your contract exercises the running application, `proof check` says so on a pass:

```
NOTE
  Nothing in this contract exercises the running application — `run:` and `file:` checks
  cannot show that the requirement works. `proof infer` suggests acceptance checks for the
  current diff. (If the requirement is about a command, a `run:` check that invokes it is
  exactly right.)
```

That is the premise of the whole tool, so it would be dishonest to let a contract that only
re-runs your test suite report DONE without comment. The note appears only on a pass, which
is where the false confidence lives, and it is advisory — exit code and verdict are
unchanged. Any `http`, `browser`, or `env` check silences it.

With a `serve` block but no `http` or `browser` check, the app **is** started and probed —
`app boots` and `app still running` both ran — so the first note would be false. The gap there
is narrower, and gets its own:

```
NOTE
  The app was started and answered, but nothing asserts what it does — `app boots` shows it
  is up, not that the requirement works. Add an `http` or `browser` check for the behaviour
  the goal describes.
```

A contract that *does* reach the app can still prove less than it looks:

```
NOTE
  No http or browser check here asserts what the app actually returned, only that it
  answered — a 200 carrying the wrong body passes. Add `expect: {body_contains: ...}` or
  `expect: {json: ...}` to the checks that carry the requirement.
```

This is the shape `proof infer --write` produces, because `infer` can generate
`expect: {status: 200}` but cannot know what the endpoint is supposed to say. A single
`body_contains`, `json`, `expect_text` or `expect_request` anywhere in the contract silences
it. `body_not_contains` does not: proving a response does not leak a stack trace is no
evidence the rest of it is right. Contracts with no `http` or `browser` checks never see
it — there is no response to assert anything about.

The same caveat is carried into `proof report`, under **What this run does not prove**. The
report is the artifact that gets shared and attached to a review, so a warning that lived
only in terminal output would be missing from the document actually making the claim.

`proof report --list` shows every recorded run — id, verdict, timestamp, how many checks
passed, and the goal — so you can pick one without guessing at ids.

### Checks that do not agree with themselves

Every run of a contract is on disk, and for a long time the only one ever consulted was the
last. A check that passes four runs in five rendered exactly like one that always passes — and
a verdict resting on it means less than it looks, which is the thing this tool exists to
prevent.

Each run now reads the last ten of the same contract. A check whose history holds **both**
outcomes for the same assertion is named, on a green run as much as a red one:

```
OBSERVED BUT NOT GATED
  coin flip has not agreed with itself: it failed 1 of the last 2 runs that asserted the same
  thing, and passed the rest. A check that flakes makes every verdict it appears in weaker —
  find the nondeterminism, or make the check wait for what it needs.
```

Two rules keep it from crying wolf:

- **A regression is not a flake.** The window is the history *before* this run. A check that
  passed ten times and fails now is the change's doing, and calling that a flake would excuse
  it. It gets the `Regression:` marker instead.
- **Like-for-like or not at all.** A check whose assertion was edited is a different check,
  and its earlier outcomes say nothing about it — the same rule the regression marker follows.

It never changes the verdict or the exit code. `--json` carries `flaky` as
`{check, failed, of}`.

### Stale reports

A report describes the code as it was when the run happened. If the tree has changed since,
the report says so rather than presenting an old verdict as a current one:

```
**Verdict:** DONE — STALE

> **Stale:** the working tree has changed since this run. These results describe the
> code as it was at the timestamp above, not the code as it stands now.
```

`--list` marks stale runs, and `--json` exposes `stale` for agents. Outside a git
repository there is nothing to compare against, so nothing is ever called stale.

## Evidence

Every run writes a bundle. Nothing is inferred after the fact; `result.json` records the
commit and the working tree **as they were when the run started**, not as they look once it
finishes — a verdict describes the code that was checked.

Each result carries `asserted`: what that check required, in one line. A bundle can be read
back without the contract that produced it, which matters because the contract usually moves
on before anyone reads the run:

```
$ alpha [run] -> passed (3ms)
  asserted: `echo hi`, exit 0, output contains "hi"
hi
```

If the tree moves while checking, the run says so. In an agent loop the editor may still be
running, and a DONE verdict for code that has since changed is precisely the false
completion signal this tool exists to catch:

```
OBSERVED BUT NOT GATED
  the working tree changed while this run was in progress — the verdict describes the
  code as it was when the run started
```

Detection is by content of tracked changes, so build output in a gitignored directory is
not mistaken for an edit.

Beside the runs, four records make up the verification chain. Each one is keyed by the contract
it is about, so several contracts can share one `.proof` without overwriting each other:

| File | Written by | Holds |
| --- | --- | --- |
| `lock.json` | `proof seal` | The contract's fingerprint, when it was sealed, at which commit, and a per-criterion and per-check hash so `proof diff` can say what moved |
| `falsification.json` | `proof falsify` | The baseline commit, the contract it was run against, which checks failed there and which criteria that falsified |
| `challenges.json` | `proof challenge` | Which faults were detected, which were missed, which were inconclusive, and which checks caught each one |
| `attacks.json` | `proof attack` | The search: its seed, the contract and tree it ran against, what each criterion's search evaluated, and every gap, violation and counterexample it produced |
| `report.json` | `proof done` | The manifest: the verdict, the commit, the contract hash, per-criterion coverage, the falsification result, the challenge outcome, the policy and every reason the verdict is not `DONE` |
| `counterexamples/` | `proof challenge`, `proof attack` | One file per thing the contract accepted: a fault (the command that broke the code unnoticed) or a scenario (the steps, the invariant, what both oracles said, and the seed). `proof replay` runs a scenario again, `proof promote` turns either into a check |

`lock.json` is meant to be committed: it is what says this contract was reviewed, and a seal
only the person who wrote it can see is not a seal. The other three are records of a particular
run against a particular commit — commit them for an audit trail, or ignore them; nothing in
proof needs them to be in git.

Evidence never carries across a change to the contract. Every record holds the contract hash
it was produced under, and `proof done` refuses one that does not match the contract on disk:
a verdict recorded under a different definition of "done" is evidence about something else.

```
.proof/
├── spec.yaml
├── lock.json                          `proof seal`: the contract as it was reviewed
├── falsification.json                 `proof falsify`: the baseline and what failed there
├── challenges.json                    `proof challenge`: which faults the contract caught
├── attacks.json                       `proof attack`: what was searched, and what it found
├── report.json                        `proof done`: the verification manifest
├── counterexamples/                   faults the contract accepted, kept
└── runs/
    └── 0001/
        ├── result.json                    every check, what it asserted, timing, git context
        ├── commands.log                   each assertion and its complete output, nothing dropped
        ├── report.md                      written by `proof report`
        ├── response-<check>.txt           a failed http check's body, when too big to keep inline
        ├── browser-<check>.json           steps, network, console, screenshot path
        └── screenshots/<check>.png
```

Nothing prunes `.proof/runs` on its own. A run costs a few hundred kilobytes — more with
browser screenshots — and an agent loop runs `check` hundreds of times, so once a hundred
runs have collected `proof check` says what is there:

```
NOTE
  100 runs (3.8 MB) have collected in .proof/runs. Nothing prunes them automatically —
  `proof report --prune` keeps the 20 most recent, or `--keep <n>` to choose.
```

Advisory only: the verdict, the exit code and `--json` are unchanged. Deleting evidence is
your call, not proof's. `proof report --list` shows the same total at any size.

```
$ proof report --prune --keep 5
Pruned 20 run(s) (0001–0020), 18 KB reclaimed.
Kept the 5 most recent in .proof/runs.
```

`--keep` must be a positive whole number, so the most recent run survives a typo'd zero.
With `--json` the same result is `{pruned, kept, freed, failed}`; a directory that could not
be removed lands in `failed` and exits 1, rather than reporting space that was never freed.

`report.md` links its evidence relative to itself, so the links work when the report is
opened where it sits or attached to a review. A browser screenshot is embedded rather than
linked — it is the evidence a reviewer actually wants to look at.

`commands.log` holds every command's output in full. What `result.json` and the terminal show
is clipped to both ends — the first lines and the last, with a count of what sits between:

```
    ERROR: cannot resolve module './missing' in src/app.ts:3
      at frame 1 of a very long stack
    … 25 line(s) omitted — full output in commands.log …
      at frame 120 of a very long stack
```

Keeping only the tail would drop the one line that explains the failure, since compilers put
the error first and the stack after.

Response bodies follow the same rule. Assertions always run against the whole body; what is
stored inline is bounded and marked as such, and when an `http` check **fails** the complete
body is written beside it as `response-<check>.txt`. A body silently cut at 4000 characters
looks complete, and can appear to contradict the very failure it accompanies.

`.proof/runs/` is gitignored by `proof init`. The contract itself is meant to be committed.

Evidence accumulates: a browser check writes a full-page screenshot every run, so a long
agent loop can reach tens of megabytes without anyone noticing. `proof report --list` shows
the total, and `--json` carries `bytes` per run:

```
3 run(s), 379 KB in .proof/runs. `proof report <id>` for one of them.
```

The directory holds nothing `proof` needs to keep working — deleting it or any run inside it
is safe, and the next `check` starts numbering from wherever it left off.
