# Dispatch regression scenarios

These failure modes were recorded before the HTTP tests were written. Each test
starts the production server with a separate temporary SQLite database, builds
its state through public HTTP routes, and leaves the running deployment alone.

- An available truck above the 20% safety threshold but below flight demand has
  no way to be sent for replenishment.
- Sending a truck for replenishment silently fills it immediately, or lets the
  scheduler allocate it before completion is confirmed.
- Completion can be submitted without a replenishment assignment, submitted
  twice, or performed by a driver rather than a dispatcher.
- Replenishment accepts a truck with an active flight task or a maintenance
  truck, or completion fails to restore its full fuel and schematic position.
- A candidate list includes insufficient fuel, a maintenance truck, a truck or
  driver committed to another active task, resting staff, or disabled staff.
- Candidate ordering ignores the journey from the person to the truck or from
  the truck to the flight; pending assignment teleports the truck to its target.
- Changing trucks leaves the original truck reserved, leaves a duplicate
  personnel binding, drops a pending task, or does not lock and reestimate it.
- Temporarily calling standby staff changes the binding but fails to transfer
  the task, or replacing a driver does not release the previous person.
- After replacement, the new driver's workspace misses the task, the previous
  driver still sees or updates it, or changing trucks leaves the driver's
  workspace showing the previous vehicle.
- A previously valid candidate is no longer free at submission time but is
  still assigned, or a rejected assignment leaves a partial personnel change.
- Two simultaneous assignments claim the same standby person and unbound truck;
  both succeed, return a server error, or lose the original pending task.
- A normal reassignment steals an in-progress task, and existing work can be
  replenished or reassigned without the required handover.

## Website review regressions

The review's real HTTP and browser experiments exposed these additional gaps.
`test_workflow_regressions.py` covers them through the same production entry:

- Zero, short, or excessive fuel can silently close a flight; duplicate completion
  deducts fuel twice.
- A partial report loses the amount delivered or the remaining demand, releases
  the truck before dispatcher review, automatically dispatches before review,
  changes the historical task demand, or plans the full demand a second time.
- Delayed/arrived events reopen held or completed flights; cancellation/departure
  bypasses the outstanding partial-report handover; null reasons are converted
  to apparently valid text instead of requiring an actual explanation.
- Cancelling a task or flight leaves an orphan reservation; cancellation is undone
  by optimization; repeated flight events mutate resources a second time.
- An exception task reopens after replacement and creates two active tasks for
  the same flight, or puts a maintenance truck back into executable work.
- Import preview writes data, bulk updates bypass the active-task guard, or
  malformed dates are accepted instead of reporting the failed row.
- An arrival estimate after departure lacks a time warning, while a constant
  on-time percentage continues to look like a measured metric.
- Acknowledging an unresolved shortage removes it or creates a new risk ID on
  the next optimization; actual resource assignment fails to resolve that risk.
- A partial-review risk closes on acknowledgement, or remains after dispatcher
  follow-up; a time warning remains after a new departure makes the plan feasible.
- Personnel create/edit/list responses include stored credential fields.
- First-login accounts bypass the password-change gate, changing to the same
  initial password clears it, or a successful change leaves old sessions valid.
- Logout leaves its server session valid, revokes another session, or cannot be
  repeated; reset/disable loses its existing revocation and ownership guards.
- A successful HTTP response reaches the client before its write commits, so a
  just-revoked session remains usable; a failed commit still returns success.

`test_transaction_http.py` adds two real HTTP transaction-boundary scenarios.
Its test-only launcher holds SQLite's context-manager commit behind a file
barrier, or causes a native commit failure with a deferred foreign-key constraint
on temporary tables. The production app has no test endpoint or fault switch.
The failure case checks both HTTP 500 and the unchanged persisted flight.

The small-flight fuel-threshold scenario uses a future departure so an expired
timestamp cannot accidentally make that test pass for the wrong reason.

Run from the repository root:

```sh
python3 -m unittest discover -s backend/tests -v
```

`DISPATCH_TEST_OUTPUT_DIR` optionally chooses the run-artifact directory. The
default is a new temporary directory retained after the run. The normalized
`result-manifest.json` contains semantic evidence, without tokens, generated IDs,
passwords, or timestamps. The replenishment lifecycle checks dispatcher start, owner-driver completion,
unchanged fuel before confirmation, and rejection of another driver or dispatcher.
Candidate tests use a separately stocked truck fixture.
