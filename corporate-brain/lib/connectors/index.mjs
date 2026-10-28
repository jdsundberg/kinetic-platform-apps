// Connector registry. Every connector turns its system's records into NormalizedSourceRecords:
// { system, originalId, sourceType, title, date, owner, url, excerpt, contentHash, accessScope,
//   participants: [{ name, email, role }], companyHints: [name], deleted?, permissionRevoked? }
// Two delivery modes:
//   pull — the Corporate Brain server reads the system itself (needs server-side credentials)
//   push — an authorized agent (e.g. Claude Code with the Google Drive/Gmail MCP connectors)
//          reads the system under the user's own grant and posts records in bounded batches to
//          POST /api/corporate-brain/jobs/{id}/batch. The pipeline is identical either way.
import { contentHash } from "../core.mjs";

const env = (k) => (process.env[k] || "").trim();
const clip = (s, n = 1000) => String(s || "").replace(/\s+/g, " ").trim().slice(0, n);

async function getJson(url, headers = {}) {
  const r = await fetch(url, { headers: { Accept: "application/json", "User-Agent": "kinetic-corporate-brain", ...headers } });
  const t = await r.text(); let d; try { d = JSON.parse(t); } catch { d = t; }
  if (!r.ok) throw Object.assign(new Error(`${url.split("?")[0]} → ${r.status} ${typeof d === "string" ? d.slice(0, 120) : d.message || d.error?.message || ""}`), { status: r.status, retryable: r.status >= 500 || r.status === 429 });
  return { data: d, headers: r.headers };
}

export const CONNECTORS = {
  // RFP Intelligence uploads: the file itself is kept as a Kinetic attachment on its rfp-documents record, so that copy is
  // the controlled original every citation points back to (Drive-originated files keep their Drive link as well).
  "rfp-upload": {
    id: "rfp-upload", name: "RFP document uploads", mode: "push",
    status: () => ({ configured: true, detail: "Procurement documents uploaded in RFP Intelligence. The original file is stored as an attachment on its RFP document record." }),
    original: () => ({ available: true, kind: "stored", detail: "The original file is attached to its RFP document record (RFP Intelligence → RFP Library)" }),
  },
  manual: {
    id: "manual", name: "Interviews & notes", mode: "push",
    status: () => ({ configured: true, detail: "Recollections and notes entered in Corporate Brain. The note itself is the controlled archival copy." }),
    original: () => ({ available: true, kind: "stored", detail: "Original content is stored in this source record" }),
  },

  kinetic: {
    id: "kinetic", name: "Kinetic Platform records", mode: "pull",
    status: () => ({ configured: true, detail: "Reads submissions from another kapp/form in this space with the requesting user's permissions." }),
    // scope: { kapp, form, q?, titleField?, dateField?, companyHint? }
    async discover(scope, checkpoint, { batchSize = 25, kineticRequest, auth }) {
      if (!scope.kapp || !scope.form) throw new Error("kinetic connector scope needs kapp and form");
      if (scope.kapp === "corporate-brain") throw new Error("Corporate Brain cannot ingest its own kapp");
      let p = `/kapps/${encodeURIComponent(scope.kapp)}/forms/${encodeURIComponent(scope.form)}/submissions?include=values,details&limit=${Math.min(batchSize, 25)}`;
      if (scope.q) p += `&q=${encodeURIComponent(scope.q)}`;
      if (checkpoint?.pageToken) p += `&pageToken=${encodeURIComponent(checkpoint.pageToken)}`;
      const r = await kineticRequest("GET", p, null, auth);
      if (r.status >= 300) throw Object.assign(new Error(`kinetic ${scope.kapp}/${scope.form} → ${r.status}`), { retryable: r.status >= 500 });
      const records = (r.data.submissions || []).map(s => {
        const vals = s.values || {};
        const body = Object.entries(vals).filter(([, v]) => v && typeof v === "string").map(([k, v]) => `${k}: ${v}`).join("; ");
        return {
          system: "kinetic", originalId: s.id, sourceType: "record", title: (scope.titleField && vals[scope.titleField]) || s.label || s.handle,
          date: (scope.dateField && vals[scope.dateField]) || (s.submittedAt || s.createdAt || "").slice(0, 10), owner: s.createdBy || "",
          url: `/app/kapps/${scope.kapp}/forms/${scope.form}/submissions/${s.id}`, excerpt: clip(body), contentHash: contentHash(JSON.stringify(vals)),
          accessScope: "internal", participants: [], companyHints: scope.companyHint ? [scope.companyHint] : [],
        };
      });
      return { records, checkpoint: { pageToken: r.data.nextPageToken || null }, done: !r.data.nextPageToken };
    },
    original: (src) => ({ available: true, kind: "link", url: src["Original URL"] }),
  },

  github: {
    id: "github", name: "GitHub", mode: "pull",
    status: () => ({ configured: true, detail: env("CB_GITHUB_TOKEN") ? "Authenticated with CB_GITHUB_TOKEN" : "Public repositories only (set CB_GITHUB_TOKEN for private repos and higher rate limits)" }),
    // scope: { repo: "owner/name", path?, since?, until?, companyHint? }
    async discover(scope, checkpoint, { batchSize = 25 }) {
      if (!/^[\w.-]+\/[\w.-]+$/.test(scope.repo || "")) throw new Error("github scope needs repo as owner/name");
      const page = checkpoint?.page || 1;
      const qs = new URLSearchParams({ per_page: String(Math.min(batchSize, 25)), page: String(page) });
      if (scope.path) qs.set("path", scope.path); if (scope.since) qs.set("since", scope.since); if (scope.until) qs.set("until", scope.until);
      const headers = env("CB_GITHUB_TOKEN") ? { Authorization: `Bearer ${env("CB_GITHUB_TOKEN")}` } : {};
      const { data } = await getJson(`https://api.github.com/repos/${scope.repo}/commits?${qs}`, headers);
      const records = data.map(c => ({
        system: "github", originalId: `${scope.repo}@${c.sha}`, sourceType: "code", title: clip(c.commit.message.split("\n")[0], 200),
        date: (c.commit.author?.date || "").slice(0, 10), owner: c.commit.author?.name || "", url: c.html_url,
        excerpt: clip(c.commit.message, 1000), contentHash: contentHash(c.sha), accessScope: "internal",
        participants: [{ name: c.commit.author?.name, email: (c.commit.author?.email || "").toLowerCase(), role: "author" }].filter(p => p.email && !p.email.includes("noreply")),
        companyHints: scope.companyHint ? [scope.companyHint] : [],
      }));
      const done = data.length < Math.min(batchSize, 25) || (scope.maxPages && page >= scope.maxPages);
      return { records, checkpoint: { page: page + 1 }, done };
    },
    original: (src) => ({ available: true, kind: "link", url: src["Original URL"] }),
  },

  "google-drive": {
    id: "google-drive", name: "Google Drive", mode: "push",
    status: () => env("CB_GOOGLE_ACCESS_TOKEN")
      ? { configured: true, pull: true, detail: "Server pull enabled with CB_GOOGLE_ACCESS_TOKEN" }
      : { configured: true, pull: false, detail: "Agent-mediated: an authorized agent reads Drive with the user's own Google grant and posts metadata batches. Server-side pull needs a Google OAuth token (CB_GOOGLE_ACCESS_TOKEN) — not configured." },
    // Server pull (only when a token is configured). scope: { query, folderId?, companyHint? }
    async discover(scope, checkpoint, { batchSize = 25 }) {
      const token = env("CB_GOOGLE_ACCESS_TOKEN");
      if (!token) throw Object.assign(new Error("Google Drive server pull is not configured (CB_GOOGLE_ACCESS_TOKEN). Use agent-mediated ingestion."), { notConfigured: true });
      const q = [scope.query ? `fullText contains '${String(scope.query).replace(/'/g, "\\'")}'` : "", scope.folderId ? `'${scope.folderId}' in parents` : "", "trashed = false"].filter(Boolean).join(" and ");
      const qs = new URLSearchParams({ q, pageSize: String(Math.min(batchSize, 25)), fields: "nextPageToken,files(id,name,mimeType,createdTime,modifiedTime,owners,webViewLink,md5Checksum,version)" });
      if (checkpoint?.pageToken) qs.set("pageToken", checkpoint.pageToken);
      const { data } = await getJson(`https://www.googleapis.com/drive/v3/files?${qs}`, { Authorization: `Bearer ${token}` });
      const records = (data.files || []).map(f => driveRecord(f, scope));
      return { records, checkpoint: { pageToken: data.nextPageToken || null }, done: !data.nextPageToken };
    },
    original: (src) => ({ available: true, kind: "link", url: src["Original URL"], detail: "Opens in Google Drive; Drive enforces the viewer's own permissions" }),
  },

  gmail: {
    id: "gmail", name: "Gmail", mode: "push",
    status: () => env("CB_GMAIL_ACCESS_TOKEN")
      ? { configured: true, pull: true, detail: "Server pull enabled with CB_GMAIL_ACCESS_TOKEN (metadata only)" }
      : { configured: false, pull: false, detail: "Agent-mediated ingestion requires the Gmail connector to be authorized in the agent session (currently needs re-authentication). Server-side pull needs CB_GMAIL_ACCESS_TOKEN — not configured." },
    // Metadata-only pull. scope: { query (Gmail syntax, required — never the whole mailbox), companyHint? }
    async discover(scope, checkpoint, { batchSize = 25 }) {
      const token = env("CB_GMAIL_ACCESS_TOKEN");
      if (!token) throw Object.assign(new Error("Gmail server pull is not configured (CB_GMAIL_ACCESS_TOKEN)."), { notConfigured: true });
      if (!scope.query) throw new Error("Gmail ingestion requires a restricted search query; whole-mailbox ingestion is not allowed");
      const H = { Authorization: `Bearer ${token}` };
      const qs = new URLSearchParams({ q: scope.query, maxResults: String(Math.min(batchSize, 25)) });
      if (checkpoint?.pageToken) qs.set("pageToken", checkpoint.pageToken);
      const { data } = await getJson(`https://gmail.googleapis.com/gmail/v1/users/me/messages?${qs}`, H);
      const records = [];
      for (const m of data.messages || []) {
        const { data: msg } = await getJson(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Cc&metadataHeaders=Date`, H);
        records.push(gmailRecord(msg, scope));
      }
      return { records, checkpoint: { pageToken: data.nextPageToken || null }, done: !data.nextPageToken };
    },
    original: (src) => ({ available: true, kind: "link", url: src["Original URL"], detail: "Opens in Gmail for the mailbox owner only" }),
  },

  // Sales Brain (phase 3): opportunities read through the Copper MCP connector by an authorized agent, read-only.
  // The excerpt carries pipeline, stage, status and dates only; opportunity values go to restricted Deal Pricing.
  copper: {
    id: "copper", name: "Copper CRM", mode: "push",
    status: () => ({ configured: true, pull: false, detail: "Agent-mediated, read-only: an authorized agent reads opportunities through the Copper MCP connector. Values are never put in the source excerpt." }),
    original: (src) => ({ available: true, kind: "link", url: src["Original URL"], detail: "Opens in Copper; Copper enforces the viewer's own permissions" }),
  },
};

export function driveRecord(f, scope = {}) {
  const kind = /presentation/.test(f.mimeType) ? "presentation" : /spreadsheet/.test(f.mimeType) ? "spreadsheet" : /folder/.test(f.mimeType) ? "folder" : "document";
  return {
    system: "google-drive", originalId: f.id, sourceType: kind, title: f.name || f.title, date: (f.createdTime || "").slice(0, 10),
    owner: f.owners?.[0]?.emailAddress || f.owner || "", url: f.webViewLink || f.viewUrl || `https://drive.google.com/open?id=${f.id}`,
    excerpt: clip(f.excerpt || "", 1000), contentHash: contentHash(f.md5Checksum || f.version || f.modifiedTime || f.id),
    accessScope: scope.accessScope || "internal", participants: [], companyHints: scope.companyHint ? [scope.companyHint] : [],
  };
}

const parseAddr = (s) => String(s || "").split(",").map(x => x.trim()).filter(Boolean).map(x => {
  const m = x.match(/^"?([^"<]*)"?\s*<([^>]+)>$/); return m ? { name: m[1].trim(), email: m[2].toLowerCase() } : { name: "", email: x.toLowerCase() };
});
export function gmailRecord(msg, scope = {}) {
  const h = Object.fromEntries((msg.payload?.headers || []).map(x => [x.name.toLowerCase(), x.value]));
  const participants = [...parseAddr(h.from).map(p => ({ ...p, role: "from" })), ...parseAddr(h.to).map(p => ({ ...p, role: "to" })), ...parseAddr(h.cc).map(p => ({ ...p, role: "cc" }))];
  return {
    system: "gmail", originalId: msg.id, sourceType: "email", title: h.subject || "(no subject)",
    date: msg.internalDate ? new Date(+msg.internalDate).toISOString().slice(0, 10) : "", owner: "mailbox owner",
    url: `https://mail.google.com/mail/u/0/#all/${msg.threadId || msg.id}`, excerpt: clip(msg.snippet, 300),
    contentHash: contentHash(msg.historyId || msg.id), accessScope: scope.accessScope || "restricted", participants,
    companyHints: scope.companyHint ? [scope.companyHint] : [],
  };
}

export function connectorStatus() {
  return Object.values(CONNECTORS).map(c => ({ id: c.id, name: c.name, mode: c.mode, pull: !!c.discover && (c.status().pull !== false), ...c.status() }));
}
