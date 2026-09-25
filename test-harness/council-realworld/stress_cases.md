# AI Council real-world stress test — scoreAlignment (2026-09-24)

Existing tests (`test/phase11-ai-council.test.mjs`) prove `scoreAlignment` correctly scores
obviously-worded findings ("Revenue increased significantly" vs "Strong positive growth
observed" = agree). This stress test asks: what happens with the kind of verbose, hedged,
multi-clause findings a real LLM (GPT/Claude/Gemini) actually writes in a structured
FINDING section, not a clean one-line textbook sentence?

Ground truth defined by reading the actual `scoreAlignment` implementation before running it
(a signal-word counter: +1 per positive-word hit, -1 per negative-word hit, then compares net
sign between the two texts).

1. **Negation flips a positive signal word but the scorer can't see negation.**
   Finding A: "Revenue increased significantly this quarter."
   Finding B: "Revenue did not increase significantly; the apparent growth was seasonal noise."
   → A human reads these as CONTRADICTING (B explicitly denies A's claim). The scorer counts
     "increase"/"significant" as positive hits in BOTH strings (it has no negation handling),
     so both score positive and the function returns 1 (agree) — a real, meaningful bug: two
     opposing findings get scored as aligned.

2. **A finding that discusses BOTH a positive and a negative aspect nets to a coin-flip score,
   not a real judgment.**
   Finding A: "The trend is positive and the increase is significant, but this could decline
     if the underlying driver weakens."
   Finding B: "This shows a clear positive, significant increase with strong supporting
     evidence."
   → Real content: both are actually positive-leaning findings (A hedges with a caveat, B is
     more confident) — a human would call these ALIGNED. The scorer's net-sign approach happens
     to score A's net as positive (more positive hits: "positive", "increase", "significant"
     vs one negative "decline") — so it correctly agrees here, but only by lucky word-count
     coincidence, not real comprehension. Included as a case that happens to pass, not one to
     "fix" — documenting the mechanism, not a bug by itself.

3. **Verbose hedged findings with roughly equal positive/negative words net to a false neutral.**
   Finding A: "There is a modest positive signal, though it is weak and the improvement is not
     strong enough to be significant on its own."
   Finding B: "The data shows a clear negative trend; performance has declined and is
     significantly worse than the prior period."
   → A human reads A as a WEAK POSITIVE claim (hedged but still net-positive) and B as a CLEAR
     NEGATIVE claim — these should score as CONTRADICTING (-1). But A's text contains "weak"
     (negative signal) and "significant" negated by "not... enough" plus "positive" and
     "improvement" (both positive signals) — the scorer has no negation awareness, so "is not
     strong enough to be significant" still counts "significant" as a positive hit. Actual
     count for A: positive hits ("positive", "improvement", "significant") = 3, negative hits
     ("weak") = 1, net = +2 (positive). B: negative hits ("negative", "declined",
     "significantly", "worse") = 4, positive hits (none clearly) = 0, net = -4. Since sa>0 and
     sb<0, the function actually returns -1 (correctly flagged as CONTRADICTING) — a genuine
     pass despite the messy phrasing, worth confirming empirically rather than assuming.

4. **A finding using none of the catalog's signal words at all.**
   Finding A: "The metric moved from 4.2 to 4.7 over the observed window."
   Finding B: "The value shifted upward across the same period, consistent with the prior
     quarter's trajectory."
   → Both describe the same real phenomenon (an increase) but neither uses a catalog word
     ("increase", "higher", etc. — B says "shifted upward", not "increase"). Expected: scorer
     nets both to 0 (no signal words matched), returns 0 (neutral) — a real recall gap, since a
     human would read these as ALIGNED (both describe an upward move), not "no signal."

Each case's ACTUAL output (not just predicted) is checked in
`test/ai-council-realworld-stress.test.mjs`, since predictions #2 and #3 needed to be verified
against the real function, not assumed.

## Fix applied and its honest limits (2026-09-24)

Added local negation detection (a "not"/"no"/"never"/etc. word within 4 words before a signal
word flips that word's polarity), but scoped to DIRECTIONAL signal words only (increase/
decrease, higher/lower, better/worse, positive/negative, decline, recommend, effective,
improve) -- deliberately excluding magnitude/confidence words (significant, strong, weak,
insignificant). The first version of this fix negated ALL signal words indiscriminately and
that over-corrected: "not strong enough to be significant" (a hedge about magnitude, not a
direction reversal) got misread as a full polarity flip, turning a correctly-scored
contradiction (case 3) into a wrong agreement. Restricting negation to directional words only
fixed that regression while keeping the negation fix for its real target.

**Final verified results after the fix** (see `test/ai-council-realworld-stress.test.mjs`):

1. **Negation flip** -- was AGREE (wrong, dangerous: two contradicting findings said to align),
   now NEUTRAL. This is real, honest progress: NEUTRAL is a safe "no confident directional
   claim" rather than a false "high agreement" claim, even though a human would call this pair
   an outright CONTRADICTION. The residual gap: B's finding ("did not increase... the apparent
   growth was seasonal noise") negates "increase" correctly, but "significant" nearby is not
   itself part of that negated clause and stays positive, netting B to 0 rather than negative.
   Getting this fully to CONTRADICT would need clause-level parsing, not word-window matching --
   out of scope for a signal-word heuristic. Documented here as a known, bounded limitation
   rather than silently left unverified.
2. **Hedged-positive vs confident-positive** -- AGREE both before and after the fix, unaffected
   (not a bug; included to confirm the fix didn't disturb an already-correct case).
3. **Weak-hedged-positive vs clear-negative** -- CONTRADICT before, briefly regressed to AGREE
   during the first (over-broad) version of the fix, restored to CONTRADICT (correct) once
   negation was scoped to directional-only words.
4. **No catalog words at all** -- NEUTRAL before and after (a real recall gap: neither finding
   uses a catalog word, so the scorer sees no signal at all). Not fixed in this pass -- fixing
   it would mean expanding the signal-word vocabulary or moving to semantic similarity, a
   larger scope change than a bug fix. Logged as a follow-up, not silently ignored.
