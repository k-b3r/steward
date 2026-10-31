# Contract tests B: notes

Files: `jobs-commands.test.ts`, `jobs-queries.test.ts`, `api-app.test.ts`.
Written blind, from `src/**/*.d.ts`, `docs/project-brief.md` and `docs/architecture.md`. Happy paths only.
Checked with `tsc -p .` only. The tests were never run.

## Spec gaps

Each entry says what I wanted to check and why the spec is silent. The tests do not assert any of it.

### jobs-commands

- **G1. Does a `failed` job offer `cancel`?** The brief says `failed → queued | cancelled` and "Actions: retry, cancel".
  The architecture table says the same. `ApiCommands.cancel` says "allowed from `queued` up to `changes_requested`",
  which leaves `failed` out. The tests only assert that `allowedActionsFor('failed')` contains `retry` and nothing
  outside `retry` and `cancel`. The test "lists only actions whose command accepts a `<state>` job" fails if the list
  and the command disagree, whichever way the spec is meant.
- **G2. What a command throws for a job in the wrong state.** `jobs-commands.d.ts` declares `JobNotFoundError`,
  `ActionNotFoundError` and `ActionNotPendingError`, but no error for "state not allowed". `ApiCommands.confirm` says
  "any other state is refused with 409". It is not stated which error class carries that. It is also not stated whether
  the command refuses before it calls the store ("Which move a person may ask for is decided in this file") or lets the
  store's edge check refuse. I could not write the 409 tests (edge round) without it.
- **G3. Who trims and validates the decline reason.** `ApiCommands.decline` says "stores the trimmed reason on the job
  event". `declineJob` says only "parked with the reason". The tests use a reason with no surrounding blanks. Whether a
  blank reason is refused is also open (the brief: "Decline needs a reason").
- **G4. What else the commands hand to `transitionJob`.** For confirm, reconsider, retry and cancel, nothing says
  whether `reason`, `failureKind` or `nextRunAt` are passed (for example whether retry clears `nextRunAt`). The store
  doc says it "derives `attempt`, `failureKind`, `nextRunAt` and the slot". The tests assert only `to` and `now`
  (plus `reason` for decline).
- **G5. Which commands must not enqueue.** `CommandDeps.enqueue` says "`confirm` and `retry` call it after the row is
  `queued`". Nothing says that reconsider, cancel and decline must not. Only "nothing is queued" for decline is asserted.
- **G6. Does `cancelJob` always call `cancelRun`?** "Stops the run first" and "Stops a run that may still be working".
  It is unclear for `queued` or `pr_open`. The tests assert it only for a `running` job.
- **G7. What a command returns.** `Promise<Job>` is declared. "each returning the row it changed" is on `ApiCommands`,
  not on the functions. It is not stated whether the command returns the row `transitionJob` returned or re-reads it.
  The fake store keeps `getJob` and `transitionJob` consistent, so both designs pass. Same for `decideAction`.
- **G8. Contradiction: does a retry increment or reset `attempt`?** The brief says "retry reuses the row, increments
  `attempt`" and the architecture says "A retry keeps the job row and increments `attempt`". `Job.attempt`,
  `JobSummary.attempt`, `retryJob` ("the attempt counter resets in the store") and `ApiCommands.retry` ("attempt reset
  to 0") say it resets to 0. The commands never pass `attempt`, so no test here can see it. An integration test needs
  the truth.
- **G9. `decideAction` with no reason.** The store may get `reason: undefined`, an empty string or a default. Not stated.
  Not asserted. The order of the checks (found, then pending) and the error for a non-pending row are for the edge round.

### jobs-queries

- **Q1. Default `limit` of `listActions`.** `QueryDeps` says "The 100 default and the 1..500 bound are module constants
  here". `ApiReads.listActions` says only "same 1..500 limit", and only `ApiReads.listJobs` says "defaults to 100".
  The default is asserted for `listJobs` only.
- **Q2. The filter handed to the store.** It is not stated what the store gets when the caller passes nothing (is
  `limit: 100` always present? is `state` a key with value `undefined`?). Only `limit` is documented as "passed
  straight through". That `state` and `status` pass under the same names is implied by `QueryStore`'s types, not
  written. The tests read `.limit`, `.state` and `.status` only.
- **Q3. Out-of-range `limit`** (0, 501, negative, fractional): "checked in this file", but whether it throws, clamps or
  falls back, and with which error class, is not stated. For the edge round.
- **Q4. ISO precision.** "ISO strings" and `z.ZodISODateTime` are all there is. The tests accept any `…Z` UTC date-time
  that parses to the same instant. The spec does not say `toISOString()` is the format.
- **Q5. Ordering.** "Both list methods return newest first" is on the port. Nothing says the functions must keep the
  store's order. `Job` has no timestamp, so they cannot re-sort. The tests assert that the order is kept.

### api/app

- **A1. Success status codes.** No route states 200, 201 or 202; the types say `ContentfulStatusCode`. The tests
  assert `res.ok` only.
- **A2. How the job command routes build the body.** From the `Job` the command returned, or by re-reading through
  `reads.getJob`? Not stated, and there is no exported `Job` to summary mapper. The fakes share one in-memory store,
  so both designs pass.
- **A3. Where the log stream starts when the client sends no resume point.** No `Last-Event-ID` and no `?after=`:
  `seq` is 1-based and `readLog` returns `seq > afterSeq`, but "tail" could mean "only new lines". Every stream test
  sends a resume point (the content-type test sends none and asserts only headers).
- **A4. Precedence** when both `Last-Event-ID` and `?after=` arrive. Not tested.
- **A5. When the stream ends.** Nothing says whether the server ever closes it (job final, idle timeout) or only on
  client abort. The tests cancel the body reader. The `sleep` stub then never settles, so a loop that ignores the abort
  cannot spin.
- **A6. Other SSE fields.** The `Envelope` doc fixes only the `id` (= `seq`) and the `data` (= the envelope). An
  `event:` name, a `retry:` value or keep-alive comments are not stated. The tests ignore them.
- **A7. The poll interval.** `createApp` takes only `sleep(ms)`; where `ms` comes from (a constant? `LOG_POLL_MS`
  passed in?) and whether `sleep` runs before or after the first `readLog` are not stated. Not asserted.
- **A8. `GET /v1/actions` without `status`.** All actions, or only pending? The type makes it optional. The brief shows
  only `?status=pending`. Not tested.
- **A9. Approve with a body.** The route type has no JSON input for approve, but `ApiCommands.decideAction` takes an
  optional `reason`. Not tested.
- **A10. Reject with no body at all.** `rejectBodySchema` makes `reason` optional. Whether an absent body (not `{}`) is
  accepted is not stated. The test sends `{}`.
- **A11. How a test must present the Host.** The guard needs `127.0.0.1:<port>` or `localhost:<port>`. It is not stated
  whether it reads the `Host` header or the URL authority. As I recall Hono (not read here), `app.request('/v1/jobs')`
  with a relative path builds `http://localhost/...` with no port, so a bare relative call may fail the guard. The
  tests use an absolute URL and a `Host` header with the same value.
- **A12. Error body shape.** `errorResponseSchema` is `{ error: string }`. Only the 404 of `GET /v1/jobs/:id` is typed
  with it. Which other statuses (400, 401, 403, 409) use it is not stated.

## Inferences the tests rely on

These are not gaps, but they come from combining sentences rather than from one direct statement. If a test fails,
check these first.

- **allowedActionsFor lists** come from `ApiCommands`: confirm and decline from "`proposed` to ...", reconsider from
  "`declined` back to `proposed`", retry from "`failed` or `cancelled` to `queued`", cancel from "allowed from `queued`
  up to `changes_requested`" (read as `queued, claiming, running, pr_open, in_review, changes_requested`, the order of
  the brief's state list). `merged` and `done` offer nothing: "`merged` and `done` are final" and neither is in the
  cancel range. `allowedActionsFor`'s own doc says only "The intents available in a given state".
- **Target states of the commands** are from `ApiCommands` ("`proposed` to `queued`", "`declined` back to `proposed`",
  "then moves the job to `cancelled`") and from the single edge each one has in the architecture table.
- **The fake store re-checks every edge with `assertTransition`.** That follows "checks the state machine edge
  again". It makes the "listed actions are accepted" test catch a command that aims at an illegal edge.
- **`Envelope` doc as the SSE contract.** "streams as the `data` of one SSE frame" and "Also the SSE `id`, so
  `Last-Event-ID` (or the dashboard's `?after=`) resumes after it".
- **The content type `text/event-stream`** comes from the brief's "SSE tail", not from a sentence about headers.
- **GET routes are pass-through.** `ApiReads` is "already shaped for the wire", so the body equals what `reads` returns.
- **`limit=2` in the query reaches `reads.listJobs` as the number 2.** The query type is a string and the read type is
  a number.
- **No Origin header means allowed.** `Config.ALLOWED_ORIGINS`: "empty or absent lets in only requests with no Origin".

## Left for the edge-case round

404s (unknown job, action, log), 409s (wrong state, action already decided), 400s (bad body, bad query, `limit` out of
range), 401 (no or wrong token), 403 (bad Host or Origin), `JobNotFoundError`, `ActionNotFoundError`,
`ActionNotPendingError`, and `getJob` returning null.
