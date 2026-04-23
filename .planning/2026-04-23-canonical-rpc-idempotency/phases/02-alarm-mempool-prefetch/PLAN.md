<plan>
  <goal>Move fetchMempoolForSponsor loop outside blockConcurrencyWhile in alarm(), running all wallet snapshots in parallel (Promise.all), consistent with the Phase1/Phase2 pattern from PR #326.</goal>
  <context>
    Post-#326, alarm() has two phases:
    - Phase 1 (outside lock): pre-fetches HiroNonceInfo in parallel via Promise.all
    - Phase 2 (inside lock): all state mutations, no Hiro I/O

    PR #339 added fetchMempoolForSponsor inside the lock (lines ~8282-8296 post-#326),
    which violates the same pattern. This is tracked as issue #350.

    The fix mirrors #326 exactly:
    - Pre-fetch mempool snapshots in parallel outside the lock
    - Build Map<number, Record<number, HiroSponsorTxView> | null>
    - Inside lock: consume the pre-fetched map; emit reconcile_skipped_api_blind for null entries
    - Use the same reconcileWalletsPre slice computed before the lock (no cursor mismatch)
  </context>

  <task id="1">
    <name>Move fetchMempoolForSponsor outside blockConcurrencyWhile</name>
    <files>src/durable-objects/nonce-do.ts</files>
    <action>
      1. After the existing prefetchedNonceInfos Promise.all block (~line 8219), add a parallel
         pre-fetch for mempool snapshots using reconcileWalletsPre (the same slice):

         const prefetchedMempoolSnapshots = new Map<number, Record<number, HiroSponsorTxView> | null>();
         if (this.isWalletCapacityEnabled()) {
           await Promise.all(
             reconcileWalletsPre.map(async ({ walletIndex, address }) => {
               try {
                 const snapshot = await this.fetchMempoolForSponsor(address);
                 prefetchedMempoolSnapshots.set(walletIndex, snapshot);
               } catch (_e) {
                 prefetchedMempoolSnapshots.set(walletIndex, null);
               }
             })
           );
         }

      2. Inside blockConcurrencyWhile, replace the for-loop that calls fetchMempoolForSponsor
         with code that:
         - Copies prefetchedMempoolSnapshots into walletMempoolSnapshots
         - Emits reconcile_skipped_api_blind for any null entries (same fields as today)

         const walletMempoolSnapshots = new Map<number, Record<number, HiroSponsorTxView> | null>();
         if (this.isWalletCapacityEnabled()) {
           for (const { walletIndex, address } of reconcileWallets) {
             const snapshot = prefetchedMempoolSnapshots.get(walletIndex);
             walletMempoolSnapshots.set(walletIndex, snapshot ?? null);
             if (snapshot === null || snapshot === undefined) {
               this.log("warn", "reconcile_skipped_api_blind", {
                 walletIndex,
                 address,
                 reason: "mempool pre-fetch failed",
               });
             }
           }
         }

      Note: The original error message (mempoolErr.message) is lost since errors were caught
      outside. Use "mempool pre-fetch failed" as a consistent reason string. This is acceptable
      — the semantic (API blind cycle) is preserved and the log fires inside the lock as before.
    </action>
    <verify>
      npm run check -- no new errors beyond pre-existing worker-configuration.d.ts
      npm run deploy:dry-run -- build succeeds
    </verify>
    <done>
      - fetchMempoolForSponsor is called only outside blockConcurrencyWhile
      - walletMempoolSnapshots is populated from prefetchedMempoolSnapshots inside the lock
      - reconcile_skipped_api_blind is emitted inside the lock for null entries
      - npm run check passes with no new errors
      - npm run deploy:dry-run succeeds
    </done>
  </task>
</plan>
