# Validation Webhook Mode

## What it is, and why it exists

Validation Webhook Mode lets a pipeline engineer POST a micro-batch (a
schema plus a handful of rows) straight to DataGlow and get back a signed
pass/warn/fail validation response — without changing their stack, adding a
new dependency, or shipping any data off the machine.

Today, using DataGlow as a data-quality checkpoint means opening the app and
uploading a file by hand. That works for exploratory analysis, but it does
not fit how data engineers actually run pipelines: Airflow DAGs, dbt runs,
and Kafka consumers move data continuously and need a validation decision
*inline*, before the batch is written downstream or promoted to production.

Validation Webhook Mode closes that gap. It exposes a small HTTP endpoint —
`POST /dataglow-webhook` — that a pipeline task calls with the batch it just
produced. DataGlow parses the payload, routes it through the streaming
validator (schema drift, value drift, arrival-cadence anomaly detection),
and responds with a signed pass/warn/fail verdict the pipeline can act on
immediately: continue on pass/warn, quarantine on fail.

DataGlow never initiates the network call. It only receives a POST that was
sent to it and responds locally — consistent with DataGlow's broader
zero-upload posture (see [TRUST.md](../TRUST.md)).

## How a pipeline engineer uses it

Point a task at the local webhook endpoint with the batch's schema and rows
as JSON:

```bash
curl -X POST http://localhost:4747/dataglow-webhook \
  -H "Content-Type: application/json" \
  -d '{
    "batchId": "batch_20260719_001",
    "source": "airflow_dag_claims_daily",
    "arrivedAt": "2026-07-19T09:00:00Z",
    "schema": [{"name": "claim_id", "type": "VARCHAR"}, {"name": "amount", "type": "DOUBLE"}],
    "rows": [{"claim_id": "C001", "amount": 142.50}, {"claim_id": "C002", "amount": 89.00}]
  }'
```

The response comes back synchronously, so a task can branch on it directly
(exit non-zero to fail the task, log a warning, etc).

## Request shape

```json
{
  "batchId": "batch_20260719_001",
  "source": "airflow_dag_claims_daily",
  "arrivedAt": "2026-07-19T09:00:00Z",
  "schema": [
    { "name": "claim_id", "type": "VARCHAR" },
    { "name": "amount", "type": "DOUBLE" }
  ],
  "rows": [
    { "claim_id": "C001", "amount": 142.50 },
    { "claim_id": "C002", "amount": 89.00 }
  ]
}
```

| Field | Required | Notes |
|---|---|---|
| `batchId` | yes | Any non-empty string identifying this micro-batch. Echoed back in the response and included in the signature. |
| `source` | no | Free-text label for the producing system (DAG name, topic, etc). Not validated, but recommended for traceability. |
| `arrivedAt` | no | ISO-8601 timestamp used for arrival-cadence anomaly detection. |
| `schema` | yes | Array of `{ name, type }` column descriptors. |
| `rows` | yes | Array of row objects keyed by column name. |

## Response shape

```json
{
  "batchId": "batch_20260719_001",
  "receivedAt": "2026-07-19T09:00:01.203Z",
  "status": "pass",
  "findings": {
    "schemaDrift": { "status": "pass", "summary": "Schema unchanged versus baseline." },
    "valueDrift": { "status": "pass", "summary": "Column means stable versus baseline." },
    "arrivalAnomaly": { "status": "pass", "summary": "Arrival cadence consistent with baseline." }
  },
  "signature": "9f1c3a7e2b6d4c58...",
  "version": "1.0"
}
```

- `status` is the worst of the three finding statuses: `pass`, `warn`, or `fail`.
- `findings` breaks the verdict down by check, so a pipeline can log or alert
  on the specific cause, not just the overall status.
- `signature` is a SHA-256 hash (via `crypto.subtle.digest` where available,
  falling back to a deterministic string hash in non-browser test
  environments) of `{ batchId, status, receivedAt }`. It is tamper-evidence
  for the response contents, not a substitute for transport security — see
  the security note below.

## Browser PWA path vs. Tauri desktop path

Two delivery mechanisms share the exact same request/response contract and
the same `js/webhook/webhook-handler.js` logic:

- **Browser PWA (this PR):** a Service Worker
  ([`js/webhook/service-worker-relay.js`](../js/webhook/service-worker-relay.js))
  intercepts `POST /dataglow-webhook` while a DataGlow tab is open in the
  background, parses the request body, and routes it through
  `webhook-handler.js`. The baseline used for drift comparisons lives in
  memory for the Service Worker's lifetime.
- **Tauri desktop (future PR):** a native localhost HTTP server replaces the
  Service Worker as the transport, since a desktop app can bind a real port
  without a browser tab needing to stay open. The same `webhook-handler.js`
  module is reused unchanged — only the thing that receives the raw HTTP
  request and hands its JSON body to `processWebhookBatch()` differs.

## Example Airflow task

```python
import requests
from airflow.decorators import task

@task
def validate_with_dataglow(batch_id: str, rows: list[dict]):
    response = requests.post(
        "http://localhost:4747/dataglow-webhook",
        json={
            "batchId": batch_id,
            "source": "airflow_dag_claims_daily",
            "arrivedAt": datetime.utcnow().isoformat() + "Z",
            "schema": [
                {"name": "claim_id", "type": "VARCHAR"},
                {"name": "amount", "type": "DOUBLE"},
            ],
            "rows": rows,
        },
        timeout=5,
    )
    result = response.json()

    if result["status"] == "fail":
        raise ValueError(f"DataGlow validation failed for {batch_id}: {result['findings']}")
    if result["status"] == "warn":
        print(f"DataGlow validation warning for {batch_id}: {result['findings']}")

    return result  # downstream tasks can inspect the signed verdict
```

On `fail`, the task raises and the DAG quarantines the batch instead of
writing it downstream. On `pass`/`warn`, the pipeline continues.

## Security note

The webhook endpoint is **localhost-only**. It is designed to be called by
processes running on the same machine as the DataGlow instance (an Airflow
worker, a local Kafka consumer, a dbt run) — not exposed to the public
internet or a shared network. There is no authentication layer because
there is no intended remote caller: the trust boundary is "same machine,"
consistent with DataGlow's broader design of never initiating outbound
network calls and never sending data anywhere by default (see
[TRUST.md](../TRUST.md)). Do not put this endpoint behind a public port,
reverse proxy, or container network without adding your own authentication
and transport security in front of it — DataGlow does not provide either.
