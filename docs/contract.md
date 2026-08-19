# The contract

[← back to README](../README.md)

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

When a `serve` block is present, `proof` adds checks you do not have to write — one set per
process it starts:

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

### More than one process

A real application is rarely one process. Write `serve` as a list and each entry starts in the
order written, every one ready before the next begins — the order in the contract is the
dependency order:

```yaml
goal: Orders placed through the API are persisted
serve:
  - name: db
    run: docker compose up postgres
    ready_log: "database system is ready to accept connections"
  - name: api
    run: npm run dev
    ready_url: http://localhost:3000
checks:
  - name: an order persists
    http: {method: POST, path: /orders, body: {sku: ABC}, expect: {status: 201}}
```

Each process gets its own `app boots (<name>)`, `app still running (<name>)` and — where it
asked for one — `app logs clean (<name>)`, and its own `serve-<name>.log` in the evidence
bundle. One log holding two processes' output is a log that explains neither.

`name` is required once there are two or more, because it is how the run says which one booted,
which one died and whose log matched. Two processes cannot share one: `app boots (api)` twice
collapses into a single entry in `result.checks`, where a failure reads as a pass. A single
process keeps the unsuffixed names and `serve.log`, so every contract written before this and
every run already recorded is unchanged.

A process that fails to boot **stops the ones after it**. The API cannot come up without its
database, so every later failure would be about the first one, and a list of failures whose
causes are all the same failure is one nobody can read.

Teardown runs in reverse — the app before the database it talks to. Killing a dependency first
makes every dependent log a connection error on the way down, and those lines land in the same
window `log_must_not_match` reads: a gate would then fail over a teardown `proof` caused.

Relative `path` and `visit` values resolve against the **last** entry that declares a URL,
since the list runs from what the app needs to the app itself. Where more than one declares
one, the run says which was chosen rather than leave it implicit:

```
OBSERVED BUT NOT GATED
  2 serve blocks declare a URL, so relative `path` and `visit` values resolve against the last
  of them (http://localhost:3000). Point a check at another with an absolute `url`, or a
  `browser.base_url`.
```

### Apps with no HTTP surface

A worker, a queue consumer, a daemon or a database has no URL to answer, so polling one
cannot say when it is up. Use `ready_log` — a regex its own output must match — in place of
`ready_url`:

```yaml
goal: Orders enqueued by the API are drained by the worker
serve:
  run: python3 -m myapp.worker
  ready_log: "consuming from queue"
  timeout: 30
checks:
  - name: the worker drains the queue
    run: ./scripts/enqueue-one.sh && ./scripts/assert-drained.sh
```

What proof observed is the matched **line**, not the word "matched" — that line is usually
where the app states its port, its mode or its worker count:

```
CHECKS
  app boots    PASS
```
```
$ proof report
app boots — consuming from queue (prefetch=16)
```

Two things are weaker without a URL, and both are said out loud rather than assumed:

- **Liveness** becomes "the process proof started is still there", not "it still answers".
  That is the strongest thing observable with nothing to ask, and `run:` is often a shell
  wrapper that outlives the app underneath it — so the check is reported under its own
  assertion, never folded in with the responding one.
- **A launcher that exits** (`./up.sh &`, `docker compose up -d`) leaves proof no URL to ask
  *and* no process it holds, so nothing can be observed at the end of the run at all. The
  liveness check is then omitted, and the run says why rather than leave a gap in the list:

```
OBSERVED BUT NOT GATED
  readiness came from the log and the launcher then exited, so nothing checks whether the app
  is still running at the end — there is no `ready_url` to ask and no process proof still
  holds. Add a `ready_url`, or run the app in the foreground.
```

Give **both** and the log gates readiness while the URL stays the base for relative `http`
and `browser` paths. That is the case where an app binds its port before it has finished the
work that makes it usable: polling the port would call that ready, and the log line is what
says the work is done.

An empty `ready_log` is refused. It matches the empty log the app has not written to yet, so
every check would run against an app that is not up — the same class of mistake as an empty
`contains`. A pattern that cannot compile is refused at load, before anything boots.

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

A contract with `ready_log` and no `ready_url` has no base either, so relative paths are
refused there the same way — a log line saying the app is up is not an address.

`proof init` scaffolds the `serve` block for you, filled in with whichever of `dev`,
`start` or `serve` your `package.json` declares. It is written **commented out**: the
command is read from your project, but the port is not something `proof` can know, and a
wrong `ready_url` is worse than an absent one. Uncomment it, confirm the port, and http and
browser checks work.

This is not pedantry. With a `localhost:3000` fallback, a contract that never starts an app
will happily test whatever unrelated project you already had running, follow its redirects,
get a 200, and report DONE. The requirement is then "verified" against software that has
nothing to do with it.
