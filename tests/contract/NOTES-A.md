# Contract tests, round A (happy paths)

Written blind. Sources: `src/**/*.d.ts`, `docs/project-brief.md`, `docs/architecture.md`. No implementation read,
nothing executed. The only check is `tsc -p .` against the declarations.

## Spec gaps

Each entry is something I wanted to check and did not assert, because the spec is silent or says two things.

### transitions

- **T1. Order of `legalNext`.** The doc comment says "in the order the state machine declares them". No document
  shows that order (the architecture table may mirror it, but nothing says so). Wanted: `legalNext('proposed')`
  equals `['queued', 'declined']`. The tests compare as sets.
- **T2. "final" is not "terminal".** Both docs say "`merged` and `done` are final", yet the table gives `merged` the
  edge `merged -> done`, and the `legalNext` comment calls only `done` terminal. Wanted: is `merged` final for the
  slot-leak rule (see A3)? The `findLeakedSlots` test treats `merged` as final.

### allocate

`allocate.d.ts` has no doc comment on any export. What is known comes from `architecture.md` ("Slots"), `config.d.ts`
(`SLOT_COUNT`) and `reconcile.d.ts` (`ReconcileOptions.slotCount`).

- **A1. `holdsSlot`.** Wanted: `holdsSlot(s)` is true exactly for the members of `HOLDING_STATES`. The docs say "A job
  holds a slot only in `claiming` and `running`. `HOLDING_STATES` ... is the source of truth", but never say
  `holdsSlot` is built from it. The test assumes it from the name and that sentence.
- **A2. `assertSlotCount`.** The range "1..16" appears only in `reconcile.d.ts` ("rejects anything outside 1..16",
  "an integer in 1..16") and `config.d.ts`. Not stated: error class and message, and whether a non-integer in range
  such as 2.5 is rejected. The test only checks that 1, 3 and 16 pass.
- **A3. `findLeakedSlots`.** The doc is one sentence: "reports slots held by a job that is final or failed".
  Not stated:
  - `cancelled`: the brief says a slot is released "on `failed`, `cancelled`, or final", the architecture says leaked
    means "final or failed". Is a slot held by a `cancelled` job reported?
  - Holders in states that never hold a slot and are not final or failed: `proposed`, `declined`, `queued`,
    `pr_open`, `in_review`, `changes_requested`.
  - `jobState: null` (the type allows it; the meaning is not given, presumably a slot row with no job).
  - Order of the result, and a slot number listed twice.
- **A4. Order of `freeSlots`.** "lists what is free", no order. The tests sort.
- **A5. Odd input to `allocateSlot` and `freeSlots`.** Numbers in `taken` outside `0..slotCount-1`, duplicates, and
  whether an invalid `slotCount` is checked with `assertSlotCount` first. Not stated.

### intake-policy

- **P1. The burst rule is stated two ways.** `IntakeInput.maxEnqueuePerPoll`: "Above this many new In Progress items,
  every one of them becomes a proposal." `Config.MAX_ENQUEUE_PER_POLL`: "Most new `In Progress` tickets one poll may
  queue; the rest become proposals." With a cap of 2 and 3 new items, is the result 0 queued and 3 proposed, or 2
  queued and 1 proposed? "new" is also undefined (not in `knownSourceIds`? after the baseline rule?). Needs a ruling
  before the edge-case round.
- **P2. `reason` tags** are "free to change", so no test reads them.
- **P3. Status matching.** Whether `Todo`, `Backlog` and `In Progress` match case-insensitively or after trimming is
  not stated. The tests use the exact names from the brief. What "unknown status" covers beyond those three is not
  stated either.

### intake

- **I1. Where the source name comes from.** `IntakeDeps` has no `source`, yet `knownSourceIds(db, source)` and
  `countJobsForSource(db, source)` need one. Not stated whether it is read from the items, hard-coded, or something
  else, nor what happens on an empty feed. The fake store keys on `'linear'` and every item uses it.
- **I2. Log lines.** Only a count is documented: "one info line per decision and per skip, plus a finished line with
  the counts". Messages, field names and any other line are not. The tests assert that count only; if the
  implementation also logs, say, a start line at info, the doc comment is imprecise.
- **I3. Order of side effects.** Whether inserts follow feed order, and whether `enqueue` runs right after its own
  insert or after all inserts, is not stated. The tests do not depend on it.
- **I4. `nextPollDelayMs`.** Not stated: how `rand` maps onto the jitter (is 0.5 zero jitter?), whether jitter comes
  before or after the doubling, whether the ten-minute cap applies before or after the jitter (can the result pass
  ten minutes?), and what a negative `failures` or an `intervalMs` of 0 does. The tests check only that the result
  lies within 10% of `interval * 2^failures` (plus 1 ms for rounding), for 0 to 3 failures.
- **I5. Reads in a dry run.** "logs every decision" implies the store reads still run. Not stated. The tests check
  only that no insert and no enqueue happen.
- **I6. The `Db` handle.** `db.d.ts` says "No test fakes this handle". The tests pass a marker object cast to `Db` and
  assume `runIntakePoll` only passes it on, as `IntakeDeps.db` says ("passed unchanged to every store call").

### linear-map

- **L1. The node shape is documented nowhere.** The declarations name `branchName`, `endCursor` and `hasNextPage`;
  the task names `identifier` and `id`. For the rest I used Linear's public GraphQL names: `title`, `description`,
  `url`, `state { name }`, `labels { nodes { name } }`, and the page envelope `data.issues { nodes, pageInfo }`. If
  the adapter assumes another shape ("the assumed GraphQL shape" in `LinearMapError`'s comment, which is never
  spelled out), every test in `linear-map.test.ts` fails with `LinearMapError`. That is a spec gap, not a bug on
  either side. The brief's "Do not assume field names; log first, then map" suggests the shape was probed, but the
  result is not in any document I may read.
- **L2. Order of `items`.** Nothing says `items` follow the order of `nodes`. The tests sort.
- **L3. `source`.** "Name written into `WorkItem.source`" is stated for `LinearClientOptions.source` only. For
  `mapIssueToWorkItem` and `parseIssuesPage` it is inferred from the parameter name.
- **L4. What counts as a bad node.** `LinearMapError` is "raised when a Linear payload does not match the assumed
  GraphQL shape". Which payloads those are, and whether `parseIssuesPage` throws or skips a bad node, is not stated.
  `LinearClientOptions.logger` mentions a "skipped malformed node" at warn, so something skips; which function is
  not stated.
- **L5. `hasNextPage: true` with `endCursor: null`.** Not stated.

## Assertions that rest on a reading, not on a sentence

If one of these fails, suspect the spec before the code.

- `holdsSlot` true for `claiming` and `running`, false for the other ten states (A1).
- `assertSlotCount` accepts 1, 3 and 16 (A2).
- `findLeakedSlots` reports `done`, `merged` and `failed`, and does not report `claiming` or `running` (A3, T2).
- `legalNext` and `canTransition` agree on every pair of states. Implied by the two doc comments, never stated.
- `allocateSlot` and `freeSlots` do not touch the `taken` set. Rests on "Both are pure".
- `mapIssueToWorkItem` and `parseIssuesPage` write their `source` argument into `WorkItem.source` (L3).
- `runIntakePoll` logs exactly decisions + skips + 1 info lines (I2).
- Every field name in the Linear node fixture except `id`, `identifier` and `branchName` (L1).

## Left for the edge-case round

Documented, deliberately not tested here.

- transitions: illegal edges, self-transitions, `assertTransition` throwing `IllegalTransitionError` with both state
  names in the message, `legalNext('done')` empty, the full table including `failed` and `cancelled` retries.
- allocate: `allocateSlot` returns `null` when full, `assertSlotCount` rejecting values outside 1..16.
- intake-policy: baseline, burst above `maxEnqueuePerPoll` (needs P1), proposal cap, `already has a job` skip,
  `unknown status` skip.
- intake: an insert that loses the race (`created: false` counts as skipped and is not enqueued), skipped items
  logged, empty feed, several `queued` items enqueued.
- linear-map: null or empty `description` gives `''`, missing or empty `branchName` leaves `branch` unset, no labels,
  `LinearMapError` cases, empty page.
