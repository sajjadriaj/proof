# Verdicts and evidence

[← back to README](../README.md)

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

```
.proof/
├── spec.yaml
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
