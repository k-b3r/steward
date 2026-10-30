# Deploy and start-up: how an instance comes to exist and how its processes start

This page follows one person installing steward on one Linux box, in the order the README does
it, then follows each process through its first seconds. The deploy files and the config loader
decide almost everything here: an instance name plus a port base produce every container, unit,
network, database and port name, and one env file supplies every setting that the API and the
worker read. This flow runs before any ticket is read, so it changes no job state.

## At a glance

- Trigger: a person creates an instance, or the box boots and systemd starts the units. The
  worker then starts its intake poll; see `01-happy-path.md` for what happens after that.
- Starts in / ends in: no job rows. It ends when the worker logs `Worker started` and the API
  logs `API listening` on `127.0.0.1:<API_PORT>`. The first job state, `proposed`, appears only
  after the first intake poll.
- Main files: `deploy/render.sh`, `deploy/quadlet/`, `deploy/systemd/steward-api@.service`,
  `deploy/systemd/steward-worker@.service`, `scripts/instance-env.sh`,
  `scripts/setup-repo.sh`, `src/platform/config.ts`, `src/entries/api.ts`,
  `src/entries/worker.ts`, `src/composition/api.ts`, `src/composition/worker.ts`,
  `src/bootstrap.ts`, `src/db/migrate.ts`.

## Files involved

| File                                     | Role in this flow                                                                 |
| ---------------------------------------- | --------------------------------------------------------------------------------- |
| `deploy/render.sh`                       | Renders the six Quadlet files for one instance and port base into a directory.    |
| `deploy/quadlet/`                        | The six templates: network, two volumes, Postgres, queue Redis, slots Redis.      |
| `deploy/systemd/steward-api@.service`    | The API as a systemd **user** unit, one instance per `%i`.                        |
| `deploy/systemd/steward-worker@.service` | The worker as a systemd **user** unit, one instance per `%i`.                     |
| `scripts/instance-env.sh`                | Prints the env file path the dev scripts pass to `tsx --env-file`.                |
| `scripts/setup-repo.sh`                  | Clones the repo an instance works on and pins that clone's git identity.          |
| `src/platform/config.ts`                 | `loadConfig`: every key, its default, its validation, the secret list, redaction. |
| `src/entries/api.ts`                     | API process entry: load config, build the app, bind `127.0.0.1`.                  |
| `src/entries/worker.ts`                  | Worker process entry: load config, build the worker, start it, poll.              |
| `src/composition/api.ts`                 | Wires the HTTP app to the database, the queue and the runner.                     |
| `src/composition/worker.ts`              | Wires the worker: migrate, reconcile, register the handler, run the poll loop.    |
| `src/bootstrap.ts`                       | The objects both entries share: logger, pool, db, queue, runner.                  |
| `src/db/migrate.ts`                      | Applies every pending SQL file in `src/db/migrations`.                            |

## Step by step

### 1. Two roots: the app checkout and one folder per instance

The app checkout is code only. Every piece of instance state lives in one folder per instance,
named like `INSTANCE`:

```text
~/steward-instances/personal/     mode 0700
  .env                            mode 0600  every setting, including the six secrets
  repo/                                      the clone the instance works on (REPO_PATH)
  runs/                                      job output (RUNS_DIR)
    <job-id>/                     mode 0700  one job's folder, made by the transcript writer
    <job-id>/worktree                        the git worktree of one job, removed after the run
    <job-id>/transcript.jsonl      mode 0600  the redacted transcript the API serves
    <job-id>/raw.jsonl             mode 0600  the byte-exact runner output, never served
  quadlet/                                   the real rendered Quadlet files, no secrets
  backups/                                   `podman volume export` files, created by hand
```

`repo/` holds the clone's own files and its `.git`, which `git worktree add` writes into; those
files carry the clone's own modes. The worker unit's `ReadWritePaths=%h/steward-instances/%i`
covers `repo/` and `runs/` together, which is why the default layout needs no extra write path. A
custom `REPO_PATH` or `RUNS_DIR` needs `ReadWritePaths=` changed to match (`docs/decisions.md`,
open item 6).

The database does **not** live in this folder. Its volume is `steward-personal-pgdata` in
Podman's store (`~/.local/share/containers/storage/volumes/`), owned by a sub-uid, so the files
are not readable as your user. `podman volume export` into `backups/` is the copy you can read
and move. The queue Redis has its own volume, `steward-personal-redis-queue-data`; the slots
Redis has none, because its data is disposable.

Two tool-owned folders stay outside the instance folder:

- `~/.config/containers/systemd` holds **symlinks** to the six files in the instance's
  `quadlet/` folder. Quadlet follows symlinks (tested, `docs/decisions.md`), so the real files
  live with the instance data. Those files hold no secrets, so mode 0644 is fine.
- `~/.config/systemd/user` holds the two host units, as copies (README) or links
  (`systemctl --user link`).

The units' `WorkingDirectory=%h/steward` points at the app checkout, never at instance data.

### 2. The instance name becomes every other name

`instanceNames` in `src/platform/config.ts` derives the three names that the code and the deploy
files must agree on.

Source: `src/platform/config.ts` (`instanceNames`)

```ts
/** External names derived from an instance name; hyphens are legal in units and networks. */
export function instanceNames(instance: string): { unit: string; dbName: string; redisNetwork: string } {
  return {
    unit: `steward@${instance}`,
    dbName: `steward_${instance.replaceAll('-', '_')}`,
    redisNetwork: `steward-${instance}-net`,
  }
}
```

`deploy/render.sh` computes the same database name, and the three ports, from the instance name
and the port base. The app never sees the port base: it finds the three ports inside the URLs in
the env file.

Source: `deploy/render.sh` (the port and database computation)

```bash
pg_port=$port_base
redis_queue_port=$((port_base + 1))
redis_slots_port=$((port_base + 2))
# Must match instanceNames().dbName in src/platform/config.ts: hyphens become underscores.
pg_db="steward_${instance//-/_}"
```

Worked example: instance `personal`, port base `15432`. Every name below comes from the code or
the templates.

| Thing                  | Value                                                                                                                                                                                                                            |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Instance folder        | `~/steward-instances/personal/`                                                                                                                                                                                                  |
| Quadlet files          | `steward-personal.network`, `steward-personal-postgres.volume`, `steward-personal-redis-queue.volume`, `steward-personal-postgres.container`, `steward-personal-redis-queue.container`, `steward-personal-redis-slots.container` |
| Generated unit names   | `steward-personal-network.service`, `steward-personal-postgres-volume.service`, `steward-personal-redis-queue-volume.service`, and the three container services                                                                  |
| Container names        | `steward-personal-postgres`, `steward-personal-redis-queue`, `steward-personal-redis-slots`                                                                                                                                      |
| Network name           | `steward-personal-net`                                                                                                                                                                                                           |
| Volume names           | `steward-personal-pgdata`, `steward-personal-redis-queue-data`                                                                                                                                                                   |
| Database               | `steward_personal`, user `postgres`                                                                                                                                                                                              |
| Postgres port          | `127.0.0.1:15432` (the base)                                                                                                                                                                                                     |
| Queue Redis port       | `127.0.0.1:15433` (base + 1)                                                                                                                                                                                                     |
| Slots Redis port       | `127.0.0.1:15434` (base + 2)                                                                                                                                                                                                     |
| API port               | `API_PORT`, default `3000` on `127.0.0.1`                                                                                                                                                                                        |
| Podman secrets         | `steward-personal-postgres-password`, `steward-personal-redis-password`                                                                                                                                                          |
| Host units             | `steward-api@personal.service`, `steward-worker@personal.service`                                                                                                                                                                |
| BullMQ queue name      | `steward-personal`                                                                                                                                                                                                               |
| `REPO_PATH`            | `/home/you/steward-instances/personal/repo`                                                                                                                                                                                      |
| `RUNS_DIR`             | `/home/you/steward-instances/personal/runs`                                                                                                                                                                                      |
| `instanceNames().unit` | `steward@personal` (no code reads it)                                                                                                                                                                                            |

The queue name is built in `src/bootstrap.ts` from the same instance name:

Source: `src/bootstrap.ts` (`createContext`)

```ts
  const db: Db = createDb(pool)
  const queue = createJobQueue({ redisUrl: config.REDIS_QUEUE_URL, queueName: `steward-${config.INSTANCE}` })
```

Two naming rules that catch people out:

- Hyphens stay in unit, container, volume, network and file names, and become underscores in the
  database name only. `my-work` gives `steward-my-work-net` and `steward_my_work`.
- The port base exists only in the render call. No config key holds it, and the app never learns
  it. The app finds the three ports inside `DATABASE_URL`, `REDIS_QUEUE_URL` and
  `REDIS_SLOT_URL`. If you render with a different base, edit those three URLs by hand.

`instanceNames().unit` returns `steward@personal`, but the deployed units are
`steward-api@personal` and `steward-worker@personal`. Nothing consumes the unit name today
(`docs/decisions.md`, open item 7).

### 3. Create the two Podman secrets

The containers read their passwords from Podman's secret store, never from a file in the repo.
Use hex values, so they need no URL encoding.

```bash
export PG_PASSWORD="$(openssl rand -hex 24)"
export REDIS_PASSWORD="$(openssl rand -hex 24)"
printf '%s' "$PG_PASSWORD" | podman secret create steward-personal-postgres-password -
printf '%s' "$REDIS_PASSWORD" | podman secret create steward-personal-redis-password -
```

Both Redis servers use the one Redis secret; they are separate processes with separate data. Keep
both values: the env file needs the same two passwords inside the database and Redis URLs,
because the app connects over TCP. Anyone who can read the env file can read them, which is why
it stays at 0600.

### 4. Render the six Quadlet files

```bash
mkdir -p ~/steward-instances/personal/quadlet ~/.config/containers/systemd
deploy/render.sh personal 15432 ~/steward-instances/personal/quadlet
```

The script validates the instance with the same regex as the config schema and the base as an
integer in `1024..65530`.

Source: `deploy/render.sh` (the port base check)

```bash
port_base=$((10#$port_base_raw))
if ((port_base < 1024 || port_base > 65530)); then
  die "port-base must be in 1024..65530, got: $port_base"
fi
```

It writes six files: one network, two volumes, three containers. Every published port binds
`127.0.0.1`. It checks every destination before writing anything, so a refused run changes
nothing. It refuses to overwrite an existing file unless you add `--force`. To look at the output
without touching the real folder, render into a temporary directory first.

The Postgres template shows where each placeholder lands.

Source: `deploy/quadlet/steward-@INSTANCE@-postgres.container` (the `[Container]` section)

```ts
[Container]
Image=docker.io/library/postgres:17
ContainerName=steward-@INSTANCE@-postgres
Network=steward-@INSTANCE@.network
PublishPort=127.0.0.1:@PG_PORT@:5432
Volume=steward-@INSTANCE@-postgres.volume:/var/lib/postgresql/data
Environment=POSTGRES_DB=@PG_DB@
Environment=POSTGRES_USER=postgres
Secret=steward-@INSTANCE@-postgres-password,type=env,target=POSTGRES_PASSWORD
```

`Secret=...type=env` makes Podman set `POSTGRES_PASSWORD` in the container's environment from
the secret, so the password appears in no file.

### 5. Link the files into Quadlet's folder and reload

```bash
ln -s ~/steward-instances/personal/quadlet/steward-personal* ~/.config/containers/systemd/
systemctl --user daemon-reload
```

Quadlet reads `~/.config/containers/systemd` and follows the symlinks into the instance folder,
so the real files live with the instance data. `daemon-reload` is what makes systemd generate
`steward-personal-postgres.service` and the other five units from the files. Run it after every
render.

### 6. Install the two host units

```bash
mkdir -p ~/.config/systemd/user
cp deploy/systemd/steward-api@.service deploy/systemd/steward-worker@.service ~/.config/systemd/user/
systemctl --user daemon-reload
```

The units are templates: `%i` is the instance name. Each one requires the three container
services of its own instance, so starting the API or the worker also starts Postgres and both
Redis servers.

Source: `deploy/systemd/steward-worker@.service` (the `[Service]` section)

```ts
[Service]
Type=simple
# The app checkout, not the per-instance data folder; edit if cloned elsewhere.
WorkingDirectory=%h/steward
EnvironmentFile=%h/steward-instances/%i/.env
ExecStart=/usr/bin/node dist/entries/worker.js
Restart=on-failure
RestartSec=5
NoNewPrivileges=yes
ProtectSystem=strict
ReadWritePaths=%h/steward-instances/%i
PrivateTmp=yes
```

`WorkingDirectory=%h/steward` is the app checkout. Edit it in both files if you cloned steward
elsewhere. `EnvironmentFile=` has no `-` prefix, so a missing env file stops the unit from
starting. `Restart=on-failure` with `RestartSec=5` means a crash comes back five seconds later,
with the same error in the journal if the cause is still there.

The filesystem directives are correct for a system unit but are **not enforced** for a user unit
on Ubuntu 24.04: only `NoNewPrivileges=yes` takes effect (`docs/decisions.md`). Do not rely on
`ProtectSystem=strict` or `ReadWritePaths=` to contain the orchestrator on this box.

### 7. Write the env file

```bash
mkdir -p -m 700 ~/steward-instances/personal
cp .env.example ~/steward-instances/personal/.env
chmod 700 ~/steward-instances/personal
chmod 600 ~/steward-instances/personal/.env
```

Fill it in. The URLs must carry the passwords from step 3.

```dotenv
INSTANCE=personal
GH_ACCOUNT=your-github-login
GIT_USER_NAME=Your Name
GIT_USER_EMAIL=you@example.com
DATABASE_URL=postgres://postgres:REPLACE_WITH_PG_PASSWORD@127.0.0.1:15432/steward_personal
REDIS_QUEUE_URL=redis://:REPLACE_WITH_REDIS_PASSWORD@127.0.0.1:15433/0
REDIS_SLOT_URL=redis://:REPLACE_WITH_REDIS_PASSWORD@127.0.0.1:15434/0
LINEAR_API_KEY=REPLACE_WITH_KEY
LINEAR_TEAM_KEY=TST
API_TOKEN=REPLACE_WITH_TOKEN
API_PORT=3000
SLOT_COUNT=3
DRY_RUN=true
REPO_PATH=/home/you/steward-instances/personal/repo
```

The file is named `.env` on purpose: the agent-config secret guard blocks reads of `.env` and
`.env.*` only, and the repo's `.gitignore` covers them. Open agent sessions in `repo/` or
`runs/`, never in the instance folder.

### 8. Create `runs/` and enable linger

```bash
mkdir -p ~/steward-instances/personal/runs
loginctl enable-linger "$USER"
```

`runs/` is the worker's `ReadWritePaths=` entry and the default `RUNS_DIR`. The worker also
creates `runs/<job-id>` itself with mode 0700 when it writes the first transcript line, and git
creates the worktree's parent folders, so a missing `runs/` does not stop a job when the
directive is not enforced. Create it anyway: it is required where `ReadWritePaths=` is enforced.

Without linger, systemd stops your user units when your last session ends. With linger they run
from boot. This command needs admin rights on some systems.

### 9. Start the services

```bash
systemctl --user enable --now steward-api@personal.service steward-worker@personal.service
systemctl --user status steward-api@personal.service steward-worker@personal.service
journalctl --user -u steward-worker@personal -f
```

The three container services come up as dependencies of the two host units. To check the
containers before the host units exist, start them alone:

```bash
systemctl --user start \
  steward-personal-postgres.service \
  steward-personal-redis-queue.service \
  steward-personal-redis-slots.service
```

Stopping a host unit leaves the containers running, so a restart does not wait for Postgres. To
stop the containers too, `systemctl --user stop` the three container units.

Each container unit sets `Restart=always` and `TimeoutStartSec=900` (for the first image pull),
and ends with `[Install] WantedBy=default.target`. Whether that target pulls them in at boot
after `enable-linger` is unverified; see `## Not built yet`.

### 10. Point the instance at a repository

`repo:setup` is `scripts/setup-repo.sh`. It needs the three identity keys, so run it after the
env file exists.

```bash
pnpm repo:setup personal example-org/scratch-repo
```

It reads `GH_ACCOUNT`, `GIT_USER_NAME` and `GIT_USER_EMAIL` from the environment, or else from
`~/steward-instances/personal/.env`, which it parses and never runs as shell code.

Source: `scripts/setup-repo.sh` (the identity read)

```bash
for key in GH_ACCOUNT GIT_USER_NAME GIT_USER_EMAIL; do
  if [[ -z "${!key:-}" ]] && value="$(read_env_value "$env_file" "$key")"; then
    printf -v "$key" '%s' "$value"
  fi
done
```

It clones once into `~/steward-instances/personal/repo` with that account's token, then marks
the clone: `steward.instance`, `steward.role`, `steward.repo`, `steward.account`,
`user.name` and `user.email` in the clone's local git config, plus `.git/steward.json`. Both are
local, so they survive a move and never show in `git status`. It prints the `REPO_PATH` line for
the env file. A second run with the same destination prints `already exists: <dest>` and only
rewrites the markers.

## How the processes find their settings

### The env file for the dev scripts

`pnpm dev:api` and `pnpm dev:worker` ask `scripts/instance-env.sh` for the path and pass it to
`tsx --env-file`.

Source: `package.json` (the two dev scripts)

```json
    "dev:api": "tsx --env-file=\"$(scripts/instance-env.sh)\" src/entries/api.ts",
    "dev:worker": "tsx --env-file=\"$(scripts/instance-env.sh)\" src/entries/worker.ts",
```

The script prints one path on stdout and every error on stderr, so the caller can use the output
directly. The order is: `STEWARD_ENV_FILE`, then `$STEWARD_INSTANCES_DIR/$STEWARD_INSTANCE/.env`,
then the only instance folder under the instances root that holds a `.env`. The instances root is
`$STEWARD_INSTANCES_DIR`, else `$HOME/steward-instances`.

Source: `scripts/instance-env.sh` (the resolution order)

```bash
env_file="${STEWARD_ENV_FILE:-}"
if [[ -z "$env_file" ]]; then
  root="${STEWARD_INSTANCES_DIR:-${HOME:?HOME is not set}/steward-instances}"
  instance="${STEWARD_INSTANCE:-}"
  if [[ -n "$instance" ]]; then
    # Same rule as scripts/setup-repo.sh, so the name cannot walk out of the instances root.
    if ! [[ "$instance" =~ ^[a-z][a-z0-9-]{0,30}$ ]]; then
      echo "STEWARD_INSTANCE must match ^[a-z][a-z0-9-]{0,30}$ (got '$instance')" >&2
      exit 1
    fi
    env_file="$root/$instance/.env"
  else
```

Source: `scripts/instance-env.sh` (the single-folder fallback)

```bash
    found=()
    for dir in "$root"/*/; do
      [[ -d "$dir" && -f "$dir/.env" ]] || continue
      found+=("${dir%/}")
    done
```

The final check is a readable file, and it fails loudly rather than passing an empty path to
`tsx`:

Source: `scripts/instance-env.sh` (the readability check)

```bash
if [[ ! -f "$env_file" || ! -r "$env_file" ]]; then
  echo "cannot read the instance env file $env_file; set STEWARD_INSTANCE or STEWARD_ENV_FILE" >&2
  exit 1
fi
```

Two instances and no `STEWARD_INSTANCE` is an error that names both folders. A folder without a
`.env` is not an instance.

### The env file for the units

The units do no searching at all. `EnvironmentFile=%h/steward-instances/%i/.env` names one file,
so `steward-worker@personal.service` reads `~/steward-instances/personal/.env` and nothing else.
The units also do not set `STEWARD_CONFIG_FILE`, so under systemd the env file is the only source
of settings.

### Every config key

`loadConfig` reads the environment and, when `STEWARD_CONFIG_FILE` is set, a JSON file whose keys
use the same names. Env values win over file values. A secret key in the file is an error. This
table comes from `src/platform/config.ts`.

| Key                    | Default                                  | Required                   | Secret     | Read by                                            |
| ---------------------- | ---------------------------------------- | -------------------------- | ---------- | -------------------------------------------------- |
| `INSTANCE`             | none                                     | yes                        | no         | every derived name; the BullMQ queue name          |
| `DATABASE_URL`         | none                                     | yes                        | **secret** | the connection pool in `src/bootstrap.ts`          |
| `TEST_DATABASE_URL`    | unset (empty string means unset)         | no                         | **secret** | integration tests only; redacted in logs           |
| `REDIS_QUEUE_URL`      | none                                     | yes                        | **secret** | the BullMQ queue and the queue worker              |
| `REDIS_SLOT_URL`       | none                                     | yes                        | **secret** | validated and redacted; no code connects to it yet |
| `LINEAR_API_KEY`       | none                                     | yes                        | **secret** | the Linear client (worker only)                    |
| `LINEAR_TEAM_KEY`      | none                                     | yes                        | no         | the Linear client's team filter                    |
| `GH_ACCOUNT`           | none                                     | yes                        | no         | `scripts/setup-repo.sh` only; no `src/` code       |
| `GIT_USER_NAME`        | none                                     | yes                        | no         | `scripts/setup-repo.sh` only                       |
| `GIT_USER_EMAIL`       | none                                     | yes                        | no         | `scripts/setup-repo.sh` only                       |
| `API_TOKEN`            | none                                     | yes, 32+ chars             | **secret** | the API bearer check                               |
| `API_PORT`             | `3000` (1024..65535)                     | no                         | no         | the API bind address and the Host check            |
| `ALLOWED_ORIGINS`      | `[]` (empty string means `[]`)           | no                         | no         | the API Origin check                               |
| `ALLOWED_HOSTS`        | `[]`, lowercased                         | no                         | no         | the API Host check                                 |
| `SLOT_COUNT`           | `3` (1..16)                              | no                         | no         | the worker: slot acquisition and the reconciler    |
| `POLL_INTERVAL_MS`     | `30000` (min 1000)                       | no                         | no         | the poll loop in `src/composition/worker.ts`       |
| `MAX_ENQUEUE_PER_POLL` | `2` (min 0)                              | no                         | no         | intake                                             |
| `MAX_OPEN_PROPOSALS`   | `20` (min 1)                             | no                         | no         | intake                                             |
| `RUN_RETENTION_DAYS`   | `30` (min 1)                             | no                         | no         | nothing yet (phase 5)                              |
| `MAX_ATTEMPTS`         | `3` (min 1)                              | no                         | no         | new job rows; the retry policy                     |
| `DRY_RUN`              | `true`                                   | no                         | no         | intake, and the raw-response log                   |
| `REPO_PATH`            | none                                     | yes, absolute              | no         | the worker's git calls                             |
| `BASE_BRANCH`          | `main` (absent or empty)                 | no                         | no         | the fetch and the new branch's start point         |
| `DASHBOARD_DIR`        | unset (empty string means unset)         | no, absolute               | no         | the static route in the API                        |
| `ALLOWED_STATUSES`     | `['In Progress']`                        | no, non-empty              | no         | nothing yet (phase 4)                              |
| `RUNS_DIR`             | `$HOME/steward-instances/$INSTANCE/runs` | no, unless `HOME` is unset | no         | the runner and the worktree path                   |

The `RUNS_DIR` default is built in the loader, not in the schema:

Source: `src/platform/config.ts` (`loadConfig`)

```ts
  const instance = pick('INSTANCE', env, file)
  const explicitRunsDir = pick('RUNS_DIR', env, file)
  const home = env.HOME
  const defaultRunsDir =
    typeof instance === 'string' && typeof home === 'string' && home.length > 0
      ? `${home}/steward-instances/${instance}/runs`
      : undefined
```

The six secret keys are `DATABASE_URL`, `TEST_DATABASE_URL`, `REDIS_QUEUE_URL`,
`REDIS_SLOT_URL`, `LINEAR_API_KEY` and `API_TOKEN`. The logger replaces every one of those values
with `[REDACTED]` wherever it appears.

Eleven keys have no default: `INSTANCE`, the five required secrets, `LINEAR_TEAM_KEY`,
`GH_ACCOUNT`, `GIT_USER_NAME`, `GIT_USER_EMAIL` and `REPO_PATH`. Set those and the instance can
start. The other fifteen keys have a default that suits one person on one box.

## What happens when a process starts

### The worker

`src/entries/worker.ts` reads `STEWARD_CONFIG_FILE` if set, calls `loadConfig`, then
`composeWorker`. `composeWorker` calls `createContext` in `src/bootstrap.ts`, which builds the
logger (with the secret list), the pool, the drizzle handle, the BullMQ queue named after the
instance (`steward-personal` here), and the echo runner. None of them connects yet.

The entry then awaits `worker.start()` and `worker.poll()`, in that order.

Source: `src/entries/worker.ts` (the last two lines)

```ts
await worker.start()
await worker.poll()
```

`start` does four things in this order:

1. `migrateDb` applies every pending SQL file in `src/db/migrations`. All pending files run in
   one transaction, so a failure rolls the whole set back and records no row in
   `drizzle.__drizzle_migrations`.

   Source: `src/db/migrate.ts`

   ```ts
   const MIGRATIONS_FOLDER = join(import.meta.dirname, 'migrations')

   /** Applies every pending SQL migration in src/db/migrations. */
   export async function migrateDb(db: Db): Promise<void> {
     await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER })
   }
   ```

2. `reconcile` runs once with `isWorkerAlive: () => Promise.resolve(false)`: this process is the
   only worker, so no job it sees has a live worker. It logs `Reconciled on startup` with
   `requeued`, `retried`, `failed` and `slotsFreed`. The rules are in `04-crash-and-recovery.md`.

3. `queue.startWorker(processJob)` registers the BullMQ handler and waits for the Redis
   connection.

   Source: `src/worker/queue.ts` (`startWorker`)

   ```ts
         // Processor errors become failed jobs. Connection errors are retried by
         // BullMQ; without a listener Node would treat the event as fatal.
         worker.on('error', () => {
           // Intentionally ignored: the job handler owns its own logging.
         })
         await worker.waitUntilReady()
   ```

4. It logs `Worker started` with `instance` and `dryRun`.

`poll` then loops: one `runIntakePoll`, one `sleep`. The first poll runs immediately after
`start` returns, so no ticket is read before the migrations and the reconcile are done. A failed
poll increases the delay; the interval, the jitter and the ten-minute cap are in
`01-happy-path.md` and `02-intake.md`. `SIGTERM` or `SIGINT` closes the queue and the pool.

### The API

`src/entries/api.ts` reads the same config, calls `composeApi` (which builds the context and the
routes, and adds the static dashboard route when `DASHBOARD_DIR` is set), then binds.

Source: `src/entries/api.ts` (the bind)

```ts
const server = serve({ fetch: app.fetch, port: config.API_PORT, hostname: '127.0.0.1' }, (info) => {
  logger.info('API listening', { instance: config.INSTANCE, address: info.address, port: info.port })
})
```

The address is hard-coded to `127.0.0.1`, so the port is reachable only from this machine.
Nothing connects to Postgres or Redis at start-up: the pool and the queue open connections
lazily. The API therefore binds and answers even when both are down; the first request that
needs the database fails with `{"error":"internal"}`.

Every `/v1/*` request then passes the Host check, the Origin check and the bearer token check in
`src/api/auth.ts`. The full rules, the routes and the static dashboard route are in
`06-api-and-dashboard.md`.

## Failure scenarios

| What goes wrong                                    | What you see                                                                                   | What the system does                                                                                                                                                  | Where                            |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| A required key is missing                          | `Invalid configuration:` then `<KEY>: Invalid input: expected string, received undefined`      | exits 1 before any connection; systemd retries in 5 s                                                                                                                 | `loadConfig`                     |
| `API_TOKEN` is shorter than 32 characters          | `Invalid configuration:` then `API_TOKEN: must be at least 32 characters`                      | same                                                                                                                                                                  | `config.ts` schema               |
| `REPO_PATH` is relative                            | `Invalid configuration:` then `REPO_PATH: must be an absolute path`                            | same                                                                                                                                                                  | `config.ts` schema               |
| `DRY_RUN` is not a boolean word                    | `Invalid configuration:` then `DRY_RUN: Invalid input: expected boolean, received string`      | same                                                                                                                                                                  | `parseDryRun`                    |
| A secret key is in the JSON config file            | `<KEY> is a secret and must be set in the environment, not in the config file`                 | throws before validation                                                                                                                                              | `loadConfig`                     |
| Both Redis URLs point at one Redis                 | `REDIS_QUEUE_URL and REDIS_SLOT_URL must point to different Redis instances`                   | throws after validation                                                                                                                                               | `loadConfig`                     |
| The unit's env file is missing                     | `Failed to load environment files` in the journal                                              | the unit does not start                                                                                                                                               | `EnvironmentFile=`               |
| Postgres is not accepting connections yet          | `Failed query: CREATE SCHEMA IF NOT EXISTS "drizzle"`, cause `ECONNREFUSED`                    | the worker exits 1 and restarts in 5 s until Postgres answers (see the note below)                                                                                    | `migrateDb`                      |
| The database password is wrong                     | the same failed-query error                                                                    | the worker loops on restart; the API binds but every read returns 500                                                                                                 | `migrateDb`                      |
| Postgres is up, Redis is not                       | migrate finishes, then no `Worker started` line                                                | every Redis call blocks while ioredis reconnects: the reconcile's queue lookups and `waitUntilReady`; the process stays up, and a command that enqueues never answers | `reconcile`, `queue.startWorker` |
| `REPO_PATH` does not exist                         | job fails as `setup` with `Repository path does not exist: <path>`; the app itself starts fine | no retry, dead letter (see `03-failures-and-retries.md`)                                                                                                              | `processJob`                     |
| `API_PORT` is already in use                       | `EADDRINUSE: address already in use 127.0.0.1:3000` as an uncaught error                       | exits 1; systemd retries in 5 s. Seen on this box with an old dev API on 3000                                                                                         | `src/entries/api.ts`             |
| A published container port is already in use       | Podman reports `address already in use`; the container unit fails                              | the host unit that `Requires=` it does not start                                                                                                                      | the Quadlet files                |
| A migration's SQL fails                            | the drizzle error, then exit 1                                                                 | the whole pending set rolls back, so the schema stays at the last good migration                                                                                      | `migrateDb`                      |
| There is no build, so `dist/` is missing           | `Error: Cannot find module '.../dist/entries/api.js'`                                          | exits 1; the unit restarts in 5 s and fails the same way                                                                                                              | the unit's `ExecStart=`          |
| `repo:setup` runs before the identity keys are set | `GH_ACCOUNT is not set (expected in /home/you/steward-instances/personal/.env)`                | exits 1, nothing cloned                                                                                                                                               | `scripts/setup-repo.sh`          |
| Two instance folders and no `STEWARD_INSTANCE`     | `several instances found under ...; set STEWARD_INSTANCE to pick one`                          | the dev script exits 1 before `tsx` starts                                                                                                                            | `scripts/instance-env.sh`        |

An empty value for a required key gives `<KEY>: must not be empty` instead. A short
`API_TOKEN` gives `must be at least 32 characters`.

The Postgres start-order row is the known gap. `Requires=` and `After=` order the host unit after
`podman run -d` returns, not after Postgres accepts connections. In the one test on this box the
containers were started several seconds before the app, so the race was never exercised
(`docs/decisions.md`, `UNVERIFIED:` container readiness ordering, and open item 5). The
five-second restart usually hides it: the worker crashes, waits, and succeeds once Postgres is
up.

## `DRY_RUN`

`DRY_RUN` defaults to `true` when the key is absent. Only four words are accepted.

Source: `src/platform/config.ts` (`parseDryRun`)

```ts
function parseDryRun(value: unknown): unknown {
  if (value === undefined) return true
  if (value === 'true' || value === '1' || value === true) return true
  if (value === 'false' || value === '0' || value === false) return false
  return value
}
```

When it is on, one intake poll logs every decision and the counts, then returns before writing.

Source: `src/intake.ts` (`runIntakePoll`)

```ts
  if (config.dryRun) {
    const counts = {
      queued: result.decisions.filter((decision) => decision.action === 'queue').length,
      proposed: result.decisions.filter((decision) => decision.action === 'propose').length,
      skipped: result.skipped.length,
    }
    logFinished(logger, true, counts)
    return counts
  }
```

So in dry run: no job row, no proposal, no queue entry, no container, and no ticket state change.
The first page of the raw Linear response is logged as `Linear raw response`, because dry run is
where you check field names. With `DRY_RUN=false` the worker wraps the logger so that line is
dropped, since the response holds ticket text.

Source: `src/composition/worker.ts` (`withoutRawResponses`)

```ts
/** Raw Linear responses hold ticket text: keep them for dry-run only. */
function withoutRawResponses(logger: Logger, dryRun: boolean): Logger {
  if (dryRun) return logger
  return { ...logger, info: (msg, fields) => (msg === RAW_RESPONSE_MESSAGE ? undefined : logger.info(msg, fields)) }
}
```

`DRY_RUN` changes nothing else. Migrations, the reconcile, the poll, the API and the git calls
all run the same way. The value is read once at start, so change it and restart the worker. Every
phase starts in dry run on the personal instance.

## Dev run today, host units after the build

There is no build script. `tsconfig.json` sets `noEmit` and `package.json` has no `build` entry,
so `dist/entries/api.js` and `dist/entries/worker.js` do not exist and the two host units cannot
start. That is open item 1 in `docs/decisions.md` and the top of the "To do" list in
`docs/status.md`.

What works today is the same code through `tsx`:

```bash
pnpm dev:api      # the API on 127.0.0.1:3000, env file found by scripts/instance-env.sh
pnpm dev:worker   # migrate, reconcile, the queue consumer and the poll loop
```

Both scripts run the same entry files the units run, so a dev worker migrates and reconciles the
real database. Do not run a dev worker and the worker unit against one instance at the same time:
the reconciler assumes one worker per instance, and two workers would both claim the queue.

The only differences from the units: the dev scripts find the env file by searching, while the
units read one fixed path; and the dev scripts run `src/` through `tsx`, while the units run
`dist/`.

## Branches

| If ...                                              | Then ...                                                           | Where in code             | Test that covers it                                                                                           |
| --------------------------------------------------- | ------------------------------------------------------------------ | ------------------------- | ------------------------------------------------------------------------------------------------------------- |
| the instance name fails the regex                   | `render.sh` dies and writes nothing                                | `deploy/render.sh`        | `bash deploy/render.test.sh` (invalid input is rejected and writes nothing)                                   |
| the port base is not an integer, or is out of range | `render.sh` dies and writes nothing                                | `deploy/render.sh`        | `bash deploy/render.test.sh` (the same check)                                                                 |
| a destination file exists and there is no `--force` | it refuses before writing any file                                 | `deploy/render.sh`        | `bash deploy/render.test.sh` (a second render must not overwrite existing files)                              |
| `--force` is given, with another port base          | every file is replaced and the new ports appear                    | `deploy/render.sh`        | `bash deploy/render.test.sh` (--force re-renders the new port base)                                           |
| the instance name has a hyphen                      | the database name gets underscores, the file names keep the hyphen | `deploy/render.sh`        | `bash deploy/render.test.sh` (hyphen instance uses underscores in the database name)                          |
| `STEWARD_ENV_FILE` is set                           | that path is printed, nothing is searched                          | `scripts/instance-env.sh` | `bash scripts/instance-env.test.sh` (explicit STEWARD_ENV_FILE wins over the instances)                       |
| `STEWARD_INSTANCE` fails the regex                  | exit 1, stdout empty, the rule in the message                      | `scripts/instance-env.sh` | `bash scripts/instance-env.test.sh` (invalid instance name is rejected)                                       |
| exactly one instance folder holds a `.env`          | that file is printed                                               | `scripts/instance-env.sh` | `bash scripts/instance-env.test.sh` (a single instance is auto-picked)                                        |
| several instance folders hold a `.env`              | exit 1, the message names them and says to set `STEWARD_INSTANCE`  | `scripts/instance-env.sh` | `bash scripts/instance-env.test.sh` (several instances found: fails)                                          |
| a required key is missing or invalid                | `loadConfig` throws, naming the key and never the value            | `src/platform/config.ts`  | `it('rejects %s')` in `src/platform/config.test.ts`                                                           |
| a secret key appears in the JSON config file        | `loadConfig` throws, naming the key and never the value            | `src/platform/config.ts`  | `it('rejects the secret %s when it appears in the config file')` in `src/platform/config.test.ts`             |
| both Redis URLs are equal                           | `loadConfig` throws                                                | `src/platform/config.ts`  | `it('refuses to share one Redis instance between the queue and slot roles')` in `src/platform/config.test.ts` |
| `DRY_RUN` is absent                                 | it is `true`                                                       | `parseDryRun`             | `it('applies the documented defaults when only required values are set')` in `src/platform/config.test.ts`    |
| `RUNS_DIR` is unset, `HOME` and `INSTANCE` are set  | `$HOME/steward-instances/$INSTANCE/runs`                           | `loadConfig`              | `it('applies the documented defaults when only required values are set')` in `src/platform/config.test.ts`    |
| `RUNS_DIR` is set and `HOME` is not                 | the value is used as is, no error                                  | `loadConfig`              | `it('uses RUNS_DIR from env without requiring HOME')` in `src/platform/config.test.ts`                        |

## See it yourself

List the generated units and their state:

```bash
systemctl --user list-units 'steward*' --all
systemctl --user cat steward-worker@personal.service
```

Check the containers, the volumes and the secrets of one instance:

```bash
podman ps --filter name=steward-personal --format '{{.Names}}\t{{.Status}}\t{{.Ports}}'
podman volume ls --filter name=steward-personal
podman secret ls | grep steward-personal
```

Read the logs. The units write to the journal; the dev scripts write one JSON line per call to
stdout and no log file, so run one under `tee` when you want a copy (and make sure no worker
unit is running, as above).

```bash
journalctl --user -u steward-worker@personal -n 50 --no-pager
journalctl --user -u steward-api@personal -f
pnpm dev:worker | tee /tmp/steward-worker.log
```

Find out which env file the dev scripts would use, and check its mode:

```bash
scripts/instance-env.sh
stat -c '%a %n' ~/steward-instances/personal ~/steward-instances/personal/.env
```

Confirm that only loopback is listening:

```bash
ss -ltnp | grep -E ':(15432|15433|15434|3000)\b'
```

Connect to the database inside the container. The official image trusts loopback inside the
container, so no password is needed there:

```bash
podman exec -it steward-personal-postgres psql -U postgres -d steward_personal -c '\dt'
podman exec -it steward-personal-postgres psql -U postgres -d steward_personal \
  -c 'select id, hash, created_at from drizzle.__drizzle_migrations order by id;'
```

Ping each Redis with its password from the env file:

```bash
podman exec -it steward-personal-redis-queue redis-cli -a '<REDIS_PASSWORD>' ping
podman exec -it steward-personal-redis-slots redis-cli -a '<REDIS_PASSWORD>' ping
```

Render into a temporary directory to see what the templates produce, then run the deploy test:

```bash
deploy/render.sh personal 15432 /tmp/quadlet-check && ls /tmp/quadlet-check
bash deploy/render.test.sh
```

Add `--force` to the render if the folder is left over from an earlier run.

Check linger:

```bash
loginctl show-user "$USER" -p Linger
```

## Not built yet

- **The build script, and with it the host units** (phase 1, `docs/decisions.md` open item 1,
  `docs/status.md` "Now" item 1). `package.json` has no `build`, and `tsconfig.json` uses
  `noEmit` with `moduleResolution: Bundler`, while the relative imports in `src/` mostly have no
  `.js` extension, which Node cannot load from plain `tsc` output. Two options, neither chosen:
  add `.js` to every relative import, or emit with esbuild and copy the migrations next to the
  output. Until then only `pnpm dev:api` and `pnpm dev:worker` run.
- **Boot with linger enabled, and the host units under systemd.** `UNVERIFIED:` Boot behaviour of
  `WantedBy=default.target` after `loginctl enable-linger`. Not tried, because it changes the
  machine. `UNVERIFIED:` The host units (`steward-api@`, `steward-worker@`) starting under
  systemd. `dist/` does not exist yet, so only the `tsx` run above was tested.
- **Container readiness ordering.** `UNVERIFIED:` Container readiness ordering. A container
  service is active as soon as `podman run -d` returns, which is before Postgres accepts
  connections. In the test the services were started several seconds before the app, so the race
  was not exercised. Add a readiness check or a retry before relying on boot order. This is open
  item 5 in `docs/decisions.md` and belongs with phase 2.
- **A hard kill of the queue Redis.** `UNVERIFIED:` The AOF persistence of the queue Redis after
  a hard kill (only a clean restart was tested).
- **The slots Redis in use** (phase 2). `REDIS_SLOT_URL` is required, validated and redacted, but
  no code connects to it: the per-slot test databases arrive with the container work.
- **The retention sweep** (phase 5). `RUN_RETENTION_DAYS` is parsed and nothing reads it, so old
  run directories stay until you delete them.
- **Tracker writes** (phase 4). `ALLOWED_STATUSES` is parsed and nothing reads it.
- **One unit name from `instanceNames()`.** `instanceNames().unit` returns `steward@<instance>`
  while the deployed units are `steward-api@<instance>` and `steward-worker@<instance>`. Nothing
  consumes it (open item 7).

Docs disagree: `docs/decisions.md` item 23 says a missing `ReadWritePaths=` path stops the unit
from starting. The later section "User units do not sandbox the filesystem on this box" says the
directive is not enforced for a user unit on Ubuntu 24.04, so a missing path does not stop it.
The code has no check either way.
