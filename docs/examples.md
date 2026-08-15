# Worked examples

[← back to README](../README.md)

Most verification examples in the wild are web UI flows. These are the other shapes —
each one is a complete contract you can adapt, and each walks through *why* the checks are
the ones that catch an agent's false "done".

- [A CLI tool (no server at all)](#a-cli-tool-no-server-at-all)
- [A Go API service](#a-go-api-service)
- [A Python data pipeline](#a-python-data-pipeline)
- [Database migrations](#database-migrations)
- [A security fix — verifying removals](#a-security-fix--verifying-removals)
- [A browser flow with a session](#a-browser-flow-with-a-session)
- [Guarding an agent through any of these](#guarding-an-agent-through-any-of-these)

## A CLI tool (no server at all)

Requirement: *"the export command writes a complete CSV, and handles a missing input file
gracefully."*

An agent's version of done here is usually "the command runs". The contract pins down what
the command must *produce*, and — the part agents skip — what a failure must look like:

```yaml
goal: the export command writes a complete CSV and fails cleanly on bad input
checks:
  - name: builds
    run: cargo build --release

  - name: export writes the file
    run: ./target/release/tool export --input fixtures/orders.json --out /tmp/orders.csv
    expect_output: "exported 3 rows"

  - name: the CSV is complete
    file:
      path: /tmp/orders.csv
      contains: "id,name,total"
      not_contains: "undefined"

  - name: a missing input is an error, not a success
    run: "! ./target/release/tool export --input does-not-exist.json --out /tmp/x.csv"

  - name: and the error is actionable
    run: ./target/release/tool export --input does-not-exist.json --out /tmp/x.csv 2>&1 || true
    expect_output: "does-not-exist.json"
```

Why these checks:

- `expect_output: "exported 3 rows"` — exit 0 alone passes for a command that silently did
  nothing. The output claim pins the work to the fixture.
- `not_contains: "undefined"` — the classic serialization bug survives an exit-code check.
- The `!`-prefixed check asserts the *failure* path: a tool that exits 0 on a missing input
  is a bug an agent will not notice, because nothing it ran exercised it.
- The last check re-runs the failure just to assert the error message names the file — an
  error a user can act on is part of the requirement.

## A Go API service

Requirement: *"orders can be created and fetched; the service refuses to start without its
database URL."*

```yaml
goal: orders can be created and fetched, and configuration is validated at startup
serve:
  run: go run ./cmd/server
  ready_url: http://localhost:8080/healthz
  timeout: 30
  log_must_not_match: "panic|data race"
checks:
  - name: unit tests
    run: go test ./...

  - name: config is present
    env: {name: DATABASE_URL, matches: "^postgres://"}

  - name: create an order
    http:
      method: POST
      path: /api/orders
      body: {sku: "A-100", qty: 2}
      expect:
        status: 201
        json: {id: "<number>", sku: "A-100", qty: 2}

  - name: fetch it back by listing
    http:
      path: /api/orders
      expect: {status: 200, body_contains: "A-100"}

  - name: an unknown route is 404, not a stack trace
    http:
      path: /api/nope
      expect: {status: 404, body_not_contains: "goroutine"}
```

Why these checks:

- `ready_url` points at `/healthz`, so "app boots" is a real readiness probe, and
  `log_must_not_match` turns a panic or race warning during the run into a failure even
  when every request happened to succeed.
- `json: {id: "<number>", ...}` asserts shape without pinning a generated value.
- The 404 check is the regression agents cause most: rewiring a router and leaking a
  panic page. `body_not_contains: "goroutine"` fails while the stack trace leaks — and the
  create/fetch pair above keeps the check from passing vacuously (see
  [docs/contract.md](contract.md) on the content advisory).
- `proof infer` reads Go: `http.HandleFunc("POST /api/orders", ...)` and
  `os.Getenv("DATABASE_URL")` show up as suggested checks before you write any of this by
  hand.

## A Python data pipeline

Requirement: *"the nightly aggregation produces a parquet summary and never drops rows
silently."*

No server, no browser — the whole contract is artifacts and invariants:

```yaml
goal: the aggregation produces a complete summary and preserves row counts
checks:
  - name: unit tests
    run: pytest -q

  - name: pipeline runs on the fixture
    run: python -m pipeline.aggregate --input fixtures/events.ndjson --out /tmp/summary.parquet
    expect_exit: 0
    expect_output: "rows in: 10000"

  - name: nothing was dropped
    run: python -m pipeline.aggregate --input fixtures/events.ndjson --out /tmp/summary.parquet
    expect_output: "rows out: 10000"

  - name: the summary is readable and has the expected columns
    run: python -c "import pandas as p; d=p.read_parquet('/tmp/summary.parquet'); print(sorted(d.columns))"
    expect_output: "['day', 'revenue', 'user_id']"

  - name: corrupt input still completes
    run: python -m pipeline.aggregate --input fixtures/corrupt.ndjson --out /tmp/x.parquet

  - name: bad records go to the dead-letter file, not the void
    file: {path: /tmp/x.rejects.ndjson, contains: "parse_error"}
```

Why these checks:

- "rows in" / "rows out" as two assertions: the silent-drop bug — a filter that eats
  records — passes any test that only checks the output exists.
- The columns check reads the artifact back with the same library consumers use, so a
  schema drift fails here instead of in the downstream job at 3am.
- The last two checks run in order — checks always do — so "the pipeline survived corrupt
  input" and "the rejects landed where the runbook says" are separate claims with separate
  failures. Proof refuses a check with two verbs; each check asserts one thing.

## Database migrations

Requirement: *"the new column ships with a migration that applies, reverses, and leaves the
app working."*

```yaml
goal: the discount column ships with a reversible migration the app can run against
serve:
  run: npm run dev
  ready_url: http://localhost:3000/healthz
  timeout: 60
checks:
  - name: migrations apply from scratch
    run: npx prisma migrate reset --force --skip-seed

  - name: the schema has the column
    run: psql "$DATABASE_URL" -c "\d orders"
    expect_output: "discount"

  - name: the migration is reversible
    run: npx prisma migrate diff --from-schema-datamodel prisma/schema.prisma --to-migrations prisma/migrations --exit-code

  - name: the app runs against the migrated schema
    http:
      method: POST
      path: /api/orders
      body: {sku: "A-100", qty: 1, discount: 0.1}
      expect: {status: 201, json: {discount: 0.1}}
```

Why these checks:

- `migrate reset` from scratch catches the migration that only works on the developer's
  already-mutated database — the most common way "works on my machine" enters a repo.
- The `psql` check asserts the schema *as the database reports it*, not as the ORM believes
  it to be.
- The final http check is the point of the whole exercise: schema and application verified
  **together**, because a green migration against an app that 500s on the new column is
  exactly the false "done" this tool exists for.

## A security fix — verifying removals

Requirement: *"the hardcoded API key is gone, error pages no longer leak internals, and the
old debug endpoint is dead."*

Removals are most of what you check a remediation on — and the easiest thing to fake, since
"the tests still pass" says nothing about what is *absent*:

```yaml
goal: the key is out of the source, errors do not leak internals, debug endpoints are gone
serve:
  run: npm run dev
  ready_url: http://localhost:3000
checks:
  - name: no hardcoded key in the config
    file: {path: src/config.js, not_contains: "sk-live"}

  - name: the key now comes from the environment
    env: {name: PAYMENT_API_KEY, matches: "^sk-"}

  - name: error pages keep internals to themselves
    http:
      path: /definitely-missing
      expect: {status: 404, body_not_contains: "/app/src"}

  - name: the debug endpoint is dead
    http:
      path: /__debug
      expect: {status: 404}
```

Why these checks:

- `file.not_contains` fails on a *missing* file rather than passing vacuously — renaming
  `config.js` cannot turn the check green (see [docs/contract.md](contract.md)).
- Every failure keeps the secret out of the evidence bundle: the needle is echoed (it is in
  the contract already), the matching line never is.
- Asserting absences does **not** silence proof's content advisory — proving a response
  does not leak a path is no evidence the rest of it is right, and the verdict says so.

## A browser flow with a session

One web example, because the session part is where agents' "done" and reality diverge —
kept here for contrast with the rest:

```yaml
goal: a user can log in and reach their dashboard
serve:
  run: npm run dev
  ready_url: http://localhost:3000
  timeout: 60
checks:
  - name: login flow
    browser:
      flow:
        - visit: /login
        - fill: {email: "user@example.com", password: "hunter2"}
        - click: "Sign in"
        - expect_request: {method: POST, path: /api/session, status: 200}
        - expect_text: "Dashboard"

  - name: the session actually carries
    http:
      path: /api/me
      expect: {status: 200, json: {email: "user@example.com"}}
```

Why these checks:

- `expect_request` asserts the form is *wired* — a submit button that does nothing renders
  the same success page in plenty of SPAs.
- Checks in one contract share a cookie jar per origin, so the `http` check after the
  browser flow proves the session is real, not a rendering artifact.
- On failure the evidence bundle carries a screenshot, the request log and the console
  errors — the difference between "browser test failed" and something an agent can fix.

## Guarding an agent through any of these

Every contract above works as a completion gate. Instead of running the agent and checking
afterwards:

```bash
proof guard --max-attempts 5 -- claude -p "implement the requirement in .proof/spec.yaml"
```

The agent runs; when it exits, the contract runs; failures are written to
`.proof/feedback.md` (and offered as `{feedback}` / `{feedback_file}` substitutions and
`PROOF_GUARD_*` environment variables) and the agent is relaunched with them — until the
contract passes or you override. Details: [docs/agents.md](agents.md).
