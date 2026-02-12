# agentx

General-purpose agentic code generation engine. Generate, evolve, and manage your codebase with AI from the terminal.

agentx is a CLI and library that turns natural language into working code. It detects your tech stack, matches relevant skills, runs a multi-step agentic loop with tool use, and writes files directly to your project.

## Install

```bash
npm install -g agentx
```

Or run directly:

```bash
npx agentx
```

## Quick Start

```bash
# Start an interactive coding session
agentx

# Generate a component
agentx gen "a responsive pricing card with monthly/yearly toggle"

# Evolve existing code
agentx evolve "add dark mode support" --glob "src/components/**/*.tsx"

# Scaffold a new project
agentx create my-app --template saas-starter

# AI-powered git commit
agentx git commit --all
```

## Setup

On first run, agentx will prompt you to configure your AI provider:

```bash
agentx model setup
```

**Claude subscription (default)** — Uses your Claude subscription via the `claude` CLI binary. No API key needed.

**API key** — Direct API access with `ANTHROPIC_API_KEY`. Set it via the setup wizard or as an environment variable.

```bash
# Check current config
agentx model show
```

## Commands

### `generate` (aliases: `gen`, `g`)

Generate any type of file from a natural language description.

```bash
# Auto-detect output type
agentx gen "REST API for user management with CRUD endpoints"

# Specify output type
agentx gen "login page with email/password" --type page

# Target a directory
agentx gen "PostgreSQL schema for an e-commerce app" --type schema --output src/db

# Dry run to preview
agentx gen "unit tests for the auth module" --type test --dry-run

# Use a specific model
agentx gen "WebSocket chat server" --model claude-opus-4-20250514
```

**Supported output types:** `component`, `page`, `api`, `website`, `document`, `script`, `config`, `skill`, `media`, `report`, `test`, `workflow`, `schema`, `email`, `diagram`, `auto`

When set to `auto` (the default), agentx detects the right type from your task description.

**Key options:**
| Flag | Description |
|------|-------------|
| `-t, --type <type>` | Output type (default: `auto`) |
| `-o, --output <dir>` | Output directory |
| `--dry-run` | Preview without writing files |
| `--overwrite` | Overwrite existing files |
| `-p, --provider <name>` | AI provider (`claude-code`, `claude`) |
| `-m, --model <model>` | Model to use |
| `--max-steps <n>` | Max agentic loop iterations (default: 5) |
| `--heal` | Verify and auto-fix generated code |
| `--build-cmd <cmd>` | Build command for heal verification |
| `--test-cmd <cmd>` | Test command for heal verification |
| `--no-context7` | Disable live documentation lookup |
| `--debug` | Verbose logging |

### `evolve` (aliases: `ev`, `transform`)

Transform existing files using AI. Shows a diff preview for each file and lets you accept or skip changes.

```bash
# Add TypeScript types to JS files
agentx evolve "convert to TypeScript with strict types" --glob "src/**/*.js"

# Refactor with a pattern
agentx evolve "replace axios with fetch" --glob "src/api/**/*.ts"

# Migrate a framework
agentx evolve "migrate from React class components to hooks" --glob "src/components/**/*.tsx"

# Apply without confirmation
agentx evolve "add JSDoc comments to all exported functions" --glob "src/utils/*.ts" --yes

# Preview only
agentx evolve "optimize database queries" --glob "src/models/*.ts" --dry-run
```

**Key options:**
| Flag | Description |
|------|-------------|
| `-g, --glob <pattern>` | Files to evolve |
| `--max-files <n>` | Max files to process (default: 10) |
| `--dry-run` | Show diffs without writing |
| `-y, --yes` | Apply all changes without confirmation |
| `--heal` | Verify and auto-fix after changes |

### `chat`

Interactive REPL for multi-turn coding sessions with persistent history.

```bash
# Start a new session
agentx chat

# Resume the last session
agentx chat --resume

# Resume a specific session
agentx chat --session abc123

# List saved sessions
agentx chat --list
```

Sessions are saved to `.shadxn/sessions/` and can be resumed across terminal restarts.

**REPL commands:** `/help`, `/exit`, `/save`, `/load <id>`, `/files`

### `create`

Scaffold a new project from a curated template.

```bash
# Interactive template selection
agentx create my-app

# Use a specific template
agentx create my-api --template api-service

# List available templates
agentx create --list
```

**Templates:**
| Name | Description |
|------|-------------|
| `saas-starter` | Full-stack SaaS with auth, billing, dashboard |
| `api-service` | REST API with auth, validation, tests |
| `cli-tool` | CLI with commands, flags, config |
| `component-library` | UI components with Storybook and tests |
| `fullstack-app` | Full-stack app with DB, API, and UI |
| `mobile-app` | Mobile app with navigation and native features |
| `chrome-extension` | Extension with popup, content script, service worker |
| `data-pipeline` | ETL pipeline with processing stages |

### `skill`

Manage reusable instruction sets that guide AI generation.

```bash
# Install a skill from skills.sh
agentx skill install intellectronica/agent-skills

# List installed skills
agentx skill list

# Create a skill with AI
agentx skill create nextjs-api --description "Next.js API route conventions"

# Create a blank template
agentx skill create my-skill --no-ai

# View skill details
agentx skill inspect nextjs-api
```

Skills are markdown files with YAML frontmatter stored in `.skills/`:

```markdown
---
name: react-component
description: React component conventions
tags: [react, component, frontend]
---

# Instructions

- Use functional components with TypeScript
- Export named components, not default exports
- Co-locate styles using CSS modules
- Write unit tests alongside components
```

agentx auto-matches relevant skills to your task based on keywords, tags, and content similarity.

### `inspect` (aliases: `info`, `ctx`)

Show what agentx knows about your project.

```bash
agentx inspect

# JSON output
agentx inspect --json

# Full details
agentx inspect --verbose
```

Detects: languages, frameworks, package manager, databases, styling, testing tools, deployment config, schemas, and installed skills.

### `git`

AI-powered git operations.

```bash
# Status with colored summary
agentx git status

# AI-generated commit message
agentx git commit --all

# Custom commit message
agentx git commit -m "fix: resolve auth redirect loop"

# View diff
agentx git diff
agentx git diff --staged

# Recent commits
agentx git log -n 20
```

### `model`

Configure AI provider and credentials.

```bash
# Interactive setup
agentx model setup

# Show current config
agentx model show
```

**Available models:**
| Model | Description |
|-------|-------------|
| `claude-sonnet-4-20250514` | Claude Sonnet 4 (recommended) |
| `claude-opus-4-20250514` | Claude Opus 4 (reasoning) |
| `claude-haiku-4-20250514` | Claude Haiku 4 (fast) |

### `run`

Start the agentx runtime — an HTTP server that receives generation requests, learns from results, auto-heals failures, and self-enhances.

```bash
agentx run

# Custom port
agentx run --port 8080

# Disable features
agentx run --no-memory --no-heal

# With verification
agentx run --test-cmd "npm test" --build-cmd "npm run build"
```

The runtime exposes an HTTP API and runs a middleware pipeline:

```
Request → Memory → Context → Generate → Heal → Record → Enhance → Response
```

- **Memory** — Persistent store of past generations, patterns, preferences
- **Heal** — Auto-detect build/test failures and regenerate fixes
- **Enhance** — Distill recurring patterns into reusable skills

### `serve`

Run agentx as an MCP server for AI editors.

```bash
agentx serve --stdio
```

Register with Claude Code:

```bash
claude mcp add agentx -- npx agentx serve --stdio
```

**Exposed tools:** `shadxn_generate`, `shadxn_inspect`, `shadxn_skill_match`, `shadxn_detect_output_type`

Works with Claude Code, Cursor, Windsurf, and any MCP-compatible client.

### `a2a`

Start an Agent-to-Agent protocol server for external agent integration.

```bash
agentx a2a

# Custom port
agentx a2a --port 4000
```

Implements the A2A protocol with JSON-RPC 2.0:
- `tasks/send` — Synchronous task execution
- `tasks/sendSubscribe` — Streaming execution via SSE
- `tasks/get` — Retrieve task state
- `tasks/cancel` — Cancel running tasks
- `/.well-known/agent-card.json` — Agent discovery

## Use Cases

### Generate a full REST API

```bash
agentx gen "Express REST API for a blog with posts, comments, and auth.
Use PostgreSQL with Prisma ORM, JWT auth, input validation with Zod,
and proper error handling" --type api
```

### Scaffold and iterate on a project

```bash
# Create the project
agentx create my-saas --template saas-starter

# Add features
cd my-saas
agentx gen "Stripe billing integration with subscription plans"
agentx gen "admin dashboard with user management and analytics"

# Evolve existing code
agentx evolve "add rate limiting to all API routes" --glob "src/api/**/*.ts"
```

### Migrate a codebase

```bash
# Convert JavaScript to TypeScript
agentx evolve "convert to TypeScript with strict mode" --glob "src/**/*.js" --max-files 50

# Update framework patterns
agentx evolve "migrate from Express to Hono" --glob "src/routes/**/*.ts"

# Modernize styles
agentx evolve "replace styled-components with Tailwind CSS" --glob "src/components/**/*.tsx"
```

### Generate tests for existing code

```bash
agentx gen "comprehensive unit tests for the user service" --type test
agentx gen "integration tests for the checkout API endpoint" --type test
```

### Create CI/CD pipelines

```bash
agentx gen "GitHub Actions workflow for Node.js: lint, test, build, deploy to Vercel" --type workflow
agentx gen "GitLab CI pipeline with Docker build and Kubernetes deployment" --type workflow
```

### Generate documentation

```bash
agentx gen "API reference documentation from the source code" --type document
agentx gen "architecture decision record for choosing PostgreSQL over MongoDB" --type document
```

### Interactive coding session

```bash
agentx chat

# In the REPL:
> build a user authentication system with email/password and OAuth
> now add password reset with email verification
> write tests for the auth service
> /save
```

### Self-healing runtime

```bash
# Start the runtime with verification
agentx run --test-cmd "pnpm test" --build-cmd "pnpm build"

# Send requests via HTTP
curl -X POST http://localhost:3170/generate \
  -H "Content-Type: application/json" \
  -d '{"task": "add pagination to the products API"}'
```

The runtime auto-heals: if generated code breaks the build or tests, it detects the failure, feeds errors back to the agent, and regenerates a fix.

### Use as a library

```typescript
import { generate, createProvider, detectTechStack } from "agentx"

const provider = createProvider("claude-code")
const techStack = await detectTechStack(process.cwd())

const result = await generate({
  task: "React form component with validation",
  type: "component",
  provider,
  techStack,
})

for (const file of result.files) {
  console.log(`${file.path}: ${file.content.length} bytes`)
}
```

### Build custom skills

```bash
# Generate a skill from your project's patterns
agentx skill create our-api-conventions \
  --description "REST API conventions: error handling, pagination, auth middleware"

# Install community skills
agentx skill install intellectronica/agent-skills

# Skills are auto-matched to tasks
agentx gen "user profile endpoint"  # ← matches our-api-conventions skill
```

### Integrate with AI editors via MCP

```bash
# Register agentx as an MCP server
claude mcp add agentx -- npx agentx serve --stdio

# Now Claude Code can use agentx tools:
# - Generate code with project context
# - Inspect project tech stack
# - Match skills to tasks
```

### Agent-to-agent workflows

```bash
# Start the A2A server
agentx a2a --port 3171

# Other agents can discover and call agentx
curl http://localhost:3171/.well-known/agent-card.json

# Send a task
curl -X POST http://localhost:3171/rpc \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "method": "tasks/send",
    "params": {
      "task": { "instruction": "generate a login page" }
    },
    "id": 1
  }'
```

## Configuration

### Project config (`shadxn.config.json`)

```json
{
  "provider": "claude-code",
  "model": "claude-sonnet-4-20250514",
  "outputDir": "src",
  "skills": [".skills/", "skills/"]
}
```

### Auth config (`~/.shadxn/auth.json`)

Created by `agentx model setup`. Stores provider credentials.

### Skills directories

agentx loads skills from these directories (in order):
- `.skills/`
- `.claude/skills/`
- `skills/`
- Root `SKILL.md`

### Hooks (`.agentx/hooks.json`)

Lifecycle hooks that run shell commands on events:

```json
{
  "pre:generate": "echo 'Starting generation...'",
  "post:file-write": "prettier --write {{file}}",
  "post:generate": "npm run lint:fix"
}
```

## How It Works

1. **Context gathering** — Detects your tech stack, schemas, dependencies, and matches relevant skills
2. **System prompt construction** — Combines project context, skills, and output type instructions
3. **Agentic loop** — Multi-step tool-calling loop where the AI can read files, search code, and create files
4. **File writing** — Generated files are written to your project with deduplication
5. **Healing** (optional) — Runs build/test commands, feeds errors back to the agent for auto-fix
6. **Memory** — Records results for pattern learning and skill enhancement

## License

MIT
