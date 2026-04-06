<plan>
  <goal>Update documentation to reflect all dashboard changes from Phases 1-5: new /stats fields, tx-decode utility, terminal reasons, timestamp semantics, and settlement filtering.</goal>
  <context>
    Phases 1-5 added: submitted_at/is_gap_fill to NonceDO, extractTransferDetails() in
    src/utils/tx-decode.ts, 19 terminal reasons across 6 categories in /stats terminalReasons,
    walletThroughput array, dual success rates (rawSuccessRate/effectiveSuccessRate), previous24h
    comparison object, and settlementTimes percentiles that exclude gap-fills.

    CLAUDE.md currently:
    - Lists GET /stats without any response shape
    - Lists Key Files without src/utils/tx-decode.ts
    - Settlement states section doesn't mention gap-fill filtering

    discovery.ts /llms-full.txt (around line 848):
    - GET /stats section is just 3 lines with no response shape

    QUEST.md status is still "pending" — needs updating to "active".
    STATE.md phase 6 row says "pending" — needs updating to "active".
  </context>

  <task id="1">
    <name>Update CLAUDE.md: /stats response shape, tx-decode key file, settlement gap-fill note</name>
    <files>CLAUDE.md</files>
    <action>
      1. In the Endpoints section, expand GET /stats bullet to note it returns new fields.
      2. In the Request/Response section, add a GET /stats response shape block showing:
         transactions (total, success, failed, clientErrors, trend, previousTotal,
         rawSuccessRate, effectiveSuccessRate), tokens (STX/sBTC/USDCx with count/volume/percentage),
         settlement (status, avgLatencyMs, uptime24h, lastCheck), settlementTimes (p50, p95, avg,
         count — gap-fill txs excluded), terminalReasons (validation, sender, relay, settlement,
         replacement, identity), walletThroughput (walletIndex, total24h, success24h, failed24h,
         feeTotal24h, hourly[]), previous24h (total, success, failed).
      3. In Key Files section, add entry for src/utils/tx-decode.ts.
      4. In Settlement states section, add note that settlementTimes percentiles exclude gap-fill
         transactions (is_gap_fill=true) to prevent artificial inflation.
      5. In Nonce queue semantics section, add note about submitted_at vs dispatched_at vs queued_at
         timestamp distinction.
    </action>
    <verify>
      grep -n "tx-decode" CLAUDE.md  # should find the new Key Files entry
      grep -n "terminalReasons" CLAUDE.md  # should find in /stats response shape
      grep -n "gap.fill" CLAUDE.md  # should find in settlement states note
    </verify>
    <done>CLAUDE.md has /stats response shape, tx-decode in Key Files, gap-fill note in settlement states, and timestamp semantics in nonce queue section.</done>
  </task>

  <task id="2">
    <name>Update discovery.ts /llms-full.txt GET /stats section with response shape</name>
    <files>src/routes/discovery.ts</files>
    <action>
      Expand the GET /stats section (around line 848) in the /llms-full.txt handler to include:
      - A JSON response example showing the key new fields: terminalReasons, walletThroughput,
        rawSuccessRate, effectiveSuccessRate, previous24h, and settlementTimes.
      - Brief field descriptions inline as comments.
      Keep the update surgical — only change the GET /stats block, not the surrounding text.
    </action>
    <verify>
      grep -n "terminalReasons\|walletThroughput\|effectiveSuccessRate" src/routes/discovery.ts
      # should show results in the /llms-full.txt handler
    </verify>
    <done>discovery.ts /llms-full.txt GET /stats section includes a response example with new fields.</done>
  </task>

  <task id="3">
    <name>Update QUEST.md and STATE.md final status</name>
    <files>.planning/2026-04-06-schema-driven-dashboard/QUEST.md, .planning/2026-04-06-schema-driven-dashboard/STATE.md</files>
    <action>
      1. In QUEST.md, change `## Status` from "pending" to "active".
      2. In STATE.md, change phase 6 row from "pending" to "active" in the Phase Status table,
         and add a Phase 6 activity log entry.
    </action>
    <verify>
      grep "Status" .planning/2026-04-06-schema-driven-dashboard/QUEST.md
      grep "6.*active\|active.*6" .planning/2026-04-06-schema-driven-dashboard/STATE.md
    </verify>
    <done>QUEST.md shows "active" status; STATE.md shows phase 6 active with activity log entry.</done>
  </task>
</plan>
