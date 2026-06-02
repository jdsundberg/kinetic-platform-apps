# Kinetic Platform Apps — Server Guide

Single-page web apps for the Kinetic Platform. Every app is served through one **base launcher** (`base/server.mjs`) on port **3011**. You almost never start individual app servers — the launcher auto-discovers and serves them all.

## Prerequisites

- **Node.js** (any recent LTS). No `npm install` needed — the apps use pure Node.js built-ins only (`http`, `https`, `fs`, `path`, `crypto`). There is no `package.json` and no build step.

## Starting the Server

From the `apps/` directory:

```bash
node base/server.mjs
```

Then open **http://localhost:3011**.

On startup it prints the URL, the default proxy target, and a list of every auto-discovered app and its custom API handlers:

```
  Unified Base App running at: http://localhost:3011

  Default proxy target: https://first.kinetics.com (changeable via /api/base/target)

  Auto-discovered N apps:
    /itil/  ->  ITSM Console (from itil/)
    ...
  Custom API handlers (M apps):
    /api/ogc/*  (og-compliance)
    ...
```

### Run in the background

```bash
node base/server.mjs > /tmp/kinetic-apps.log 2>&1 &
```

Tail the log with `tail -f /tmp/kinetic-apps.log`.

## Stopping the Server

- **Foreground:** press `Ctrl+C` in the terminal running it.
- **Background / find by port:**

```bash
# Find the process listening on 3011
lsof -ti :3011

# Stop it
kill $(lsof -ti :3011)
```

## Configuration (environment variables)

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3011` | Port the launcher listens on |
| `KINETIC_URL` | `https://first.kinetics.com` | Default Kinetic API proxy target |

```bash
PORT=4000 KINETIC_URL=https://first.kinetics.com node base/server.mjs
```

> Note: `NODE_TLS_REJECT_UNAUTHORIZED=0` is set inside the server so it can talk to Kinetic servers using self-signed certs. This is intentional for local/dev use.

## How It Works

- **Auto-discovery:** At startup the launcher scans every directory in `apps/` (skipping `base`, `home`, `node_modules`, and dotfiles). Any directory with an `app.json` is registered; any with a `server.mjs` exporting `handleAPI` + `apiPrefix` also gets its custom API routes mounted. **No registration needed — drop a directory in `apps/` and restart.**
- **Static serving:** Each app's `index.html` is served at `/{slug}/`.
- **API proxy:** Requests are proxied to the configured Kinetic server (`KINETIC_URL`).
- **Default credentials:** `john` / `john1` against `https://first.kinetics.com`.

## Useful Base Endpoints

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/base/apps` | List all auto-discovered apps |
| `GET` | `/api/base/target` | Show the current proxy target |
| `POST` | `/api/base/target` | Change the proxy target at runtime |
| `POST` | `/api/base/rescan` | Re-scan `apps/` for newly added apps without restarting |

`/api/base/rescan` is handy after adding a new app directory — you can pick it up without bouncing the server.

## Adding a New App

**Just drop the files into a new folder under `apps/`.** There is no central registry to edit — you do **not** modify `base/server.mjs` or `base/index.html`. The launcher auto-discovers the app at startup.

```
apps/my-app/
├── app.json          ← Kapp definition: name, slug, forms, fields, indexes
├── seed-data.json    ← Sample data keyed by form slug (optional)
├── index.html        ← Single-page app (all CSS/JS inline)
└── server.mjs        ← Custom API handler (optional)
```

Only `index.html` is strictly required to serve a page. Add the rest as needed:

- **`app.json`** registers the app (name, slug, category) and defines its Kinetic kapp/forms/indexes for installation.
- **`server.mjs`** is picked up automatically *if* it exports `handleAPI` + `apiPrefix` — its custom API routes get mounted under that prefix. No dispatch code to add anywhere.

After dropping the folder in:

1. Restart the launcher, **or** call `POST /api/base/rescan` to pick it up live.
2. The app appears in the launcher grid and is served at `/{slug}/`.

That's it. The metadata that used to live in `base/index.html` (icon, color, description, category) now comes from `app.json`, and the API routing that used to live in `base/server.mjs` is read straight off the app's exported `apiPrefix`/`handleAPI`.

> See `CLAUDE.md` → "App Packaging" for the full `app.json` and `server.mjs` export formats, index rules, and the `collectByQuery` gotcha.

## Running a Single App Standalone (dev only)

Each app also has its own `server.mjs` with a dedicated port (ITIL 3012, Knowledge 3013, CRM 3014, etc. — see `CLAUDE.md`). These are for isolated development only; in normal use everything goes through `:3011`.

```bash
node itil/server.mjs   # standalone ITIL on its own port
```

## Key Files

| Path | What it is |
|---|---|
| `base/server.mjs` | The unified launcher (port 3011) — start this |
| `base/index.html` | Platform Launcher (the app grid) |
| `home/index.html` | Platform Home (auto-discovers kapps) |
| `CLAUDE.md` | App patterns, registration checklist, port assignments |
| `app.md` | Architecture & data model |
| `branding.md` | Branding & design |

## Troubleshooting

- **`EADDRINUSE` on 3011:** another instance is running. Stop it (`kill $(lsof -ti :3011)`) or start with a different `PORT`.
- **`WARN: failed to import <dir>/server.mjs`:** a per-app server has a syntax/import error; that app's custom API won't mount but the launcher still starts. Check the printed message.
- **App not showing up:** make sure the directory has an `app.json` (and isn't named `base`/`home`/`node_modules`). Then restart or hit `POST /api/base/rescan`.
- **Dashboards show all zeros:** usually a `collectByQuery` kapp-argument bug or a missing form index — see `CLAUDE.md` for the details.
