# Capability detail — Visualization

Companion to the **Visualization** area in
[`../capability-map.md`](../capability-map.md).

## What this area is

The chart and dashboard layer: turning query results and validation findings into
visual output. Backing module: `js/chart/chart-engine.js`.

## Chart engine (`chart-engine.js`)

- Auto-selects chart type from query result shape: bar for categorical comparisons,
  line for time-series, histogram for distributions, donut for part-of-whole.
- Renders via Canvas 2D — zero third-party dependencies, no CDN round-trip.
- All chart data is computed locally; no row data is sent to any rendering service.
- Supports export to PNG for inclusion in reports.

## Glow Canvas (dashboard builder)

Multi-chart canvas with cross-filtering. Analysts can pin multiple query results
as chart tiles, arrange them spatially, and click a segment on one chart to filter
all others. Canvas state serialises to JSON for OPFS persistence across sessions.

## Design standards

DataGlow charts follow the design-foundations palette:
- Primary chart series: Teal `#20808D`
- Secondary series follow the eight-colour curated sequence
- Chart titles state the insight, not the data ("Revenue grew 23% in Q4" not
  "Revenue Chart")
- Labels are placed directly on data points where possible; legends only when
  direct labelling would clutter
- Never 3D charts, never pie with 5+ slices, never dual-axis charts
