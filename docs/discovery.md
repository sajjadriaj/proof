# Blast radius and gap discovery

[← back to README](../README.md)

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

**Python** modules resolve the same way, from the repo root and from `src/` for the src-layout
convention. `from a.b import c` is read as both `a.b` and `a.b.c`, because whether `c` is a
submodule or a name defined inside `a.b` is not knowable without importing it — whichever file
exists is the one the edge points at, submodule first. A parenthesised import list counts every
name in it, relative imports (`from .`, `from ..pkg`) resolve against the importing file's
package, and a module that is not in the repo becomes a package edge rather than a fabricated
local path. A path configured only in `pyproject.toml` or `PYTHONPATH` is not read, so a module
it would have found is treated as an installed one. Dependency bumps are read from
`package.json` only: a version change in `pyproject.toml` shows the file as changed with no
dependents derived from it.

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

### Routes from an OpenAPI document

A per-framework regex only covers repositories using that framework, and it has to be written
again for Spring, ASP.NET, Rails, Laravel and Phoenix. A project that publishes an OpenAPI or
Swagger document has already declared its whole surface in a file `proof` can read, whatever
language serves it — so `openapi.yaml`, `openapi.json` and the `swagger` spellings are a route
source in their own right, at the repository root or under `api/`, `docs/`, `spec/` or
`openapi/`. YAML and JSON are both read.

The document also states example values, so a path with a parameter in it is generated as
something requestable rather than as a template you have to fill in:

```yaml
  /orders/{orderId}:
    parameters:
      - {name: orderId, in: path, schema: {type: string, example: "ord_42"}}
```

```
HIGH    GET /orders/ord_42 is reachable    (openapi.yaml:12)
```

`example`, `schema.example`, the first `enum` entry and `schema.default` all count, in that
order. Where the document states no value the path stays a template and is flagged dynamic,
as a code-derived route would be — `type: integer` does not mean `1` exists, and a generated
check that 404s costs an agent a whole iteration. `$ref` parameters are not followed.

A `basePath` (Swagger 2) or a relative `servers` URL is a prefix the document states about
itself, so it is applied silently. An absolute `servers` URL describes a *deployment*, which
is not necessarily the dev server `proof` starts, so its path is applied and reported:

```
HIGH    GET /v2/ping is reachable    (openapi.yaml:4)
          ↳ the prefix /v2 came from the document's `servers` URL, which describes a
            deployment — confirm the dev server serves it there
```

**When the document is read** is deliberately narrow. It is a route source when the diff
touched it — the declared surface changed — or when nothing else in scope could be scanned,
which is the case where every other detector reports nothing for an API that is fully
described on disk. Where `proof` can read the code, the code wins: pulling in every path of a
large document because one unrelated file moved is the kind of list people learn to skip.

A file named `openapi.yaml` that does not declare `openapi:` or `swagger:` is ignored. A
`paths` mapping alone is not distinctive — build configs have one — and routes read out of one
are a gap list nobody can act on.

A route both the code and the document declare is one gap, not two.

GraphQL is not read. Its surface is one endpoint, so the route is not the interesting part and
the operations would each need a request body generated for them — which is guessing at
semantics, not reading a declaration.

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
`pages/api`), Express/Fastify/Hono handlers, Flask/FastAPI decorators, Go `net/http` and
chi/gin/echo registrations (Go 1.22 `"POST /path"` patterns included), OpenAPI and Swagger
documents in any language, env reads
(`process.env`, `os.environ`, `os.getenv`, `os.Getenv`, `os.LookupEnv`) checked against your
`.env.example`, migration directories mapped to the migrator in your `package.json`.
`proof` does not guess at semantics it cannot observe. The import graph for the blast radius
reads JavaScript/TypeScript and Python; for anything else `changed` says the file was not
import-scannable rather than reporting an empty radius as an answer.

Precision matters more than recall here, because a wrong suggestion costs an agent a whole
iteration. So: only string literals beginning with `/` count as routes, which keeps
Express's `app.get('port')` settings getter and client calls like `api.get('users')` out of
the list. Paths carrying `:id`, `[id]`, `{id}`, Flask's `<id>` or an unresolved `${id}` are reported as gaps but
flagged dynamic, since the URL cannot be requested as written. Platform-injected variables
(`NODE_ENV`, `PORT`, `CI`, `npm_*`, `VERCEL_*`, …) are skipped so they do not bury the one
deployment secret that actually goes missing.
