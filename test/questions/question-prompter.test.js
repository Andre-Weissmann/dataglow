// ============================================================
// DATAGLOW — Question Prompter test suite (Feature 13)
// ============================================================
// Pure-logic module, pure-logic tests: no DuckDB, no DOM, no network.
// RUN WITH: node test/questions/question-prompter.test.js

import {
  QUESTION_TEMPLATES,
  generateQuestions,
  generatePreUploadQuestions,
  inferDomain,
  updateStreamingQuestions,
  rankQuestions,
  generateStarterSQL,
  formatQuestionsCard,
} from '../../js/questions/question-prompter.js';

let passed = 0;
let failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log(`\u2713 ${msg}`); }
  else { failed++; console.log(`\u2717 FAILED: ${msg}`); }
}

const REQUIRED_FIELDS = ['id', 'text', 'priority', 'category', 'triggeredBy', 'suggestedSQL', 'suggestedAction'];

function main() {
  // ---------------------------------------------------------
  // generateQuestions — basic shape
  // ---------------------------------------------------------
  {
    const columnStats = [
      { name: 'insurance_type', type: 'string', nullPct: 14, uniqueCount: 4 },
      { name: 'discharge_status', type: 'string', nullPct: 1, uniqueCount: 5 },
    ];
    const findings = [];
    const questions = generateQuestions(findings, columnStats);
    ok(Array.isArray(questions), 'generateQuestions returns an array');
    ok(questions.length > 0, 'generateQuestions returns at least one question for high-null column stats');
    for (const q of questions) {
      for (const field of REQUIRED_FIELDS) {
        ok(Object.prototype.hasOwnProperty.call(q, field), `Question object has required field "${field}"`);
      }
    }
  }

  // ---------------------------------------------------------
  // high_nulls template fires when nullPct > 10
  // ---------------------------------------------------------
  {
    const statsHigh = [{ name: 'insurance_type', type: 'string', nullPct: 15 }];
    const statsLow = [{ name: 'insurance_type', type: 'string', nullPct: 5 }];
    const qHigh = generateQuestions([], statsHigh);
    const qLow = generateQuestions([], statsLow);
    ok(qHigh.some(q => q.triggeredBy.includes('high_nulls')), 'high_nulls fires when nullPct > 10');
    ok(!qLow.some(q => q.triggeredBy.includes('high_nulls')), 'high_nulls does NOT fire when nullPct <= 10');
  }

  // ---------------------------------------------------------
  // right_skew template fires when skewness > 2
  // ---------------------------------------------------------
  {
    const statsSkewed = [{ name: 'transaction_amount', type: 'number', skewness: 3.2 }];
    const statsNormal = [{ name: 'transaction_amount', type: 'number', skewness: 0.5 }];
    const qSkewed = generateQuestions([], statsSkewed);
    const qNormal = generateQuestions([], statsNormal);
    ok(qSkewed.some(q => q.triggeredBy.includes('right_skew')), 'right_skew fires when skewness > 2');
    ok(!qNormal.some(q => q.triggeredBy.includes('right_skew')), 'right_skew does NOT fire when skewness <= 2');
  }

  // ---------------------------------------------------------
  // outliers template fires when findings contain outlier finding
  // ---------------------------------------------------------
  {
    const findings = [{ type: 'outlier', column: 'basket_value', count: 12, threshold: '3 std dev' }];
    const questions = generateQuestions(findings, []);
    ok(questions.some(q => q.triggeredBy.includes('outliers')), 'outliers template fires from an outlier finding');
    const outlierQ = questions.find(q => q.triggeredBy.includes('outliers'));
    ok(outlierQ.text.includes('basket_value'), 'outliers question text includes the triggering column name');
  }

  // ---------------------------------------------------------
  // fanout template fires when findings contain fanout finding
  // ---------------------------------------------------------
  {
    const findings = [{ type: 'fanout', tableA: 'orders', tableB: 'line_items', ratio: 3.4 }];
    const questions = generateQuestions(findings, []);
    ok(questions.some(q => q.triggeredBy.includes('fanout')), 'fanout template fires from a fanout finding');
    const fanoutQ = questions.find(q => q.triggeredBy.includes('fanout'));
    ok(fanoutQ.text.includes('orders') && fanoutQ.text.includes('line_items'), 'fanout question mentions both tables');
  }

  // ---------------------------------------------------------
  // maxQuestions option is respected
  // ---------------------------------------------------------
  {
    const columnStats = [
      { name: 'a', nullPct: 20 },
      { name: 'b', nullPct: 30 },
      { name: 'c', skewness: 5 },
      { name: 'd', skewness: 6 },
      { name: 'e', uniqueCount: 3 },
    ];
    const findings = [
      { type: 'outlier', column: 'f', count: 3 },
      { type: 'fanout', tableA: 'x', tableB: 'y', ratio: 2 },
    ];
    const questions = generateQuestions(findings, columnStats, { maxQuestions: 3 });
    ok(questions.length <= 3, `generateQuestions respects maxQuestions option (got ${questions.length}, max 3)`);
  }

  // ---------------------------------------------------------
  // healthcare domain adds healthcare-specific questions
  // ---------------------------------------------------------
  {
    // Column name here is deliberately NOT LOS-shaped so the two branches
    // (domain-driven vs. name-driven) are isolated: this checks the domain
    // option alone can surface healthcare_los when a LOS-like column exists
    // elsewhere in stats under a slightly different name ("discharge" pattern).
    const columnStatsWithDischarge = [{ name: 'discharge', type: 'number', min: 1, max: 45 }];
    const columnStatsUnrelated = [{ name: 'widget_count', type: 'number', min: 1, max: 45 }];
    const questionsHealthcare = generateQuestions([], columnStatsWithDischarge, { domain: 'healthcare' });
    const questionsGeneral = generateQuestions([], columnStatsUnrelated, { domain: 'general' });
    ok(questionsHealthcare.some(q => q.triggeredBy.includes('healthcare_los')), 'healthcare domain adds healthcare_los question when a discharge/LOS-shaped column exists');
    ok(!questionsGeneral.some(q => q.triggeredBy.includes('healthcare_los')), 'general domain with an unrelated column does NOT add healthcare_los question');
  }

  // ---------------------------------------------------------
  // domain-specific healthcare template fires for LOS column name (even without domain hint)
  // ---------------------------------------------------------
  {
    const columnStats = [{ name: 'length_of_stay', type: 'number', min: 0, max: 60 }];
    const questions = generateQuestions([], columnStats);
    ok(questions.some(q => q.triggeredBy.includes('healthcare_los')), 'LOS-named column triggers healthcare_los template without explicit domain option');
  }

  // ---------------------------------------------------------
  // generateQuestions returns empty array when no findings and no column stats
  // ---------------------------------------------------------
  {
    const questions = generateQuestions([], []);
    ok(Array.isArray(questions) && questions.length === 0, 'generateQuestions returns empty array when given no findings and no column stats');
  }

  // ---------------------------------------------------------
  // generatePreUploadQuestions
  // ---------------------------------------------------------
  {
    const columnNames = ['claim_id', 'patient_id', 'admit_date', 'discharge_date', 'total_charge_amount'];
    const questions = generatePreUploadQuestions('claims_2024.csv', columnNames);
    ok(Array.isArray(questions), 'generatePreUploadQuestions returns an array');
    ok(questions.length >= 3 && questions.length <= 5, `generatePreUploadQuestions returns 3-5 questions (got ${questions.length})`);
    for (const q of questions) {
      for (const field of REQUIRED_FIELDS) {
        ok(Object.prototype.hasOwnProperty.call(q, field), `Pre-upload question has required field "${field}"`);
      }
    }
  }

  // ---------------------------------------------------------
  // generatePreUploadQuestions identifies date column by name pattern
  // ---------------------------------------------------------
  {
    const questions = generatePreUploadQuestions('events.csv', ['event_id', 'created_date', 'value']);
    ok(questions.some(q => q.triggeredBy.includes('date-like column name')), 'generatePreUploadQuestions identifies a date-like column by name pattern');
  }

  // ---------------------------------------------------------
  // generatePreUploadQuestions identifies amount column by name pattern
  // ---------------------------------------------------------
  {
    const questions = generatePreUploadQuestions('orders.csv', ['order_id', 'order_date', 'total_amount']);
    ok(questions.some(q => q.triggeredBy.includes('amount-like column name')), 'generatePreUploadQuestions identifies an amount-like column by name pattern');
  }

  // ---------------------------------------------------------
  // inferDomain
  // ---------------------------------------------------------
  {
    ok(inferDomain('claims_2024.csv', ['patient_id', 'icd_code', 'diagnosis']) === 'healthcare',
      "inferDomain returns 'healthcare' for claims/patient/icd column names");
    ok(inferDomain('ledger.csv', ['revenue', 'account_id', 'transaction_date']) === 'finance',
      "inferDomain returns 'finance' for revenue/account/transaction column names");
    ok(inferDomain('misc.csv', ['col1', 'col2', 'notes']) === 'general',
      "inferDomain returns 'general' for ambiguous column names");
    ok(inferDomain('claims_q2.csv', ['id', 'value']) === 'healthcare',
      "inferDomain uses file name as a signal (e.g. claims_q2.csv -> healthcare)");
  }

  // ---------------------------------------------------------
  // updateStreamingQuestions
  // ---------------------------------------------------------
  {
    const initialFindings = [{ type: 'outlier', column: 'amount', count: 4 }];
    const initialResult = updateStreamingQuestions([], initialFindings, 1);
    ok(initialResult.questions.length > 0, 'updateStreamingQuestions produces questions from the first batch');
    ok(initialResult.newQuestions.length === initialResult.questions.length, 'first batch: all questions are "new"');

    const batch2Findings = [
      { type: 'outlier', column: 'amount', count: 4 },
      { type: 'fanout', tableA: 'orders', tableB: 'items', ratio: 2.1 },
    ];
    const result2 = updateStreamingQuestions(initialResult.questions, batch2Findings, 2);
    ok(result2.newQuestions.some(q => q.triggeredBy.includes('fanout')), 'updateStreamingQuestions adds new questions revealed by a later batch');

    const batch3Findings = [{ type: 'fanout', tableA: 'orders', tableB: 'items', ratio: 2.1 }];
    const result3 = updateStreamingQuestions(result2.questions, batch3Findings, 3);
    ok(result3.resolvedQuestions.some(q => q.triggeredBy.includes('outliers')), 'updateStreamingQuestions marks the outliers question resolved once it stops appearing in the batch');
  }

  // ---------------------------------------------------------
  // rankQuestions
  // ---------------------------------------------------------
  {
    const questions = [
      { id: 'q1', text: 'low priority q', priority: 'low', category: 'exploration', triggeredBy: 'x', suggestedSQL: null, suggestedAction: 'a' },
      { id: 'q2', text: 'high priority q', priority: 'high', category: 'quality', triggeredBy: 'y', suggestedSQL: null, suggestedAction: 'b' },
      { id: 'q3', text: 'medium priority q', priority: 'medium', category: 'business', triggeredBy: 'z', suggestedSQL: null, suggestedAction: 'c' },
    ];
    const ranked = rankQuestions(questions);
    ok(ranked[0].priority === 'high', 'rankQuestions sorts high priority first');
    ok(ranked[ranked.length - 1].priority === 'low', 'rankQuestions sorts low priority last');

    const rankedExcluding = rankQuestions(questions, [questions[1]]);
    ok(!rankedExcluding.some(q => q.id === 'q2'), 'rankQuestions excludes previously-shown questions');
    ok(rankedExcluding.length === 2, 'rankQuestions returns remaining questions after exclusion');
  }

  // ---------------------------------------------------------
  // generateStarterSQL
  // ---------------------------------------------------------
  {
    const columnStats = [{ name: 'insurance_type', nullPct: 14 }];
    const questions = generateQuestions([], columnStats);
    const nullQ = questions.find(q => q.triggeredBy.includes('high_nulls'));
    ok(!!nullQ, 'high_nulls question exists for SQL generation test');
    const sql = generateStarterSQL(nullQ, 'claims', columnStats);
    ok(typeof sql === 'string' && sql.length > 0, 'generateStarterSQL returns a non-empty SQL string');
    ok(sql.includes('insurance_type'), 'generateStarterSQL returns SQL string containing the column name');
    ok(/COUNT\(\*\)\s*-\s*COUNT\(/.test(sql), 'generateStarterSQL for high_nulls returns a COUNT(*) - COUNT(...) query');
    ok(sql.includes('claims'), 'generateStarterSQL includes the provided table name');
  }

  // ---------------------------------------------------------
  // formatQuestionsCard
  // ---------------------------------------------------------
  {
    const columnStats = [{ name: 'insurance_type', nullPct: 14 }];
    const questions = generateQuestions([], columnStats, { includeSQL: true, tableName: 'claims' });
    const card = formatQuestionsCard(questions);
    ok(typeof card === 'string', 'formatQuestionsCard returns a string');
    ok(card.includes('WHERE TO START'), 'formatQuestionsCard includes the "WHERE TO START" header');
    ok(/\[HIGH\]|\[MEDIUM\]|\[LOW\]/.test(card), 'formatQuestionsCard includes a priority level tag in the output');

    const emptyCard = formatQuestionsCard([]);
    ok(emptyCard.includes('WHERE TO START'), 'formatQuestionsCard handles an empty question list gracefully');
  }

  // ---------------------------------------------------------
  // Question ids are deterministic
  // ---------------------------------------------------------
  {
    const stats = [{ name: 'insurance_type', nullPct: 14 }];
    const q1 = generateQuestions([], stats);
    const q2 = generateQuestions([], stats);
    ok(q1.length > 0 && q2.length > 0, 'deterministic id test has questions to compare');
    ok(q1[0].id === q2[0].id, 'Question ids are deterministic: same input produces the same id');

    const statsDiff = [{ name: 'insurance_type', nullPct: 40 }];
    const q3 = generateQuestions([], statsDiff);
    ok(q3[0].id !== q1[0].id, 'Question ids differ when the triggering value materially differs');
  }

  // ---------------------------------------------------------
  // QUESTION_TEMPLATES sanity
  // ---------------------------------------------------------
  {
    ok(typeof QUESTION_TEMPLATES === 'object', 'QUESTION_TEMPLATES is exported as an object');
    ok(Object.keys(QUESTION_TEMPLATES).length >= 14, 'QUESTION_TEMPLATES contains all documented template keys');
    ok('right_skew' in QUESTION_TEMPLATES && 'schema_only_amount' in QUESTION_TEMPLATES, 'QUESTION_TEMPLATES includes both statistical and schema-only templates');
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main();
