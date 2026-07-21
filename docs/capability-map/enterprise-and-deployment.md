# Capability detail — Enterprise & deployment

Companion to the **Enterprise & deployment** area in
[`../capability-map.md`](../capability-map.md).

## What this area is

Enterprise-readiness primitives that take DataGlow from a solo analyst tool toward
team and organizational deployment. The backing module is `js/build/enterprise-policy.js`,
which exposes a runtime policy object that feature flags, audit exports, and governance
checks can read to adapt behaviour based on the deployment context.

## Key capabilities

- **Deployment context detection** — distinguishes personal, team, and enterprise
  deployment modes. Governs which features are available and how strict the audit
  trail requirements are.
- **Policy enforcement** — enterprise deployments can mandate validation before
  any analysis proceeds, require provenance attestation on all exports, and block
  raw-data egress.
- **No-egress mode** — a policy flag that prevents any dataset row from leaving the
  browser, even to in-org endpoints. Validation, SQL, Python, and R all run locally;
  only lightweight state (metric hashes, provenance receipts) can sync.
- **License boundary** — current license is MIT. A BAA or enterprise agreement would
  be required before a hospital or covered-entity deployment could touch PHI on
  shared infrastructure.
- **Audit export** — enterprise policy enables signed validation-report exports so
  a data governance team can verify what DataGlow found without re-running the suite.

## Privacy architecture note

Enterprise mode does **not** change the local-first privacy guarantee. Data still
never leaves the browser unless the user explicitly exports or shares. Enterprise
mode adds governance *around* that guarantee, not exceptions to it.

## Roadmap

- Versioned clinical rulepacks (healthcare@1.x)
- Real X12 835/837 parsing for claims validation
- Multi-tenant OPFS project isolation
- Scoped identity layer (team roles: analyst / reviewer / admin)
