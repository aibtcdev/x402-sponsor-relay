# Changelog

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
