# Inbound Transactions

Event intake, normalization, and routing system for the Kinetic Platform.

## Architecture

External systems POST events to the `intake` WebAPI. The workflow:
1. Parses the JSON request body
2. Creates an event record in the `events` form
3. Returns a correlation ID for status tracking

```
External System  →  POST /app/kapps/inbound-transactions/webApis/intake
                    ↓
                 Parse Body (Echo node — extracts source, type, external_id, payload)
                    ↓
                 Create Event (Core API — writes to events form)
                    ↓
                 Return {status: "accepted", correlation_id: "..."}
```

## WebAPI Endpoints

### POST `/app/kapps/inbound-transactions/webApis/intake?timeout=30`

Accept an inbound event.

```json
{
  "source": "stripe",
  "event_type": "payment.completed",
  "external_id": "evt_12345",
  "correlation_id": "corr_optional",
  "payload": "{\"amount\":4999,\"currency\":\"usd\"}"
}
```

Response:
```json
{
  "status": "accepted",
  "correlation_id": "corr_optional",
  "source": "stripe",
  "event_type": "payment.completed",
  "external_id": "evt_12345"
}
```

### GET `/app/kapps/inbound-transactions/webApis/event-status?correlation_id=...&timeout=10`

Look up event status by correlation ID.

## Forms

| Form | Purpose |
|------|---------|
| `events` | Central event log (External ID, Source, Event Type, Payload, Status, Correlation ID) |
| `event-types` | Registered event type definitions with schemas |
| `event-sources` | External system registrations (auth type, webhook secret) |
| `error-queue` | Failed events with retry tracking |
| `processing-rules` | Event→workflow routing rules (type pattern, source pattern, target tree) |

## Seeded Data

- 8 event sources (Stripe, Salesforce, GitHub, Jira, PagerDuty, custom, email, IoT)
- 15 event type definitions with JSON schemas
- 11 processing rules mapping event patterns to handler trees

## Dependencies

- `kinetic_core_api_v1` handler must be installed and configured on the task engine
- Handler properties: `api_username`, `api_password`, `api_location` pointing to the Core API

## Key Lessons

- **ERB context is per-node** — instance variables don't carry between nodes. Use `@results['Node']['output']` to pass data.
- **WebAPI request body** — access via `@request['Body']`, parse with `JSON.parse()` in ERB
- **JSON in ERB** — use `JSON.generate()` to build JSON bodies, avoids manual quote escaping
- **WebAPI timeout max 30** — values over 30 cause HTTP 500 (see kinetic-bugs.md)
