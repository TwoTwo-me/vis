# Vis

An alternative web UI for [OpenCode](https://github.com/sst/opencode), designed for daily use. Vis now targets a managed deployment model: the browser talks only to the vis server, and the vis server relays approved OpenCode REST, SSE, and PTY traffic to one configured upstream.

![Demo](docs/demo.gif)

## Features

- **Review-first floating windows** that keep tool output and agent reasoning in context
- Session management with **multi-project and worktree** support
- Syntax-highlighted **code and diff viewers** built for fast, confident review
- Permission and question prompts for interactive agent workflows
- Embedded terminal powered by xterm.js

## Managed Deployment

Managed mode is the primary way to run vis.

In this model:

- the browser stays on the vis origin
- vis relays approved `/api/*`, `/api/global/event`, and `/api/pty/*` traffic to one upstream OpenCode target
- upstream credentials stay on the server, never in browser storage
- your edge or reverse proxy handles user authentication before a request reaches vis

### Runtime Contract

Set these environment variables on the vis server:

```bash
VIS_MODE=managed
VIS_UPSTREAM_URL=https://opencode.internal.example
VIS_EDGE_AUTH_MODE=edge
VIS_UPSTREAM_AUTH_HEADER="Bearer server-side-token" # optional
```

- `VIS_MODE=managed` enables the managed runtime
- `VIS_UPSTREAM_URL` is required and must point to the single upstream OpenCode server for this deployment
- `VIS_EDGE_AUTH_MODE=edge` is required today and makes the edge-auth contract explicit
- `VIS_UPSTREAM_AUTH_HEADER` is optional and lets vis attach a fixed server-side `Authorization` header when the upstream requires one

### Edge Auth Expectation

Vis does not own user login in managed mode. Put authentication and authorization at the edge, then let authenticated traffic reach vis. The browser should not connect to OpenCode directly and should not manage upstream auth headers or cookies.

### Local Managed Smoke Test

From this repo:

```bash
pnpm install
VIS_MODE=managed \
VIS_UPSTREAM_URL=http://127.0.0.1:4096 \
VIS_EDGE_AUTH_MODE=edge \
pnpm serve:managed
```

Then open `http://localhost:3000`.

If your upstream also expects a fixed auth header, add `VIS_UPSTREAM_AUTH_HEADER` before `pnpm serve:managed`.

## Verification

These are the supported verification commands for the managed runtime:

```bash
pnpm lint
pnpm build
pnpm test:managed
```

Or run the combined check:

```bash
pnpm verify:managed
```

## Development

```bash
pnpm install
pnpm dev
```

`pnpm dev` runs the Vite frontend for local UI work. Managed deployment verification still goes through `pnpm build` and `pnpm test:managed`.

## Legacy Direct Connect

Browser-direct `opencode serve --cors ...` setups are no longer the primary deployment story for this project. If you still need that flow for local experimentation, treat it as legacy and keep it outside the managed deployment path documented here.

## License

MIT
