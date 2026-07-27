# R3 Screenshot capture + R4 Ship pack SPEC

## R3 Screenshot / proof capture
- Button "Capture step" (local only) uses html2canvas or native if present; else canvas draw fallback
- Saves PNG blob to IndexedDB or download with step name + timestamp
- Steps: home, loaded, validate, scout, prove, narrative, export
- No network upload

## R4 Ship pack
- Button "Export ship pack" builds ZIP or multi-download JSON bundle:
  - keepers.json (from Scout if present)
  - claims.json (proven claims + SQL + engine ids)
  - validation_summary.json
  - honest_claims.md template (no pure-local overclaim)
  - screenshots/ if any captured
- window.DataGlowShipPack.export()

## Ship
One branch feature/r3-r4-capture-ship or two if cleaner.
PR DO NOT MERGE. Tests. RESULT md.
No em dash visible. canvas authoritative.
Skip R2 mission picker entirely.
