# machinectl as the real-machine tier

This is a positioning note, not a feature spec. It explains where `machinectl` sits relative to [`@cloudflare/workspace`](https://github.com/cloudflare/workspace) — the recently-public-preview "give your agent a computer" primitive — and why both exist.

The short version: workspace is the agent-scale ephemeral computer. `machinectl` is the real-machine tier. They are complementary, not competitive.

## The two tiers

| Tier | What it is | Where it runs | Backing storage | Shell | Reach |
|---|---|---|---|---|---|
| **agent-scale** | `@cloudflare/workspace` — a SQLite-backed virtual filesystem inside a Durable Object, with a FUSE-mounted container mirror and `exec`. | Cloudflare edge, inside a DO + container. | DO SQLite VFS; container mirror held **in memory**. | Container `exec` through FUSE. | The agent gets its own fresh box. |
| **real-machine** | `machinectl` — an authenticated MCP daemon over an outbound WebSocket relay. | The user's actual workstation. | Real local disk. | Real local shell, real installed toolchain. | The agent reaches into the user's existing dev environment. |

Workspace's own preview docs are honest about the tier it serves: aim for agent-scale workspaces, not full monorepos; the container-side VFS is held in memory and capped (~10 GB); and heavy IO through FUSE (large `node_modules` installs, big tarball extractions) takes a measurable performance hit. Those aren't bugs — they're the price of being an ephemeral, cloud-resident, per-agent computer.

`machinectl` does not try to be that. It is intentionally the other tier: your real machine, reached securely from elsewhere, audited.

## When to use which

A short decision table. Pick the tier that matches the job, not the one that sounds cooler.

| The job is… | Use |
|---|---|
| agent-scale scratch (a few files, a quick script, a fresh checkout) | `@cloudflare/workspace` |
| small portable FS the agent owns end-to-end | `@cloudflare/workspace` |
| untrusted code that must run nowhere near your machine | `@cloudflare/workspace` (or workspace + Worker Loader / capa) |
| ephemeral per-task computer, freshly built each run | `@cloudflare/workspace` |
| a heavy real repo (e.g. Stratus) where `node_modules` alone outsizes the agent-scale budget | `machinectl` |
| work that must run where the data, secrets, signed-in apps and build caches already live | `machinectl` |
| driving a real toolchain, GUI app, or accessibility surface on the user's machine | `machinectl` |
| anything where the answer "spin up a fresh box in the cloud" would lose the whole point | `machinectl` |

The boundary isn't a value judgement. It's the workspace docs telling you, plainly, what their primitive is for — and `machinectl` covering the work that sits outside that scope on purpose.

## How they compose, not compete

An agent loop doesn't have to pick once. It can use both, in the same run, for the parts each is good at:

1. start in workspace: a fresh VFS, light scratch, planning, small files, untrusted-code execution;
2. when the job outgrows agent-scale — a real repo to build, a real desktop to drive, a local secret store to read — hand off to `machinectl`;
3. both sides emit auditable records: workspace through the DO/Workflow it lives inside, `machinectl` through the relay's content-minimizing receipts.

That handoff is the runtime story `loomctl` is built around: a loop decides, per step, **runtime cloud** (workspace) vs **runtime machine** (`machinectl`). Same loop, same audit trail, different tier.

```text
            ┌─────────────────────────────┐
agent loop  │ choose runtime per step      │
            └──────┬───────────────┬──────┘
                   │               │
                   ▼               ▼
       @cloudflare/workspace   machinectl
       agent-scale, cloud      real-machine, your laptop
       (DO VFS + container)    (MCP over relay)
```

## Honest framing

`machinectl` is Jordan's project; `@cloudflare/workspace` is an official Cloudflare public preview. This document is not pitching `machinectl` against it. The opposite: `machinectl` is positioned as complementary dogfood — the escape hatch for work too heavy for the agent-scale primitive, deliberately small, deliberately not trying to be a cloud sandbox.

Workspace is the default. `machinectl` is the tier you reach for when the job lives on your real machine and needs to stay there.

That's the whole argument.
