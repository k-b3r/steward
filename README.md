# steward

A self-hosted orchestrator that turns tracker tickets into draft pull requests. Tickets
arrive from a tracker feed, become jobs, and run a coding agent in a sandboxed container. The
orchestrator validates the result, pushes it, and opens a draft pull request for review. It
runs on one local Linux box. It is a personal tool, and it holds no employer code, ticket
text, or team keys in the repo.

Status: phase 1 is in progress. The state machine, retry policy, slot allocator, ticket
mapping, transcript writer, config loader, and redacting logger are built and tested. The API
and worker entry points are stubs. There is no build script yet, so the systemd units cannot
start until one exists. Phases are listed in [docs/architecture.md](docs/architecture.md).

## Requirements

- Linux with systemd 255 or newer, as a systemd **user** session.
- Podman 4.9 or newer, rootless.
- Node 22 and pnpm 10.
- git, and `openssl` for generating passwords.
- A tracker workspace and a private scratch repo (the personal instance). Intake only reads
  the tracker, and creates no jobs or runs, while `DRY_RUN=true`.

## Layout on disk

Each instance has one folder under `~/steward-instances`. The app checkout sits elsewhere.

```text
~/steward-instances/<instance>/
  .env        secrets and settings (file mode 0600, folder mode 0700)
  repo/       the clone the instance works on (REPO_PATH)
  runs/       job output: runs/<job-id>/{worktree,transcript.jsonl,raw.jsonl} (RUNS_DIR)
  quadlet/    the rendered Quadlet files; ~/.config/containers/systemd holds symlinks to them
  backups/    `podman volume export` files
```

The env file is named `.env` on purpose. The agent-config secret guard only protects files
named `.env` or `.env.*`, and the repo's `.gitignore` covers them. Open agent sessions in
`repo/` or `runs/`, not in the instance folder itself.

The database stays in Podman's store (`~/.local/share/containers/storage`). Its files map to a
sub-uid, so you cannot open them as your user. Back it up with `podman volume export` into
`backups/`; create that folder when you take the first export.

Podman's Quadlet folder and systemd's user-unit folder stay where the tools look:
`~/.config/containers/systemd` and `~/.config/systemd/user`. Quadlet follows symlinks (tested
with `QUADLET_UNIT_DIRS` and the `podman-system-generator --dryrun`: identical output), so the
rendered files live in the instance `quadlet/` folder and `~/.config/containers/systemd` holds
symlinks to them.

## Install the personal instance

These steps assume the user units run as your login user, and the instance is named `personal`
with port base `15432`. Use another name and base if you like; the three ports must stay free.

The app checkout is wherever you cloned this repo. The commands below call it `<where you
cloned steward>`; if you are already in it, `steward` is enough.

The units will not start until `dist/entries/api.js` and `dist/entries/worker.js` exist. There is
no build script yet. See open item 1 in [docs/decisions.md](docs/decisions.md).

### 1. Install dependencies

```bash
cd <where you cloned steward>     # e.g. cd ~/Develop/steward
pnpm install
podman info >/dev/null && echo "rootless Podman is ready"
```

### 2. Create the Podman secrets

The containers read their passwords from Podman secrets. Create one password for Postgres and
one for both Redis servers. Use hex values, so they need no URL encoding.

```bash
export PG_PASSWORD="$(openssl rand -hex 24)"
export REDIS_PASSWORD="$(openssl rand -hex 24)"
printf '%s' "$PG_PASSWORD" | podman secret create steward-personal-postgres-password -
printf '%s' "$REDIS_PASSWORD" | podman secret create steward-personal-redis-password -
```

Keep both values: step 5 puts the same passwords in the env file. The secrets are stored in
Podman's user store and are not in the repo.

### 3. Render the Quadlet files

```bash
mkdir -p ~/steward-instances/personal/quadlet ~/.config/containers/systemd
deploy/render.sh personal 15432 ~/steward-instances/personal/quadlet
ln -s ~/steward-instances/personal/quadlet/steward-personal* ~/.config/containers/systemd/
systemctl --user daemon-reload
```

The script writes six files: the network, two volumes, and the three containers. It refuses
to overwrite files that already exist; add `--force` to replace them. Every published port
binds `127.0.0.1` only. To check the output without touching the real directory, render into
a temporary directory first.

Quadlet reads `~/.config/containers/systemd` and follows the symlinks into the instance
folder. Run `daemon-reload` after every render, so systemd picks up the new units.

### 4. Install the host units

```bash
mkdir -p ~/.config/systemd/user
cp deploy/systemd/steward-api@.service deploy/systemd/steward-worker@.service ~/.config/systemd/user/
systemctl --user daemon-reload
```

The units' `WorkingDirectory=%h/steward` is the app checkout. Edit it to wherever you cloned
the app, in both files, before you copy them.

### 5. Create the env file

The units read `~/steward-instances/personal/.env`. Start from `.env.example`.

```bash
mkdir -p -m 700 ~/steward-instances/personal
cp .env.example ~/steward-instances/personal/.env
chmod 700 ~/steward-instances/personal
chmod 600 ~/steward-instances/personal/.env
```

Fill it in. The database and Redis URLs must carry the same passwords you created in step 2.

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

There is one env file per instance, at `~/steward-instances/<instance>/.env` (file mode 0600, folder mode 0700, outside the repo). `pnpm dev:api` and `pnpm dev:worker` pick the env file from `STEWARD_ENV_FILE`, else `STEWARD_INSTANCE`, else the only folder under `~/steward-instances`; set `STEWARD_INSTANCES_DIR` to move that root. Several instances and no choice is an error. The systemd units read the same file. `.env.example` is the template.

Three more keys, all non-secret. `BASE_BRANCH` is the branch each job starts from: a new `agent/*` branch is cut from `origin/<BASE_BRANCH>`, and it defaults to `main`. `DASHBOARD_DIR` is optional: set it to the absolute path of the built `dashboard/dist` and the API serves it from its own origin; unset means the API answers only `/v1`. `ALLOWED_STATUSES` is a comma-separated list of the tracker statuses the orchestrator may move a ticket into, default `In Progress`, and an empty list is a config error; it is parsed and validated now, but nothing reads it yet, because nothing writes to Linear.

### Point an instance at a repo

```bash
pnpm repo:setup personal k-b3r/scratch-repo     # -> ~/steward-instances/personal/repo
```

A third argument sets the destination instead of `~/steward-instances/<instance>/repo`: `pnpm repo:setup personal k-b3r/scratch-repo /path/to/clone`. The identity (`GH_ACCOUNT`, `GIT_USER_NAME`, `GIT_USER_EMAIL`) comes from the environment, or else from `~/steward-instances/<instance>/.env`, which is parsed and never run as shell code.

It clones once, then marks the clone as steward's: `steward.instance`, `steward.role` and `steward.repo` in the clone's local git config, and the same in `.git/steward.json`. Both are local, so they survive moving the clone and never appear in `git status`. It also prints the `REPO_PATH` line to put in the instance env file.

Layout: `~/steward-instances/<instance>/repo` holds the clone, and `~/steward-instances/<instance>/runs/<job-id>/` holds one worktree and its transcripts per job. Each job gets a worktree from that clone; the clone itself is never touched by an agent.

`REPO_PATH` must be absolute. `RUNS_DIR` defaults to `$HOME/steward-instances/$INSTANCE/runs`,
which is `~/steward-instances/personal/runs` here. The env file is the only place the app
reads secrets.

### 6. Create the runs directory

The worker writes transcripts under `~/steward-instances/personal/runs`, and its `ReadWritePaths=`
needs that folder to exist before the unit starts. The worker unit allows writes under
`%h/steward-instances/%i`, the whole instance folder.

```bash
mkdir -p ~/steward-instances/personal/runs
```

### 7. Let user units run without a login

```bash
loginctl enable-linger "$USER"
```

Without linger, systemd stops your user units when your last session ends. This command needs
admin rights on some systems.

### 8. Start the units

```bash
systemctl --user enable --now steward-api@personal.service steward-worker@personal.service
systemctl --user status steward-api@personal.service steward-worker@personal.service
journalctl --user -u steward-api@personal -f
```

The container units start on demand: each host unit has `Requires=` and `After=` for
`steward-personal-postgres.service`, `steward-personal-redis-queue.service`, and
`steward-personal-redis-slots.service`.

Stopping the host units leaves the containers running, so a restart does not wait for
Postgres. To stop the containers too:

```bash
systemctl --user stop \
  steward-personal-postgres.service \
  steward-personal-redis-queue.service \
  steward-personal-redis-slots.service
```

Check the containers with `podman ps --filter name=steward-personal`.

## Dry run

Dry run is on by default: `DRY_RUN` defaults to `true` in the config loader even when the key
is absent. While it is on, ticket intake logs each match and the raw JSON it received, and
creates nothing: no job row, no proposal, no container. Use it to check field names and
filters before anything runs.

To turn it off, set `DRY_RUN=false` in `~/steward-instances/personal/.env` and restart the worker:

```bash
systemctl --user restart steward-worker@personal.service
```

Turn it off only after reading the logged JSON. Every phase starts in dry run on the personal
instance. Ticket intake itself is phase 1 work and is not built yet.

## Tests

```bash
pnpm check                  # format:check, lint, depcruise, knip, typecheck, unit tests
pnpm test                   # unit tests only
pnpm test:mutation          # mutation tests on the pure core files
bash deploy/render.test.sh  # render the Quadlet templates into a temp dir and check them
pnpm test:integration       # needs TEST_DATABASE_URL, a disposable database
```

Integration tests read only `TEST_DATABASE_URL`. Never point it at the database the app uses.
The deploy test creates nothing outside a temporary directory.

## Deploy files

```
deploy/
  quadlet/       templates with @INSTANCE@, @PG_PORT@, @REDIS_QUEUE_PORT@,
                 @REDIS_SLOTS_PORT@, and @PG_DB@ placeholders
  render.sh      renders one instance and port base into a directory (the instance quadlet/)
  render.test.sh shell test for render.sh
  systemd/       steward-api@.service and steward-worker@.service
```

A second instance is a second folder under `~/steward-instances`, a render with another name
and port base, and its own secrets. Nothing in the repo changes. Keep instances apart: never
share a database, a Redis, or a runs folder between them.

## Documentation

- [docs/architecture.md](docs/architecture.md): interfaces, job states, retries, slots,
  transcripts, per-instance naming, code layout, phase boundaries.
- [docs/security.md](docs/security.md): credentials, redaction, API exposure, per-instance
  isolation.
- [docs/decisions.md](docs/decisions.md): dated decision log, verified facts, unverified
  items, open questions.
- [docs/project-brief.md](docs/project-brief.md): the design.

## Dashboard

`dashboard/` is a Vite + React app built from a design export (the export itself is not in the repo; `design.css` and `sprite.ts` come from it). It shows the overview, jobs, a live job transcript, slots and approvals, and talks to the API only through `src/api/contract.ts`.

```sh
pnpm install
pnpm dev:api                          # the API on 127.0.0.1:3000
pnpm --filter steward-dashboard dev   # http://127.0.0.1:5173, proxies /v1 to the API
```

Add `http://127.0.0.1:5173` (or `http://localhost:5173`) to `ALLOWED_ORIGINS`, then sign in with `API_TOKEN`. The token stays in `sessionStorage`. Set `STEWARD_API` to proxy to another API address.

### Open the dashboard from another device on your tailnet

Keep the API on `127.0.0.1` and let `tailscale serve` proxy to it. Do not use `tailscale funnel`: it is public.

```sh
tailscale serve --bg 3000      # HTTPS on the tailnet name -> 127.0.0.1:3000
tailscale serve status         # must say "(tailnet only)"
```

Set `ALLOWED_HOSTS=<machine>.<tailnet>.ts.net` and add `https://<machine>.<tailnet>.ts.net` to `ALLOWED_ORIGINS`, then restart the API. The tailnet needs MagicDNS and HTTPS certificates enabled (admin console, DNS page). The other device only needs the Tailscale app on; open the URL and sign in with `API_TOKEN`. Every device on the tailnet can reach the page, so limit it with a Tailscale access rule, and rotate `API_TOKEN` if a device is lost.

The production build (`pnpm --filter steward-dashboard build`) adds a Content-Security-Policy `<meta>` tag: scripts from the same origin only, no inline script, no eval, network calls to the same origin. Serve `dashboard/dist` from the same origin as the API, or change `connect-src` in `dashboard/csp.ts`. A `<meta>` tag cannot set `frame-ancestors`; add that header where the files are served.

The API serves the built `dashboard/dist` when `DASHBOARD_DIR` is set to its absolute path (`pnpm --filter steward-dashboard build` writes it). The dashboard is then at the API origin, `http://127.0.0.1:<API_PORT>`. Over an SSH tunnel the local port must equal `API_PORT`, because the Host and Origin checks compare it.

The API has no job titles, projects, costs or health data yet, so those parts of the design are not built. `pnpm --filter steward-dashboard build` writes `dashboard/dist`.
