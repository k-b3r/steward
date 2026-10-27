# Context

## Architecture

**Decision (2026-10-27): flat.** Fit check from the global coding standards:

1. Fewer than 3 features with their own data? **Yes.** Only jobs and slots own tables. Flat: one module, pure files beside shell files.
2. Mostly a library or SDK? No.
3. Mostly a framework app? No for the orchestrator. The later dashboard is a framework app and gets its own answer when it starts.
4. A part that must scale, deploy, fail or run independently? Not yet (the Podman worker is phase 2; revisit then).
5. Several teams with separate release cycles? No.
6. Event-driven or realtime core? No.

Revisit when a phase adds features with their own data (validation reports, PR records): split into modules then.

Design brief: `docs/project-brief.md`.
