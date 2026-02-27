# Changelog

## [1.16.0](https://github.com/aibtcdev/x402-sponsor-relay/compare/x402-sponsor-relay-v1.15.2...x402-sponsor-relay-v1.16.0) (2026-02-27)


### Features

* **stats:** dashboard stats overhaul — accurate metrics and new signals ([#129](https://github.com/aibtcdev/x402-sponsor-relay/issues/129)) ([de52b8d](https://github.com/aibtcdev/x402-sponsor-relay/commit/de52b8d99a2d54a889d993b5363a785becf3748d))

## [1.15.2](https://github.com/aibtcdev/x402-sponsor-relay/compare/x402-sponsor-relay-v1.15.1...x402-sponsor-relay-v1.15.2) (2026-02-26)


### Bug Fixes

* **diagnostics:** reduce error noise for expected failures ([#127](https://github.com/aibtcdev/x402-sponsor-relay/issues/127)) ([f7c84f4](https://github.com/aibtcdev/x402-sponsor-relay/commit/f7c84f4d72eed5dd351670878c5d428763f9fda7))
* **resilience:** broadcast retry and stuck-nonce auto-recovery ([#125](https://github.com/aibtcdev/x402-sponsor-relay/issues/125)) ([72496c7](https://github.com/aibtcdev/x402-sponsor-relay/commit/72496c7a3359fb3a953aab9f2a625b05c94f53bf))

## [1.15.1](https://github.com/aibtcdev/x402-sponsor-relay/compare/x402-sponsor-relay-v1.15.0...x402-sponsor-relay-v1.15.1) (2026-02-26)


### Bug Fixes

* **settlement:** relax testnet sBTC matching and DRY token dispatch ([#123](https://github.com/aibtcdev/x402-sponsor-relay/issues/123)) ([488ffd1](https://github.com/aibtcdev/x402-sponsor-relay/commit/488ffd1208c5dbd5b888ac6e6b6220141aab8302))

## [1.15.0](https://github.com/aibtcdev/x402-sponsor-relay/compare/x402-sponsor-relay-v1.14.1...x402-sponsor-relay-v1.15.0) (2026-02-24)


### Features

* **btc-verify:** add BIP-322 support and migrate to pure JS crypto ([#118](https://github.com/aibtcdev/x402-sponsor-relay/issues/118)) ([dfe252b](https://github.com/aibtcdev/x402-sponsor-relay/commit/dfe252b4d63cb27a86ea455bb0f8afeafc799d92))

## [1.14.1](https://github.com/aibtcdev/x402-sponsor-relay/compare/x402-sponsor-relay-v1.14.0...x402-sponsor-relay-v1.14.1) (2026-02-23)


### Bug Fixes

* **settlement:** pass maxTimeoutSeconds through to broadcastAndConfirm ([88354d7](https://github.com/aibtcdev/x402-sponsor-relay/commit/88354d7b0ea78e8f8ee13ddf6b9e7ea48a9462a7)), closes [#105](https://github.com/aibtcdev/x402-sponsor-relay/issues/105)
* **settlement:** pass maxTimeoutSeconds through to broadcastAndConfirm ([#106](https://github.com/aibtcdev/x402-sponsor-relay/issues/106)) ([88354d7](https://github.com/aibtcdev/x402-sponsor-relay/commit/88354d7b0ea78e8f8ee13ddf6b9e7ea48a9462a7))
* **settle:** silence BadNonce burst noise and relay error audit ([#117](https://github.com/aibtcdev/x402-sponsor-relay/issues/117)) ([a508266](https://github.com/aibtcdev/x402-sponsor-relay/commit/a508266ecd0b2164a897dd70578881da7591472c))

## [1.14.0](https://github.com/aibtcdev/x402-sponsor-relay/compare/x402-sponsor-relay-v1.13.1...x402-sponsor-relay-v1.14.0) (2026-02-22)


### Features

* **settlement:** support Circle USDCx contract alongside Aave aeUSDC ([60b0788](https://github.com/aibtcdev/x402-sponsor-relay/commit/60b0788115d9147ab74177712094a876a730eb67))
* **settlement:** support Circle USDCx contract alongside Aave aeUSDC ([#102](https://github.com/aibtcdev/x402-sponsor-relay/issues/102)) ([60b0788](https://github.com/aibtcdev/x402-sponsor-relay/commit/60b0788115d9147ab74177712094a876a730eb67))

## [1.13.1](https://github.com/aibtcdev/x402-sponsor-relay/compare/x402-sponsor-relay-v1.13.0...x402-sponsor-relay-v1.13.1) (2026-02-22)


### Bug Fixes

* **nonce-do:** evict stale nonces on assign and alarm to prevent BadNonce conflicts ([#100](https://github.com/aibtcdev/x402-sponsor-relay/issues/100)) ([dad3c17](https://github.com/aibtcdev/x402-sponsor-relay/commit/dad3c17454a98ec1583ae14af93b61a364f3e8cb))
* **services:** increase Hiro API timeouts and improve fee fallback resilience ([5e2cf66](https://github.com/aibtcdev/x402-sponsor-relay/commit/5e2cf6639c0e8e704fa264f05ca1b6ca0708b3b2))
* **services:** increase Hiro API timeouts and improve fee fallback resilience ([#103](https://github.com/aibtcdev/x402-sponsor-relay/issues/103)) ([5e2cf66](https://github.com/aibtcdev/x402-sponsor-relay/commit/5e2cf6639c0e8e704fa264f05ca1b6ca0708b3b2))

## [1.13.0](https://github.com/aibtcdev/x402-sponsor-relay/compare/x402-sponsor-relay-v1.12.2...x402-sponsor-relay-v1.13.0) (2026-02-21)


### Features

* add fee estimation endpoint with per-type clamps ([#34](https://github.com/aibtcdev/x402-sponsor-relay/issues/34)) ([86f9f52](https://github.com/aibtcdev/x402-sponsor-relay/commit/86f9f52b456360babe8dfa55a6266f395be3db73))
* add general transaction sponsorship with API key authentication ([#24](https://github.com/aibtcdev/x402-sponsor-relay/issues/24)) ([9cf4144](https://github.com/aibtcdev/x402-sponsor-relay/commit/9cf41444f3eccd0ad107cac7461e92fe926df192))
* add programmatic API key provisioning via BTC signature ([#31](https://github.com/aibtcdev/x402-sponsor-relay/issues/31)) ([a6b5bcc](https://github.com/aibtcdev/x402-sponsor-relay/commit/a6b5bcc5898bed3da8a96db4414cbd7120adea81))
* add public dashboard for relay statistics ([#10](https://github.com/aibtcdev/x402-sponsor-relay/issues/10)) ([54cc46f](https://github.com/aibtcdev/x402-sponsor-relay/commit/54cc46f798071e20d4de1838b8152dcfe0ab7202))
* add SIP-018 signature verification for agent authentication ([#38](https://github.com/aibtcdev/x402-sponsor-relay/issues/38)) ([e3aaf44](https://github.com/aibtcdev/x402-sponsor-relay/commit/e3aaf44334d29af1676637fdba5671ad5ed56e11))
* add structured error responses and fee tracking ([#13](https://github.com/aibtcdev/x402-sponsor-relay/issues/13)) ([9b6dba1](https://github.com/aibtcdev/x402-sponsor-relay/commit/9b6dba15f1d66da2a8bda4ea5d4890934a1febde))
* add test script for relay endpoint ([55d1871](https://github.com/aibtcdev/x402-sponsor-relay/commit/55d18717d3ddc7428f92092452c304609c640b31))
* add x402 V2 facilitator API (settle, verify, supported) ([#50](https://github.com/aibtcdev/x402-sponsor-relay/issues/50)) ([991e698](https://github.com/aibtcdev/x402-sponsor-relay/commit/991e6989edec35e6187b9cc0348c0a8e3a99c9cb))
* **dashboard:** apply AIBTC branding ([#11](https://github.com/aibtcdev/x402-sponsor-relay/issues/11)) ([556afee](https://github.com/aibtcdev/x402-sponsor-relay/commit/556afeec72dfc3ecee5ee9d6aa325021dc7e25fd))
* **dashboard:** local timezone + per-transaction log ([#65](https://github.com/aibtcdev/x402-sponsor-relay/issues/65)) ([c090ab5](https://github.com/aibtcdev/x402-sponsor-relay/commit/c090ab55658ee11f6b135b6c302bf4983ca4833d))
* **discovery:** add AX discovery chain for AI agent onboarding ([#42](https://github.com/aibtcdev/x402-sponsor-relay/issues/42)) ([d1185af](https://github.com/aibtcdev/x402-sponsor-relay/commit/d1185afc49028e57e393dcd98e3eb912440fe5a2))
* implement sponsor relay endpoint ([3f0c16f](https://github.com/aibtcdev/x402-sponsor-relay/commit/3f0c16fa29f13b4785bd3fa3bdad08a8c4b71b38))
* initial scaffolding for x402 sponsor relay ([06870e2](https://github.com/aibtcdev/x402-sponsor-relay/commit/06870e246a7065f496a195fb3ca3f172a042cdec))
* integrate facilitator settle endpoint for payment verification ([#4](https://github.com/aibtcdev/x402-sponsor-relay/issues/4)) ([59b6a78](https://github.com/aibtcdev/x402-sponsor-relay/commit/59b6a78d271ec32640a4e598ea1fe0e89c4b50b4))
* native settlement replaces external facilitator ([994462b](https://github.com/aibtcdev/x402-sponsor-relay/commit/994462b53bd1f45abb59a0a4e1ea4247642b9271))
* nonce gap detection and self-healing recovery ([#67](https://github.com/aibtcdev/x402-sponsor-relay/issues/67)) ([d28ea6d](https://github.com/aibtcdev/x402-sponsor-relay/commit/d28ea6d61f395657ae2101dac06a0bd0d4aa8efd))
* nonce mastery — self-healing gaps, dedup liveness, chaining pressure ([#77](https://github.com/aibtcdev/x402-sponsor-relay/issues/77)) ([5d3f0c0](https://github.com/aibtcdev/x402-sponsor-relay/commit/5d3f0c0d0a5ef2abe8bcf031a7a9df137f954dbb))
* nonce reservation pool, multi-wallet rotation, and wallet monitoring ([#74](https://github.com/aibtcdev/x402-sponsor-relay/issues/74)) ([5c0fb22](https://github.com/aibtcdev/x402-sponsor-relay/commit/5c0fb22ea0c8e5cc488a1c7d50da1eb49c089ae6))
* read agent credentials from env in test script ([#3](https://github.com/aibtcdev/x402-sponsor-relay/issues/3)) ([fec43bc](https://github.com/aibtcdev/x402-sponsor-relay/commit/fec43bc315d600b1d42d49e13192ecee6fe2df0e))
* relay-as-server architecture with payment receipts ([#27](https://github.com/aibtcdev/x402-sponsor-relay/issues/27)) ([1091808](https://github.com/aibtcdev/x402-sponsor-relay/commit/1091808217c543d55640d8da4e25d147e94ed6ef))


### Bug Fixes

* add KV → StatsDO backfill for dashboard stats recovery ([#72](https://github.com/aibtcdev/x402-sponsor-relay/issues/72)) ([c5edfe4](https://github.com/aibtcdev/x402-sponsor-relay/commit/c5edfe4498b4bd40e6542e9bcb55cb0d1902000d))
* align receipt TTL, add USDCx validation, remove backfill endpoint ([#87](https://github.com/aibtcdev/x402-sponsor-relay/issues/87)) ([a3e11c8](https://github.com/aibtcdev/x402-sponsor-relay/commit/a3e11c8f64ec07b6b30836f6e21a6cbc8f5012ad))
* apply AIBTC brand guidelines to dashboard UI ([#21](https://github.com/aibtcdev/x402-sponsor-relay/issues/21)) ([dbdc712](https://github.com/aibtcdev/x402-sponsor-relay/commit/dbdc712d267ec045572f488a582e5fb3c51ca5db)), closes [#20](https://github.com/aibtcdev/x402-sponsor-relay/issues/20)
* capture generateNewAccount return value for wallet derivation ([#80](https://github.com/aibtcdev/x402-sponsor-relay/issues/80)) ([4db3929](https://github.com/aibtcdev/x402-sponsor-relay/commit/4db3929a6001d8fbdab3b68ec2d4d9236e54f15c)), closes [#79](https://github.com/aibtcdev/x402-sponsor-relay/issues/79)
* dashboard accuracy, performance, and dead code cleanup ([#58](https://github.com/aibtcdev/x402-sponsor-relay/issues/58)) ([25b6ab4](https://github.com/aibtcdev/x402-sponsor-relay/commit/25b6ab42bf1aaccb74519be7c377bfeeef07bcab))
* **dashboard:** resolve all code review findings ([#60](https://github.com/aibtcdev/x402-sponsor-relay/issues/60)) ([aef5f9c](https://github.com/aibtcdev/x402-sponsor-relay/commit/aef5f9cf9cb7e60c6f8aaf6dea7c7a9f293d1f06))
* detect wallet address changes and reinitialize stale nonce pools ([#85](https://github.com/aibtcdev/x402-sponsor-relay/issues/85)) ([b37cd0e](https://github.com/aibtcdev/x402-sponsor-relay/commit/b37cd0ec1e866729884876898f85aaa7c5a45fb2))
* **nonce-do:** eliminate nonce conflicts via resync overlap fix and defense guards ([#99](https://github.com/aibtcdev/x402-sponsor-relay/issues/99)) ([c2ec5eb](https://github.com/aibtcdev/x402-sponsor-relay/commit/c2ec5ebe1869f72989efb88ec70932d63164b68f))
* **nonce-do:** improve observability — null defaults, gap-fill fees, structured logging ([#94](https://github.com/aibtcdev/x402-sponsor-relay/issues/94)) ([cd35898](https://github.com/aibtcdev/x402-sponsor-relay/commit/cd3589836acd316df4eb2653897682da276ac5f1))
* **nonce-do:** refill depleted pools and extend resync/reset to all wallets ([#90](https://github.com/aibtcdev/x402-sponsor-relay/issues/90)) ([0d38eaf](https://github.com/aibtcdev/x402-sponsor-relay/commit/0d38eaf87e8d55b61de04322d08af00c408b2087))
* production hardening — nonce fail-fast, StatsDO, BTC provision errors ([#70](https://github.com/aibtcdev/x402-sponsor-relay/issues/70)) ([cb986a7](https://github.com/aibtcdev/x402-sponsor-relay/commit/cb986a7891f72590b643627ad1fc536a58e65cf6))
* **relay:** release nonce on verify failure to prevent pool leak ([#98](https://github.com/aibtcdev/x402-sponsor-relay/issues/98)) ([841b784](https://github.com/aibtcdev/x402-sponsor-relay/commit/841b784f023f7611c66bfda90d57c868de5fdff3))
* remove release-type input so release-please uses config file ([#88](https://github.com/aibtcdev/x402-sponsor-relay/issues/88)) ([86c634f](https://github.com/aibtcdev/x402-sponsor-relay/commit/86c634f24902a15c595c6fff3c2ce5d1be1e9b9f))
* resolve Hiro API rate limiting cascading failures ([#41](https://github.com/aibtcdev/x402-sponsor-relay/issues/41)) ([251ffc8](https://github.com/aibtcdev/x402-sponsor-relay/commit/251ffc84f3454696d65fab0285257248d7c0de48))
* **stats-do:** compute overview totals from rolling 24h hourly sums ([#97](https://github.com/aibtcdev/x402-sponsor-relay/issues/97)) ([dd0570d](https://github.com/aibtcdev/x402-sponsor-relay/commit/dd0570d4af00a73c77b8b417148c30efde89e5ab)), closes [#96](https://github.com/aibtcdev/x402-sponsor-relay/issues/96)
* update facilitator URL to stacksx402.com ([#2](https://github.com/aibtcdev/x402-sponsor-relay/issues/2)) ([8ccadd8](https://github.com/aibtcdev/x402-sponsor-relay/commit/8ccadd872be21aa974a635ce6b7f1334f8915e1d))
* update serialize() calls for stacks.js v7 compatibility ([#12](https://github.com/aibtcdev/x402-sponsor-relay/issues/12)) ([1619570](https://github.com/aibtcdev/x402-sponsor-relay/commit/1619570710459bbb0dc60f4516d8b1e9d1d9377e))
* update service bindings to match worker-logs env names ([389ff85](https://github.com/aibtcdev/x402-sponsor-relay/commit/389ff85146048536e38a1804b428901aef4ef7fd))
* use valid AIBTC recipient addresses in test script ([#15](https://github.com/aibtcdev/x402-sponsor-relay/issues/15)) ([42547dc](https://github.com/aibtcdev/x402-sponsor-relay/commit/42547dcd2f507a1b83141fbf035984566b987bf7))
* **version:** sync version.ts with package.json (1.4.0) ([#36](https://github.com/aibtcdev/x402-sponsor-relay/issues/36)) ([de2edf7](https://github.com/aibtcdev/x402-sponsor-relay/commit/de2edf72b0ae13c8549b52a6e2ece2c97589645b))

## [1.12.2](https://github.com/aibtcdev/x402-sponsor-relay/compare/v1.12.1...v1.12.2) (2026-02-20)


### Bug Fixes

* detect wallet address changes and reinitialize stale nonce pools ([#85](https://github.com/aibtcdev/x402-sponsor-relay/issues/85)) ([b37cd0e](https://github.com/aibtcdev/x402-sponsor-relay/commit/b37cd0ec1e866729884876898f85aaa7c5a45fb2))

## [1.12.1](https://github.com/aibtcdev/x402-sponsor-relay/compare/v1.12.0...v1.12.1) (2026-02-20)


### Bug Fixes

* capture generateNewAccount return value for wallet derivation ([#80](https://github.com/aibtcdev/x402-sponsor-relay/issues/80)) ([4db3929](https://github.com/aibtcdev/x402-sponsor-relay/commit/4db3929a6001d8fbdab3b68ec2d4d9236e54f15c)), closes [#79](https://github.com/aibtcdev/x402-sponsor-relay/issues/79)

## [1.12.0](https://github.com/aibtcdev/x402-sponsor-relay/compare/v1.11.0...v1.12.0) (2026-02-20)


### Features

* nonce mastery — self-healing gaps, dedup liveness, chaining pressure ([#77](https://github.com/aibtcdev/x402-sponsor-relay/issues/77)) ([5d3f0c0](https://github.com/aibtcdev/x402-sponsor-relay/commit/5d3f0c0d0a5ef2abe8bcf031a7a9df137f954dbb))

## [1.11.0](https://github.com/aibtcdev/x402-sponsor-relay/compare/v1.10.1...v1.11.0) (2026-02-20)


### Features

* nonce reservation pool, multi-wallet rotation, and wallet monitoring ([#74](https://github.com/aibtcdev/x402-sponsor-relay/issues/74)) ([5c0fb22](https://github.com/aibtcdev/x402-sponsor-relay/commit/5c0fb22ea0c8e5cc488a1c7d50da1eb49c089ae6))


### Bug Fixes

* add KV → StatsDO backfill for dashboard stats recovery ([#72](https://github.com/aibtcdev/x402-sponsor-relay/issues/72)) ([c5edfe4](https://github.com/aibtcdev/x402-sponsor-relay/commit/c5edfe4498b4bd40e6542e9bcb55cb0d1902000d))

## [1.10.1](https://github.com/aibtcdev/x402-sponsor-relay/compare/v1.10.0...v1.10.1) (2026-02-20)


### Bug Fixes

* production hardening — nonce fail-fast, StatsDO, BTC provision errors ([#70](https://github.com/aibtcdev/x402-sponsor-relay/issues/70)) ([cb986a7](https://github.com/aibtcdev/x402-sponsor-relay/commit/cb986a7891f72590b643627ad1fc536a58e65cf6))

## [1.10.0](https://github.com/aibtcdev/x402-sponsor-relay/compare/v1.9.0...v1.10.0) (2026-02-20)


### Features

* nonce gap detection and self-healing recovery ([#67](https://github.com/aibtcdev/x402-sponsor-relay/issues/67)) ([d28ea6d](https://github.com/aibtcdev/x402-sponsor-relay/commit/d28ea6d61f395657ae2101dac06a0bd0d4aa8efd))

## [1.9.0](https://github.com/aibtcdev/x402-sponsor-relay/compare/v1.8.2...v1.9.0) (2026-02-20)


### Features

* **dashboard:** local timezone + per-transaction log ([#65](https://github.com/aibtcdev/x402-sponsor-relay/issues/65)) ([c090ab5](https://github.com/aibtcdev/x402-sponsor-relay/commit/c090ab55658ee11f6b135b6c302bf4983ca4833d))

## [1.8.2](https://github.com/aibtcdev/x402-sponsor-relay/compare/v1.8.1...v1.8.2) (2026-02-18)


### Bug Fixes

* **dashboard:** resolve all code review findings ([#60](https://github.com/aibtcdev/x402-sponsor-relay/issues/60)) ([aef5f9c](https://github.com/aibtcdev/x402-sponsor-relay/commit/aef5f9cf9cb7e60c6f8aaf6dea7c7a9f293d1f06))

## [1.8.1](https://github.com/aibtcdev/x402-sponsor-relay/compare/v1.8.0...v1.8.1) (2026-02-18)


### Bug Fixes

* dashboard accuracy, performance, and dead code cleanup ([#58](https://github.com/aibtcdev/x402-sponsor-relay/issues/58)) ([25b6ab4](https://github.com/aibtcdev/x402-sponsor-relay/commit/25b6ab42bf1aaccb74519be7c377bfeeef07bcab))

## [1.8.0](https://github.com/aibtcdev/x402-sponsor-relay/compare/v1.7.0...v1.8.0) (2026-02-18)


### Features

* add x402 V2 facilitator API (settle, verify, supported) ([#50](https://github.com/aibtcdev/x402-sponsor-relay/issues/50)) ([991e698](https://github.com/aibtcdev/x402-sponsor-relay/commit/991e6989edec35e6187b9cc0348c0a8e3a99c9cb))

## [1.7.0](https://github.com/aibtcdev/x402-sponsor-relay/compare/v1.6.0...v1.7.0) (2026-02-17)


### Features

* native settlement replaces external facilitator ([994462b](https://github.com/aibtcdev/x402-sponsor-relay/commit/994462b53bd1f45abb59a0a4e1ea4247642b9271))

## [1.6.0](https://github.com/aibtcdev/x402-sponsor-relay/compare/v1.5.0...v1.6.0) (2026-02-17)


### Features

* **discovery:** add AX discovery chain for AI agent onboarding ([#42](https://github.com/aibtcdev/x402-sponsor-relay/issues/42)) ([d1185af](https://github.com/aibtcdev/x402-sponsor-relay/commit/d1185afc49028e57e393dcd98e3eb912440fe5a2))


### Bug Fixes

* resolve Hiro API rate limiting cascading failures ([#41](https://github.com/aibtcdev/x402-sponsor-relay/issues/41)) ([251ffc8](https://github.com/aibtcdev/x402-sponsor-relay/commit/251ffc84f3454696d65fab0285257248d7c0de48))

## [1.5.0](https://github.com/aibtcdev/x402-sponsor-relay/compare/v1.4.1...v1.5.0) (2026-02-16)


### Features

* add SIP-018 signature verification for agent authentication ([#38](https://github.com/aibtcdev/x402-sponsor-relay/issues/38)) ([e3aaf44](https://github.com/aibtcdev/x402-sponsor-relay/commit/e3aaf44334d29af1676637fdba5671ad5ed56e11))

## [1.4.1](https://github.com/aibtcdev/x402-sponsor-relay/compare/v1.4.0...v1.4.1) (2026-02-14)


### Bug Fixes

* **version:** sync version.ts with package.json (1.4.0) ([#36](https://github.com/aibtcdev/x402-sponsor-relay/issues/36)) ([de2edf7](https://github.com/aibtcdev/x402-sponsor-relay/commit/de2edf72b0ae13c8549b52a6e2ece2c97589645b))

## [1.4.0](https://github.com/aibtcdev/x402-sponsor-relay/compare/v1.3.0...v1.4.0) (2026-02-13)


### Features

* add fee estimation endpoint with per-type clamps ([#34](https://github.com/aibtcdev/x402-sponsor-relay/issues/34)) ([86f9f52](https://github.com/aibtcdev/x402-sponsor-relay/commit/86f9f52b456360babe8dfa55a6266f395be3db73))

## [1.3.0](https://github.com/aibtcdev/x402-sponsor-relay/compare/v1.2.0...v1.3.0) (2026-02-12)


### Features

* add programmatic API key provisioning via BTC signature ([#31](https://github.com/aibtcdev/x402-sponsor-relay/issues/31)) ([a6b5bcc](https://github.com/aibtcdev/x402-sponsor-relay/commit/a6b5bcc5898bed3da8a96db4414cbd7120adea81))

## [1.2.0](https://github.com/aibtcdev/x402-sponsor-relay/compare/v1.1.0...v1.2.0) (2026-02-12)


### Features

* relay-as-server architecture with payment receipts ([#27](https://github.com/aibtcdev/x402-sponsor-relay/issues/27)) ([1091808](https://github.com/aibtcdev/x402-sponsor-relay/commit/1091808217c543d55640d8da4e25d147e94ed6ef))

## [1.1.0](https://github.com/aibtcdev/x402-sponsor-relay/compare/v1.0.0...v1.1.0) (2026-02-12)


### Features

* add general transaction sponsorship with API key authentication ([#24](https://github.com/aibtcdev/x402-sponsor-relay/issues/24)) ([9cf4144](https://github.com/aibtcdev/x402-sponsor-relay/commit/9cf41444f3eccd0ad107cac7461e92fe926df192))


### Bug Fixes

* apply AIBTC brand guidelines to dashboard UI ([#21](https://github.com/aibtcdev/x402-sponsor-relay/issues/21)) ([dbdc712](https://github.com/aibtcdev/x402-sponsor-relay/commit/dbdc712d267ec045572f488a582e5fb3c51ca5db)), closes [#20](https://github.com/aibtcdev/x402-sponsor-relay/issues/20)

## 1.0.0 (2026-01-23)


### Features

* add public dashboard for relay statistics ([#10](https://github.com/aibtcdev/x402-sponsor-relay/issues/10)) ([54cc46f](https://github.com/aibtcdev/x402-sponsor-relay/commit/54cc46f798071e20d4de1838b8152dcfe0ab7202))
* add structured error responses and fee tracking ([#13](https://github.com/aibtcdev/x402-sponsor-relay/issues/13)) ([9b6dba1](https://github.com/aibtcdev/x402-sponsor-relay/commit/9b6dba15f1d66da2a8bda4ea5d4890934a1febde))
* add test script for relay endpoint ([55d1871](https://github.com/aibtcdev/x402-sponsor-relay/commit/55d18717d3ddc7428f92092452c304609c640b31))
* **dashboard:** apply AIBTC branding ([#11](https://github.com/aibtcdev/x402-sponsor-relay/issues/11)) ([556afee](https://github.com/aibtcdev/x402-sponsor-relay/commit/556afeec72dfc3ecee5ee9d6aa325021dc7e25fd))
* implement sponsor relay endpoint ([3f0c16f](https://github.com/aibtcdev/x402-sponsor-relay/commit/3f0c16fa29f13b4785bd3fa3bdad08a8c4b71b38))
* initial scaffolding for x402 sponsor relay ([06870e2](https://github.com/aibtcdev/x402-sponsor-relay/commit/06870e246a7065f496a195fb3ca3f172a042cdec))
* integrate facilitator settle endpoint for payment verification ([#4](https://github.com/aibtcdev/x402-sponsor-relay/issues/4)) ([59b6a78](https://github.com/aibtcdev/x402-sponsor-relay/commit/59b6a78d271ec32640a4e598ea1fe0e89c4b50b4))
* read agent credentials from env in test script ([#3](https://github.com/aibtcdev/x402-sponsor-relay/issues/3)) ([fec43bc](https://github.com/aibtcdev/x402-sponsor-relay/commit/fec43bc315d600b1d42d49e13192ecee6fe2df0e))


### Bug Fixes

* update facilitator URL to stacksx402.com ([#2](https://github.com/aibtcdev/x402-sponsor-relay/issues/2)) ([8ccadd8](https://github.com/aibtcdev/x402-sponsor-relay/commit/8ccadd872be21aa974a635ce6b7f1334f8915e1d))
* update serialize() calls for stacks.js v7 compatibility ([#12](https://github.com/aibtcdev/x402-sponsor-relay/issues/12)) ([1619570](https://github.com/aibtcdev/x402-sponsor-relay/commit/1619570710459bbb0dc60f4516d8b1e9d1d9377e))
* update service bindings to match worker-logs env names ([389ff85](https://github.com/aibtcdev/x402-sponsor-relay/commit/389ff85146048536e38a1804b428901aef4ef7fd))
* use valid AIBTC recipient addresses in test script ([#15](https://github.com/aibtcdev/x402-sponsor-relay/issues/15)) ([42547dc](https://github.com/aibtcdev/x402-sponsor-relay/commit/42547dcd2f507a1b83141fbf035984566b987bf7))
