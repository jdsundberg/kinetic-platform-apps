# Kinetic Platform + Claude Code — Developer Setup Guide

Go from a bare macOS terminal to a fully working AI-assisted Kinetic Platform development environment: Claude Code, the Kinetic Platform MCP server, the official Kinetic AI skills library, and John Sundberg's demo apps and administration tools.

**What you need before starting:**

- A Mac with admin rights
- Credentials for your Kinetic Platform space (server URL, username, password) — provided by your administrator
- A [GitHub](https://github.com) account (the repos are public; an account makes cloning easier)
- A Claude subscription (Pro/Max) or an Anthropic API key for Claude Code

**What you'll have when done:**

| Component | What it gives you |
|---|---|
| Claude Code | AI coding agent in your terminal |
| Kinetic Platform MCP server | ~400 tools letting Claude directly manage your space (forms, kapps, submissions, users, teams, workflows, integrations) |
| Kinetic AI skills | Curated platform knowledge (API, KQL, workflows, security) that keeps Claude accurate |
| kinetic-platform-apps | 70+ single-page demo applications served from one launcher (port 3011) |
| kinetic-admin-tools | Admin suite — Data Browser, Space/Kapp/Form Admin, monitoring, reporting (port 4000) |

---

## 1. Install the prerequisites

### 1.1 Homebrew (package manager)

Open **Terminal** (⌘-Space, type "Terminal") and run:

```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
```

Follow the prompts. When it finishes, it may print two `echo ... >> ~/.zprofile` commands — run those too, then restart your terminal.

### 1.2 Node.js and Git

```bash
brew install node git
```

Verify (Node must be **18 or newer**):

```bash
node --version   # v18+ required, v20/v22 LTS recommended
git --version
```

### 1.3 GitHub CLI (optional but recommended)

```bash
brew install gh
gh auth login    # follow the browser prompts
```

---

## 2. Install Claude Code

```bash
curl -fsSL https://claude.ai/install.sh | bash
```

(Alternative if you prefer npm: `npm install -g @anthropic-ai/claude-code`)

Then start it once to log in:

```bash
claude
```

Follow the authentication prompts (Claude subscription login or API key). Type `/exit` to leave. Verify:

```bash
claude --version
```

---

## 3. Create your workspace and clone the repos

We'll keep everything under `~/dev`:

```bash
mkdir -p ~/dev && cd ~/dev

git clone https://github.com/kineticdata/kinetic-platform-ai-skills.git
git clone https://github.com/kineticdata/kinetic-platform-mgnt-mcp-server.git
git clone https://github.com/jdsundberg/kinetic-platform-apps.git
git clone https://github.com/jdsundberg/kinetic-admin-tools.git
```

You should now have:

```
~/dev/
├── kinetic-platform-ai-skills/      ← AI skills library (platform knowledge)
├── kinetic-platform-mgnt-mcp-server/← MCP server (Claude ↔ Kinetic bridge)
├── kinetic-platform-apps/           ← Demo apps + launcher (port 3011)
└── kinetic-admin-tools/             ← Admin tools + launcher (port 4000)
```

---

## 4. Build the Kinetic Platform MCP server

The MCP server is what lets Claude Code call the Kinetic Platform APIs directly as tools.

```bash
cd ~/dev/kinetic-platform-mgnt-mcp-server
npm install
npm run build
```

A successful build produces `dist/index.js`. Quick sanity check:

```bash
ls dist/index.js
```

---

## 5. Register the MCP server with Claude Code

Claude Code reads MCP server definitions from a `.mcp.json` file in your project directory (shared, checked in) or from your user config. We'll set it up at the project level so it travels with your work.

Pick (or create) the directory where you'll do your Kinetic work — the demo apps repo is a good home base:

```bash
cd ~/dev/kinetic-platform-apps
```

Create a file named `.mcp.json` with this content (adjust the path if your home directory differs — run `echo $HOME` to check):

```json
{
  "mcpServers": {
    "kinetic-platform-mgnt": {
      "type": "stdio",
      "command": "node",
      "args": [
        "/Users/YOUR_USERNAME/dev/kinetic-platform-mgnt-mcp-server/dist/index.js",
        "--stdio"
      ],
      "env": {
        "KINETIC_ALLOW_SELF_SIGNED": "true"
      }
    }
  }
}
```

> Replace `YOUR_USERNAME` with your macOS username. `KINETIC_ALLOW_SELF_SIGNED=true` is only needed if your Kinetic server uses a self-signed certificate (common for dev/lab servers); omit it for production servers with real certificates.

### Option A — connect interactively (recommended)

Leave credentials out of the file. Each session, just tell Claude:

> Connect to my Kinetic space at https://myspace.example.com as user `myusername`

Claude will call the `connect` tool and prompt for what it needs. Your password is never written to disk.

### Option B — credentials via environment variables

If you want the connection pre-configured, add these to the `env` block:

```json
"env": {
  "KINETIC_SERVER_URL": "https://myspace.example.com",
  "KINETIC_USERNAME": "myusername",
  "KINETIC_PASSWORD": "mypassword",
  "KINETIC_ALLOW_SELF_SIGNED": "true"
}
```

> ⚠️ If you put a password in `.mcp.json`, add `.mcp.json` to `.gitignore` so it never gets committed.

### Verify

Start Claude Code in that directory and check the server status:

```bash
cd ~/dev/kinetic-platform-apps
claude
```

The first time, Claude Code will ask you to approve the project's MCP server — approve it. Then run:

```
/mcp
```

You should see `kinetic-platform-mgnt` listed as **connected**. (You can also verify from the shell with `claude mcp list`.)

---

## 6. Wire up the Kinetic AI skills

The skills library teaches Claude the Kinetic Platform's rules — API conventions, KQL and indexing, pagination limits, workflow XML discipline, security policies. Without it, Claude will guess; with it, Claude follows patterns learned from real systems.

Add one line to your **global** Claude config so the skills apply to every project. Create or edit `~/.claude/CLAUDE.md`:

```bash
mkdir -p ~/.claude
echo '@/Users/YOUR_USERNAME/dev/kinetic-platform-ai-skills/CLAUDE.md' >> ~/.claude/CLAUDE.md
```

(Again, replace `YOUR_USERNAME`.) Claude Code follows `@`-imports transitively, so this one line pulls in the whole library — recipes, concepts, front-end patterns, and API reference.

> Prefer project-scoped? Put the same `@`-line in a `CLAUDE.md` at the root of an individual project instead.

### Keep it current

The skills repo is actively maintained. Refresh periodically:

```bash
cd ~/dev/kinetic-platform-ai-skills && git pull
```

---

## 7. First conversation — smoke test

From your project directory:

```bash
cd ~/dev/kinetic-platform-apps
claude
```

Try these prompts in order:

1. **Connect** (if you used Option A):
   > Connect to my Kinetic space at https://YOUR-SPACE-URL as user YOUR-USERNAME

2. **Read-only check:**
   > List the kapps in my space

3. **Slightly deeper:**
   > Show me the forms in the [some kapp] kapp and tell me which ones have indexes defined

If Claude returns real data from your space, the MCP server and connection are working.

---

## 8. Run the demo apps (kinetic-platform-apps)

70+ single-page demo applications (ITSM, CRM, asset management, scheduling, and many more) served by one unified launcher. Pure Node.js — **no `npm install`, no build step**.

### Start the launcher

```bash
cd ~/dev/kinetic-platform-apps
KINETIC_URL=https://YOUR-SPACE-URL node base/server.mjs
```

`KINETIC_URL` sets the Kinetic server the launcher proxies API calls to — point it at **your** space. On startup it prints the proxy target and every auto-discovered app.

Open **http://localhost:3011** and log in with your Kinetic space credentials.

To run it in the background instead:

```bash
KINETIC_URL=https://YOUR-SPACE-URL node base/server.mjs > /tmp/kinetic-apps.log 2>&1 &
tail -f /tmp/kinetic-apps.log
```

### Install an app into your space

Demo apps store their data in real Kinetic kapps and forms. From the Platform Launcher, click an uninstalled app — space admins see an **Install App** button that provisions the kapp, forms, indexes, and seed data automatically. Once installed, the app is fully interactive against your space.

### Useful endpoints

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/base/apps` | List all discovered apps |
| GET | `/api/base/target` | Show current proxy target |
| POST | `/api/base/target` | Change the proxy target at runtime |
| POST | `/api/base/rescan` | Pick up newly added app folders without restarting |

### Stop the server

```bash
kill $(lsof -ti :3011)
```

---

## 9. Run the admin tools (kinetic-admin-tools)

A suite of platform administration apps — Data Browser (grid/calendar/kanban/Gantt views), Space/Kapp/Form Admin, Governance Hub, Activity Monitor, Kinetic Insights, Report Generator, and more — behind a unified launcher on port **4000**.

```bash
cd ~/dev/kinetic-admin-tools
npm install
cd base
node server.mjs
```

Open **http://localhost:4000** and log in with your Kinetic Platform **server URL, username, and password**. The launcher proxies all API calls through localhost, so your browser never needs direct network access to the platform server, and each browser tab keeps its own session — you can connect different tabs to different servers.

Highlights to try first:

| App | What it does |
|---|---|
| **Data Browser** | Spreadsheet-style explorer for any form's submissions |
| **Space Admin / Kapp Admin / Form Admin** | Manage settings, forms, fields, indexes, workflows |
| **Activity Monitor** | Workflow execution monitoring and run history |
| **Report Generator** | PDF-ready space overview, engine stats, platform inspector reports |

> ⚠️ **Task Archiver** is marked DANGEROUS — it requires direct PostgreSQL access and archives workflow execution data. Skip it unless you know you need it.

Stop with `Ctrl+C` (or `kill $(lsof -ti :4000)` if backgrounded).

---

## 10. Daily workflow

A typical session looks like:

```bash
# Terminal tab 1 — demo apps launcher
cd ~/dev/kinetic-platform-apps && KINETIC_URL=https://YOUR-SPACE-URL node base/server.mjs

# Terminal tab 2 — admin tools (when needed)
cd ~/dev/kinetic-admin-tools/base && node server.mjs

# Terminal tab 3 — Claude Code
cd ~/dev/kinetic-platform-apps && claude
```

Things to ask Claude once you're set up:

- *"Create a new form called Equipment Request in the services kapp with fields for Requester, Equipment Type, and Justification — and add the indexes."*
- *"Why is my KQL query returning empty results?"* (it will check your indexes — the #1 cause)
- *"Walk me through the submissions on form X created this week."*
- *"Build me a new demo app for [your use case]"* — drop the folder into `apps/`, hit `POST /api/base/rescan`, and it appears in the launcher.

### Ground rules worth knowing (from hard-won experience)

- **KQL needs indexes.** Queries against unindexed fields silently return empty. Always create indexes alongside forms.
- **Never change a form slug after creation** — code and data are tied to it.
- **Respect API pagination** — the `/submissions` endpoint hard-caps at 1000 records; use keyset pagination (the skills cover this).
- **Workflow trees are strict XML** — let Claude follow the workflow-xml skill and its validators rather than hand-editing.

---

## 11. Troubleshooting

| Symptom | Fix |
|---|---|
| `claude: command not found` | Restart your terminal; check the installer added Claude to your PATH (`which claude`) |
| MCP server missing from `/mcp` | You must start `claude` from the directory containing `.mcp.json`; approve the server when prompted |
| MCP server fails to start | Confirm `dist/index.js` exists (`npm run build` in the MCP repo); confirm Node 18+ |
| Connect tool fails with TLS/certificate error | Add `"KINETIC_ALLOW_SELF_SIGNED": "true"` to the server's `env` block |
| `401 Unauthorized` from your space | Re-check the server URL (full `https://...` space URL) and credentials; test them by logging into the space in a browser |
| `EADDRINUSE` on 3011 or 4000 | Another instance is running: `kill $(lsof -ti :3011)` (or `:4000`) |
| Demo app not in launcher grid | The folder needs an `app.json`; restart or `curl -X POST localhost:3011/api/base/rescan` |
| Dashboards show all zeros | Usually a missing form index — ask Claude to audit the form's indexes |
| Claude gives wrong platform advice | Make sure the skills `@`-import is in `~/.claude/CLAUDE.md` and the skills repo is pulled up to date |

---

## 12. Reference links

| Resource | URL |
|---|---|
| Claude Code docs | https://docs.claude.com/en/docs/claude-code |
| Kinetic Platform docs | https://docs.kineticdata.com |
| Kinetic AI skills | https://github.com/kineticdata/kinetic-platform-ai-skills |
| Kinetic MCP server | https://github.com/kineticdata/kinetic-platform-mgnt-mcp-server |
| Demo apps | https://github.com/jdsundberg/kinetic-platform-apps |
| Admin tools | https://github.com/jdsundberg/kinetic-admin-tools |
