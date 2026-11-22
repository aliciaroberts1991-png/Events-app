# Example payloads

These files show the research API and manual-import formats. Names, venues and
URLs are **fictional** (example.org): use them to test, never as real listings.
Every file here is validated by `tests/server/examples.test.ts`, so they stay in
step with the schema.

| File | Endpoint | Shows |
| --- | --- | --- |
| `01-discovery-import.json` | `POST /api/research/v1/import` (or Settings → Research → Manual import) | New club night, concert, festival edition with day-by-day lineup, artist introductions, sources |
| `02-partial-update.json` | `POST /import` | Updating only ticket-sale details; clearing a field with `null` |
| `03-verification-batch.json` | `POST /import` | Weekly verification outcomes: confirmed, source missing, check failed |
| `04-reschedule-and-cancel.json` | `POST /import` | A rescheduled event (keeps your booking and records the old date) and a cancellation |
| `05-ibiza-residency.json` | `POST /import` | A residency announcement and individual confirmed party dates |
| `06-recurring-market.json` | `POST /import` | Weekly market with exceptions; daily Christmas market |
| `run-start.json` | `POST /api/research/v1/runs` | Starting a run from your own scheduler |
| `run-complete.json` | `POST /api/research/v1/runs/{id}/complete` | Finishing with coverage per area |
| `run-fail.json` | `POST /api/research/v1/runs/{id}/fail` | Recording a failed run |
| `import-response.json` | — | What `POST /import` returns |
