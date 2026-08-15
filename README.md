# proof

**Don't trust your coding agent. Test its work.**

[![node](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](https://nodejs.org)
[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![dependencies](https://img.shields.io/badge/runtime%20deps-1%20(yaml)-lightgrey)](package.json)

Coding agents write code. `proof` verifies that the code actually works.

An agent that implements a feature is usually also the judge of whether the feature
is done. It runs the unit tests, they pass, and it reports success — while the button
is wired to nothing. `proof` is an independent layer between an agent's implementation
and its claim of completion: a human-readable acceptance contract in your repo, executed
against the *running application*, producing a verdict backed by evidence.

![proof demo — a failing check caught with evidence, fixed, and verified green](docs/demo.gif)

```text
Passing the existing test suite is not the same as satisfying the requirement.
```

- **Agent independent** — the interface is a CLI; anything that can run a shell command can be verified
- **Evidence over confidence** — every run leaves a bundle: responses, logs, screenshots, `report.md`
- **A verdict that means something** — exit 0 passed, 1 failed, 2 the contract itself is wrong; `DONE` is never said about something proof did not verify
- **Supervision built in** — `proof guard -- <agent...>` reruns your agent until the contract passes

## Install

```bash
npm install -g proof-cli
```

Browser checks additionally need Playwright, which is not a runtime dependency —
install it only if your contract uses the `browser:` verb:

```bash
npm i -D playwright && npx playwright install chromium
```

Both halves are needed: the package and the browser binaries are separate downloads. Proof
tells you which one is missing rather than passing on Playwright's drawn box, whose closing
lines — the ones carrying the command — did not survive being wrapped into a failure reason.
In a container you may also need `sudo npx playwright install-deps` for the system libraries;
that is a different message, and proof names it separately.

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

## The contract

`.proof/spec.yaml` is a plain, hand-editable file. It is the definition of "done",
and it is meant to be reviewed and committed like any other source file.

```yaml
goal: Users can reset a forgotten password and log in with the new one

serve:
  run: npm run dev
  ready_url: http://localhost:3000
  timeout: 60
  log_must_not_match: "unhandled rejection|ECONNREFUSED"

checks:
  - name: build
    run: npm run build

  - name: migrations
    run: npx prisma migrate deploy

  - name: reset endpoint
    http:
      method: POST
      path: /api/password-reset
      body: { email: user@example.com }
      expect:
        status: 200
        json:
          ok: true
          user: { id: "<number>", email: "<string>" }

  - name: password reset flow
    browser:
      visit: /forgot-password
      flow:
        - fill: { email: user@example.com }
        - click: "Send reset link"
        - expect_request: { method: POST, path: /api/password-reset }
        - expect_text: "Check your email"

  - name: existing login still works
    browser:
      visit: /login
      flow:
        - fill: { email: user@example.com, password: hunter2 }
        - click: "Log in"
        - expect_url: /dashboard
```

### Verbs

| Verb | Shape | Notes |
| --- | --- | --- |
| `run` | `run: <shell command>` | `expect_exit` (default 0), `expect_output` (substring), `timeout` (seconds, default 600) |
| — | `timeout` on any check | The budget for that whole check, never per step. A `browser` flow gets `timeout` seconds in total (default 60), not `timeout` seconds each. Must be greater than zero — there is no "unlimited" value, and `0` in most tools means the opposite of what it would mean here. |
| `http` | `http: {method, path\|url, headers, body, expect: {status, body_contains, body_not_contains, json}}` | `path` resolves against `serve.ready_url`; object bodies are sent as JSON. With no `expect`, any status `>= 400` fails — a 500 answering the phone is not a pass |
| `file` | `file: <path>` or `file: {path, exists, contains, not_contains}` | Asserts a **regular file** — a directory of that name fails. `exists: false` asserts absence; use `run: test -d <path>` for a directory. `not_contains` verifies a removal, and fails on a missing file rather than passing vacuously |
| `env` | `env: <NAME>` or `env: {name, matches}` | Reads **proof's own environment** (see below). Never echoes the value — these usually cover secrets |
| `browser` | `browser: {visit, flow, base_url, expect_no_console_errors}` | Needs Playwright |

### What `env` actually checks

`env` reads the environment **`proof` itself is running in**. That is the environment a
`serve` block inherits, so the check is meaningful exactly when `proof` starts your app — the
common case, and the one `proof init` scaffolds.

A `serve` command that starts the app and exits — `docker compose up -d`, `pm2 start`, any
detaching launcher — is not a boot failure. A non-zero exit is: the launcher said it failed.
On a zero exit proof keeps polling `ready_url` until the timeout, and if the app answers the
run proceeds. It says so, because the app is then outside the process group proof stops:

```
OBSERVED BUT NOT GATED
  `./up.sh` exited after starting the app, so the app is outside the process group proof
  stops — it is still running now, and stopping it is yours to do
```

It is *not* a claim about an app running somewhere else. If `serve` shells out to
`docker compose`, or loads variables from a file, or the app is already running elsewhere,
the app's environment is not the one being read, and a green `env` check says nothing about
it. Messages name the scope for this reason:

```
env STRIPE_SECRET_KEY is set in proof's environment
```

To assert the *app's* view, ask the app — a health endpoint reporting its own configuration,
checked with `http` and `expect.json`, proves what `env` cannot.

### Sessions

`http` checks share a cookie jar for the length of a run, in the order the contract writes
them. Logging in and then reading a protected route works:

```yaml
- name: log in
  http: { method: POST, path: /login, body: { email: buyer@example.com }, expect: { status: 200 } }
- name: read profile
  http: { path: /me, expect: { status: 200, json: { user: buyer } } }
```

Without this, the second check gets a bare `401` — the app behaving correctly and `proof`
having thrown the session away. A cleared cookie (`Max-Age=0`) is dropped, so a check after
a logout sees no session. A check that sets its own `Cookie` header keeps control of it, and
each run starts with an empty jar.

Cookie **names** are recorded as evidence; values never are, since they are credentials and
evidence bundles get shared. Browser checks are separate — each gets a fresh context.

### Redirects

`http` checks follow redirects, so the status you assert is whatever answered **last**. A
`/admin` route that 302s to a 200 login page therefore satisfies `expect: {status: 200}` —
the check passes while the page you named never answered at all.

That stays a pass, because plenty of APIs redirect legitimately, but it is never silent:

```
OBSERVED BUT NOT GATED
  admin dashboard: GET /admin did not answer directly — it redirected to http://…/login
```

The final URL also appears in the check's `observed`, on failures as well as passes, so a
status mismatch is never diagnosed against the wrong endpoint. Set `follow_redirects: false`
to stop at the first response and assert the redirect itself (`expect: {status: 302}`).

### Request bodies

An object body is encoded to match the content-type you declare:

| Declared content-type | Sent as |
| --- | --- |
| none | JSON, and the header is set to `application/json` |
| anything containing `json` | JSON |
| `application/x-www-form-urlencoded` | `a=1&b=2`, percent-encoded |
| anything else | contract error — provide the body as a string |

Serialising an object as JSON while labelling it a form would send a request no client would
ever produce, and not the one the contract describes. Where `proof` cannot encode faithfully
it refuses rather than guesses. String bodies are sent verbatim and never relabelled.

### Response shape

`expect.json` matches a subset: everything the contract names must be present and match,
and the response may return more. Where the value is generated but the shape is what
matters, use a type token — `<string>`, `<number>`, `<boolean>`, `<array>`, `<object>`,
`<null>`, `<any>`.

```yaml
expect:
  json:
    user: { id: "<number>", email: "<string>" }
    ok: true
```

Failures name the exact path, so a drifted response reads as
`$.user.id = <number>` / `$.user.id was "42"` rather than a substring test that passes
because the right characters happened to appear somewhere in the body. A non-JSON
response reports its content-type, which is how an HTML error page usually announces itself.

### Runtime health

When a `serve` block is present, `proof` adds checks you do not have to write:

- **`app boots`** — the app answers at `ready_url` within `timeout`. Before starting your
  command, `proof` checks that nothing is *already* answering there. If something is, the
  run fails: a server that cannot bind the port looks exactly like one that booted, and
  every check would then run against whatever was already listening. Set
  `serve.reuse_existing: true` to point at an app you started yourself — the run then warns
  that it is talking to a process `proof` did not start.
- **`app still running`** — it is *still* answering when the run ends. A dev server that
  died halfway through explains every connection error after it, and nothing else in the
  run would tell you. Health means still responding: launcher wrappers like `npm run dev`
  exit 0 even when the app underneath crashed, so their exit code is reported as detail,
  never as the verdict.
- **`app logs clean`** — only when you set `serve.log_must_not_match`, a regex the runtime
  log must not contain. The failure quotes the offending line.

The server's full stdout and stderr are captured to `serve.log` in the evidence bundle on
every run, pass or fail.

After the last check, `proof` leaves the app running briefly before judging anything. That
window is when a crash *caused by* the last check happens — probing liveness immediately
reported "still running" for an app the run had just killed. Health is asked after the
window, and the app's output is read after that. An error logged just after a request — the usual
shape of an unhandled rejection — would otherwise never be written at all, and the log gate
would pass over a failure it was never given the chance to see.

Everything `proof` starts is torn down when it exits, including on Ctrl-C. Interrupting a
run does not leave a dev server holding its port — which would otherwise fail the *next*
run's port check and look like an unrelated process squatting there.

Browser flow steps: `visit`, `fill`, `click`, `expect_text`, `expect_url`, `expect_request`, `wait`.

`visit` fails immediately on a status `>= 400`, so a route that does not exist reports
`status 404` instead of a mystifying selector timeout fifteen seconds later.

`expect_request` only considers requests made since the previous *action* step, so it can
tell "no request fired at all" apart from "some unrelated request fired" — and reports which.

It also watches what came **back**. A request that fired and then answered 500 is not what
"the button works" means, so that is reported even though the assertion — that the request
was made — did hold:

```
OBSERVED BUT NOT GATED
  reset flow: POST /api/password-reset was sent but answered status 500
              — add `status:` to expect_request to fail on this
```

Add `status:` to make it a failure outright (`expect_request: {method: POST, path: /api/x, status: 200}`).
Every request's response status, or its network-level failure, is recorded in the evidence
bundle regardless.

Its `path` is matched **exactly** against the request's pathname, ignoring origin and query
string. A substring match would let `/api/user` be satisfied by a call to
`/api/user-preferences`, which is the same button-wired-to-the-wrong-thing bug the check
exists to catch. For dynamic segments use `path_matches`, a regex:

```yaml
- expect_request: { method: PATCH, path_matches: "^/api/users/\\d+$" }
```

`expect_text` matches the first *visible* element containing the text. Responsive layouts
and templates routinely put a hidden copy earlier in the DOM, and waiting on that one would
time out with the real text plainly on screen.

`expect_url` is matched **exactly** against the pathname, not as a substring, so
`/dashboard` is not satisfied by landing on `/dashboard-error`. Include a query string to
assert it too (`/dashboard?welcome=1`), or give an absolute URL to compare the whole thing.
A bare fragment is a contract error, since there is no substring semantic to fall back on.
When the URL is wrong the failure says where the browser actually is.

A `visit` that redirects is reported the same way the `http` verb reports it — a page that
bounced to a login screen otherwise looks exactly like one that loaded.

`fill: {email: "…"}` resolves the field by `[name]`, `[data-testid]`, `#id`, placeholder,
aria-label, input type, then label text. Pass an explicit selector as the key
(`fill: {"#email": "…"}`) to skip the guessing. `click: "…"` resolves by button role, link
role, submit value, then any text.

Both are **strict priority orders, not document order**. A newsletter box whose placeholder
mentions "email" does not outrank `[name="email"]` for sitting earlier in the page, and a
paragraph quoting a button's label does not outrank the button. The selector that actually
matched is recorded in the evidence bundle under `resolved`, so a mis-targeted fill is
visible rather than something you infer from a confusing downstream failure.

When nothing matches, the failure lists every selector tried instead of expiring as a bare
timeout.

Console errors are always captured and attached to a failure, because they usually explain it.
Set `expect_no_console_errors: true` to also fail *on* them.

The failure shows the message and the first frame; the evidence bundle keeps the **whole
stack**, since the first frame is often framework internals and the frame worth reading sits
further down. Locations are 1-based, matching what your editor shows.

When a check **passes** and console errors were logged anyway, `proof` says so rather than
staying quiet — failing on them is opt-in, but reporting what was observed is not:

```
OBSERVED BUT NOT GATED
  dashboard flow: 2 console error(s) logged — set `expect_no_console_errors: true` to fail on them
```

The report lists the errors themselves, with source locations, under **Observed but not
gated** — a reviewer deciding whether a green run is good enough needs the text, not a count.

## The contract is validated strictly

A key `proof` does not recognise is rejected, never ignored. This matters more here than
in most tools: a silently-dropped key is an assertion that never runs, and a check that
asserts nothing would report PASS.

```
$ proof check
proof: .proof/spec.yaml is invalid:
  - check[0] "api returns 200" › http: unknown key "expect_status" — did you mean "expect"?
  - check[1] "two verbs": 2 verbs (run, file) — a check asserts one thing
  - check[2] "nothing": no verb — expected one of run, http, file, env, browser
  - check[3] "flow" › browser › flow[0]: unknown key "clik" — did you mean "click"?
```

A key that is real but in the wrong place is told where it belongs rather than guessed at:

```
check[0] "api" : unknown key "expect" — that key belongs under `http`
check[1] "api" › http: unknown key "status" — that key belongs under `http › expect`
check[2] "flow": unknown key "click" — that key belongs under a step in `browser › flow`
```

Places are named as the contract writes them. A key valid in two places names both, since
choosing one would be a guess about which was meant.

Nesting is the likeliest mistake in this language, and edit distance answered it badly —
`expect` on a check used to suggest `expect_exit`, a different assertion, so following the
advice produced a contract that was valid and wrong. An ordinary misspelling still gets the
nearest key.

Every problem in the file is reported at once, so an agent fixes the contract in one pass
rather than one error per run.

A browser flow step does one thing. `{click: "Go", expect_text: "Welcome"}` is refused,
because the runner dispatches on the first verb it finds — it would click and never assert
the text. Split it into two steps.

Three rules catch a written assertion that would never run: `file` with both `exists: false`
and `contains` or `not_contains` (an absent file has no contents to match), `http` with both `path` and
`url` (the runner takes `url`, so the `path` would be ignored), and a flow step with two
verbs. Each is the remains of editing one form into another, and each passes silently
otherwise — the check runs, reports
PASS, and one clause of it was never evaluated.

Two more rules exist because **proof writes contracts too**, and what it writes is sometimes
deliberately incomplete:

- a `run:` still holding the placeholder command `proof init` wrote when it found no test
  command. It passes, so a contract made only of that would report DONE for a requirement
  nothing verified.
- a `path:` still holding the route pattern `proof infer` generated it from — `/api/orders/[id]`,
  `/api/users/:id`, `/api/x/{id}`. `infer` says "replace with a real value" once, in a terminal;
  the contract keeps no trace, so without this the next run requests that path literally and
  fails with nothing to say it was a placeholder.

A third covers the `serve` block proof scaffolds: `run: <your dev command>` uncommented but
not filled in reaches the shell, where `<` is input redirection and the run fails with a
syntax error nowhere near the real problem. A `ready_url` still holding `<port>` is refused
the same way.

All of these are refused by `proof check` rather than run. The rules are deliberately narrow:
only whole segments count as route patterns, so `?after=12:30`, `localhost:3000` and
`/api/a-[b]-c` are ordinary URLs; and placeholder commands are matched exactly rather than by
pattern, so `grep '<div>' index.html` and `sort < in.txt > out.txt` are ordinary commands. A
validation rule that cries wolf is one people learn to ignore, which costs more than the
placeholder it would catch. Key spaces that are yours — `headers`, `body`, and the field
names in `fill` — are left alone.

A bad contract aborts before anything runs (exit 2). Once the run has started, a check that
crashes fails *itself* and the run continues — you keep the evidence every other check
produced, which is the point of running them.

Values that carry assertions are type-checked, because YAML makes it easy to write one that
never runs. `contains: 0` is the *number* zero, which is falsy, so a truthiness guard would
skip the comparison and the check would pass against a file containing no zero at all:

```
- check[0] "file has a zero" › file › contains: must be a string, got number — quote it in YAML
```

### Check names must be unique

A check's name keys its entry in `result.checks`, its evidence filenames, and `--only`
selection. Two checks sharing one is a contract error, compared after normalising case and
punctuation so `API Works` and `api-works` still collide.

Without that rule, the later result silently replaces the earlier in the results map — a
check that *failed* can be reported as `passed` there — and two browser checks overwrite
each other's evidence bundle and screenshot. Unnamed checks are named by position
(`file check 3`) so they cannot collide either.

### URLs are checked before anything runs

`serve.ready_url` and `browser.base_url` must be absolute. A scheme-less value like
`localhost:3000` can never be fetched, so `proof` would poll it for the whole boot timeout
and then report the app as never ready — blaming the application for a typo in the contract.
It is now rejected at load, in under a second.

### No guessed host

A relative `path` or `visit` needs a `serve.ready_url` or a `browser.base_url` to resolve
against. If neither is present, that is a contract error — `proof` will not fall back to a
default host.

`proof init` scaffolds the `serve` block for you, filled in with whichever of `dev`,
`start` or `serve` your `package.json` declares. It is written **commented out**: the
command is read from your project, but the port is not something `proof` can know, and a
wrong `ready_url` is worse than an absent one. Uncomment it, confirm the port, and http and
browser checks work.

This is not pedantry. With a `localhost:3000` fallback, a contract that never starts an app
will happily test whatever unrelated project you already had running, follow its redirects,
get a 200, and report DONE. The requirement is then "verified" against software that has
nothing to do with it.

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

## Blast radius

`proof changed --depth 2` walks the reverse import graph outward from the diff, then
cross-references every file it reaches against the checks that name it.

The heading is **"Checks naming these files"**, not "coverage", and the distinction is
deliberate: matching a check's text against a filename is a heuristic, and `proof` has not
measured whether that check exercises that code. Matching is by whole token, so
`sessionStorage polyfill tests` does not count as naming `session.ts` — over-claiming here
would hide a gap, which is the direction that costs something.

A contract that does not validate withholds only the coverage section. The changed files,
their dependents and the dependency changes do not depend on the contract, and a typo in one
check should not withhold the blast radius you ran the command for:

```
Checks naming these files:
  the contract is invalid, so coverage was not computed — check[0] "ok": unknown key
  "expect_stat" — did you mean "expect_exit"?
```

A file whose name is a framework convention is identified by its directory instead:
`src/lib/session/index.ts` is `session`, `app/dashboard/page.tsx` is `dashboard`. And a check
requesting `/api/users` counts as naming the file that serves it, since every app-router file
is called `route.ts` and the filename says nothing about which route it is.

Test and fixture files are listed as `TEST` rather than `WARN` and left out of the count —
the file is the verification, and warning about it is the noise that teaches people to skip
this section. A check that does name one explicitly still reports `OK`.

Import aliases are read from `tsconfig.json` or `jsconfig.json` — `compilerOptions.baseUrl`
and `paths`, comments and trailing commas included — rather than assumed. Guessing that
`@/` means `src/` in a project where it means `app/` under-reports the radius, and an
under-reported radius says nothing else is affected, which is worse than saying nothing at
all. With no config present the `@/` convention is used as a fallback. A malformed config
degrades to that fallback rather than failing the command — but it says so, because
unresolved aliases mean dependents go missing and "none found" would otherwise read as
"nothing is affected":

```
Direct dependents:
  none found (import scan, depth 1)

NOTE
  tsconfig.json could not be parsed (…) — import aliases are unresolved, so dependents may be missing
```

`extends` is not followed.

Files `proof` cannot scan for imports — lockfiles, `tsconfig.json`, configs, assets — are
named rather than passed over. Both can change the whole build, and an empty radius would
otherwise read as "nothing is affected" when it means "this cannot be derived":

```
Direct dependents:
  not derivable — no changed file could be scanned for imports

Not import-scannable (dependents cannot be derived from these):
  package-lock.json
  tsconfig.json
```

A source file with genuinely no importers still reports `none found` — the two cases are
kept distinct, because only one of them is a result.

A **dependency bump** reports what imports it. Changing a version in `package.json` breaks
or changes behaviour in every file importing that package, and a diff touching only
`package.json` would otherwise show an empty radius:

```
Changed dependencies:
  lodash  ^4.17.20 → ^4.17.21

Direct dependents:
  src/list.ts
  src/merge.ts
```

Subpath imports (`lodash/fp`) count as the same package, scopes are handled
(`@scope/pkg/deep` → `@scope/pkg`), and added or removed dependencies are labelled as such.
All four dependency fields are compared, against the same `--base` ref as the file diff.

**Every** changed `package.json` is compared, not only the one at the root, and each change
carries the `manifest` it came from — `express 4 → 5` means something different in
`packages/api` than in `packages/web`, and a monorepo can change both at once. Workspace
packages are resolved from `workspaces` in `package.json` (array or object form) or from
`pnpm-workspace.yaml`, so importing `@acme/utils` links to `packages/utils`, not to
node_modules.

A **deleted** file still reports its importers. Resolution normally requires the target to
exist, which would make the highest-consequence change of all — removing a module every
other file depends on — come back as "none found". Importers of a path nothing occupies are
recorded by the path the import names, so a deletion shows its full radius. The same applies
to a mistyped import: the file containing it is attributed to the path it names.

## Finding what to verify

`proof infer` reads the diff and its blast radius and reports what could break that nothing
currently proves — each gap pointing at a `file:line`:

```
HIGH    GET /api/auth/callback is reachable          (app/api/auth/callback/route.ts:1)
HIGH    env GITHUB_CLIENT_SECRET is set at run time  (src/oauth.ts:3)
          ↳ not declared in .env.example
HIGH    database migrations apply cleanly            (prisma/migrations/001_init/migration.sql)
MEDIUM  no check references src/oauth.ts
```

Routes are read from route calls (`app.get`, `router.post`) and from framework file paths
(`app/api/x/route.ts`, `pages/api/x.ts`). An app-router file declares its methods by the
handlers it exports, so a route exporting only `POST` is not offered as a `GET` check. A
router mounted in the same file carries its prefix; one mounted elsewhere is reported at its
bare path and says so, rather than being guessed at.

A contract that does not validate does not withhold the gaps — they come from the code, not
from the contract. What it costs is knowing which are already covered, and the run says so.
`--write` is refused in that state: appending to a file proof cannot read would add duplicates
of checks it could not see.

Tests and fixtures are skipped, and the count says how many. Scanning proof's own repository
reported 60 gaps before this, 58 of them fixtures written to exercise these very detectors —
a list that long is one nobody reads.

`proof infer --write` appends the generated checks, preserving your comments and ordering.
It is idempotent — a gap already covered by an existing check is not reported again. Each
generated check keeps its caveat as a comment in the contract, so the reason survives past
the terminal it was printed in:

```yaml
  # dynamic segment — replace with a real value
  - name: get /api/orders/[id]
    http:
      method: GET
      path: /api/orders/[id]
```

`proof init --force` keeps whatever it replaces at `.proof/spec.yaml.bak` and says so. A
contract is written by hand over time; `--force` is explicit, but discarding weeks of it
with nothing kept is a worse trade than one file.

The whole read-modify-write is serialised through `.proof/spec.lock`, and the file is
replaced atomically. Two `infer --write` runs at once would otherwise both read the original
and both append, leaving every generated check duplicated — a contract you then have to
repair by hand. A lock left behind by a killed run is broken automatically.

"Already covered" is decided by reading the fields of your existing checks, not by searching
the contract as text. A check hitting `/api/users` does not cover `/api/user`, and one that
merely mentions `STRIPE_KEY_ID` does not cover `STRIPE_KEY`. Method counts too: a `GET`
check does not prove a `POST` endpoint. A `browser` step asserting `expect_request` on a
route covers that route as surely as an `http` check would.

Because generated `http` checks use relative paths, `infer` tells you when the contract
still needs a `serve` block for them to resolve against.

It also reports how many files it could actually scan. A diff of only lockfiles or configs
yields no code to examine, and "no gaps found" would be a clean bill of health for a scan
that never ran:

```
Detected change:
  1 file(s) in scope (diff), 0 scannable for gaps

Nothing was scanned — no code file is in scope, so gaps cannot be derived from this change.
```

Detection is deterministic, not a model call: framework file routes (Next app router,
`pages/api`), Express/Fastify/Hono handlers, `process.env` reads checked against your
`.env.example`, migration directories mapped to the migrator in your `package.json`.
`proof` does not guess at semantics it cannot observe.

Precision matters more than recall here, because a wrong suggestion costs an agent a whole
iteration. So: only string literals beginning with `/` count as routes, which keeps
Express's `app.get('port')` settings getter and client calls like `api.get('users')` out of
the list. Paths carrying `:id`, `[id]` or an unresolved `${id}` are reported as gaps but
flagged dynamic, since the URL cannot be requested as written. Platform-injected variables
(`NODE_ENV`, `PORT`, `CI`, `npm_*`, `VERCEL_*`, …) are skipped so they do not bury the one
deployment secret that actually goes missing.

## Design

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

The baseline is also the previous run *of the same contract*. Every contract's runs share one
`.proof/runs` directory, so without that restriction "passed in run 0001" could be a claim
about a different contract that happens to name a check the same way. With no comparable run,
proof says nothing rather than something wrong.

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

## Non-goals

Not a coding agent, not an IDE, not a replacement for unit tests or Playwright, not a CI
platform, not an MCP server. `proof` sits one layer above your existing tools and asks one
narrower question: does the implemented change actually satisfy the requirement?

## Development

```bash
npm test
```

MIT.
