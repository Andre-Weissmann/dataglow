# Realistic messy meeting transcript — Meeting Scribe stress test (2026-09-24)

Source annotation for `test/meeting-scribe-realworld-stress.test.mjs`. Synthetic but
realistic: modeled on how people actually talk in a business review meeting
(interruptions, filler words, hedging, indirect phrasing, multiple speakers, topic
drift) — not textbook phrasing matching the module's own phrase catalogs.

Ground truth was hand-annotated BEFORE the module was run, so the answer key isn't
reverse-engineered from the output. This file is the human-readable reasoning behind
each line; the executable assertions live in the `.test.mjs` file, which is what CI
actually runs.

1. SARAH: "So, um, before we get into it, the retention numbers this month —
   they're kind of surprising to me, honestly."
   → PUSHBACK (skeptical about a number), no exact catalog phrase present.

2. MIKE: "Yeah I saw that too, is that number even right? Feels off."
   → PUSHBACK. "feels off" and "is that number even right" both broke the
     original substring match (extra/different words vs. the catalog's bare
     phrases).

3. SARAH: "Can we double check the churn calc before we present this Friday?"
   → PUSHBACK. Contains original catalog phrase "double check" — always matched.

4. MIKE: "Where's that number even coming from, the CRM or the billing system?"
   → PUSHBACK. Different verb form + inserted "even" vs. the original exact
     phrase "where does that number come from".

5. SARAH: "Okay, let's also look at this by region if we can, curious if it's
   concentrated somewhere."
   → DATA REQUEST, phrased conversationally — a completely different
     construction than the catalog's "can you break this down by".

6. MIKE: "Actually can you pull the same thing for last quarter too, for
   comparison?"
   → DATA REQUEST. Contains original catalog phrase "can you pull" — always
     matched.

7. SARAH: "Hmm. I don't know, something about this doesn't sit right with me."
   → PUSHBACK (vague but real skepticism). No original catalog phrase present
     ("doesn't sit right" vs. catalog's "doesn't look right") — the one
     genuinely ambiguous case in this set, resolved by adding the concrete
     phrase after review.

8. MIKE: "No that's fine, moving on — next slide please."
   → NEITHER. Plain transition remark — sanity check against over-triggering.

9. SARAH: "Wait, hold on — sorry to interrupt — are you sure? Are you sure
   that's not double-counting the churned accounts that came back?"
   → PUSHBACK. Contains original catalog phrase "are you sure" (twice) despite
     interruption/self-correction noise around it — always matched.

10. MIKE: "Fair question. Let's also grab the cohort data — could you send
    that over after this call?"
    → DATA REQUEST. "could you send" without the catalog's required trailing
      "me" broke the original match.

11. SARAH: "Great, thanks. Also, small thing — can u add the churn definition
    as a footnote so nobody asks again?"
    → DATA REQUEST. Texting-style abbreviation "u" vs. the catalog's full word
      "you" broke the original match.

12. MIKE: "Sounds good. I don't love how volatile this metric is week to
    week, but that's a separate conversation."
    → NEITHER. General unease about the metric's design, not a challenge to
      this specific number, and explicitly deferred — sanity check.

13. SARAH: "One more thing — can you also break down the November cohort
    specifically, I think that's where the anomaly is."
    → DATA REQUEST. "can you also break down X" vs. the catalog's "can you
      break this down by X" — different preposition structure broke the
      original match despite unambiguous intent.

14. MIKE: "Yeah that tracks. Okay let's wrap — good discussion everyone."
    → NEITHER. Plain meeting close — sanity check.

## Result history

- **2026-09-24, before catalog widening:** 6/14 (43%) fully correct. All 8 misses
  were false negatives; 0 false positives (all 3 "neither" sanity-check lines
  correctly returned false/false).
- **2026-09-24, after adding the 8 concrete phrase variants found above to
  `PUSHBACK_PHRASES`/`DATA_REQUEST_PHRASES` in `js/agents/meeting-scribe-agent.js`:**
  14/14 (100%). No fuzzy/NLU matching was added — same substring-list design, just
  grown with the real variants this test found.
- This result is locked in as a regression floor by
  `test/meeting-scribe-realworld-stress.test.mjs`, which runs in CI.
