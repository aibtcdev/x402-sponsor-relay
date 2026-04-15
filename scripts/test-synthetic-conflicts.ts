/**
 * Synthetic conflict scenario documentation and test harness.
 *
 * Documents the four conflict scenarios from the Phase 6 acceptance checklist
 * and provides automated checks where possible without mainnet funds.
 *
 * Usage:
 *   npm run test:synthetic [-- options]
 *   npm run test:synthetic -- --help
 *   npm run test:synthetic -- --scenario forward-bump-cold-start
 *   npm run test:synthetic -- --scenario all --relay-url https://x402-relay.aibtc.dev
 *
 * Options:
 *   --relay-url <url>    Relay endpoint URL (default: http://localhost:8787)
 *   --scenario <name>   Scenario to run: all | foreign-occupant | unpriceable-orphan |
 *                       sponsor-occupied-adopt | forward-bump-cold-start
 *                       (default: all)
 *   --help              Print this help and scenario list
 *
 * Environment variables (optional):
 *   RELAY_URL           Relay endpoint URL (overridden by --relay-url)
 */

interface ScenarioResult {
  scenario: string;
  automated: boolean;
  outcome: "passed" | "failed" | "documentation-only";
  notes: string[];
}

interface ConflictScenario {
  name: string;
  slug: string;
  description: string;
  automated: boolean;
  manual_steps: string[];
  expected_logs: string[];
  run?: (relayUrl: string) => Promise<{ passed: boolean; notes: string[] }>;
}

// ---------------------------------------------------------------------------
// Scenario definitions (documentation-first)
// ---------------------------------------------------------------------------

const SCENARIOS: ConflictScenario[] = [
  {
    name: "Foreign Occupant",
    slug: "foreign-occupant",
    description:
      "An external wallet (not the relay sponsor) broadcasts a transaction into the" +
      " same nonce slot the relay has reserved. The relay should classify the occupant" +
      " as `foreign`, emit operator alerts, and NOT perform blind RBF.",
    automated: false,
    manual_steps: [
      "1. Identify the sponsor wallet address for a relay instance (GET /nonce/state → wallets[i].sponsorAddress).",
      "2. Obtain testnet funds for an INDEPENDENT wallet (not the sponsor).",
      "3. Note the sponsor wallet's current possible_next_nonce N from Hiro API.",
      "4. Use the independent wallet to broadcast a STX transfer FROM the sponsor address" +
        " at nonce N. (This requires the sponsor private key — testnet only, use a dedicated" +
        " test sponsor wallet distinct from production.)",
      "5. Submit a normal relay request via POST /relay that would use nonce N.",
      "6. Observe one alarm cycle (~60s).",
    ],
    expected_logs: [
      "rbf_occupant_foreign — occupant classified as foreign (sender != sponsor)",
      "operator_alert_foreign_occupant — operator page with occupant identity fields",
      "nonce_reconcile_forward_bump with cause: external_wallet_op (if nonce advances)",
      "NO rbf_max_attempts_reached with originalTxid=null (would indicate blind RBF)",
    ],
  },

  {
    name: "Unpriceable Orphan",
    slug: "unpriceable-orphan",
    description:
      "A stuck sponsor-broadcast transaction has a fee that cannot be outbid (e.g. the" +
      " occupant is already at MAX_STX_FEE or the relay's fee ceiling is below the" +
      " required bump). After MAX_RBF_ATTEMPTS exhaustion, the slot must be quarantined," +
      " the assignment head must advance past the slot, dispatch must be released, and" +
      " an operator alert must fire.",
    automated: false,
    manual_steps: [
      "1. Identify a sponsor wallet with a stuck nonce slot (conflict or gap_fill state).",
      "2. Manually set MAX_RBF_ATTEMPTS to a small value (e.g. 1) in nonce-do.ts for testing.",
      "3. Set the occupant's fee in the mempool to a value above the relay's fee ceiling.",
      "4. Wait for the next alarm cycle to trigger broadcastRbfForNonce.",
      "5. Verify rbf_max_attempts_reached fires with originalTxid populated (not null).",
      "6. Verify the nonce slot transitions to quarantine state in nonce_intents.",
      "7. Verify assignment head advances past the quarantined slot.",
      "8. Verify subsequent relay requests can use nonce slots after the quarantined one.",
    ],
    expected_logs: [
      "rbf_max_attempts_reached with rbfAttempts >= MAX_RBF_ATTEMPTS AND originalTxid != null",
      "rbf_max_attempts_occupant with full occupant identity (occupant_txid, occupant_sender, occupant_fee)",
      "operator_alert_unpriceable_orphan or similar quarantine page",
      "nonce_intents state = 'quarantine' for the affected slot",
      "NO repeat occurrences of the same (wallet, nonce) in conflict logs after quarantine",
    ],
  },

  {
    name: "Sponsor-Occupied Adopt",
    slug: "sponsor-occupied-adopt",
    description:
      "The relay DO is cold-started (or storage is partially reset) while the sponsor" +
      " wallet has a pending transaction in the mempool that the DO has no ledger record" +
      " for. The reconcile() cycle should classify this as `ours_orphan` and trigger" +
      " adoptOrphan, importing the broadcast into the ledger without re-broadcasting.",
    automated: false,
    manual_steps: [
      "1. Broadcast a transaction from the relay sponsor wallet via an external tool" +
        " (e.g. Hiro Explorer, scripts/test-sponsor.ts) to create an orphan in the mempool.",
      "2. Delete or reset the NonceDO storage to simulate a cold-start" +
        " (POST /nonce/reset with admin key, or wrangler DO delete).",
      "3. Wait for one alarm cycle (~60s).",
      "4. Observe that the relay does NOT re-broadcast the same nonce.",
      "5. Observe that the ledger row is created with status=broadcast_sent via adoptOrphan.",
    ],
    expected_logs: [
      "classifyOccupant output: ours_orphan (sponsor matches, txid not in ledger)",
      "decideBroadcast output: adopt",
      "adoptOrphan execution log with the imported txid",
      "nonce_intents row created with status=broadcast_sent and is_gap_fill=false",
      "nonce_reconcile_forward_bump with cause: do_cold_start (if frontier was reset)",
    ],
  },

  {
    name: "Forward-Bump Cold Start",
    slug: "forward-bump-cold-start",
    description:
      "When the DO starts cold (fresh storage) while the sponsor wallet has an on-chain" +
      " nonce > 0, reconcile() should detect the gap between the local frontier (0) and" +
      " the Hiro-reported possible_next_nonce and emit nonce_reconcile_forward_bump with" +
      " cause=do_cold_start. This is automated: checks GET /nonce/state for shape validity.",
    automated: true,
    manual_steps: [
      "1. Hit GET /nonce/state and verify the response shape matches WalletCapacity.",
      "2. For a full cold-start test: wrangler DO delete, redeploy, observe logs for" +
        " nonce_reconcile_forward_bump with cause=do_cold_start.",
    ],
    expected_logs: [
      "nonce_reconcile_forward_bump with cause: do_cold_start (when DO storage reset)",
      "nonce_reconcile_forward_bump with cause: untracked_broadcast (ledger missing entry)",
      "nonce_reconcile_forward_bump with cause: external_wallet_op (sponsor used outside relay)",
    ],
    run: async (relayUrl: string) => {
      const notes: string[] = [];
      try {
        const res = await fetch(`${relayUrl}/nonce/state`);
        if (!res.ok) {
          return {
            passed: false,
            notes: [`GET /nonce/state returned HTTP ${res.status}`],
          };
        }
        const body = (await res.json()) as Record<string, unknown>;
        if (!body.success) {
          return {
            passed: false,
            notes: [`/nonce/state response has success=false: ${JSON.stringify(body)}`],
          };
        }

        // Validate that the wallets array contains WalletCapacity-shaped entries
        const wallets = body.wallets as Array<Record<string, unknown>> | undefined;
        if (!Array.isArray(wallets)) {
          return {
            passed: false,
            notes: [`/nonce/state response missing wallets array`],
          };
        }

        let shapeOk = true;
        for (const w of wallets.slice(0, 3)) {
          const hasRequired =
            typeof w.walletIndex === "number" &&
            typeof w.chainFrontier === "number" &&
            typeof w.assignmentHead === "number" &&
            typeof w.available === "number" &&
            Array.isArray(w.occupiedNonces);
          if (!hasRequired) {
            shapeOk = false;
            notes.push(`Wallet entry missing required WalletCapacity fields: ${JSON.stringify(w)}`);
          }
        }

        if (shapeOk) {
          notes.push(
            `GET /nonce/state returned ${wallets.length} wallet(s) with valid WalletCapacity shape.`
          );
          notes.push(
            "For a full cold-start forward-bump test, reset DO storage and observe logs for" +
              " nonce_reconcile_forward_bump with cause=do_cold_start."
          );
        }

        return { passed: shapeOk, notes };
      } catch (err) {
        return {
          passed: false,
          notes: [`Network error calling /nonce/state: ${err instanceof Error ? err.message : String(err)}`],
        };
      }
    },
  },
];

// ---------------------------------------------------------------------------
// CLI helpers
// ---------------------------------------------------------------------------

function printHelp(): void {
  console.log(
    "test-synthetic-conflicts.ts — conflict scenario documentation and test harness\n"
  );
  console.log("Usage:");
  console.log("  npm run test:synthetic [-- options]\n");
  console.log("Options:");
  console.log("  --relay-url <url>    Relay URL (default: http://localhost:8787)");
  console.log(
    "  --scenario <name>   Scenario to run: all | foreign-occupant | unpriceable-orphan |"
  );
  console.log(
    "                      sponsor-occupied-adopt | forward-bump-cold-start"
  );
  console.log("  --help              Print this help\n");
  console.log("Available scenarios:");
  for (const s of SCENARIOS) {
    const tag = s.automated ? "[automated]" : "[manual/docs]";
    console.log(`  ${s.slug.padEnd(28)} ${tag}  ${s.description.slice(0, 60)}...`);
  }
  console.log("");
}

function printScenario(s: ConflictScenario): void {
  const tag = s.automated ? "AUTOMATED" : "DOCUMENTATION-ONLY";
  console.log(`\n${"=".repeat(70)}`);
  console.log(`Scenario: ${s.name} (${tag})`);
  console.log(`${"=".repeat(70)}`);
  console.log(`\n${s.description}\n`);

  if (!s.automated) {
    console.log("Manual Steps:");
    for (const step of s.manual_steps) console.log(`  ${step}`);
  }

  console.log("\nExpected Log Events:");
  for (const log of s.expected_logs) console.log(`  - ${log}`);
  console.log("");
}

async function runScenario(
  s: ConflictScenario,
  relayUrl: string
): Promise<ScenarioResult> {
  printScenario(s);

  if (!s.automated || !s.run) {
    return {
      scenario: s.slug,
      automated: false,
      outcome: "documentation-only",
      notes: ["Manual scenario — follow the steps above and check logs.aibtc.com"],
    };
  }

  console.log(`Running automated check against: ${relayUrl}`);
  try {
    const { passed, notes } = await s.run(relayUrl);
    for (const note of notes) console.log(`  ${note}`);
    return {
      scenario: s.slug,
      automated: true,
      outcome: passed ? "passed" : "failed",
      notes,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`  ERROR: ${msg}`);
    return {
      scenario: s.slug,
      automated: true,
      outcome: "failed",
      notes: [msg],
    };
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.includes("--help") || args.includes("-h")) {
    printHelp();
    process.exit(0);
  }

  const relayUrlIdx = args.indexOf("--relay-url");
  const relayUrl =
    relayUrlIdx !== -1 && args[relayUrlIdx + 1]
      ? (args[relayUrlIdx + 1] as string)
      : process.env.RELAY_URL || "http://localhost:8787";

  const scenarioIdx = args.indexOf("--scenario");
  const scenarioFilter =
    scenarioIdx !== -1 && args[scenarioIdx + 1]
      ? (args[scenarioIdx + 1] as string)
      : "all";

  const selectedScenarios =
    scenarioFilter === "all"
      ? SCENARIOS
      : SCENARIOS.filter((s) => s.slug === scenarioFilter);

  if (selectedScenarios.length === 0) {
    console.error(`Unknown scenario: ${scenarioFilter}`);
    console.error("Available:", SCENARIOS.map((s) => s.slug).join(", "));
    process.exit(1);
  }

  console.log(`\nx402 Sponsor Relay — Synthetic Conflict Scenarios`);
  console.log(`Relay URL: ${relayUrl}`);
  console.log(`Scenarios: ${selectedScenarios.map((s) => s.slug).join(", ")}\n`);

  const results: ScenarioResult[] = [];
  for (const scenario of selectedScenarios) {
    const result = await runScenario(scenario, relayUrl);
    results.push(result);
  }

  // Summary
  console.log(`\n${"=".repeat(70)}`);
  console.log("SUMMARY");
  console.log(`${"=".repeat(70)}`);

  let automated = 0;
  let passed = 0;
  let failed = 0;
  let docsOnly = 0;

  for (const r of results) {
    const icon = r.outcome === "passed" ? "PASS" : r.outcome === "failed" ? "FAIL" : "DOCS";
    console.log(`  [${icon}] ${r.scenario}`);
    if (r.outcome === "documentation-only") docsOnly++;
    else if (r.outcome === "passed") { automated++; passed++; }
    else { automated++; failed++; }
  }

  console.log("");
  console.log(`Automated: ${passed}/${automated} passed`);
  console.log(`Documentation-only: ${docsOnly} scenario(s) — follow manual steps and check logs`);

  if (failed > 0) {
    console.log("\nRESULT: FAIL");
    process.exit(1);
  } else {
    console.log("\nRESULT: PASS");
    process.exit(0);
  }
}

main();
