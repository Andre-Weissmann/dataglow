/**
 * DataGlow — main.js
 * Entry point for the modular source build.
 *
 * This file is the coordinator. The build script (build.sh) concatenates
 * every module listed here into a single self-contained index.html for
 * deployment. Module order matters — dependencies must come before dependents.
 *
 * To build for deployment:
 *   ./build.sh
 * Output: canvas/index.html (the file served at dataglow-platform.pplx.app)
 *
 * Source structure:
 *   src/
 *   ├── css/main.css              — all styles
 *   ├── index.html                — HTML shell (no inline CSS or JS)
 *   └── js/
 *       ├── main.js               — this file
 *       ├── infra/                — app bootstrap, PWA, UX utilities
 *       ├── core/ → grid, sql, chart, dashboard, nl-engine
 *       ├── ingestion/            — drop-zone, parsers, OCR
 *       ├── features/             — mirror, replay, autopilot, browser-llm
 *       ├── panels/               — analyze-tab panels
 *       ├── data/                 — sample datasets (SynPUF, etc.)
 *       └── (other domain dirs)   — join, anomaly, insight, story, etc.
 */

(function () {
  'use strict';

  /* ============================================================
     INLINED PURE-LOGIC MODULES (zero-build-step compatibility)
     ------------------------------------------------------------
     The functions below are copied inline from the repo's pure-logic
     js/ modules so this single self-contained HTML file has no
     <script src="..."> dependency on a server. Each block names its
     source file. Keep behavior identical to the source module.
     ============================================================ */

  // ── Load order (dependency-first) ──────────────────────────────────────
  // 1. Infrastructure & bootstrap
  // @@INCLUDE: src/js/infra/infrastructure.js
  // @@INCLUDE: src/js/infra/privacy-badge.js
  // @@INCLUDE: src/js/infra/pwa.js
  // @@INCLUDE: src/js/infra/ux-overhaul.js

  // 2. Ingestion pipeline
  // @@INCLUDE: src/js/drop-zone/drop-zone-router.js
  // @@INCLUDE: src/js/ingestion/text-line-parser.js
  // @@INCLUDE: src/js/ingestion/image-ocr.js
  // @@INCLUDE: src/js/ingestion/json-flattener.js
  // @@INCLUDE: src/js/ingestion/api-feed.js

  // 3. Storage & memory
  // @@INCLUDE: src/js/storage/opfs-engine.js
  // @@INCLUDE: src/js/storage/workspace-profile.js
  // @@INCLUDE: src/js/memory/institutional-memory.js

  // 4. Core engines
  // @@INCLUDE: src/js/grid/canvas-grid.js
  // @@INCLUDE: src/js/sql/sql-engine.js
  // @@INCLUDE: src/js/nl/nl-engine.js
  // @@INCLUDE: src/js/chart/chart-engine.js
  // @@INCLUDE: src/js/export/export-engine.js
  // @@INCLUDE: src/js/columns/column-editor.js
  // @@INCLUDE: src/js/join/cardinality-detector.js
  // @@INCLUDE: src/js/join/join-builder.js
  // @@INCLUDE: src/js/anomaly/anomaly-timeline.js
  // @@INCLUDE: src/js/dashboard/findings-rail.js
  // @@INCLUDE: src/js/dashboard/proof-chain-rail.js
  // @@INCLUDE: src/js/dashboard/dashboard-engine.js
  // @@INCLUDE: src/js/insight/insight-engine.js

  // 5. Supporting engines
  // @@INCLUDE: src/js/provenance/provenance-engine.js
  // @@INCLUDE: src/js/streaming/streaming-validator.js
  // @@INCLUDE: src/js/proof/proof-builder.js
  // @@INCLUDE: src/js/rooms/rooms-builder.js
  // @@INCLUDE: src/js/nats/nats-message-parser.js
  // @@INCLUDE: src/js/nats/nats-bridge.js
  // @@INCLUDE: src/js/connectors/connector-manager.js
  // @@INCLUDE: src/js/publish/publish-engine.js

  // 6. Panels (analyze tab)
  // @@INCLUDE: src/js/panels/sql-builder-legacy.js
  // @@INCLUDE: src/js/panels/sql-query-builder.js
  // @@INCLUDE: src/js/panels/stats-legacy.js
  // @@INCLUDE: src/js/panels/stats.js
  // @@INCLUDE: src/js/panels/arena-legacy.js
  // @@INCLUDE: src/js/panels/arena.js
  // @@INCLUDE: src/js/panels/case-library-legacy.js
  // @@INCLUDE: src/js/panels/case-library.js
  // @@INCLUDE: src/js/panels/window-dojo-legacy.js
  // @@INCLUDE: src/js/panels/window-dojo.js
  // @@INCLUDE: src/js/panels/business-translation-legacy.js
  // @@INCLUDE: src/js/panels/business-translation.js
  // @@INCLUDE: src/js/panels/osce-legacy.js
  // @@INCLUDE: src/js/panels/osce.js
  // @@INCLUDE: src/js/panels/peer-review-legacy.js
  // @@INCLUDE: src/js/panels/peer-review.js
  // @@INCLUDE: src/js/panels/take-home-case.js
  // @@INCLUDE: src/js/panels/question-prompter-legacy.js
  // @@INCLUDE: src/js/panels/question-prompter.js
  // @@INCLUDE: src/js/panels/narrative-legacy.js
  // @@INCLUDE: src/js/panels/narrative.js
  // @@INCLUDE: src/js/panels/skill-progression-legacy.js
  // @@INCLUDE: src/js/panels/skill-progression.js
  // @@INCLUDE: src/js/panels/level-system.js
  // @@INCLUDE: src/js/panels/witness.js
  // @@INCLUDE: src/js/panels/formula-tooltip.js
  // @@INCLUDE: src/js/panels/privacy-audit.js

  // 7. Features
  // @@INCLUDE: src/js/features/mission-brief-legacy.js
  // @@INCLUDE: src/js/features/mission-brief.js
  // @@INCLUDE: src/js/features/browser-llm-chip.js
  // @@INCLUDE: src/js/features/browser-llm-engine.js
  // @@INCLUDE: src/js/features/browser-llm.js
  // @@INCLUDE: src/js/features/browser-llm-wiring.js
  // @@INCLUDE: src/js/features/mirror-legacy.js
  // @@INCLUDE: src/js/features/mirror.js
  // @@INCLUDE: src/js/features/mirror-engine.js
  // @@INCLUDE: src/js/features/replay-legacy.js
  // @@INCLUDE: src/js/features/replay-engine.js
  // @@INCLUDE: src/js/features/replay-ui.js
  // @@INCLUDE: src/js/features/replay-wiring.js
  // @@INCLUDE: src/js/features/ai-director-legacy.js
  // @@INCLUDE: src/js/features/ai-director.js
  // @@INCLUDE: src/js/features/projects.js
  // @@INCLUDE: src/js/features/portfolio-export.js

  // 8. Story & data
  // @@INCLUDE: src/js/story/story-builder.js
  // @@INCLUDE: src/js/data/synpuf-datasets.js

  // 9. UX utilities (run last — wire everything together)
  // @@INCLUDE: src/js/infra/ux-spotlight-legacy.js
  // @@INCLUDE: src/js/infra/ux-empty-states-legacy.js
  // @@INCLUDE: src/js/infra/ux-nl-pulse-legacy.js

})();
