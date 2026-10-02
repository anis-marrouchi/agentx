# Changelog

Notable changes per release. Older releases are summarized; see `git log` for the full record.

## [0.94.1](https://github.com/anis-marrouchi/agentx/compare/v0.94.0...v0.94.1) (2026-10-02)


### Bug Fixes

* **voice:** every shortcut answers, not only the one registered last ([#513](https://github.com/anis-marrouchi/agentx/issues/513)) ([0761a71](https://github.com/anis-marrouchi/agentx/commit/0761a71220edbe0771ff8af2a0ce464da01eaba4)), closes [#511](https://github.com/anis-marrouchi/agentx/issues/511)

## [0.94.0](https://github.com/anis-marrouchi/agentx/compare/v0.93.0...v0.94.0) (2026-10-02)


### Features

* **voice:** drag the character with its bubble, and hide both ([#506](https://github.com/anis-marrouchi/agentx/issues/506)) ([6896599](https://github.com/anis-marrouchi/agentx/commit/68965996d6bf4d585c6a15c88c67ae3c259221c3))


### Bug Fixes

* **voice:** a hush holds a lesson; the words that follow reach it ([#507](https://github.com/anis-marrouchi/agentx/issues/507)) ([7d5e696](https://github.com/anis-marrouchi/agentx/commit/7d5e696a37ab8abeb46446f08a19bc7da6aa71d6))
* **voice:** keep asking for the settings until the daemon answers ([#503](https://github.com/anis-marrouchi/agentx/issues/503)) ([2234609](https://github.com/anis-marrouchi/agentx/commit/22346094184aa68fa9315f4ffb1be831cd90f79f)), closes [#498](https://github.com/anis-marrouchi/agentx/issues/498)

## [0.93.0](https://github.com/anis-marrouchi/agentx/compare/v0.92.4...v0.93.0) (2026-10-02)


### Features

* **voice:** the pill is the character's speech bubble ([#494](https://github.com/anis-marrouchi/agentx/issues/494)) ([850c6ae](https://github.com/anis-marrouchi/agentx/commit/850c6ae67d2db5030053842fd02e714438a3db0a))

## [0.92.4](https://github.com/anis-marrouchi/agentx/compare/v0.92.3...v0.92.4) (2026-10-02)


### Bug Fixes

* **members:** hide the connection strip after a load that worked ([#497](https://github.com/anis-marrouchi/agentx/issues/497)) ([c5c2a53](https://github.com/anis-marrouchi/agentx/commit/c5c2a5393e7c8383c13012c11e3bb6254a92b7dd)), closes [#496](https://github.com/anis-marrouchi/agentx/issues/496)

## [0.92.3](https://github.com/anis-marrouchi/agentx/compare/v0.92.2...v0.92.3) (2026-10-02)


### Bug Fixes

* **members:** retry the name line and say offline only when the browser is ([#490](https://github.com/anis-marrouchi/agentx/issues/490)) ([6273baa](https://github.com/anis-marrouchi/agentx/commit/6273baa61a0592a14319995939e4879613894844)), closes [#489](https://github.com/anis-marrouchi/agentx/issues/489)

## [0.92.2](https://github.com/anis-marrouchi/agentx/compare/v0.92.1...v0.92.2) (2026-10-02)


### Bug Fixes

* **requests:** tie the said-mark to the pick-up that set it ([#486](https://github.com/anis-marrouchi/agentx/issues/486)) ([df66b50](https://github.com/anis-marrouchi/agentx/commit/df66b5002d73506b1d457dcc236b37fe7d6858cb)), closes [#485](https://github.com/anis-marrouchi/agentx/issues/485)

## [0.92.1](https://github.com/anis-marrouchi/agentx/compare/v0.92.0...v0.92.1) (2026-10-02)


### Bug Fixes

* **requests:** do not repeat an old owner reply on a later pick-up ([#483](https://github.com/anis-marrouchi/agentx/issues/483)) ([d77fcfe](https://github.com/anis-marrouchi/agentx/commit/d77fcfefbe2e77bc2812b4ed96af8fa3a8d81226))

## [0.92.0](https://github.com/anis-marrouchi/agentx/compare/v0.91.1...v0.92.0) (2026-10-02)


### Features

* **requests:** show open requests as cards with reply, hand-off and a notice that stays ([#473](https://github.com/anis-marrouchi/agentx/issues/473)) ([c2bc8cf](https://github.com/anis-marrouchi/agentx/commit/c2bc8cfbeaaf33c543590f6f4e5a0fd2f367d085)), closes [#459](https://github.com/anis-marrouchi/agentx/issues/459)

## [0.91.1](https://github.com/anis-marrouchi/agentx/compare/v0.91.0...v0.91.1) (2026-10-02)


### Bug Fixes

* **demo:** install without git by moving baileys to 7.0.0-rc14 ([#472](https://github.com/anis-marrouchi/agentx/issues/472)) ([7d2ccc1](https://github.com/anis-marrouchi/agentx/commit/7d2ccc1b9fe7f5c8503224d280f730a9330bd366)), closes [#461](https://github.com/anis-marrouchi/agentx/issues/461)

## [0.91.0](https://github.com/anis-marrouchi/agentx/compare/v0.90.0...v0.91.0) (2026-10-02)


### Features

* **voice:** show the assistant as an animated character instead of the orb ([#471](https://github.com/anis-marrouchi/agentx/issues/471)) ([d2eb7f5](https://github.com/anis-marrouchi/agentx/commit/d2eb7f5aa18b02a426b292858d69a359295d0da9))

## [0.90.0](https://github.com/anis-marrouchi/agentx/compare/v0.89.0...v0.90.0) (2026-10-02)


### Features

* **agents:** scope plan holds to the model, lift them early or by hand, and show them ([#470](https://github.com/anis-marrouchi/agentx/issues/470)) ([cc7a1f0](https://github.com/anis-marrouchi/agentx/commit/cc7a1f0f18c2cb1c242bcaf19cb1318fcb4799f2))
* **daemon:** show version, running since and last restart in daemon status, /health and the dashboard header ([#469](https://github.com/anis-marrouchi/agentx/issues/469)) ([d0f4330](https://github.com/anis-marrouchi/agentx/commit/d0f4330ce6086f39453e66b5383967b413d73a2c))


### Bug Fixes

* **agents:** do not hold cold dispatches while extra usage still serves ([#467](https://github.com/anis-marrouchi/agentx/issues/467)) ([2cc2ef4](https://github.com/anis-marrouchi/agentx/commit/2cc2ef42e9120b7a71a72f1a4777f68f8cbc6bf1)), closes [#466](https://github.com/anis-marrouchi/agentx/issues/466)
* **agents:** gate cold dispatches on Claude Code's rate-limit signal, not a local count ([#463](https://github.com/anis-marrouchi/agentx/issues/463)) ([0d93881](https://github.com/anis-marrouchi/agentx/commit/0d938813b4c0b7120d9e99d986e053bfa5768849)), closes [#462](https://github.com/anis-marrouchi/agentx/issues/462)
* **dashboard:** stop the member page's poll from freezing every page ([#451](https://github.com/anis-marrouchi/agentx/issues/451)) ([6891e52](https://github.com/anis-marrouchi/agentx/commit/6891e52f981815eef27e260ead5a8e4d72835c1d)), closes [#448](https://github.com/anis-marrouchi/agentx/issues/448)
* **people:** keep a person's turns newest first when two start in the same millisecond ([#456](https://github.com/anis-marrouchi/agentx/issues/456)) ([a6f7e51](https://github.com/anis-marrouchi/agentx/commit/a6f7e510c7d6a14662c62e41359d124ddd40cfb0))

## [0.89.0](https://github.com/anis-marrouchi/agentx/compare/v0.88.0...v0.89.0) (2026-10-02)


### Features

* **app:** swipe between tabs in the phone app ([#450](https://github.com/anis-marrouchi/agentx/issues/450)) ([2d56b6b](https://github.com/anis-marrouchi/agentx/commit/2d56b6b7d1226a7a8d7aa23dee5ca567916862a9)), closes [#444](https://github.com/anis-marrouchi/agentx/issues/444)

## [0.88.0](https://github.com/anis-marrouchi/agentx/compare/v0.87.0...v0.88.0) (2026-10-02)


### Features

* **dashboard:** add a People page with paired machines and activity ([#446](https://github.com/anis-marrouchi/agentx/issues/446)) ([8b2a70d](https://github.com/anis-marrouchi/agentx/commit/8b2a70de54fc074495142ec91f6560f356a323c6))

## [0.87.0](https://github.com/anis-marrouchi/agentx/compare/v0.86.0...v0.87.0) (2026-10-02)


### Features

* **activity:** lane the timeline by the person who started each run ([#439](https://github.com/anis-marrouchi/agentx/issues/439)) ([2ebed4d](https://github.com/anis-marrouchi/agentx/commit/2ebed4d953df605c833dc504cada2f1c6602e5ca))

## [0.86.0](https://github.com/anis-marrouchi/agentx/compare/v0.85.0...v0.86.0) (2026-10-02)


### Features

* **activity:** put who started the work first on the map, before the channel ([#434](https://github.com/anis-marrouchi/agentx/issues/434)) ([534468b](https://github.com/anis-marrouchi/agentx/commit/534468b2cf02f7731d304fa3b77f4a5abf97efd1))

## [0.85.0](https://github.com/anis-marrouchi/agentx/compare/v0.84.0...v0.85.0) (2026-10-02)


### Features

* **teach:** tilt and move steps in draw mode ([#429](https://github.com/anis-marrouchi/agentx/issues/429)) ([12ee9b6](https://github.com/anis-marrouchi/agentx/commit/12ee9b683d0f6c6d21cc9d2efe8f1a043b595a0f))


### Bug Fixes

* **members:** take the address the proxy saw, not the first one listed ([#430](https://github.com/anis-marrouchi/agentx/issues/430)) ([303e09a](https://github.com/anis-marrouchi/agentx/commit/303e09a277545f6fd4c0c84808703cff5204a572))

## [0.84.0](https://github.com/anis-marrouchi/agentx/compare/v0.83.2...v0.84.0) (2026-10-02)


### Features

* **people:** deny a person named tools and skills, enforced on every call ([#427](https://github.com/anis-marrouchi/agentx/issues/427)) ([99a7c9d](https://github.com/anis-marrouchi/agentx/commit/99a7c9d486a2a97c5b6f8f2a0cf524e329319af6))

## [0.83.2](https://github.com/anis-marrouchi/agentx/compare/v0.83.1...v0.83.2) (2026-10-02)


### Bug Fixes

* **requests:** a peer's vouch is believed only from another machine ([#424](https://github.com/anis-marrouchi/agentx/issues/424)) ([054ff35](https://github.com/anis-marrouchi/agentx/commit/054ff351a1003432c003d15a5d49d0b78f252af7))

## [0.83.1](https://github.com/anis-marrouchi/agentx/compare/v0.83.0...v0.83.1) (2026-10-02)


### Bug Fixes

* **people:** check a person's limit before every way to an agent ([#421](https://github.com/anis-marrouchi/agentx/issues/421)) ([0308d73](https://github.com/anis-marrouchi/agentx/commit/0308d7381d13bee097f61bb9ccb64a20f5679408))
* **requests:** the forwarding node vouches for the owner on a mesh forward ([#423](https://github.com/anis-marrouchi/agentx/issues/423)) ([d08ee6d](https://github.com/anis-marrouchi/agentx/commit/d08ee6d6ac7427a3accd7a6a24d37d0c2f35fe30)), closes [#407](https://github.com/anis-marrouchi/agentx/issues/407)

## [0.83.0](https://github.com/anis-marrouchi/agentx/compare/v0.82.0...v0.83.0) (2026-10-01)


### Features

* **mesh:** let another organisation into part of a mesh, under the host's live control ([#419](https://github.com/anis-marrouchi/agentx/issues/419)) ([89e9a05](https://github.com/anis-marrouchi/agentx/commit/89e9a057ff84f68d2461e63f36975098e501f922)), closes [#380](https://github.com/anis-marrouchi/agentx/issues/380)
* **people:** limit a person to named agents, and keep their trail 90 days ([#415](https://github.com/anis-marrouchi/agentx/issues/415)) ([ef8115d](https://github.com/anis-marrouchi/agentx/commit/ef8115d2f76c0e2332e88f7a7769dc75655a6db0))

## [0.82.0](https://github.com/anis-marrouchi/agentx/compare/v0.81.1...v0.82.0) (2026-10-01)


### Features

* **members:** invite a teammate to their own work page ([#413](https://github.com/anis-marrouchi/agentx/issues/413)) ([8bc7b9a](https://github.com/anis-marrouchi/agentx/commit/8bc7b9a8f515537e812fd1176c861a8556eaa848))

## [0.81.1](https://github.com/anis-marrouchi/agentx/compare/v0.81.0...v0.81.1) (2026-10-01)


### Bug Fixes

* **calls:** find a /task run with no chat by the pair its warm process sends ([#411](https://github.com/anis-marrouchi/agentx/issues/411)) ([92aa53d](https://github.com/anis-marrouchi/agentx/commit/92aa53d7352780ae7339ca63c98a72f3d3c28185))
* **calls:** keep a call waiting while the voice pill is busy ([#409](https://github.com/anis-marrouchi/agentx/issues/409)) ([88e4b35](https://github.com/anis-marrouchi/agentx/commit/88e4b3544684bae1cc2cc5db9a8040aeef887a7e))

## [0.81.0](https://github.com/anis-marrouchi/agentx/compare/v0.80.1...v0.81.0) (2026-10-01)


### Features

* **people:** one identity per human across channels ([#389](https://github.com/anis-marrouchi/agentx/issues/389)) ([23c9604](https://github.com/anis-marrouchi/agentx/commit/23c96049768872b815676c59508997ee2f8b0c19))
* **requests:** show a request's state in the thread where it was made ([#391](https://github.com/anis-marrouchi/agentx/issues/391)) ([2daf0ff](https://github.com/anis-marrouchi/agentx/commit/2daf0ff3f187a22347d599d4d44e14f49d88d0ea))


### Bug Fixes

* **demo:** carry on without a browser opener; refuse an unsupported Node.js in one line ([#406](https://github.com/anis-marrouchi/agentx/issues/406)) ([75ad79a](https://github.com/anis-marrouchi/agentx/commit/75ad79a51cfcb0a56c216fde8fa25c0d3dba7a19))
* **requests:** queued hand-back, owner proof, and the agentx tool for every agent ([#404](https://github.com/anis-marrouchi/agentx/issues/404)) ([47dfc38](https://github.com/anis-marrouchi/agentx/commit/47dfc38909d24655cf5761ff245abbfbe960c4c3))

## [0.80.1](https://github.com/anis-marrouchi/agentx/compare/v0.80.0...v0.80.1) (2026-10-01)


### Bug Fixes

* **requests:** close four rough edges in the CLI and the page ([#397](https://github.com/anis-marrouchi/agentx/issues/397)) ([db179c9](https://github.com/anis-marrouchi/agentx/commit/db179c9a717dcadc927e4dad1867fdc9ba50f9d2)), closes [#395](https://github.com/anis-marrouchi/agentx/issues/395)
* **requests:** raise a request when its work stops, and never drop a yes ([#396](https://github.com/anis-marrouchi/agentx/issues/396)) ([ec48fcd](https://github.com/anis-marrouchi/agentx/commit/ec48fcd1724790f9041bd6432c1c27a8b42dfb85)), closes [#394](https://github.com/anis-marrouchi/agentx/issues/394)
* **requests:** take the caller from proof, not from what the caller says ([#398](https://github.com/anis-marrouchi/agentx/issues/398)) ([5e0e53f](https://github.com/anis-marrouchi/agentx/commit/5e0e53fa1278fe55c9464d5e917528196b72dcfe)), closes [#393](https://github.com/anis-marrouchi/agentx/issues/393)

## [0.80.0](https://github.com/anis-marrouchi/agentx/compare/v0.79.4...v0.80.0) (2026-10-01)


### Features

* **requests:** open requests in the Approvals inbox and on its page ([#390](https://github.com/anis-marrouchi/agentx/issues/390)) ([5eff06b](https://github.com/anis-marrouchi/agentx/commit/5eff06bb35f339964dcff368b47bfeb92be66995))
* **requests:** record owner requests and follow them until closed ([#382](https://github.com/anis-marrouchi/agentx/issues/382)) ([5163628](https://github.com/anis-marrouchi/agentx/commit/5163628ae011f954aad075e994bd9b4451da1b46))
* **requests:** see and close open requests (tool, API, CLI) ([#388](https://github.com/anis-marrouchi/agentx/issues/388)) ([2f3f52f](https://github.com/anis-marrouchi/agentx/commit/2f3f52fb636c5cfbb2c7cebad3789e8623296d8e))

## [0.79.4](https://github.com/anis-marrouchi/agentx/compare/v0.79.3...v0.79.4) (2026-10-01)


### Bug Fixes

* **approvals:** Mac card receives clicks, drags and keys ([#377](https://github.com/anis-marrouchi/agentx/issues/377)) ([1fe271d](https://github.com/anis-marrouchi/agentx/commit/1fe271dc16cdcc590d3cec3a28edc9e72d5c837b)), closes [#369](https://github.com/anis-marrouchi/agentx/issues/369)

## [0.79.3](https://github.com/anis-marrouchi/agentx/compare/v0.79.2...v0.79.3) (2026-10-01)


### Bug Fixes

* **approvals:** Mac card stays up, takes the first click, sends long messages ([#373](https://github.com/anis-marrouchi/agentx/issues/373)) ([b73b65f](https://github.com/anis-marrouchi/agentx/commit/b73b65ff0b2647429661e01906038ae4c22d303a))

## [0.79.2](https://github.com/anis-marrouchi/agentx/compare/v0.79.1...v0.79.2) (2026-10-01)


### Bug Fixes

* **approvals:** check-ins wait for a busy agent, retry once, and report failures ([#371](https://github.com/anis-marrouchi/agentx/issues/371)) ([c0a221a](https://github.com/anis-marrouchi/agentx/commit/c0a221ad8e21872654021dffb7f7907178b736d5))
* **owner-sweep:** an unfinished run with no start time counts as the newest ([#368](https://github.com/anis-marrouchi/agentx/issues/368)) ([2079959](https://github.com/anis-marrouchi/agentx/commit/207995937bb92524627f8ce80847b8609f9df175))

## [0.79.1](https://github.com/anis-marrouchi/agentx/compare/v0.79.0...v0.79.1) (2026-10-01)


### Bug Fixes

* **owner-sweep:** cancelled duplicate check no longer counts as red CI ([#364](https://github.com/anis-marrouchi/agentx/issues/364)) ([60104fa](https://github.com/anis-marrouchi/agentx/commit/60104fa4f98365144d61d2126f1cf0410dad784a))

## [0.79.0](https://github.com/anis-marrouchi/agentx/compare/v0.78.0...v0.79.0) (2026-10-01)


### Features

* **workflows:** poll trigger that starts a run per new item ([#362](https://github.com/anis-marrouchi/agentx/issues/362)) ([fc873f9](https://github.com/anis-marrouchi/agentx/commit/fc873f9b682df4c664a925bf268c0f173be7e10c))


### Bug Fixes

* **voice:** end a long spoken answer on a sentence and say there is more ([#358](https://github.com/anis-marrouchi/agentx/issues/358)) ([73935d3](https://github.com/anis-marrouchi/agentx/commit/73935d3c0b49b08f0854672b93fce693f76ff70a))
* **workflows:** manual run starts the workflow named in the URL ([#361](https://github.com/anis-marrouchi/agentx/issues/361)) ([9c3b076](https://github.com/anis-marrouchi/agentx/commit/9c3b07645f30ac7e4c8b8a33ede0ca497e282ba4))

## [0.78.0](https://github.com/anis-marrouchi/agentx/compare/v0.77.0...v0.78.0) (2026-10-01)


### Features

* **approvals:** Mac card follows the Answer Card design ([#354](https://github.com/anis-marrouchi/agentx/issues/354)) ([79cb743](https://github.com/anis-marrouchi/agentx/commit/79cb743e6f8bcd23b8c5376eee883c0595889c6e))

## [0.77.0](https://github.com/anis-marrouchi/agentx/compare/v0.76.0...v0.77.0) (2026-09-30)


### Features

* **approvals:** web card on the Mac and scheduled check-ins for reminders ([#351](https://github.com/anis-marrouchi/agentx/issues/351)) ([7f328bb](https://github.com/anis-marrouchi/agentx/commit/7f328bb7f72a3dff0ffc42a0b93628c96dbcdc9a))

## [0.76.0](https://github.com/anis-marrouchi/agentx/compare/v0.75.3...v0.76.0) (2026-09-30)


### Features

* **approvals:** Mac popup to answer decision cards in one click ([#348](https://github.com/anis-marrouchi/agentx/issues/348)) ([f085eec](https://github.com/anis-marrouchi/agentx/commit/f085eec7cd6fa78bebbf90acda22601e395eab1a)), closes [#347](https://github.com/anis-marrouchi/agentx/issues/347)

## [0.75.3](https://github.com/anis-marrouchi/agentx/compare/v0.75.2...v0.75.3) (2026-09-30)


### Bug Fixes

* **install:** accept Node 22.19 through 26, not only 22.x ([#344](https://github.com/anis-marrouchi/agentx/issues/344)) ([2d6fc33](https://github.com/anis-marrouchi/agentx/commit/2d6fc33a656e4dd0e06091692b3be19452649fca))

## [0.75.2](https://github.com/anis-marrouchi/agentx/compare/v0.75.1...v0.75.2) (2026-09-30)


### Bug Fixes

* **agents:** bound every preparation step, retry a run the pre-spawn deadline stops, and close its trace ([#341](https://github.com/anis-marrouchi/agentx/issues/341)) ([724fb7a](https://github.com/anis-marrouchi/agentx/commit/724fb7a540af603436b732f2b4435a9005f0053a)), closes [#340](https://github.com/anis-marrouchi/agentx/issues/340)

## [0.75.1](https://github.com/anis-marrouchi/agentx/compare/v0.75.0...v0.75.1) (2026-09-30)


### Bug Fixes

* **mac-voice:** bring the closed pill back in one click ([#338](https://github.com/anis-marrouchi/agentx/issues/338)) ([6b557f3](https://github.com/anis-marrouchi/agentx/commit/6b557f35ed563c2a5897e8931b024cf9ec3c3bd4))

## [0.75.0](https://github.com/anis-marrouchi/agentx/compare/v0.74.0...v0.75.0) (2026-09-29)


### Features

* **camera:** an agent watches the phone camera and asks to see ([#325](https://github.com/anis-marrouchi/agentx/issues/325) phases 2 and 3) ([#335](https://github.com/anis-marrouchi/agentx/issues/335)) ([e687679](https://github.com/anis-marrouchi/agentx/commit/e68767980879da1d03d07126bc2b7fea807434b6))

## [0.74.0](https://github.com/anis-marrouchi/agentx/compare/v0.73.0...v0.74.0) (2026-09-29)


### Features

* **daemon:** restart policy in config, the runs a restart would cut, and resumed agent-to-agent work ([#333](https://github.com/anis-marrouchi/agentx/issues/333)) ([966e753](https://github.com/anis-marrouchi/agentx/commit/966e753cf6563306da52dd9edf6223b1c486b7ee))

## [0.73.0](https://github.com/anis-marrouchi/agentx/compare/v0.72.0...v0.73.0) (2026-09-29)


### Features

* **whatsapp:** triage watched WhatsApp chats, replies only on approval ([#331](https://github.com/anis-marrouchi/agentx/issues/331)) ([ff36dda](https://github.com/anis-marrouchi/agentx/commit/ff36ddaeba809cd20b9539312ce8681305946dfc))

## [0.72.0](https://github.com/anis-marrouchi/agentx/compare/v0.71.0...v0.72.0) (2026-09-29)


### Features

* **app:** share the phone camera with another mesh node ([#325](https://github.com/anis-marrouchi/agentx/issues/325) phase 1) ([#327](https://github.com/anis-marrouchi/agentx/issues/327)) ([435c68f](https://github.com/anis-marrouchi/agentx/commit/435c68f4f41c4d54c0aa9064ed87a2ec90052a28))


### Bug Fixes

* **tui:** start OpenCode's server before its screen so the console opens on a busy machine ([#323](https://github.com/anis-marrouchi/agentx/issues/323)) ([0fd8b18](https://github.com/anis-marrouchi/agentx/commit/0fd8b1890f0e19a0443894193863fb86334483bd))
* **voice:** tell the owner when a configured voice is missing, and fall back well ([#320](https://github.com/anis-marrouchi/agentx/issues/320)) ([4eaf6bc](https://github.com/anis-marrouchi/agentx/commit/4eaf6bc9df0be98c15fa369b66692b4441b57d1f))

## [0.71.0](https://github.com/anis-marrouchi/agentx/compare/v0.70.1...v0.71.0) (2026-09-29)


### Features

* **calls:** agents ring the owner for a live voice call ([#322](https://github.com/anis-marrouchi/agentx/issues/322)) ([8a7df51](https://github.com/anis-marrouchi/agentx/commit/8a7df51874115574e08d850526b669d518c3cbc1))

## [0.70.1](https://github.com/anis-marrouchi/agentx/compare/v0.70.0...v0.70.1) (2026-09-29)


### Bug Fixes

* **demo:** configurable, load-aware startup limit ([#316](https://github.com/anis-marrouchi/agentx/issues/316)) ([84de480](https://github.com/anis-marrouchi/agentx/commit/84de480bbead58a127565236af16fb3907cc849b)), closes [#315](https://github.com/anis-marrouchi/agentx/issues/315)
* **resume:** answer forwarded chat runs through the node that received them ([#313](https://github.com/anis-marrouchi/agentx/issues/313)) ([e454a42](https://github.com/anis-marrouchi/agentx/commit/e454a424a0c7352b2cbb5218acddf0ad59f6e477))
* **wiki:** keep text matches ahead of branch matches and read the path from the running turn ([#314](https://github.com/anis-marrouchi/agentx/issues/314)) ([238a998](https://github.com/anis-marrouchi/agentx/commit/238a998178a3bb768c24df8df8bed43e7f01eefa))

## [0.70.0](https://github.com/anis-marrouchi/agentx/compare/v0.69.4...v0.70.0) (2026-09-29)


### Features

* **decisions:** classify intents through a Jev seat and route the path into wiki retrieval ([#308](https://github.com/anis-marrouchi/agentx/issues/308)) ([3ec60c9](https://github.com/anis-marrouchi/agentx/commit/3ec60c977243549400c3454c317fb112f09f8309))

## [0.69.4](https://github.com/anis-marrouchi/agentx/compare/v0.69.3...v0.69.4) (2026-09-29)


### Performance Improvements

* take the intent classifier off the critical path and cut per-turn overhead ([#305](https://github.com/anis-marrouchi/agentx/issues/305)) ([b87628d](https://github.com/anis-marrouchi/agentx/commit/b87628dee6edada4d278fb8d46667766422141cc))

## [0.69.3](https://github.com/anis-marrouchi/agentx/compare/v0.69.2...v0.69.3) (2026-09-29)


### Bug Fixes

* **daemon:** a task a restart cuts off reports the restart and resumes ([#303](https://github.com/anis-marrouchi/agentx/issues/303)) ([51073b7](https://github.com/anis-marrouchi/agentx/commit/51073b78419413d78dc9bb68c1456f88da7ba7d7))

## [0.69.2](https://github.com/anis-marrouchi/agentx/compare/v0.69.1...v0.69.2) (2026-09-29)


### Bug Fixes

* **app:** phone orb keeps a square canvas on 2x screens ([#298](https://github.com/anis-marrouchi/agentx/issues/298)) ([#299](https://github.com/anis-marrouchi/agentx/issues/299)) ([889eb9f](https://github.com/anis-marrouchi/agentx/commit/889eb9f32718cb22065a84e909a316c5bc397cf7))


### Performance Improvements

* **daemon:** stop the classifier and delegation check from blocking the event loop ([#301](https://github.com/anis-marrouchi/agentx/issues/301)) ([7b9d15c](https://github.com/anis-marrouchi/agentx/commit/7b9d15cab1e570a72b3c1b2349d81ff800bc29cf))

## [0.69.1](https://github.com/anis-marrouchi/agentx/compare/v0.69.0...v0.69.1) (2026-09-28)


### Bug Fixes

* **wiki:** an agent cannot dismiss or answer a fact disagreement ([#295](https://github.com/anis-marrouchi/agentx/issues/295)) ([5026c0f](https://github.com/anis-marrouchi/agentx/commit/5026c0f47b3fd180c821bae08379ce3f86bae1bf))
* **wiki:** only a person confirms facts; harden ledger lock and reads ([#293](https://github.com/anis-marrouchi/agentx/issues/293)) ([1680eb1](https://github.com/anis-marrouchi/agentx/commit/1680eb1ec1d3f3147224211a23430df2de4954aa)), closes [#273](https://github.com/anis-marrouchi/agentx/issues/273)

## [0.69.0](https://github.com/anis-marrouchi/agentx/compare/v0.68.1...v0.69.0) (2026-09-28)


### Features

* **activity-map:** true origins, full A2A hop chains and clickable cards ([#290](https://github.com/anis-marrouchi/agentx/issues/290)) ([0eb31a4](https://github.com/anis-marrouchi/agentx/commit/0eb31a4e8e1015d5589706f00368d18767aeb52b))
* **memory:** fact ledger with provenance, overwrite safety and verify-or-ask ([#288](https://github.com/anis-marrouchi/agentx/issues/288)) ([47f7068](https://github.com/anis-marrouchi/agentx/commit/47f70689916551bb38d00f6247b08b91ee8cec3c))


### Bug Fixes

* **channels:** an outsider's agentx marker neither hides nor relabels their comment ([#289](https://github.com/anis-marrouchi/agentx/issues/289)) ([d3f80d9](https://github.com/anis-marrouchi/agentx/commit/d3f80d95b898dffdcaf282b20af9873de21bd656))

## [0.68.1](https://github.com/anis-marrouchi/agentx/compare/v0.68.0...v0.68.1) (2026-09-28)


### Bug Fixes

* **channels:** trust an agent signature only from AgentX's own accounts ([#286](https://github.com/anis-marrouchi/agentx/issues/286)) ([e268259](https://github.com/anis-marrouchi/agentx/commit/e268259723a94cdc0ea0f2947a2254681cd0ee22))
* **router:** queued mesh turns are not failures; agent comments are agent-sent ([#284](https://github.com/anis-marrouchi/agentx/issues/284)) ([99a514a](https://github.com/anis-marrouchi/agentx/commit/99a514a90e84741587d2990a183fffaa7c83fad7))

## [0.68.0](https://github.com/anis-marrouchi/agentx/compare/v0.67.0...v0.68.0) (2026-09-28)


### Features

* **a2a:** call the caller back when a person started the delegation ([#279](https://github.com/anis-marrouchi/agentx/issues/279)) ([af3c4c1](https://github.com/anis-marrouchi/agentx/commit/af3c4c1c5d32615e55de04ce6b8e503d798582f9))
* **contrib:** assisted issue filing and community voting ([#283](https://github.com/anis-marrouchi/agentx/issues/283)) ([1062da0](https://github.com/anis-marrouchi/agentx/commit/1062da01ba3f1502e6d7fa57f4a81c186e007a50))

## [0.67.0](https://github.com/anis-marrouchi/agentx/compare/v0.66.0...v0.67.0) (2026-09-28)


### Features

* **memory:** flag stale volatile facts as unverified, verify-or-ask ([#273](https://github.com/anis-marrouchi/agentx/issues/273)) ([#274](https://github.com/anis-marrouchi/agentx/issues/274)) ([6164f5e](https://github.com/anis-marrouchi/agentx/commit/6164f5e094129258a413bca3a1bdcefdcb530deb))


### Bug Fixes

* **app:** record phone chats as the operator on the phone, not A2A ([#278](https://github.com/anis-marrouchi/agentx/issues/278)) ([5eaa1af](https://github.com/anis-marrouchi/agentx/commit/5eaa1af7cf2783338096792d4d850244f7e69503))

## [0.66.0](https://github.com/anis-marrouchi/agentx/compare/v0.65.0...v0.66.0) (2026-09-28)


### Features

* **app:** mesh announcements in the phone Alerts tab, with push ([#272](https://github.com/anis-marrouchi/agentx/issues/272)) ([27d0901](https://github.com/anis-marrouchi/agentx/commit/27d090177bac720bea66497d972cc5aaaf1814a8))
* **app:** talk to several agents at once on the phone ([#270](https://github.com/anis-marrouchi/agentx/issues/270)) ([5bb6183](https://github.com/anis-marrouchi/agentx/commit/5bb6183465d57c7be8b7eb7d32557f80b37310da))
* **voice:** ask mesh agents by name, mini orbs for parallel asks ([#269](https://github.com/anis-marrouchi/agentx/issues/269)) ([b427b62](https://github.com/anis-marrouchi/agentx/commit/b427b62b82c5115ed0617236cdf8e84b07dadf38))

## [0.65.0](https://github.com/anis-marrouchi/agentx/compare/v0.64.0...v0.65.0) (2026-09-28)


### Features

* **app:** attach phone files from an outbox inside the workspace ([#261](https://github.com/anis-marrouchi/agentx/issues/261)) ([eb2044d](https://github.com/anis-marrouchi/agentx/commit/eb2044def5dfa87c6a6829df4410e5e39ab2adf2))
* **app:** quick-reply chips and reply buttons in phone chat ([#263](https://github.com/anis-marrouchi/agentx/issues/263)) ([2cae695](https://github.com/anis-marrouchi/agentx/commit/2cae695342b2a19103f7a323744953596a11570b))
* **app:** richMessages false also turns off phone pictures and files ([#262](https://github.com/anis-marrouchi/agentx/issues/262)) ([c4458e1](https://github.com/anis-marrouchi/agentx/commit/c4458e1e88b5ae2cfab6cca7adadd1e1402b77a9)), closes [#259](https://github.com/anis-marrouchi/agentx/issues/259)


### Bug Fixes

* **app:** keep finished answers that mention an unclosed agentx-artifact tag ([#260](https://github.com/anis-marrouchi/agentx/issues/260)) ([d7e6128](https://github.com/anis-marrouchi/agentx/commit/d7e6128b4419cd52b568699de9c3cbb236351d36)), closes [#256](https://github.com/anis-marrouchi/agentx/issues/256)

## [0.64.0](https://github.com/anis-marrouchi/agentx/compare/v0.63.0...v0.64.0) (2026-09-28)


### Features

* **app:** Markdown pictures and agent files in phone chat ([#254](https://github.com/anis-marrouchi/agentx/issues/254)) ([620947d](https://github.com/anis-marrouchi/agentx/commit/620947d55da467bafc559568e4dfe7de311b03d2))

## [0.63.0](https://github.com/anis-marrouchi/agentx/compare/v0.62.0...v0.63.0) (2026-09-28)


### Features

* **voice:** move speech engines to their own Settings tab ([#251](https://github.com/anis-marrouchi/agentx/issues/251)) ([036a6a3](https://github.com/anis-marrouchi/agentx/commit/036a6a3fe470f78a559824ec75675e77aa624dd6)), closes [#236](https://github.com/anis-marrouchi/agentx/issues/236)


### Bug Fixes

* **app:** keep the phone paired across updates; scan the pairing QR inside the app ([#248](https://github.com/anis-marrouchi/agentx/issues/248)) ([02deffe](https://github.com/anis-marrouchi/agentx/commit/02deffea116ec234f45de849ac3d12c88af7db01))
* **app:** refuse phone recordings the daemon can't measure ([#246](https://github.com/anis-marrouchi/agentx/issues/246)) ([1e62863](https://github.com/anis-marrouchi/agentx/commit/1e62863a2b7fb71382b577485ff4e5af28e8e67f)), closes [#233](https://github.com/anis-marrouchi/agentx/issues/233)
* **app:** renew the session cookie on each app load ([#252](https://github.com/anis-marrouchi/agentx/issues/252)) ([58c5c13](https://github.com/anis-marrouchi/agentx/commit/58c5c13c56adefd9b11c685a956b94f3808b4028)), closes [#234](https://github.com/anis-marrouchi/agentx/issues/234)
* **crons:** read only the requested day's runs; slow extras don't hide a node ([#247](https://github.com/anis-marrouchi/agentx/issues/247)) ([329f84c](https://github.com/anis-marrouchi/agentx/commit/329f84c222560cc7414cbbeccdf286e2937912f1)), closes [#245](https://github.com/anis-marrouchi/agentx/issues/245)
* **desktop:** adopt an existing voice login item instead of adding a second ([#249](https://github.com/anis-marrouchi/agentx/issues/249)) ([e8d1eb0](https://github.com/anis-marrouchi/agentx/commit/e8d1eb06650c6fb83875c6ae5470ef5a6c4016f0))
* **mac-voice:** correct log path in install summary ([#240](https://github.com/anis-marrouchi/agentx/issues/240)) ([3766384](https://github.com/anis-marrouchi/agentx/commit/3766384f602d3b8fba8e512591270c1d9fab9247))
* **procedures:** keep AI banned in the miner's word list ([#242](https://github.com/anis-marrouchi/agentx/issues/242)) ([b19dd37](https://github.com/anis-marrouchi/agentx/commit/b19dd3739c3025311ba0017e88798ebf933147aa))

## [0.62.0](https://github.com/anis-marrouchi/agentx/compare/v0.61.0...v0.62.0) (2026-09-28)


### Features

* **daemon:** report running version and commit in /health ([#229](https://github.com/anis-marrouchi/agentx/issues/229)) ([b8ae884](https://github.com/anis-marrouchi/agentx/commit/b8ae884e8fa929b8b22e3138efdc235594e2821b))


### Bug Fixes

* **app:** enforce the 2-minute voice cap and speak the pinned peer's voice ([#228](https://github.com/anis-marrouchi/agentx/issues/228)) ([2b11f5c](https://github.com/anis-marrouchi/agentx/commit/2b11f5cd96555aa824ca988eee35400c847d7b63))
* **procedures:** render the miner prompt's banned words from the lint list ([#231](https://github.com/anis-marrouchi/agentx/issues/231)) ([bac8e42](https://github.com/anis-marrouchi/agentx/commit/bac8e42f6d19fa62c913e8d5e5f408f8a5218fba)), closes [#230](https://github.com/anis-marrouchi/agentx/issues/230)

## [0.61.0](https://github.com/anis-marrouchi/agentx/compare/v0.60.0...v0.61.0) (2026-09-28)


### Features

* **app:** voice-first Chat with the AgentX Voice orb ([#224](https://github.com/anis-marrouchi/agentx/issues/224)) ([3023318](https://github.com/anis-marrouchi/agentx/commit/30233186d11fa55f806fe7befd41161e6a25f17b))

## [0.60.0](https://github.com/anis-marrouchi/agentx/compare/v0.59.0...v0.60.0) (2026-09-28)


### Features

* **voice:** answer inside the pill, native look, nature orb palettes ([#211](https://github.com/anis-marrouchi/agentx/issues/211)) ([#220](https://github.com/anis-marrouchi/agentx/issues/220)) ([63efbd3](https://github.com/anis-marrouchi/agentx/commit/63efbd3498dd4c70d9480d3e626ee011ab067287))

## [0.59.0](https://github.com/anis-marrouchi/agentx/compare/v0.58.0...v0.59.0) (2026-09-28)


### Features

* **voice:** History window, recent replays and bounded history routes ([#215](https://github.com/anis-marrouchi/agentx/issues/215)) ([0bfa659](https://github.com/anis-marrouchi/agentx/commit/0bfa6595cc0a8b402138d52dc35fcfa1c33bafdc))
* **voice:** Silero VAD end of turn and opt-in Parakeet on-device speech-to-text ([#221](https://github.com/anis-marrouchi/agentx/issues/221)) ([c7c4fcc](https://github.com/anis-marrouchi/agentx/commit/c7c4fcc872c7a6839f55768b2677430372eec287))


### Bug Fixes

* **app:** pair the installed phone app with a one-time code ([#217](https://github.com/anis-marrouchi/agentx/issues/217)) ([b313cc0](https://github.com/anis-marrouchi/agentx/commit/b313cc0b769dd886f24b8e20028a1c3a826f91ce))
* **daemon:** require a mesh token for task traces from off-box ([#216](https://github.com/anis-marrouchi/agentx/issues/216)) ([c2f7b9f](https://github.com/anis-marrouchi/agentx/commit/c2f7b9fbd909b7561078f4684c25a08e7dd22678))

## [0.58.0](https://github.com/anis-marrouchi/agentx/compare/v0.57.0...v0.58.0) (2026-09-28)


### Features

* **voice:** the orb lives in the floating pill — smaller, movable, dismissible ([#209](https://github.com/anis-marrouchi/agentx/issues/209)) ([25b8af5](https://github.com/anis-marrouchi/agentx/commit/25b8af54b93da3ea17960fa14b3b84a2e8d61f1e))

## [0.57.0](https://github.com/anis-marrouchi/agentx/compare/v0.56.0...v0.57.0) (2026-09-28)


### Features

* **voice:** per-agent settings window saved through the daemon ([#204](https://github.com/anis-marrouchi/agentx/issues/204)) ([#206](https://github.com/anis-marrouchi/agentx/issues/206)) ([c84726d](https://github.com/anis-marrouchi/agentx/commit/c84726d5bc782c3d694808b850f2357c746b04cc))

## [0.56.0](https://github.com/anis-marrouchi/agentx/compare/v0.55.0...v0.56.0) (2026-09-28)


### Features

* **voice:** Siri-style orb overlay tinted with the agent's colour ([#203](https://github.com/anis-marrouchi/agentx/issues/203)) ([920a17e](https://github.com/anis-marrouchi/agentx/commit/920a17e3afc41e9c98e58ff87069aa485ca74ea7))

## [0.55.0](https://github.com/anis-marrouchi/agentx/compare/v0.54.0...v0.55.0) (2026-09-27)


### Features

* **app:** Chat tab — talk to any agent on the mesh from the phone ([#201](https://github.com/anis-marrouchi/agentx/issues/201)) ([0869723](https://github.com/anis-marrouchi/agentx/commit/08697232485595d0acf2000a7aba75d1fc8d634c))
* **attach:** watch-only sessions with a capped event digest ([#199](https://github.com/anis-marrouchi/agentx/issues/199)) ([d2a12c1](https://github.com/anis-marrouchi/agentx/commit/d2a12c1304852b044d747d268da2347811ecfed9))
* **events:** per-agent event subscriptions — pull, fresh-session digest, and wake ([#197](https://github.com/anis-marrouchi/agentx/issues/197)) ([329f98e](https://github.com/anis-marrouchi/agentx/commit/329f98e213cfd3dbdeb20777fb5ff40c92488f00))
* **mesh:** peer event feed, mesh announcements and the Mesh feed on Operations ([#198](https://github.com/anis-marrouchi/agentx/issues/198)) ([38b8fad](https://github.com/anis-marrouchi/agentx/commit/38b8fadb69811496ced9adc960ad51482cf6c689))
* **voice:** parallel asks per agent and address by name ([#202](https://github.com/anis-marrouchi/agentx/issues/202)) ([88c9ac5](https://github.com/anis-marrouchi/agentx/commit/88c9ac5c75978f99a054325b54d9b1dbe406c11c))

## [0.54.0](https://github.com/anis-marrouchi/agentx/compare/v0.53.0...v0.54.0) (2026-09-27)


### Features

* **push:** Web Push notifications to the phone app ([#195](https://github.com/anis-marrouchi/agentx/issues/195)) ([1fc038e](https://github.com/anis-marrouchi/agentx/commit/1fc038ec7282e86e23ef35bfb41c296a3c912d65))


### Bug Fixes

* **attach:** keep attach bindings across daemon restarts and idle spells ([a02149d](https://github.com/anis-marrouchi/agentx/commit/a02149d5a106abfe5a675f547095eb8f5494d407)), closes [#193](https://github.com/anis-marrouchi/agentx/issues/193)
* **live:** keep slow nodes on the Live page and show attached sessions ([08309bb](https://github.com/anis-marrouchi/agentx/commit/08309bb6cce052d3b1dc4211d5ebb62744450e25)), closes [#193](https://github.com/anis-marrouchi/agentx/issues/193)
* **live:** short attached badge and aligned sessions row ([#193](https://github.com/anis-marrouchi/agentx/issues/193)) ([#196](https://github.com/anis-marrouchi/agentx/issues/196)) ([63a753d](https://github.com/anis-marrouchi/agentx/commit/63a753d77269a76414b023793f19daf61df77013))

## [0.53.0](https://github.com/anis-marrouchi/agentx/compare/v0.52.1...v0.53.0) (2026-09-27)


### Features

* **app:** Fleet and Activity tabs — monitor and control the fleet from the phone ([#190](https://github.com/anis-marrouchi/agentx/issues/190)) ([990ff05](https://github.com/anis-marrouchi/agentx/commit/990ff05ca98f5ee3d5ef13dd5bd5d5f8ad50ae2d))
* **reminders:** hand due Apple Reminders back to the agent that created them ([#187](https://github.com/anis-marrouchi/agentx/issues/187)) ([e5a764c](https://github.com/anis-marrouchi/agentx/commit/e5a764c4b94f077830a2e76a3d97768280e1d922))


### Bug Fixes

* **channels:** render agentx:ui blocks on outbound relays ([#192](https://github.com/anis-marrouchi/agentx/issues/192)) ([34e7902](https://github.com/anis-marrouchi/agentx/commit/34e790223d958b0c1230d02039e46011f89e9a00))

## [0.52.1](https://github.com/anis-marrouchi/agentx/compare/v0.52.0...v0.52.1) (2026-09-27)


### Bug Fixes

* **agents:** give every run a pre-spawn deadline and trace its steps ([#185](https://github.com/anis-marrouchi/agentx/issues/185)) ([86ce8dd](https://github.com/anis-marrouchi/agentx/commit/86ce8ddf0d32e4e042a20e4f309232184ef85c08))

## [0.52.0](https://github.com/anis-marrouchi/agentx/compare/v0.51.0...v0.52.0) (2026-09-27)


### Features

* **app:** installable phone app shell and device pairing ([#178](https://github.com/anis-marrouchi/agentx/issues/178)) ([cfd3bfb](https://github.com/anis-marrouchi/agentx/commit/cfd3bfbb2cabbc38a021caadaa072cba33939e97))


### Bug Fixes

* **routing:** let another agent's signed GitHub comment reach the handler ([#182](https://github.com/anis-marrouchi/agentx/issues/182)) ([59441b8](https://github.com/anis-marrouchi/agentx/commit/59441b8452b96c582b75fc494351d75c9c5892ea))

## [0.51.0](https://github.com/anis-marrouchi/agentx/compare/v0.50.1...v0.51.0) (2026-09-27)


### Features

* **events:** one bus with a bounded envelope and root ids ([#175](https://github.com/anis-marrouchi/agentx/issues/175)) ([fa2242b](https://github.com/anis-marrouchi/agentx/commit/fa2242bb59255428736b5dec56efc683ef95c550))
* **voice:** menu-bar icon with agent switcher ([#162](https://github.com/anis-marrouchi/agentx/issues/162)) ([6babcd6](https://github.com/anis-marrouchi/agentx/commit/6babcd6062abe8641d6062ae017dcfda29d104aa))
* **voice:** one speaking queue for everything the daemon says ([#168](https://github.com/anis-marrouchi/agentx/issues/168)) ([9c63e0a](https://github.com/anis-marrouchi/agentx/commit/9c63e0aa621eac0b4100df0d25c6035eba13da83))


### Bug Fixes

* **daemon:** require a mesh token for off-box control routes ([#176](https://github.com/anis-marrouchi/agentx/issues/176)) ([d641060](https://github.com/anis-marrouchi/agentx/commit/d641060a20a70f3428d9a68e2661a38ce725e077))
* **github:** decode form-encoded webhook bodies with URLSearchParams ([#177](https://github.com/anis-marrouchi/agentx/issues/177)) ([6e6f516](https://github.com/anis-marrouchi/agentx/commit/6e6f5163e97a7ac4d26c4d00f3aae55fd1bc2db7))
* **github:** skip only an agent's own signed comments ([#180](https://github.com/anis-marrouchi/agentx/issues/180)) ([7aabf21](https://github.com/anis-marrouchi/agentx/commit/7aabf2140423cb7189d14d9dc69a748fc8013359))

## [0.50.1](https://github.com/anis-marrouchi/agentx/compare/v0.50.0...v0.50.1) (2026-09-27)


### Bug Fixes

* **board:** list columns without crashing, show tab leads as plain text ([#150](https://github.com/anis-marrouchi/agentx/issues/150)) ([9b66125](https://github.com/anis-marrouchi/agentx/commit/9b661251d2171e2759c962e1e3b195523cd36289))

## [0.50.0](https://github.com/anis-marrouchi/agentx/compare/v0.49.0...v0.50.0) (2026-09-26)


### Features

* **integrations:** Raycast extension to ask and list agents ([#148](https://github.com/anis-marrouchi/agentx/issues/148)) ([3daf749](https://github.com/anis-marrouchi/agentx/commit/3daf74933e1c967c68aa896baa37c2550f42889d))

## [0.49.0](https://github.com/anis-marrouchi/agentx/compare/v0.48.0...v0.49.0) (2026-09-26)


### Features

* **trace:** measure whether lessons make repeated tasks better ([#139](https://github.com/anis-marrouchi/agentx/issues/139)) ([55891be](https://github.com/anis-marrouchi/agentx/commit/55891be18af652b6c6e0393fef67e9a5700da0e8)), closes [#98](https://github.com/anis-marrouchi/agentx/issues/98)
* **wiki:** turn repeated failures into proposed lessons ([#140](https://github.com/anis-marrouchi/agentx/issues/140)) ([8204a4a](https://github.com/anis-marrouchi/agentx/commit/8204a4ac386171c88ee013cdf04d96f32dd4a734)), closes [#96](https://github.com/anis-marrouchi/agentx/issues/96)


### Bug Fixes

* **gitlab:** bot-username prefix as a setting; neutral defaults in public code ([#137](https://github.com/anis-marrouchi/agentx/issues/137)) ([ffc0dc5](https://github.com/anis-marrouchi/agentx/commit/ffc0dc5317250fd2bbe21a90aa241a3593dee933))

## [0.48.0](https://github.com/anis-marrouchi/agentx/compare/v0.47.1...v0.48.0) (2026-09-26)


### Features

* **approvals:** one inbox for every pending decision ([#134](https://github.com/anis-marrouchi/agentx/issues/134)) ([aab18ca](https://github.com/anis-marrouchi/agentx/commit/aab18ca91b08b9be4e5713442d6ad6db71902133)), closes [#102](https://github.com/anis-marrouchi/agentx/issues/102)
* **daemon:** restart when idle, from the CLI or the dashboard ([#133](https://github.com/anis-marrouchi/agentx/issues/133)) ([f29a512](https://github.com/anis-marrouchi/agentx/commit/f29a51241d532e7c630f1e964a48ed01c08fa8fd))
* **screen:** capture the screen at the right moment ([#131](https://github.com/anis-marrouchi/agentx/issues/131)) ([851fed7](https://github.com/anis-marrouchi/agentx/commit/851fed78c835d14f1bdd761f1fe8d853f248de41)), closes [#83](https://github.com/anis-marrouchi/agentx/issues/83)

## [0.47.1](https://github.com/anis-marrouchi/agentx/compare/v0.47.0...v0.47.1) (2026-09-26)


### Bug Fixes

* **agents:** end runs stuck before spawn on cancel or deadline ([#125](https://github.com/anis-marrouchi/agentx/issues/125)) ([3202145](https://github.com/anis-marrouchi/agentx/commit/3202145679fbb54b8f31cc66e4a0f81e6ac92829))

## [0.47.0](https://github.com/anis-marrouchi/agentx/compare/v0.46.2...v0.47.0) (2026-09-26)


### Features

* **daemon:** resume runs a restart cut off, with safety limits ([#126](https://github.com/anis-marrouchi/agentx/issues/126)) ([06b1dce](https://github.com/anis-marrouchi/agentx/commit/06b1dce75fd644a8fcb0094c0a65c9dde89711ba)), closes [#103](https://github.com/anis-marrouchi/agentx/issues/103)

## [0.46.2](https://github.com/anis-marrouchi/agentx/compare/v0.46.1...v0.46.2) (2026-09-26)


### Bug Fixes

* **daemon:** let a stop signal drain in-flight tasks instead of exiting ([#122](https://github.com/anis-marrouchi/agentx/issues/122)) ([b56752d](https://github.com/anis-marrouchi/agentx/commit/b56752da1f3792e289d3720e9942aeb240f6c938)), closes [#103](https://github.com/anis-marrouchi/agentx/issues/103)

## [0.46.1](https://github.com/anis-marrouchi/agentx/compare/v0.46.0...v0.46.1) (2026-09-26)


### Bug Fixes

* **voice:** reach ffmpeg from the login item and never forward Whisper errors ([#119](https://github.com/anis-marrouchi/agentx/issues/119)) ([6223b4a](https://github.com/anis-marrouchi/agentx/commit/6223b4a2d67a3b7dd346d8f01150ea56573ee675))

## [0.46.0](https://github.com/anis-marrouchi/agentx/compare/v0.45.1...v0.46.0) (2026-09-26)


### Features

* **wiki:** promote proposes lessons with evidence for human review ([#116](https://github.com/anis-marrouchi/agentx/issues/116)) ([afec99d](https://github.com/anis-marrouchi/agentx/commit/afec99dc77ee99e8e5b13eb86f0e27f5b72302ac)), closes [#95](https://github.com/anis-marrouchi/agentx/issues/95)

## [0.45.1](https://github.com/anis-marrouchi/agentx/compare/v0.45.0...v0.45.1) (2026-09-26)


### Bug Fixes

* **memory:** list pre-review external facts as held ([#113](https://github.com/anis-marrouchi/agentx/issues/113)) ([dab23bc](https://github.com/anis-marrouchi/agentx/commit/dab23bcaa4bf73419ee7758b662f688f956829d3)), closes [#97](https://github.com/anis-marrouchi/agentx/issues/97)

## [0.45.0](https://github.com/anis-marrouchi/agentx/compare/v0.44.1...v0.45.0) (2026-09-26)


### Features

* **memory:** versions, conditional writes and verified authors ([#106](https://github.com/anis-marrouchi/agentx/issues/106)) ([ac0a1e8](https://github.com/anis-marrouchi/agentx/commit/ac0a1e80951c979dfa79baa7c25c7f85a343b021))


### Bug Fixes

* **crons:** follow-ups from the [#85](https://github.com/anis-marrouchi/agentx/issues/85) review — attached-session result and docs ([01bc869](https://github.com/anis-marrouchi/agentx/commit/01bc86906bd25db21faed8955ef2218821777073))
* **mac-helper:** use the current AgentX symbol for the helper icon ([ecf0b80](https://github.com/anis-marrouchi/agentx/commit/ecf0b8042af8b54a6d66f76c11c6f03d2f6d84df))
* **mac-helper:** use the current AgentX symbol for the helper icon ([d527d9c](https://github.com/anis-marrouchi/agentx/commit/d527d9cbc7b05e33310438f5c5a14154152c12cd))

## [0.44.1](https://github.com/anis-marrouchi/agentx/compare/v0.44.0...v0.44.1) (2026-09-26)


### Bug Fixes

* **daemon:** refuse browser requests from pages on other origins ([#104](https://github.com/anis-marrouchi/agentx/issues/104)) ([1c3feb6](https://github.com/anis-marrouchi/agentx/commit/1c3feb619c5d1637b75248c5d0a0b7a8bcd10cbf)), closes [#100](https://github.com/anis-marrouchi/agentx/issues/100)

## [0.44.0](https://github.com/anis-marrouchi/agentx/compare/v0.43.0...v0.44.0) (2026-09-26)


### Features

* **crons:** enforce report, propose and act autonomy per routine ([#89](https://github.com/anis-marrouchi/agentx/issues/89)) ([a1a0305](https://github.com/anis-marrouchi/agentx/commit/a1a03057ef6529a22759abae6745f95e5081e706)), closes [#80](https://github.com/anis-marrouchi/agentx/issues/80)
* **crons:** link cron runs to their task for watch and steer ([#85](https://github.com/anis-marrouchi/agentx/issues/85)) ([e6f4c89](https://github.com/anis-marrouchi/agentx/commit/e6f4c8974fc85b24b9d6ac78665ddbd170d008ad)), closes [#76](https://github.com/anis-marrouchi/agentx/issues/76)
* **mac-helper:** post banners as AgentX Helper with the AgentX logo ([95d8bd7](https://github.com/anis-marrouchi/agentx/commit/95d8bd71933a40805e84442cc572d1138b6455ec)), closes [#74](https://github.com/anis-marrouchi/agentx/issues/74)
* **mesh:** routines view for schedules and triggered workflows ([#86](https://github.com/anis-marrouchi/agentx/issues/86)) ([cdd564a](https://github.com/anis-marrouchi/agentx/commit/cdd564a7a45bf43a63e20e4f4460c7c0e672e9fe)), closes [#77](https://github.com/anis-marrouchi/agentx/issues/77)
* **notify:** banner through the helper, icon set from agentx.json ([95d3eb6](https://github.com/anis-marrouchi/agentx/commit/95d3eb67c7619d68f69e10aa28823813a2df3c65)), closes [#74](https://github.com/anis-marrouchi/agentx/issues/74)
* **notify:** local Mac banner and sound, configurable and documented ([27c55a0](https://github.com/anis-marrouchi/agentx/commit/27c55a0673afbd1c7177aa27b204545d5060a778))
* **notify:** local Mac banner and sound, set from agentx.json ([6f40b60](https://github.com/anis-marrouchi/agentx/commit/6f40b60ddc3a1bd71181a3d930d8e5995c93783d)), closes [#74](https://github.com/anis-marrouchi/agentx/issues/74)
* **routines:** fire one routine on demand via POST /routines/:id/fire ([#84](https://github.com/anis-marrouchi/agentx/issues/84)) ([6688e88](https://github.com/anis-marrouchi/agentx/commit/6688e885dbef1a2d2f7bd14aadab847b8b4556b1))
* **schedule:** agent schedule tool with operator approval ([#87](https://github.com/anis-marrouchi/agentx/issues/87)) ([503c44a](https://github.com/anis-marrouchi/agentx/commit/503c44ac5a5c7094d90b41a83e7622bf655c70df)), closes [#79](https://github.com/anis-marrouchi/agentx/issues/79)
* **workflows:** loop guard for event-triggered workflows ([#82](https://github.com/anis-marrouchi/agentx/issues/82)) ([457b71c](https://github.com/anis-marrouchi/agentx/commit/457b71c3ec281436681088ae686d71e8c6d334d5))


### Bug Fixes

* **daemon:** mesh auth for the memory API and the right port in the remember skill ([#101](https://github.com/anis-marrouchi/agentx/issues/101)) ([743c391](https://github.com/anis-marrouchi/agentx/commit/743c3918680cfe3c008d0f26a53b4a4cb7313121))

## [0.43.0](https://github.com/anis-marrouchi/agentx/compare/v0.42.0...v0.43.0) (2026-09-26)


### Features

* **teach:** draw mode paints paths, palettes and ambitious pieces ([032dd03](https://github.com/anis-marrouchi/agentx/commit/032dd033aaaa9abaf4ebf6a91bf07555ec296f8a))
* **teach:** draw mode paints paths, palettes and ambitious pieces ([6f1c7f5](https://github.com/anis-marrouchi/agentx/commit/6f1c7f56c7207d95af680c2d2d108a8eb3cc2e0f))


### Bug Fixes

* **workflows:** owner sweep wakes the agent only on a steps verdict ([#71](https://github.com/anis-marrouchi/agentx/issues/71)) ([c6f318a](https://github.com/anis-marrouchi/agentx/commit/c6f318a6b8a98da9883454e0bcfea0b885cb3831))

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
