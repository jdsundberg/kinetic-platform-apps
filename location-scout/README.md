# Location Scout MN

Minnesota location scouting for film and commercial production. Served through the base
launcher at `/location-scout/` (port 3011); kapp `location-scout`.

## What it tracks

| Form | Records | Purpose |
|---|---|---|
| `locations` | 64 | The catalog — 38 attribute fields covering geography, production spec (power, crew, parking, noise, cell, ADA, seasonal access), and commercial terms |
| `location-photos` | 211 | Plates stored as **real Kinetic file attachments** |
| `contacts` | 89 | Owners, managers, film officers, rangers — tied to a location |
| `scout-reports` | 85 | Visit reports with a review lifecycle |
| `holds` | 74 | Scout/prep/shoot/strike day bookings with a double-booking guard |
| `permits` | 45 | City, county, DNR, drone, road-closure permits |
| `projects` | 14 | The productions the catalog is scouted against |

## State machines

- **Location** — `Prospect → Scouted → Cleared / Restricted → Unavailable → Archived`.
  Only `Cleared` and `Restricted` are bookable.
- **Hold** — `Inquiry → Soft Hold → First Refusal → Confirmed → Released / Completed / Cancelled`.
  `Confirmed` is **exclusive** (two overlapping confirmed holds is a double-booking, shown red);
  `Soft Hold` and `First Refusal` legitimately stack (shown amber as "contended").
- **Scout report** — `Draft → Submitted → Under Review → Approved / Rejected → Archived`.
  `Reviewed By`/`Reviewed On` exist exactly when the status is Approved or Rejected.
- **Permit** — `Not Required / Required → Applied → In Review → Issued → Expired / Denied`.

Queues are predicates over these state sets (whitelists, never blacklists), not over dates.

## Scripts

All pure Node built-ins — no npm, no build step.

```bash
node gen-app-json.mjs                                  # emit app.json
node gen-seed.mjs                                      # emit seed-data.json (deterministic)
node install.mjs <url> <user> <pass> [--seed]          # kapp + forms + indexes (+ data)
node seed-photos.mjs <url> <user> <pass> [--dry-run]   # generate & upload photo attachments
node audit.mjs <url> <user> <pass>                     # 35 business invariants over LIVE data
node reconcile.mjs <url> <user> <pass> [--apply]       # diff seed vs live by business key
node test-indexes.mjs <url> <user> <pass>              # run all 61 index combos as real KQL
```

`seed-photos.mjs` and `reconcile.mjs` are idempotent and resumable — re-running only does
the work that is actually missing or drifted.

## Notes

- **Indexes are derived, not hand-written.** `LOCATION_FILTERS` in `gen-app-json.mjs` is the
  single declaration behind both the UI filter bar and the 15 locations indexes (every
  non-empty subset), so a filter combination can never exist without a matching index.
- **Attachments.** This is the only app here using real Kinetic file attachments. The raw
  multipart contract and its several traps are written up in
  `skills/skills/concepts/form-engine/SKILL.md` — read that before changing upload code.
- **`lib-png.mjs`** is a dependency-free PNG encoder plus a procedural scene generator used
  to produce recognisable placeholder plates. All draw coordinates must be integers: a float
  index into the pixel Buffer is silently discarded.
- Lists are paged **server-side** by `/api/location-scout/search`, so free-text search spans
  every record while the browser still only ever receives 25 rows.
- Aggregation endpoints are cached 5 minutes in memory with in-flight dedup; any write calls
  `/api/location-scout/invalidate`.
