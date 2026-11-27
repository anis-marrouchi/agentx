# Third-party notices for src/hub/ui

Button, Badge, Card, Tabs, Dialog, Sheet, Tooltip, Skeleton, Switch,
Popover, Select and Command start from
[shadcn/ui](https://github.com/shadcn-ui/ui) components, copied in and
restyled on the AgentX tokens (`src/daemon/ui/tokens.ts`). Behaviour comes
from [Radix UI Primitives](https://github.com/radix-ui/primitives) (MIT),
used as a package; Command is built on [cmdk](https://github.com/pacocoursey/cmdk)
(MIT), also used as a package.

shadcn/ui is under the MIT licence:

> MIT License
>
> Copyright (c) 2023 shadcn
>
> Permission is hereby granted, free of charge, to any person obtaining a copy
> of this software and associated documentation files (the "Software"), to deal
> in the Software without restriction, including without limitation the rights
> to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
> copies of the Software, and to permit persons to whom the Software is
> furnished to do so, subject to the following conditions:
>
> The above copyright notice and this permission notice shall be included in all
> copies or substantial portions of the Software.
>
> THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
> IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
> FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
> AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
> LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
> OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
> SOFTWARE.

The scoped reset in `src/hub/styles.css` is Tailwind CSS's preflight
(MIT, Copyright (c) Tailwind Labs, Inc.), with each selector limited to the
Hub's React root so the old Hub pages do not change.

Task chat parts from the shadcn successor of Vercel AI Elements (Apache-2.0)
come in with the Task page (step 2); their notice is added with them.

Icons are [Lucide](https://lucide.dev) (`lucide-static`, used as a package),
under the ISC licence: Copyright (c) 2026 Lucide Icons and Contributors.
Some Lucide icons derive from Feather (MIT, Copyright (c) 2013-2023 Cole
Bemis). The full text is in the package's LICENSE file.
