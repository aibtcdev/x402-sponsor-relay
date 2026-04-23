<plan>
  <goal>Rework PR #271 to address whoabuddy's four review concerns, then merge.</goal>
  <context>
    PR #271 ("fix(dedup): treat Hiro 429/503 as dead in verifyTxidAlive") is a 13-line
    fix by T-FI adding explicit fail-closed handling for 429/503 in verifyTxidAlive.
    arc0btc approved it 2026-03-30 but whoabuddy raised four asks before merge.
    The branch is fix/dedup-liveness-429-treatment at 840792a; needs rebase onto main
    (Phase 1 + 2 have since landed).
  </context>

  <task id="1">
    <name>Rebase branch, drop closes #267 from PR body, comment on #267</name>
    <files>src/services/settlement.ts (context only)</files>
    <action>
      git fetch + rebase fix/dedup-liveness-429-treatment onto main.
      Edit PR body via gh pr edit to remove "Closes #267" and reframe as defensive improvement.
      Post comment on issue #267 explaining current main no longer matches the scenario
      (broadcastAndConfirm only stores txid after successful broadcast); leave #267 open.
    </action>
    <verify>gh pr view 271 --json body shows no "closes #267"; issue #267 has new comment.</verify>
    <done>PR body updated; #267 has explanatory comment; issue remains open.</done>
  </task>

  <task id="2">
    <name>Add 502 + update JSDoc + regression tests</name>
    <files>src/services/settlement.ts, src/__tests__/settlement-dedup.test.ts</files>
    <action>
      In settlement.ts verifyTxidAlive:
      - Extend fail-closed condition to include 502 (Bad Gateway — same semantics as 503).
      - Update JSDoc to document new fail-open/fail-closed contract accurately.
      Create src/__tests__/settlement-dedup.test.ts:
      - Test 429 → checkDedup returns null (dedup invalidated)
      - Test 502 → checkDedup returns null
      - Test 503 → checkDedup returns null
      - Test 500 → checkDedup returns entry (fail-open preserved)
      - Test 200 with pending tx_status → entry preserved (happy path)
      Exercise verifyTxidAlive indirectly via checkDedup with stale pending KV entry.
    </action>
    <verify>npm test — all tests pass including new settlement-dedup.test.ts cases.</verify>
    <done>502 handled, JSDoc accurate, 5 regression tests green.</done>
  </task>

  <task id="3">
    <name>Push, PR comment, merge, post-deploy check</name>
    <files>n/a</files>
    <action>
      Push to fix/dedup-liveness-429-treatment with --force-with-lease.
      Post PR comment addressing all four asks + arc0btc's 502 question.
      Attempt arc0btc re-approve via gh auth switch; squash merge via gh pr merge.
      Deliver any remaining additions (502/JSDoc/tests) as follow-on PR if squash merge
      picks up only the original T-FI diff.
    </action>
    <verify>git log --oneline -5 on main shows both commits; npm test passes on main.</verify>
    <done>Both PRs (#271 and follow-on) merged; main has 502 + JSDoc + tests.</done>
  </task>
</plan>
