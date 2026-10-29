# Security

Steward runs on one local box for one person. The threat model is modest: keep credentials
out of agent containers, keep the API off the network, and keep secrets out of the repo,
logs, and served files. This page records what the code does today and what it deliberately
does not do.

## Credentials and the agent boundary

- Agent containers get no GitHub and no tracker credentials. They cannot push, open pull
  requests, or write to the tracker.
- The orchestrator alone pushes commits, opens pull requests, and writes to the tracker.
  Those writes are phase 4. The API and worker hold the credentials; agent containers do not.
- The phase 2 container launch must pass no host environment into the container. The agent
  works in a local worktree and commits locally. A short-lived, scoped credential in the
  container is not part of the design.
- Nothing in an agent container can read the API token, the database URLs, or the tracker
  key, because none of them are passed in.

## Secrets

- Secrets come from the environment only. `loadConfig` throws if a secret key appears in the
  JSON config file. The secret keys are `DATABASE_URL`, `TEST_DATABASE_URL`,
  `REDIS_QUEUE_URL`, `REDIS_SLOT_URL`, `LINEAR_API_KEY`, and `API_TOKEN`.
- Each instance has one env file outside the repo: `~/steward-instances/<instance>/.env`,
  mode 0600 in a 0700 folder. The systemd units read it with `EnvironmentFile=`.
- `API_TOKEN` must be at least 32 characters.
- The Postgres and Redis containers get their passwords from Podman secrets, not from the
  Quadlet files: `steward-<instance>-postgres-password` sets `POSTGRES_PASSWORD`, and
  `steward-<instance>-redis-password` sets `REDIS_PASSWORD`. Create them once per instance
  with `podman secret create`.
- The env file must contain the same two passwords, inside the database and Redis URLs,
  because the app connects over TCP. Anyone who can read the env file can read them. Keep
  it at 0600.
- The Redis password is not written in a file, but `redis-server --requirepass` puts it in
  the process argument list inside the container. A process inside that container, or
  anyone who can inspect the container as the same user, can read it. This is a known
  limitation, not a leak to another instance.

## Redaction

The redacting logger (`src/platform/logger.ts`) writes one JSON line per call:

- Every known secret value is replaced with `[REDACTED]` in the message and in string
  fields, at any depth.
- Values under credential-like keys (`authorization`, `api_key`, `apikey`, `token`,
  `password`) are always `[REDACTED]`, even when the value is not a known secret.
- Circular references become `[Circular]`, so logging cannot throw or loop.
- `redactConfig` turns every secret key in a config object into `[REDACTED]`.

The transcript writer (`src/runner/transcript.ts`) applies redaction to orchestrator lines
only. Agent output is stored unmodified. That is deliberate: the transcript must show what
the agent actually did, and hiding fields would make debugging unreliable. The same rule
applies to `raw.jsonl`, which is the byte-exact runner output.

So:

- Process logs and orchestrator transcript lines do not contain known secrets.
- `transcript.jsonl` agent lines and `raw.jsonl` are not redacted. Treat them as sensitive:
  an agent may print a token it read from a test fixture or an error message.
- Neither file is served by the API. The API serves the transcript tail only, and reads
  `transcript.jsonl`, never `raw.jsonl`.

## Files on disk

- `~/steward-instances/<instance>/runs/<job-id>/` is mode 0700.
- `transcript.jsonl` and `raw.jsonl` are mode 0600. `raw.jsonl` is never served.
- The run directory holds the agent's local logs. It is not in the repo and not synced.
- Retention is `RUN_RETENTION_DAYS` (default 30). The sweep is phase 5. Until then, delete
  old run directories by hand.
- `~/steward-instances/<instance>/.env` is mode 0600 and holds the database passwords. The
  whole instance folder is 0700, because `runs/` and `repo/` are under it.
- Quadlet files hold no secrets, so they can be 0644. They are real files in the instance's
  `quadlet/` folder; `~/.config/containers/systemd` only holds symlinks to them.
- Secrets are readable by the login user, and the orchestrator runs as that user. The folder
  mode keeps other OS users out, not agents. Agent containers see only their worktree (phase
  2), and the agent session for a run lives in `runs/<job-id>/`, so it cannot read the env
  file unless it is pointed at the instance folder.
- The agent-config guard hook blocks reads of files named `.env` or `.env.*` only, which is
  why the file is `.env` and not `<instance>.env`. That guard is not present in every agent
  session: a pi session was checked and had no such hook. Open an interactive agent session
  in `repo/` or `runs/`, never in the instance folder.
- The Postgres volume is in Podman's store, not in the instance folder. Its files belong to
  a sub-uid, so they are not readable as the user; `podman volume export` into `backups/` is
  the copy that can be read and moved.

## API exposure

The API is specified as local-only. The entry point is a stub today; these rules are part of
its phase 1 contract.

- Bind to `127.0.0.1` only. No `0.0.0.0`, no LAN address.
- Every request needs `Authorization: Bearer <API_TOKEN>`. The token compare is
  constant-time. The token never appears in logs.
- Reject a `Host` header that is not exactly `127.0.0.1:<API_PORT>` or `localhost:<API_PORT>`,
  or one of the exact values in `ALLOWED_HOSTS`. That list is for the host name of a reverse
  proxy or tunnel: a value has no scheme and no wildcard, the comparison is exact apart from
  case, and the port is part of the value only when the value carries one
  (`steward.example.ts.net` matches that host with no port, `other.example:8443` matches that
  host and port). The default is empty, so only the two loopback names pass. This blocks DNS
  rebinding.
- Reject a cross-origin request unless the origin is in `ALLOWED_ORIGINS`. The default is
  empty, which rejects every cross-origin request.
- The built dashboard is served by a route outside `/v1/*` (`app.get('*')` in
  `src/composition/api.ts`), so it skips the Host check and the bearer auth. That is fine for
  public built assets, so nothing secret may ever be placed in `DASHBOARD_DIR`.
- SSE clients use `fetch` streaming, because `EventSource` cannot send an `Authorization`
  header. The resume point is the `Last-Event-ID` header, matched to the envelope `seq`.
- Postgres and both Redis servers publish their ports on `127.0.0.1` only. They are not
  reachable from the LAN.

## The future dashboard

The dashboard is phase 6. It will import only `src/api/contract.ts` types. It runs in a
browser and needs the API token.

A token in `sessionStorage` is readable by any script on the dashboard origin. One cross-site
scripting bug is enough to steal it. The design accepts this for a local tool and mitigates
it as follows: no third-party scripts, a strict Content Security Policy, and no user HTML.
If the dashboard ever leaves this box, move the token to an HttpOnly cookie set by a small
same-origin proxy. Do not put the token in `localStorage`.

## Per-instance isolation

The work instance and the personal instance share the box but not state:

- Separate Postgres container, database, and volume.
- Two separate Redis containers per instance: queue and slots. Never shared between roles or
  instances.
- Separate Podman network, so containers of one instance cannot reach the other.
- Separate ports on `127.0.0.1`, and one folder per instance for its env file, clone, runs,
  Quadlet files and backups.
- Separate git author name and email, and a separate `gh` account, in each config.
- Before any push, the worker checks `git config` and `gh auth status` against the instance
  config. A mismatch fails the job with kind `setup`, which is never retried.

The shared things are the box, the OS user, and the app checkout. The checkout is code only;
every instance's data lives in its own folder.

## Notifications and tracker text

Notifications are phase 4. Nothing is sent today. Whether ticket text may leave the box to
an ntfy server is an open question; see `docs/decisions.md`. Until that is decided, send
only identifiers and states, never ticket bodies.

## Related documents

- [architecture.md](architecture.md): runtime shape, transcripts, per-instance names.
- [decisions.md](decisions.md): verified facts, unverified items, open questions.

## What the systemd units do and do not protect

The API and worker run as systemd **user** units. On Ubuntu 24.04 a user unit applies `NoNewPrivileges=yes` but silently ignores `ProtectSystem=strict`, `ProtectHome` and `PrivateTmp`, because unprivileged user namespaces are blocked. This was checked with a probe; the table and the cause are in `docs/decisions.md`. So the orchestrator is not filesystem-sandboxed. It is the trusted side: it holds the tokens and does the pushing. The isolation that matters is the agent's container (phase 2), which has no credentials and sees only its worktree. Running the orchestrator as a system unit under a dedicated user would enforce the directives and is an open item.
