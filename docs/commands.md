# Command reference

[← back to README](../README.md)

## Commands

| Command | What it does |
| --- | --- |
| `proof init "<requirement>"` | Write an acceptance contract to `.proof/spec.yaml`, seeded from the repo's own build/test commands and its dev script |
| `proof infer` | Find verification gaps in the current diff; `--write` appends them to the contract |
| `proof changed` | Blast radius of the diff — reverse import graph plus which checks name each file |
| `proof check` | Execute the contract; the only command whose exit code means "done" |
| `proof report [run]` | Render the evidence for a run (default: the latest); `--list` shows recent runs, `--all` shows every one |
| `proof help` | The usage text; `--help` and `-h` are the same |
| `proof --version` | The installed version, read from `package.json` rather than a copy that can drift |
| `proof guard -- <agent...>` | Supervise a coding agent: run it, run the contract when it exits, and relaunch it with the failure evidence until the contract passes. `--max-attempts N` bounds the loop; Ctrl-C is the other override |

Flags: `--json` (machine-readable, on every command), `--force` (init), `--write` (infer),
`--only TEXT` and `--spec PATH` (check), `--list` and `--all` (report), `--depth N` and `--base REF` (changed, infer).

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
| `serve_skipped` | True when a subset selected nothing that needs the app, so the `serve` block was not started |
| `advisory` | Set when a passing run proves less than it appears to, otherwise `null` |
| `warnings` | Things observed but not gated: console errors, redirects, a tree that changed mid-run |
| `contract_checks` | How many checks the contract declares |
| `selected_checks` | How many `--only` selected |
| `ran_checks` | How many contract checks actually ran (synthetic `serve` checks excluded) |
| `checks` | `{name: status}` for everything that ran, including `app boots` and friends |
| `results` | `{name, kind, asserted, status, observed, ms}` per check, plus `expected` and `output` on a failure, `evidence`, `warnings`, `cookies_set`, `output_clipped`, `body_clipped` where they apply |
| `failures` | `{check, expected, observed, output, evidence, was, since}` for each failure. `was` is that check's status in the most recent finished run before this one — `passed`, `failed`, `changed` if a check of that name ran but asserted something else, or `null` if it did not run there. `since` is that run's id |

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
| `uncovered` | Application files in the blast radius that no check names; tests and fixtures are excluded |
| `tests_changed` | Existing test files this diff edits or removes; added ones are not counted |
| `contract_changed` | `{removed, added, modified, goal}` — how this diff alters the contract; `null` outside a repository |
| `coverage` | `{file, checks}` — which check names point at each file in the radius |
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
