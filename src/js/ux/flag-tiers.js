/* ---- from js/ux/flag-tiers.js ---- */
/* ================================================================
   DataGlow Flag Tiers -- Progressive Disclosure for Feature Flags
   Feature flag: window.FEATURE_FLAGS.flagTiers

   101 flags all set to true = every feature visible simultaneously.
   Jobs principle: show only what is relevant to the analyst's
   current context. Complexity is revealed, not dumped.

   TIER 0 -- Always visible (first screen, no data loaded)
     Core analysis tools. Minimal. Purposeful.

   TIER 1 -- Unlocked when first dataset loads
     All analysis, validation, AI tools.

   TIER 2 -- Unlocked at Pulse score >= 70
     Advanced features requiring clean-enough data.

   TIER 3 -- Unlocked at Pulse score >= 90 (Dashboard gate)
     Governance exports, provenance, IRB-grade features.

   Implementation:
     - CSS: [data-flag-tier="N"] hidden unless body has .tier-N-unlocked
     - JS: listens to dataglow:dataset-loaded and dataglow:pulse-scored
     - No features are removed -- only their UI visibility changes
     - Analyst can always unlock all tiers manually in Feature Settings
================================================================ */
(function () {
  'use strict';

  /* Guard */
  if (!window.FEATURE_FLAGS || !window.FEATURE_FLAGS.flagTiers) return;

  /* ---- Tier definitions ---- */
  var TIERS = {
    /* Tier 0: always on. The minimal viable DataGlow. */
    0: [
      'nlSql', 'questionPrompter', 'peerReview',
      'anomalyDetection', 'exportEngine',
      'purposeContracts', 'biasPreflight',
      'whisperVoice', 'gemmaReflex'
    ],

    /* Tier 1: unlocked on first dataset load */
    1: [
      'chronosForecast', 'polyglotWorkbench', 'dataVersionControl',
      'crucibleValidator', 'crucibleValidatorUI',
      'relationalValidators', 'foreignKeyChecker', 'joinCoverageChecker',
      'temporalOrderChecker', 'flagConsistencyChecker',
      'missingnessDetective', 'upperBoundSanity', 'categoricalConsistency',
      'domainPhysics', 'healthStandards', 'rulepacks',
      'imputation', 'formatFingerprint', 'selfLearningRules',
      'adaptivePriority', 'queryMemory', 'memoryStore',
      'glowCanvas', 'psiHandshake', 'qrTransport',
      'microLessons', 'drillFloor', 'nutritionBadges',
      'trustStrip', 'proofExport', 'provenancePacket',
      'metricStudio', 'roleContext'
    ],

    /* Tier 2: unlocked at Pulse >= 70 */
    2: [
      'aiCouncil', 'semanticLayer', 'semanticDriftWatchdog',
      'timeMachine', 'digitalTwin', 'syntheticTwin', 'syntheticAdversarial',
      'equityStratification', 'statisticalRigor', 'devilsAdvocate',
      'robustnessVerdict', 'goldenSignals', 'calibratedGrades',
      'problemFramer', 'costOfBadData', 'analysisContract',
      'spcControl', 'isolationForest', 'anomalyDetection',
      'guardedCopilot', 'narrativeStory', 'narrativeOverconfidenceGuard',
      'portfolioNarrativeAssembler', 'meetingScribe',
      'objectSpace', 'glowOrb', 'glowPathRail',
      'trustCertificate', 'trustBeam', 'verifiableCheckSeal',
      'phiPromptGuard', 'querySentinel', 'querySentinelAssist',
      'privacyBudget', 'deidentificationVerifier',
      'sqlDialectAdapter', 'communityPack'
    ],

    /* Tier 3: unlocked at Pulse >= 90 (Dashboard gate) */
    3: [
      'irbMode', 'zkThresholdProof', 'analysisFingerprint',
      'trainingPassport', 'syntheticDataPassport',
      'gateExporter', 'airGapCert', 'federatedQualityScore',
      'incidentPostmortem', 'denialRootCause',
      'drgIcdValidator', 'ncciValidator',
      'dataDiplomacy', 'sourceConvergence',
      'dataglowRooms', 'natsConnector', 'tauriConnector',
      'crucibleOrchestration', 'crucibleRevertProposals',
      'meetingScribeLiveCapture', 'meetingDecisionLedger',
      'aiTouchLedger', 'agentGate', 'uncertaintyResolver',
      'onDeviceLLM'
    ]
  };

  /* Reverse map: flag name -> tier number */
  var FLAG_TIER_MAP = {};
  Object.keys(TIERS).forEach(function (tier) {
    TIERS[tier].forEach(function (flag) {
      FLAG_TIER_MAP[flag] = parseInt(tier, 10);
    });
  });

  /* Current unlocked tier level (0 = only tier 0 visible) */
  var _unlockedTier = 0;

  /* ---- Body class management ---- */
  function applyTierClasses(tier) {
    _unlockedTier = tier;
    for (var t = 0; t <= 3; t++) {
      if (t <= tier) {
        document.body.classList.add('tier-' + t + '-unlocked');
      } else {
        document.body.classList.remove('tier-' + t + '-unlocked');
      }
    }
    /* Also fire a custom event so other systems can react */
    document.dispatchEvent(new CustomEvent('dataglow:tier-changed', {
      detail: { tier: tier }
    }));
  }

  /* ---- Annotate sidebar + panel items with their tier ---- */
  /*
   * Any DOM element with data-feature="flagName" gets data-flag-tier="N"
   * added automatically. CSS then handles show/hide.
   * This runs once on DOMContentLoaded and again after any dynamic render.
   */
  function annotateTiers() {
    document.querySelectorAll('[data-feature]').forEach(function (el) {
      var flag = el.getAttribute('data-feature');
      var tier = FLAG_TIER_MAP[flag];
      if (tier !== undefined) {
        el.setAttribute('data-flag-tier', tier);
      }
    });

    /* Also annotate sidebar nav items by their tool name */
    var TOOL_TIER_MAP = {
      'sql':         0,
      'python':      0,
      'r':           1,
      'excel':       1,
      'validate':    0,
      'review':      0,
      'witness':     1,
      'dashboard':   3,
      'explore':     0,
      'query':       0
    };
    document.querySelectorAll('[data-panel], [data-tool], .sidebar-nav-item').forEach(function (el) {
      var tool = el.getAttribute('data-panel') || el.getAttribute('data-tool');
      if (!tool) return;
      var key = tool.toLowerCase().replace(/-view$/, '');
      var tier = TOOL_TIER_MAP[key];
      if (tier !== undefined && !el.hasAttribute('data-flag-tier')) {
        el.setAttribute('data-flag-tier', tier);
      }
    });
  }

  /* ---- Event listeners ---- */
  document.addEventListener('dataglow:dataset-loaded', function () {
    if (_unlockedTier < 1) applyTierClasses(1);
    /* Re-annotate in case sidebar was rendered after init */
    setTimeout(annotateTiers, 200);
  });

  document.addEventListener('dataglow:pulse-scored', function (e) {
    var score = e.detail && e.detail.score;
    if (score === undefined || score === null) return;
    var newTier = _unlockedTier;
    if (score >= 90) newTier = 3;
    else if (score >= 70) newTier = 2;
    else newTier = 1; /* already past tier 0 since data is loaded */
    if (newTier > _unlockedTier) applyTierClasses(newTier);
  });

  /* Manual override from Feature Settings -- unlock all tiers */
  document.addEventListener('dataglow:unlock-all-tiers', function () {
    applyTierClasses(3);
  });

  /* ---- Init ---- */
  function init() {
    /* Start at tier 0 */
    applyTierClasses(0);
    annotateTiers();

    /* Observe DOM mutations to annotate newly rendered elements */
    if (window.MutationObserver) {
      var obs = new MutationObserver(function (mutations) {
        var needsAnnotation = mutations.some(function (m) {
          return m.addedNodes.length > 0;
        });
        if (needsAnnotation) annotateTiers();
      });
      obs.observe(document.body, { childList: true, subtree: true });
    }

    /* Expose for Feature Settings panel */
    window.FlagTiers = {
      getCurrentTier: function () { return _unlockedTier; },
      unlockTier: applyTierClasses,
      unlockAll: function () { applyTierClasses(3); },
      getTierForFlag: function (flag) { return FLAG_TIER_MAP[flag]; },
      TIERS: TIERS
    };
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
/* ---- end js/ux/flag-tiers.js ---- */
