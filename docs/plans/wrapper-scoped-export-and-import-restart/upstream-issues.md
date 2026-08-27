# Upstream Issue Drafts: `vignesh07/clawdbot-railway-template`

**Status: NOT FILED.** These two issue bodies are drafts. The operator files
them by hand against
<https://github.com/vignesh07/clawdbot-railway-template/issues> after
reviewing them (third-party public repo; nothing in this repo files them
autonomously). After filing, append the issue URL to the `Filed:` line of the
matching draft so the Dockerfile comment trail resolves.

Both drafts describe the pinned commit
`b9e2467189d02dfe51a80173c40bad650a58eaf2` (`deploy/openclaw-railway/template-lock.json`).
Sizes below were measured once, during planning for
[openclaw-control-plane#73](https://github.com/yuens1002/openclaw-control-plane/issues/73),
with a read-only `du -sh` on one deployed instance; they are representative,
not universal. No hosted identifiers belong in either body.

---

## Issue 1 — Add a scoped `/setup/export` variant (state subset, consistent SQLite snapshot, size cap)

Filed:

### Title

Add a scoped `/setup/export` variant (state subset, consistent SQLite snapshot, size cap)

### Body

## Summary

`GET /setup/export` tars all of `STATE_DIR` and `WORKSPACE_DIR` (relative to
`/data`) with `tar.c({ gzip, portable, noMtime })` and no `filter`. That is
the right shape for a one-off "download everything" button, but it makes the
endpoint unusable as the source for a scheduled backup: almost all of the
bytes are reinstallable artifacts, and the one file that matters most
(`state/openclaw.sqlite`) is copied hot out of a WAL-mode database.

## Measured

On one instance at the pinned commit `b9e2467189d02dfe51a80173c40bad650a58eaf2`
(read-only `du -sh`, Node 22.23, `node:22-bookworm` image):

| Path under `STATE_DIR` | Size |
| --- | --- |
| whole `STATE_DIR` | 541 MB |
| `bin/` | 415 MB |
| `agents/main/sessions/` | 64 MB |
| `lib/` | 32 MB |
| `agents/main/agent/{plugins,codex-home}` | ~22 MB |
| **state subset** (`openclaw.json`, `exec-approvals.json`, `credentials/`, `devices/`, `cron/`, `identity/`, `memory/`, `state/openclaw.sqlite` ~7 MB, `agents/*/agent/{*.sqlite,models.json,auth-profiles*}`) | **~7.2 MB** |

So a daily backup pulls ~541 MB to preserve ~7 MB, and the 7 MB it needs is
the part that is not guaranteed consistent.

## Consistency

`state/openclaw.sqlite` runs in WAL mode with a live `-wal`/`-shm` pair
(mtimes minutes old under normal operation). `tar.c` copies the main file
and the `-wal` file at different instants, so the archive can contain a
database whose WAL does not match its main file. The runtime image has no
`sqlite3` CLI, but `node:sqlite` (`DatabaseSync`, unflagged since Node 22.13,
and the wrapper already requires `node >= 22`) provides `VACUUM INTO`, which
writes a consistent single-file copy from a read-only connection.

## Proposed change (minimal shape)

Keep the existing route and auth; add a query parameter:

- `GET /setup/export` — unchanged, full export.
- `GET /setup/export?scope=state` — archive only the state subset above,
  with every `*.sqlite` replaced by a `VACUUM INTO` snapshot and
  `-wal`/`-shm`/`*.bak*`/symlinks skipped.
- Any other non-empty `scope` → `400`.
- Build the subset in a temp dir under `os.tmpdir()` first and refuse (500)
  once it exceeds a byte cap (suggest 200 MiB default, env-overridable) so
  a runaway state directory cannot stream unbounded bytes; remove the temp
  dir when the response closes.
- Keep archive paths as `.openclaw/...` relative to `/data`, so the output
  is a valid input for the existing `POST /setup/import`.

A reference implementation that does exactly this as a build-time patch on
the pinned commit:

- logic: <https://github.com/yuens1002/openclaw-control-plane/blob/main/scripts/wrapper-state-export.mjs>
  (`filterStateEntry`, `snapshotSqlite`, `buildStateExportTree`; only
  `node:*` built-ins)
- the delegate inserted at the top of the export handler:
  <https://github.com/yuens1002/openclaw-control-plane/blob/main/scripts/patch-wrapper-scoped-export.mjs>

Happy to turn that into a PR here if the query-parameter shape is acceptable.

## Environment

- Pinned commit: `b9e2467189d02dfe51a80173c40bad650a58eaf2`
- Deployed via a downstream Railway-template consumer (Dockerfile pulls this
  repo's `src/` at build time)

---

## Issue 2 — `/setup/import` stops the gateway with the same unconfirmed kill→sleep(750) race as `restartGateway()` (see #233)

Filed:

### Title

`/setup/import` stops the gateway with the same unconfirmed kill→sleep(750) race as `restartGateway()` (see #233)

### Body

## Summary

#233 describes `restartGateway()` sending `SIGTERM`, sleeping a flat 750 ms,
and clearing `gatewayProc` with no confirmation the child exited. The
`POST /setup/import` handler carries its own inline copy of the same
sequence:

```js
    // Stop gateway before restore so we don't overwrite live files.
    if (gatewayProc) {
      try { gatewayProc.kill("SIGTERM"); } catch {}
      await sleep(750);
      gatewayProc = null;
    }
```

(`src/server.js` at `b9e2467189d02dfe51a80173c40bad650a58eaf2`, inside
`app.post("/setup/import", requireSetupAuth, ...)`.)

## Why this site is worse than the restart one

The comment states the intent — stop the gateway *so we don't overwrite live
files* — and the code does not establish it. If the gateway takes longer
than 750 ms to shut down (closing a channel provider's persistent connection,
flushing state, an in-flight request), `tar.x` then extracts over
`state/openclaw.sqlite` and its `-wal`/`-shm` siblings while the old process
may still hold them open and may still write to them. The result is either a
corrupted restore or a restore that the exiting process partially overwrites
on shutdown — and the handler then reports `OK - imported backup`.

Fixing #233 alone leaves this site racing, because it does not call
`restartGateway()` for the stop; it only calls it for the restart afterwards.

## Suggested fix

Extract one exit-confirmed helper and call it from both sites, so the two
places that encode "the gateway is stopped" cannot drift apart:

```js
async function stopGatewayAndWait() {
  const proc = gatewayProc;
  if (!proc) return;
  try { proc.kill("SIGTERM"); } catch {}
  const alreadyExited = proc.exitCode !== null || proc.signalCode !== null;
  const exited = alreadyExited ? Promise.resolve() : new Promise((r) => proc.once("exit", () => r()));
  const timedOut = alreadyExited ? false : await Promise.race([exited.then(() => false), sleep(5000).then(() => true)]);
  if (timedOut) {
    try { proc.kill("SIGKILL"); } catch {}
    await exited;
  }
  gatewayProc = null;
}
```

Then `restartGateway()` becomes `if (gatewayProc) await stopGatewayAndWait(); return ensureGatewayRunning();`
and the import handler's inline block becomes `if (gatewayProc) await stopGatewayAndWait();`.

Note the local `proc` capture: the wrapper's own `exit` handler nulls the
shared `gatewayProc`, so a fast-exiting process would otherwise leave the
helper dereferencing `null`. The `alreadyExited` check covers a process that
died before `kill` was called, where `exit` has already fired.

A build-time patch applying exactly this to the pinned commit:
<https://github.com/yuens1002/openclaw-control-plane/blob/main/scripts/patch-wrapper-restart-gateway.mjs>

## Environment

- Pinned commit: `b9e2467189d02dfe51a80173c40bad650a58eaf2`
- Deployed via a downstream Railway-template consumer (Dockerfile pulls this
  repo's `src/` at build time)
