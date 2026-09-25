# Changelog

Notable changes per release. Older releases are summarized; see `git log` for the full record.

## [0.42.0](https://github.com/anis-marrouchi/agentx/compare/v0.41.0...v0.42.0) (2026-09-25)


### Features

* **teach:** draw mode, a tldraw illustration in one model turn ([85c7545](https://github.com/anis-marrouchi/agentx/commit/85c754598a40bb38c422b525cb2eb626d6d52a34))
* **workflows:** owner sweep applies ownership itself ([2a2eeb8](https://github.com/anis-marrouchi/agentx/commit/2a2eeb81ea6b185527609d8df2dc8e1d1656f629))
* **workflows:** owner sweep applies ownership itself ([f0faf7b](https://github.com/anis-marrouchi/agentx/commit/f0faf7b47e8200851891459905b9d8677eaf44a3)), closes [#53](https://github.com/anis-marrouchi/agentx/issues/53)

## [0.41.0](https://github.com/anis-marrouchi/agentx/compare/v0.40.0...v0.41.0) (2026-09-25)


### Features

* **live:** show a live lesson on its agent's card, with a stop ([94ca480](https://github.com/anis-marrouchi/agentx/commit/94ca480a8bd5652bebbe58cbee50602598616c88)), closes [#64](https://github.com/anis-marrouchi/agentx/issues/64)
* **workflows:** owner sweep gives every issue and PR an owner and next step ([f6b0e20](https://github.com/anis-marrouchi/agentx/commit/f6b0e208c702e07eb00c338bcf1f6c53a4e35a5b))
* **workflows:** owner sweep, an owner and next step for every issue and PR ([6c3fa14](https://github.com/anis-marrouchi/agentx/commit/6c3fa142a1fcd9a6dee567efd6484109f25d1141))


### Bug Fixes

* **voice:** lessons only when asked, a hush gives the screen back, and Live shows them ([4dd79a5](https://github.com/anis-marrouchi/agentx/commit/4dd79a59a8fa6af1b43c492db2b55e76eacd5e2a))
* **voice:** lessons only when asked, and a hush gives the screen back ([7c9debb](https://github.com/anis-marrouchi/agentx/commit/7c9debbaec5d6a480f4ba1744800baefe50814f1)), closes [#64](https://github.com/anis-marrouchi/agentx/issues/64)

## [0.40.0](https://github.com/anis-marrouchi/agentx/compare/v0.39.1...v0.40.0) (2026-09-25)


### Features

* **mac-voice:** stop speaking with ⌘⌥. or the menu ([0d2058f](https://github.com/anis-marrouchi/agentx/commit/0d2058fcdc4fe34bf032318278c2da5e0214f929))


### Bug Fixes

* **voice:** a stuck say can no longer hold the speaker; POST /voice/stop ([8cf8503](https://github.com/anis-marrouchi/agentx/commit/8cf8503d7cc273bfd488ae4c83c52742e4becefa))
* **voice:** stuck-speaker watchdog, stale-line drop, and stop speaking (⌘⌥., /voice/stop) ([5cfb802](https://github.com/anis-marrouchi/agentx/commit/5cfb802555532e77cb81365a52e52fcae4561896))

## [0.39.1](https://github.com/anis-marrouchi/agentx/compare/v0.39.0...v0.39.1) (2026-09-25)


### Bug Fixes

* **mac-voice:** end a spoken line when its voice stops, not when say exits ([5982529](https://github.com/anis-marrouchi/agentx/commit/5982529ec21cae7b4defc4422184b02acc6da5e8))
* **mac-voice:** end a spoken line when its voice stops, not when say exits ([82dd3c7](https://github.com/anis-marrouchi/agentx/commit/82dd3c779ebe9f3627779f709044b0e0b88e887f)), closes [#58](https://github.com/anis-marrouchi/agentx/issues/58)
* **teach:** live lessons target the app in front, not the last voice turn's ([409a73e](https://github.com/anis-marrouchi/agentx/commit/409a73e89c9bf221ff9bdc97f8708aaedc0a5f5f))
* **teach:** live lessons target the app in front, not the last voice turn's ([a6395db](https://github.com/anis-marrouchi/agentx/commit/a6395db20d3f3d0e5c091d9362534a5c00b4e574)), closes [#55](https://github.com/anis-marrouchi/agentx/issues/55)

## [0.39.0](https://github.com/anis-marrouchi/agentx/compare/v0.38.0...v0.39.0) (2026-09-25)


### Features

* **presence:** park beside the user's pointer, not the corner ([9d99b6e](https://github.com/anis-marrouchi/agentx/commit/9d99b6ecc380de700a74000cff93c543ebf98e4d)), closes [#51](https://github.com/anis-marrouchi/agentx/issues/51)
* **teach:** Clicky-style narration and tldraw offline act mode ([1934133](https://github.com/anis-marrouchi/agentx/commit/19341332ab229d029e384c1c8c4c1967fcf1b88d))
* **teach:** Clicky-style narration for live teach ([c6baa3d](https://github.com/anis-marrouchi/agentx/commit/c6baa3d91ab795fe5f7fcb136186121ad564865a)), closes [#51](https://github.com/anis-marrouchi/agentx/issues/51)
* **teach:** key action, canvas target and room for a style panel ([32ccc88](https://github.com/anis-marrouchi/agentx/commit/32ccc8849bef96782665619f3b22e8970ce56ed6)), closes [#51](https://github.com/anis-marrouchi/agentx/issues/51)


### Bug Fixes

* **mac-helper:** read and click Electron web apps like tldraw offline ([548f4bf](https://github.com/anis-marrouchi/agentx/commit/548f4bf766968803a5a69993459d7d0327bba8d4)), closes [#51](https://github.com/anis-marrouchi/agentx/issues/51)
* **teach:** type into unnamed text boxes; plainer act-mode lines ([5717324](https://github.com/anis-marrouchi/agentx/commit/5717324c5b6d146dc371b7d03ab34eb1e1a530fd)), closes [#51](https://github.com/anis-marrouchi/agentx/issues/51)


### Performance Improvements

* **teach:** act while speaking, and a pointer move that keeps time ([a1138e9](https://github.com/anis-marrouchi/agentx/commit/a1138e987b64b60a250e1e8f339c402a081793b2)), closes [#51](https://github.com/anis-marrouchi/agentx/issues/51)

## [0.38.0](https://github.com/anis-marrouchi/agentx/compare/v0.37.0...v0.38.0) (2026-09-25)


### Features

* **mac-voice:** speak Siri and OS-default lines through the shared script ([437e2fb](https://github.com/anis-marrouchi/agentx/commit/437e2fb1ea99f5a3ac037347b400901349359bf6)), closes [#48](https://github.com/anis-marrouchi/agentx/issues/48)
* **voice:** offer Siri voices only where the host can switch them ([75d63c3](https://github.com/anis-marrouchi/agentx/commit/75d63c3a252873f9efdac4bd96ab9db36863ce2f)), closes [#48](https://github.com/anis-marrouchi/agentx/issues/48)
* **voice:** OS default voice, per-language voices, gender-aware casting ([2af6894](https://github.com/anis-marrouchi/agentx/commit/2af68947985d8b04e6f83182cf961adfb679fbc5))
* **voice:** per-agent Siri voices by switching the system voice ([74a4d72](https://github.com/anis-marrouchi/agentx/commit/74a4d72c534bb827cb1806dce256400570748cd0))
* **voice:** per-agent Siri voices by switching the system voice ([ce6dd87](https://github.com/anis-marrouchi/agentx/commit/ce6dd87a883e4b62b98af8860fc0e2dc7b2bb731)), closes [#48](https://github.com/anis-marrouchi/agentx/issues/48)


### Bug Fixes

* **teach:** re-read the screen before acting on a plan ([25f4e75](https://github.com/anis-marrouchi/agentx/commit/25f4e7525c5cd73f1fac398a0e565c1765e864fa))
* **teach:** re-read the screen before acting on a plan ([057aed9](https://github.com/anis-marrouchi/agentx/commit/057aed97db1c50d7e206278cb292a76e1777eb67)), closes [#46](https://github.com/anis-marrouchi/agentx/issues/46)

## [0.37.0](https://github.com/anis-marrouchi/agentx/compare/v0.36.0...v0.37.0) (2026-09-25)


### Features

* **mac-voice:** speak in the voice the daemon resolved ([de11ac9](https://github.com/anis-marrouchi/agentx/commit/de11ac98e735d4ea3897e7ed21fc4c27fa0b850c)), closes [#40](https://github.com/anis-marrouchi/agentx/issues/40)
* **voice:** free macOS system voices by default, one per agent ([458735d](https://github.com/anis-marrouchi/agentx/commit/458735dbc29fd43bd9d4c4425769b67266f7e0ca)), closes [#40](https://github.com/anis-marrouchi/agentx/issues/40)
* **voice:** free macOS system voices by default, per-agent pick, ElevenLabs opt-in ([8b5868c](https://github.com/anis-marrouchi/agentx/commit/8b5868ccd4e6eec3156e01f77cf32c6fc6b506ef))

## [0.36.0](https://github.com/anis-marrouchi/agentx/compare/v0.35.0...v0.36.0) (2026-09-25)


### Features

* **mac-helper:** movable presence name tag and bubble ([8140beb](https://github.com/anis-marrouchi/agentx/commit/8140beb10344233a5e64e5a356221fcc4ab7e637))
* **presence:** movable name tag and bubble, floating level ([9a3010a](https://github.com/anis-marrouchi/agentx/commit/9a3010ac00ee26afc8ac38c83d6911d94463f62a))
* **presence:** remember each agent's tag position ([3d4a0b5](https://github.com/anis-marrouchi/agentx/commit/3d4a0b525eac5845f34c79de23427b82a6717c2a))
* **talk:** a mesh agent can take either side of a talk ([0162c58](https://github.com/anis-marrouchi/agentx/commit/0162c58c5a0bbcd8be423e0f6b8fa1cdc1918ce2))
* **voice:** one door for every spoken activity ([b60897c](https://github.com/anis-marrouchi/agentx/commit/b60897c57ac86867107aa0f0766c833bbdd185e8))
* **voice:** voice for mesh agents through the local daemon ([1f1b75c](https://github.com/anis-marrouchi/agentx/commit/1f1b75cf786b2e8e181fe9c08aef1a9c742e63d4))
* **voice:** voice for mesh agents through the local daemon ([da843fa](https://github.com/anis-marrouchi/agentx/commit/da843fa179a46759136b62f960f3d1bbecae4159))


### Bug Fixes

* **mac-helper:** presence never outlives its owner ([63a9a71](https://github.com/anis-marrouchi/agentx/commit/63a9a7195c33ec1d026c44bd90cdefca09ccd69d))
* **mac-voice:** Option-Space always opens the door ([e0aaf30](https://github.com/anis-marrouchi/agentx/commit/e0aaf30783b6f5aca218993c7dea838b7b18b735))
* **mac-voice:** reuse the existing login item label on reinstall ([eaf0967](https://github.com/anis-marrouchi/agentx/commit/eaf0967c51cbbd541b6e089aa072e3ceca60ff25))
* **mac-voice:** reuse the existing login item label on reinstall ([636b995](https://github.com/anis-marrouchi/agentx/commit/636b9955b545c7c24fdc86e77a3a86e394e3e2b1)), closes [#38](https://github.com/anis-marrouchi/agentx/issues/38)
* **presence:** one overlay per agent, gone when the turn ends; one door for every spoken activity ([b3b8165](https://github.com/anis-marrouchi/agentx/commit/b3b816569bdcc79b41211f84765851e6caa67ead))
* **presence:** one overlay per agent, released when the turn ends ([37915df](https://github.com/anis-marrouchi/agentx/commit/37915df51c1fa1c5d9ee3c9e4f7cc38138facdec))

## [0.35.0](https://github.com/anis-marrouchi/agentx/compare/v0.34.0...v0.35.0) (2026-09-24)


### Features

* **daemon:** presence on voice turns, POST /teach/live ([a58c62c](https://github.com/anis-marrouchi/agentx/commit/a58c62cd267d8e377df9f4442440ca50100a8fe2))
* **decisions:** presence-mode seat, decided on every voice turn ([af52077](https://github.com/anis-marrouchi/agentx/commit/af520778e4088656e3304f9b6123ef6354de20ed))
* **presence:** agents on screen — own cursor, presence-mode seat, live teach ([e307971](https://github.com/anis-marrouchi/agentx/commit/e307971a45de0c80785d8101801db3143df74c57))
* **presence:** an agent's own cursor on screen ([e644a13](https://github.com/anis-marrouchi/agentx/commit/e644a13ed45f141fde63ff313a9e0bffe8712377))
* **teach:** live teach for apps with no written lesson ([2760b85](https://github.com/anis-marrouchi/agentx/commit/2760b8593ff25a5b492ced88d373ae1a6cda9c28))

## [0.34.0](https://github.com/anis-marrouchi/agentx/compare/v0.33.0...v0.34.0) (2026-09-24)


### Features

* **daemon:** /talk and /narration endpoints, `agentx talk` and `narrate` ([969a29d](https://github.com/anis-marrouchi/agentx/commit/969a29d0560c0a389dc862c04b28374acf230368))
* **mac-voice:** Option-Space is the door to a running talk ([832270b](https://github.com/anis-marrouchi/agentx/commit/832270be02324d0a98d4686c9fc70ce204f88463))
* **voice:** give each agent its own voice and introduction ([98696d6](https://github.com/anis-marrouchi/agentx/commit/98696d6c4ecfda158949817a8a23695e7c23a1fa))
* **voice:** narrate an agent's real work in its own voice ([1854708](https://github.com/anis-marrouchi/agentx/commit/1854708d9c8c3988640e993a2415cee81d7827ee))
* **voice:** per-agent voices, talk mode with a door, task narration ([c006935](https://github.com/anis-marrouchi/agentx/commit/c00693591bc441360dde09fe77ba7de4abcb88b8))
* **voice:** talk mode, two agents talking out loud with a door ([9c93c62](https://github.com/anis-marrouchi/agentx/commit/9c93c623181cf6dee546c0a82191e4c55275a704))


### Bug Fixes

* **router:** resolve intent decisions for mesh-forwarded dispatches ([bdb9afc](https://github.com/anis-marrouchi/agentx/commit/bdb9afcb9a10cdf28f7c13c6541f0e0815a6d710))
* **router:** resolve intent decisions for mesh-forwarded dispatches ([732ffd5](https://github.com/anis-marrouchi/agentx/commit/732ffd5d541c7d838a9420480018fa9a01dd379d)), closes [#27](https://github.com/anis-marrouchi/agentx/issues/27)

## [0.33.0](https://github.com/anis-marrouchi/agentx/compare/v0.32.0...v0.33.0) (2026-09-24)


### Features

* **activity:** give work with no project its agent's own line ([7acddcb](https://github.com/anis-marrouchi/agentx/commit/7acddcbb26b63348278f03bfbbb1706245bf98d9))
* **activity:** give work with no project its agent's own line ([2bc4439](https://github.com/anis-marrouchi/agentx/commit/2bc44390e610454de8a0c5314b6008c700a263f6))


### Bug Fixes

* **activity:** show the whole mesh on the fleet map ([7ade9f9](https://github.com/anis-marrouchi/agentx/commit/7ade9f97106db18a25d0bc87afa91d28f45c8992))
* **activity:** show the whole mesh on the fleet map ([7d590e0](https://github.com/anis-marrouchi/agentx/commit/7d590e0126332ce7faa493fc7111620322464255))
* **intent:** stop halting agents that are not in the org chart ([065ba45](https://github.com/anis-marrouchi/agentx/commit/065ba450464b35edfd0dfd0bd61272b4dd648adf))
* **intent:** stop halting agents that are not in the org chart ([b000640](https://github.com/anis-marrouchi/agentx/commit/b000640479f9275ffc2b16b8cd4c6eaacb04a1df))

## [0.32.0](https://github.com/anis-marrouchi/agentx/compare/v0.31.0...v0.32.0) (2026-09-24)


### Features

* **bench:** run agentx on Terminal-Bench ([dc06ca8](https://github.com/anis-marrouchi/agentx/commit/dc06ca8265aa89e2dafce6c22dd9e8dbd760d283))

## [0.31.0](https://github.com/anis-marrouchi/agentx/compare/v0.30.0...v0.31.0) (2026-09-24)


### Features

* **activity-graph:** attach live issue/MR/pipeline state to snapshots ([2add936](https://github.com/anis-marrouchi/agentx/commit/2add936c3e44bd4f914577537b0e48ed8deddcf5))
* **activity-graph:** Fleet Map tab ([9221a47](https://github.com/anis-marrouchi/agentx/commit/9221a471189c61429695fd1365f3411d9b519bf3))
* **activity-graph:** rework the Map tab as a transit map ([816e409](https://github.com/anis-marrouchi/agentx/commit/816e409716e16f095ffa31f0b481ab3a65654a5d))
* **activity:** fold the fleet map into /activity and retire Activity Graph ([4817f16](https://github.com/anis-marrouchi/agentx/commit/4817f1635aa6e7b1d10447ea0473e530a8fb8c52))
* **decisions:** hold out 10% of turns from Jev preprocessing ([03f572d](https://github.com/anis-marrouchi/agentx/commit/03f572d035f3138f6e0c8bbb489fdf703de613f9))
* **traces:** record tier-2 tokens and the resume decision per turn ([bf766eb](https://github.com/anis-marrouchi/agentx/commit/bf766ebac852598f4fd3165b7b24b4b1c5586840))

## [0.30.0](https://github.com/anis-marrouchi/agentx/compare/v0.29.0...v0.30.0) (2026-09-23)


### Features

* **daemon:** stream OpenAI-compatible replies per OpenCode session ([4a830c9](https://github.com/anis-marrouchi/agentx/commit/4a830c93ac58930ae87ea596682f80439e0b0327))
* **decisions:** shadow seats for stuck turns and turn handoffs ([fc7adb8](https://github.com/anis-marrouchi/agentx/commit/fc7adb8bce97e4a57ee325d10e504170c4cdbb92))
* **demo:** add --reuse and --bind for a persistent, reachable demo ([4ccb2f2](https://github.com/anis-marrouchi/agentx/commit/4ccb2f2a6c9425d153a3459fa1942b3a223b97cc))
* **docker:** add a persistent scripted demo image for lessons ([ff99972](https://github.com/anis-marrouchi/agentx/commit/ff99972a5aa0a00e48136356a6e118f6e343faf6))
* **teach:** add a dashboard tour lesson for the Docker demo ([5f961ef](https://github.com/anis-marrouchi/agentx/commit/5f961efa4befa72cedc8fbeb1d823ee23e0649ad))
* **teach:** tour-guide lesson safety and Docker demo stage ([56b15ae](https://github.com/anis-marrouchi/agentx/commit/56b15ae82860a58db36dbe288b9a1e85a7be70ad))


### Bug Fixes

* **look:** report why the helper's screen capture failed ([a2d61e0](https://github.com/anis-marrouchi/agentx/commit/a2d61e0257cb7254cfe1918cbd091012a08c3a37))
* **routing:** keep the selected model for OpenCode requests ([283272f](https://github.com/anis-marrouchi/agentx/commit/283272fc1e7921debcf0ea92265e3be9539dcc2c))
* **runtime:** honour maxExecutionMinutes on persistent Claude turns ([4a32013](https://github.com/anis-marrouchi/agentx/commit/4a32013032ff502aa045b418a10b892581b38e87))
* **runtime:** stream text from persistent Claude turns ([64b9101](https://github.com/anis-marrouchi/agentx/commit/64b9101c126948e24b36c6011abc4a2ee8b14aae))
* **teach:** gate every action on a verified screen and stop on failure ([b409b93](https://github.com/anis-marrouchi/agentx/commit/b409b9300ad4f107a207ac513bfc5b589c70985b))

## [0.29.0](https://github.com/anis-marrouchi/agentx/compare/v0.28.0...v0.29.0) (2026-09-22)


### Features

* add contributor support and context-driven maintenance routines ([148c803](https://github.com/anis-marrouchi/agentx/commit/148c803b0ff024bcb0d7fef65d8b1dfcf93963d5))
* gate request preprocessing and protect desktop model selection ([c1c01c0](https://github.com/anis-marrouchi/agentx/commit/c1c01c05d62d11a1b43fa9d1353f5343871b7738))
* **runtime:** reuse Codex app-server processes across requests ([b753b52](https://github.com/anis-marrouchi/agentx/commit/b753b524799ea84e0fb5b0b59d2798e673e106e3))
* **runtime:** reuse isolated OpenCode servers and add launch badge ([93cd9be](https://github.com/anis-marrouchi/agentx/commit/93cd9befcdc1721e77660ed3326b4d25dee655ce))

## 0.28.0 (2026-09-22)

### Features
- Add `agentx desktop install/start/stop/status` for the macOS assistant and computer-use helper.
- Open AgentX agents in OpenCode v2, with a built-in TUI fallback for missing or older installations.
- Add operator-first documentation, annotated screenshot tours, prerequisites, Jev architecture, A2A and terminal guides.
- Seed isolated documentation demos with scripted workflows and review fixtures.

### Fixes
- Include the postinstall script and desktop build sources in npm packages.
- Build Docker from source on Node 22, initialize shared configuration, and connect dashboard and daemon containers.
- Keep scripted demos from calling the live session reviewer.
- Report upstream model errors correctly from the OpenAI-compatible endpoint.
- Correct sorted test expectations and use a pinned local CLI test runner; require opt-in for paid Claude integration tests.

### Release automation
- Generate future versions and changelogs with Release Please, then validate and publish npm releases through GitHub Actions.

## Historical development notes


### Added
- **Attach mode — wearable agents.** A Claude Code session you already have open can register with the daemon and wear an agent's identity, so channel messages for that agent are answered in the session in front of you instead of spawning a subprocess. `agentx attach install` once, then `agentx attach <agent>` inside any session. Three delivery modes: `manual` (never interrupts), `notify` (default — a note at the end of your turn), `auto` (takes the turn and drains until the inbox is empty, bounded at 5 messages). Unclaimed messages atomically expire after 90s and fall back to spawning, so nothing is lost and nothing is answered twice. See [Attach mode](/reference/attach) and [Journey 14](/journey/14-wearable-agent).
- `agentx attach install` also lays down the `PreToolUse` guard hook at user scope: an attached session runs under your permissions rather than the agent workspace's `settings.json`, so without it an attached production identity would be *less* guarded than a spawned one.
- MCP tools `agentx_attach_next` and `agentx_attach_answer`. Both take the session id from the environment, never from the model.

### Changed
- **Dashboard design system ported from the agentina console**: four-colour brand palette (blue/green/amber/red), 2px borders, 16–20px radii, pill chips and badges, the signature un-blurred offset shadow (`0 4px 0 <darker>`) that collapses on press, and Outfit / Roboto Mono. Both light and dark are written out in full — dark is not a derived tint, because derived dark themes are how contrast bugs ship. The `crt` theme is removed; a stored `crt` preference migrates to dark. See [Design system](/architecture/design-system).

### Removed
- **Discord and Slack channel adapters**, their `channels.discord` / `channels.slack` config schema, the Slack user-task renderer, and the Slack reference page. Neither has carried a single task in the entire history of `task_history` on either node, and neither is configured anywhere in the fleet. This shortens the marketed channel list — a deliberate trade, on the grounds that an adapter which has never delivered a message is a claim rather than a feature. Re-adding is contained: two adapter files, two registration blocks, one schema entry. See [Surface reduction](/architecture/surface-reduction).

### Deprecated
- `agentx chat` and `agentx tui` — no recorded use on any node in the fleet since 2026-07-03. Use [`agentx attach <agent>`](/reference/attach) instead, which wears the identity in the Claude Code session you already have open. Both commands still work and print a notice; removal follows the process in [Surface reduction](/architecture/surface-reduction).

### Added (observability)
- `surface_usage` table (schema v11) + `agentx usage surfaces [--unused]` — counts which CLI commands and dashboard pages actually get opened. Names only, never arguments or payloads. Fills the gap `task_history` cannot: it records agent dispatches, not operator behaviour across 268 registered commands and 19 pages.

### Documentation
- New [Surface reduction](/architecture/surface-reduction) — fleet usage baseline across both nodes, the two-part bar (usage AND impact) a surface must fail before removal, and the staged hide-then-remove process.
- New [Attach mode](/reference/attach) reference and [Journey 14 — Wearable agents](/journey/14-wearable-agent).
- New [Guardrails](/reference/guard) reference — the guard subsystem shipped without a docs page or sidebar entry.
- `agentx guard` and `agentx attach` added to the CLI reference; the attach + guard HTTP endpoints documented as loopback-only.

### Security
- Mesh endpoints (`/task`, `/mesh/task`, `/workflow/event`, `/workflow/transition`, `/channel/send`, `/webrtc/signal`) now verify the Bearer token mesh peers have always sent. Loopback callers are exempt; installs without a configured `MESH_TOKEN` keep working with a warning for one release. `AGENTX_MESH_AUTH=off` opts out.
- The peer-identity forward endpoints (`/gitlab/react`, `/gitlab/send-note`, `/gitlab/log-time`, `/github/send-comment`) joined the protected set — previously an unauthenticated non-loopback caller could make the daemon post as its GitLab/GitHub bot.

### Fixed
- Daemon-level peer forwards (workflow trigger broadcast/transition, cross-node `channel/send`, GitLab/GitHub identity forwards, chat listing fan-out) now attach the peer's mesh token via `A2AMesh.authHeaders()` — previously only `a2a/mesh.ts` task calls sent it, so these paths 401'd against enforcing peers.
- Persistent claude processes are no longer idle-killed mid-turn. The handle now reports `busy` while a turn streams (it used to stay `idle`, so any turn longer than the pool's idle window was reaped mid-work — surfacing as `claude process … is dead (idle (Ns))`), `acquire()` claims reused handles to close the acquire→first-write race, and a handle that dies before the first stream event falls back to spawn-per-task instead of failing the task.

### Changed
- **Dashboard nav is now minimal and mesh-first**: Live · Ledger · Cost · Settings. Boards, Workflows, and Inbox tabs appear only when those surfaces are configured (`boards`, `workflows.enabled`); the Team/Business Settings sub-tabs require `business.enabled`. Every previous page stays reachable at its URL — only the top chrome slimmed down.
- `agentx demo` now starts the board dashboard alongside the three daemons, so the printed `/live` URL shows the whole mesh from one page (previous builds printed daemon-port URLs that had no live view).

## 0.24.1 — 2026-07

- **Chat REPL overhaul** — Claude-Code-style Ink interface: live streaming with tool badges (`● Read(app.ts)`), markdown + syntax highlighting, slash menu, `@agent` / `@file` autocomplete, multiline compose, esc-to-interrupt.
- **Procedures** — user-perspective SOP mining: episode clustering and distillation from recurring activity, daily extraction cadence, promote/reject/match CLI, fresh-session injection.
- **Memory → wiki promotion** — recurring agent memories get clustered, judged, and promoted into the compounding wiki (`agentx wiki promote`).
- **Rich channel messages** — buttons, polls, and media via the in-band `agentx:ui` directive on Telegram and WhatsApp; fixed Telegram streaming-edit truncation.
- **Session continuity** — tier-2 rotation now uses real per-request context size instead of cumulative usage (fixes long-conversation amnesia), with deterministic memo handover into fresh sessions.
- **MCP** — HTTP/SSE transport for MCP servers in the orchestrator tier and `.mcp.json`.
- Fixes: Telegram group self-loop guard, GitLab mesh-aware bot identity, workflow trigger `noteableType` filter.

## 0.24.0 — 2026-05

- Workflow YAML round-trips preserve comments; workflow trace + retry.
- Business layer: plan-driven standup ticks with day → week → month fallback.

## 0.23.0 / 0.22.0 — 2026-05

- Lexical RAG (BM25) for retrieval; workflow run tracing and retries.

## 0.21.0 / 0.20.0 — 2026-05

- Action registry with CLI + admin UI; business-layer scheduling.

## 0.19.0 — 2026-05

- ESM cleanup; Node floor raised to 22.

## 0.18.0 and earlier — 2026-04

- The "architectural rescue": append-only intent ledger with replay, SQLite storage via event-bus subscribers (task history, usage, route traces), dataflow DAG workflow engine with visual editor, WhatsApp in-browser QR pairing, natural-language cron (`agentx schedule`), BM25 retrieval + token cost dashboards, SMB repositioning.
