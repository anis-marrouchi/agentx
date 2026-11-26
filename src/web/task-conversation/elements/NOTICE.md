The components in this folder are adapted from Vercel AI Elements
(https://github.com/vercel/ai-elements): Conversation, Message, Response,
Tool and Reasoning. AI Elements is licensed under the Apache License 2.0.
Changes: rewritten without Tailwind or shadcn/ui, styled with the AgentX
design tokens (../styles.css), fed from the AgentX task stream instead of
AI SDK UIMessage parts, and a diff view added for edit steps.

Copyright 2025 Vercel, Inc.
Licensed under the Apache License, Version 2.0 (the "License"); you may not
use these files except in compliance with the License. You may obtain a
copy of the License at http://www.apache.org/licenses/LICENSE-2.0
Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS, WITHOUT
WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.

Response renders markdown with Streamdown (https://github.com/vercel/streamdown,
Apache-2.0) and highlights code with Shiki (https://github.com/shikijs/shiki, MIT).
The diff view uses jsdiff (https://github.com/kpdecker/jsdiff, BSD-3-Clause).

The tool card state, the eight-ray thinking indicator and the Needs you
inbox heading are adapted from
[affectUI](https://github.com/flohoeller/affectui/tree/8b3963021e3442a5350c89cd14324a45e51dc48c)
(`tool-call-card-clean.tsx`, `thinking-loader-clean.tsx`, `decision-inbox-clean.tsx`), MIT.
Their styles live in one place for every Hub page, the phone app and this
bundle: `src/daemon/ui/affect.css.ts`. The MIT terms and copyright are in
`src/daemon/ui/LICENSE.affectui`.
