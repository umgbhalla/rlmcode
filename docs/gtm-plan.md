# rlmcode — Go-To-Market & Marketing Plan

> **Product**: rlmcode — a self-orchestrating TUI coding agent.
> **Status**: v0.0.1 · MIT · Bun + TypeScript · Effect v4 core · opentui UI
> **Default model**: Kimi K2.7 on Cloudflare Workers AI
> **One-liner**: *The coding agent that writes its own orchestration scripts.*

---

## 1. Core Positioning

### Elevator Pitch

> rlmcode is a terminal-based AI coding agent. But unlike every other agent, it doesn't just call tools one at a time — it writes and runs a JS orchestration plan mid-turn, fanning out sub-agents, judging candidates, pipelining work, and mining large codebases — all rendered as a live nested tree you can watch.

### Tagline Candidates

| Tagline | Vibe |
|---|---|
| *The agent that builds agents* | Ambition |
| *Orchestrate your codebase* | Action |
| *Not just a tool caller — a tool composer* | Differentiator |
| *Watch the tree grow* | Experience |
| *Programmable intelligence for your terminal* | Developer dignity |
| *Your AI doesn't just act. It plans.* | Contrast |

### Positioning vs Incumbents

| This | vs That |
|---|---|
| **rlmcode** = model writes JS scripts that compose sub-agents | **Claude Code** = model calls tools sequentially, one after another |
| **rlmcode** = live unicode tree shows every sub-agent branch | **OpenCode** = flat transcript of tool calls |
| **rlmcode** = full OTel traces (traces + logs + metrics) → local motel | **Cursor/SWE-agent** = basic logging |
| **rlmcode** = importable SDK (`createAgent` → `AsyncGenerator`) | **Claude Code** = not a library |

### Brand Personality

- **Archetype**: The Architect / The Scientist
- **Voice**: Precise, confident, unafraid to be technical. No marketing fluff. Speaks to builders.
- **Colors**: Terminal green on black. Deep indigo for diagrams. Monospace throughout.
- **Vibe**: "This is what happens when you give an LLM the ability to write code that calls other LLMs — and you instrument every layer."

### Messaging Matrix

| Audience | Message |
|---|---|
| **Effect/FP-adjacent devs** | "The first production Effect v4 application. Full OTel, strict module boundaries, static analysis gate. This is what Effect looks like in the real world." |
| **AI tooling enthusiasts** | "The model writes JS scripts that call `agent()`, `parallel()`, `pipeline()`, and `judge()` — mid-turn. Watch it orchestrate itself." |
| **Terminal power users** | "Multi-session TUI. Keyboard-driven. Which-key overlay. Themes. The tool feels like what happens when vim and AI had a child." |
| **OSS / indie build-in-public** | "v0.0.1. Single author. MIT. Built in the open with motel traces, ponytail shortcuts, and a debt ledger. No VC bloat." |
| **LLM infra / platform teams** | "Importable SDK. Bring your own `AxAIService`. Headless. Full OTel 3-signal export. Wire it into your own observability stack." |

---

## 2. Target Audience (Tiers)

### Tier 1: Core — The Effect Ecosystem

~5k–15k developers. The most natural audience — rlmcode is literally the first production-grade Effect v4 app.

- **Where to reach them**: Effect Discord, Effect GitHub discussions, r/effect-ts, Effect Twitter/X community
- **Angle**: "This is what Effect can build." Showcase the architecture: `Effect.fn` spans, `Layer` composition, `Atom`-driven TUI, strict tsconfig.
- **Assets needed**: "Architecture of rlmcode" blog post, EffectConf talk abstract, BTS of why every abstraction was chosen

### Tier 2: Adjacent — Terminal AI Power Users

~20k–50k developers who already use Claude Code, OpenCode, Cursor terminal, aider.

- **Where to reach them**: Hacker News, Lobsters, `/r/coding`, `/r/programming`, `/r/ClaudeAI`, Twitter/X build-in-public
- **Angle**: "You've seen tool-calling agents. Now see one that writes orchestration scripts." The `workflow` tool demo is the hook.
- **Assets needed**: Asciicast demo of a multi-step orchestration, comparison table vs Claude Code, "why the tree matters" explainer

### Tier 3: Long-tail — SDK Consumers

~1k–5k. Teams that want to embed an AI agent in their product.

- **Where to reach them**: Hacker News "Show HN", GitHub trending, npm discovery
- **Angle**: `npm create rlmcode` — plug in your model, get a turn loop over serializable events
- **Assets needed**: SDK quickstart, API reference (already barrel-only), integration guide

---

## 3. Launch Strategy

### Phase 0: The Document (Current)

- [ ] Polish the README into a proper landing README (not just dev notes)
- [ ] Write the GTM plan (this document)
- [ ] Capture a killer asciicast of `workflow` orchestration in action
- [ ] Stabilize the TUI for first impressions (no crashes, clean install)

### Phase 1: The Seeding (Weeks 1–2)

Small, high-signal drops. No PR blast. Build narrative momentum.

| Action | Why |
|---|---|
| **Post to Effect Discord** (#showcase) | Core audience, immediate signal |
| **Write a "Building rlmcode" devlog** | The Effect architecture story is the hook |
| **Short asciicast on X/Twitter** tagged with @effect-ts, @ax_llm | Visual proof of the tree rendering |
| **Post to Hacker News** as "Show HN: rlmcode" | Broad dev audience, needs asciicast and clear README |
| **Publish to npm** (`rlmcode`) | Discoverability, `bunx rlmcode` install |

### Phase 2: The Amplification (Weeks 3–4)

| Action | Why |
|---|---|
| **rlmcode on GitHub Trending** (if HN hits) | Organic exponential reach |
| **"Why Effect built the most interesting AI agent" blog** | Technical deep-dive, cross-post to Effect blog |
| **Compare with Claude Code / OpenCode blog** | Controversy = attention, but keep it respectful |
| **Record a full OTel trace walkthrough** | Show the motel dashboard with span trees |
| **Collect testimonials from early users** | Social proof for v0.1.0 |

### Phase 3: The Community (Month 2+)

| Action | Why |
|---|---|
| **Open issues for contributed recipes** | Let the community write workflow recipes |
| **Release v0.1.0 with breaking stabilizations** | Show velocity |
| **Record talk abstract for Effect Conf / AI Engineer Summit** | Conference distribution |
| **Add RLM_MOCK=1 smoke test to CI** | Let anyone try without a CF account |

---

## 4. Channels

### Primary

| Channel | Investment | Content type |
|---|---|---|
| **GitHub** | High | README, issues, discussions, CONTRIBUTING.md, GitHub Actions badge |
| **X/Twitter** | Medium | Asciicast clips, architecture diagrams, launch thread, model output highlights |
| **Hacker News** | High (spike) | Show HN with README + asciicast + clear differentiator |
| **Effect Discord** | Medium | Architecture walkthrough, Q&A, Effect patterns showcase |
| **npm** | Low | `rlmcode` package, `bunx rlmcode` one-liner |

### Secondary

| Channel | Content |
|---|---|
| **r/effect-ts** | Cross-post from Discord |
| **r/programming** | "I built an AI agent that writes its own orchestration scripts" |
| **Lobsters** | Architecture-focused post |
| **YouTube** | 2-min asciicast walkthrough + 10-min architecture talk |
| **AI Engineer newsletter** | Tip about the workflow tool |
| **OpenCode/Claude Code newsletters** | "The open-source agent doing something different" |

---

## 5. Content Pillars

### 1. The `workflow` Tool — Programmable Orchestration

*The headline feature. The model writes JS scripts that call agent(), parallel(), pipeline(), judge(), and rlm().*

- **Demo**: Asciicast of "refactor this monorepo" — the model spawns 4 parallel agents to analyze 4 packages, then a judge picks the best approach, then a pipeline refactors them
- **Blog**: "Why let the model orchestrate? A look at self-composing agents"
- **Quote**: *"Claude Code gives the model tools. rlmcode gives the model the ability to compose agents."*

### 2. The Live Node Tree — Observability as UX

*Every sub-agent, every fan-out, every retry renders as a collapsible unicode tree under the turn.*

- **Demo**: Side-by-side of the same task in Claude Code (flat transcript) vs rlmcode (nested tree with status badges, retry count, token badges)
- **Blog**: "Making agentic work visible: why the tree matters"
- **Screenshot**: The tree with a parallel fan-out, showing rate-limited nodes retrying

### 3. Built with Effect — Architecture as Differentiator

*rlmcode is the most ambitious Effect v4 app in existence.*

- **Blog**: "What Effect v4 lets you build: tracing, atoms, strict boundaries, and an AI agent"
- **Talk**: "Effect v4 in production: building rlmcode" (Effect Conf, AI Engineer Summit)
- **Deep-dive**: How `Effect.fn` spans mirror the agent tree, how `Layer` composition keeps the SDK clean, how `Atom` drives the TUI

### 4. The SDK — Embeddable by Design

*Clean, importable, zero-leakage agent framework.*

- **Blog**: "Designing an AI agent SDK that doesn't leak Effect"
- **Example**: Headless `createAgent()` + `for-await-of runTurn` in 10 lines
- **Comparison**: Why the barrel-only boundary matters (vs LangChain's import spaghetti)

### 5. Built in the Open — Engineering Integrity

*Ponytail debt markers, static analysis gate, headless TUI tests.*

- **Blog**: "The ponytail system: how we track debt at v0.0.1"
- **Screenshot**: Failed lint gate — "Your ponytail marker needs an Upgrade line"
- **Value prop**: "We don't just write code. We measure our shortcuts."

---

## 6. Website / README Hierarchy

The README is the website. rlmcode doesn't need a landing page at v0.0.1 — the README + TUI is the product. Structure should be:

```
# rlmcode

> One-liner + asciicast (hero)

## What makes rlmcode different
- The workflow tool (model writes orchestration scripts)
- Live node tree (watch sub-agents branch)
- Full OTel tracing (traces + logs + metrics)
- Importable SDK (clean barrel boundary)

## Quick start
bunx rlmcode

## Demo
[asciicast of "refactor this project"]

## Features (detailed)
- Workflow orchestration
- Multi-session TUI
- LLM observability
- Keyboard-driven
- Themes

## Architecture
[svg diagram of three-layer design]

## SDK
```ts
const agent = createAgent({ ai, model })
for await (const event of agent.runTurn(prompt)) { ... }
```

## Under the hood
- Built with Effect v4
- Full OTel → motel
- Static analysis gate
- Headless TUI test suite

## Roadmap
- [ ] More provider support
- [ ] MCP tools
- [ ] v0.1.0

## Contributing
```

---

## 7. Launch Assets Checklist

| Asset | Format | Status |
|---|---|---|
| README with asciicast | Markdown + SVG | Needs polish |
| Asciicast: workflow orchestration | SVG terminal recording | **MUST CREATE** |
| Asciicast: "refactor monorepo" | SVG terminal recording | Nice-to-have |
| Screenshot: live node tree | PNG | Capture from TUI |
| Screenshot: OTel span tree in motel | PNG | Capture from motel |
| Architecture diagram | SVG | Create simple 3-layer box diagram |
| Comparison table vs Claude Code | Markdown | Draft in GTM plan |
| "Building rlmcode" devlog | Markdown blog | Write |
| "Why Effect × AI" blog | Markdown blog | Write |
| Launch tweet thread | 8–10 tweets | Draft |
| HN Show HN post | 1 paragraph + link | Draft |
| Effect Discord showcase post | Short technical walkthrough | Draft |
| npm package | `rlmcode` | Publish |

---

## 8. KPIs & Success Metrics

### Launch (Week 1)

| Metric | Good | Great |
|---|---|---|
| GitHub Stars | 100 | 500 |
| npm downloads | 500 | 2000 |
| Hacker News points | 50 | 200 |
| Unique `bunx rlmcode` runs | 200 | 1000 |
| Effect Discord reactions | 20 | 50 |

### Month 1

| Metric | Good | Great |
|---|---|---|
| GitHub Stars | 500 | 2000 |
| Contributors (non-author) | 3 | 10 |
| Open issues (bugs) | <5 | <2 |
| Community workflow recipes | 5 | 20 |
| SDK usage in other projects | 2 | 10 |

### Month 3

| Metric | Good | Great |
|---|---|---|
| GitHub Stars | 2000 | 5000 |
| Consistent weekly users | 50 | 200 |
| Conference talk accepted | 1 | 2 |
| Integration with other tools | 3 | 10 |

---

## 9. Risk & Mitigation

| Risk | Probability | Mitigation |
|---|---|---|
| "Another Claude Code clone" perception | Medium | Lead with the `workflow` tool — that is the visible differentiator. The tree rendering. The OTel traces. |
| Cloudflare-only model lock-in | Medium | SDK already supports any `AxAIService`. Add Ollama/local model example to README day 1. |
| `new Function` eval concerns | High | Document explicitly: "run only in trusted directories." Consider WASM sandbox for v0.2.0. |
| Effect ecosystem smallness | Medium | Leverage it. Don't hide from it. "Built with Effect" is a feature for Effect devs, not a bug. |
| Single author bus factor | Medium | CONTRIBUTING.md day 1. Document architecture. Accept PRs early. |
| "v0.0.1 — too immature to try" | Medium | Be transparent about it. The ponytail debt system is a *feature* — it shows engineering discipline. |

---

## 10. Competitive Landscape

### Direct Competitors

| Product | rlmcode's Advantage | Their Advantage |
|---|---|---|
| **Claude Code** (Anthropic) | Orchestration, tree, OTel, SDK, open-source | Claude model quality, ecosystem, maturity |
| **OpenCode** (OpenWork/Anthropic) | Orchestration, tree, OTel, Effect architecture | Desktop app, team features, MCP, cloud sync |
| **Cursor Terminal** | Agent programmability, OTel, free | IDE integration, multi-model, polish |
| **aider** (Paul Gauthier) | Orchestration, TUI, OTel, Effect | Map/reduce, repo-wide editing, mature |
| **SWE-agent** (Princeton) | TUI, OTel, Effect | Research-backed, formal evaluation, bash-only |

### Indirect Competitors

| Product | Threat |
|---|---|
| **GitHub Copilot CLI** | Low — different philosophy (y/n confirmations vs agentic) |
| **Continue.dev** | Medium — open-source IDE agent, growing fast |
| **Cline** (VS Code extension) | Medium — open-source agent, VSCode integration |
| **Devin** | Low — closed-source, enterprise-price, very different UX |

### White Space

No competitor has:
1. **Model-authored orchestration scripts** — the model writes code that calls `parallel()` / `pipeline()` / `judge()`
2. **Live nested node tree** — sub-agent branches visible under the parent turn
3. **Full OTel 3-signal with span-level agent lifecycle** — every sub-agent turn is a real OTel child span
4. **Clean, importable, zero-leakage SDK** — `createAgent()` without Effect/OTel dependency bleed

This is the core of the pitch: **rlmcode is not a better Claude Code. It is a different category of tool.**

---

## 11. Community Playbook

### Structure

- **GitHub Discussions** — Q&A, Show and Tell (workflow recipes), Ideas
- **GitHub Issues** — Bug reports, feature requests (with templates)
- **Discord** (Effect server, not a separate one) — rlmcode channel
- **Subreddit** — None. Too early. Use r/effect-ts and r/programming for posts.

### Rituals

| Ritual | Cadence | Description |
|---|---|---|
| **rlmcode devlog** | Weekly (month 1), biweekly (month 2+) | "This week in rlmcode" — what changed, what broke, what's next |
| **Workflow recipe of the week** | Weekly | Highlight a community workflow script |
| **Ponytail audit** | Monthly | Publish debt ledger changes |
| **Trace of the week** | Weekly | A notable OTel trace from a real use case, annotated |

### Contributor Onboarding

1. `CONTRIBUTING.md` with architecture overview (point to AGENTS.md)
2. "Good first issue" label with `ponytail:` marker removal tasks
3. Developer environment setup script (`bun install && bun run lint`)
4. Workflow recipe contributions (no Rust/Effect knowledge needed — just JS)

---

## 12. Monetization (Speculative — v0.x is Free)

| Phase | Model | Rationale |
|---|---|---|
| v0.0.1–v0.5.0 | **Free + MIT** | Build adoption, community, trust |
| v0.5.0–v1.0.0 | **Free + MIT** | Stabilize SDK, grow ecosystem |
| v1.0.0+ | **Enterprise** (optional) | Self-hosted OTel backend, team management, SSO, audit logs |
| v1.0.0+ | **Cloud** (optional) | Managed motel tracing, team workspaces, shared recipes |

Keep the core free forever. Monetize the infrastructure around it (managed OTel, team sync) — the pattern OpenWork uses for OpenCode.

---

## 13. Immediate Next Steps (This Week)

1. **Capture the killer asciicast** — `bun run chat` with `RLM_MOCK=1`, type a prompt that triggers orchestration, record the full tree rendering. This is the single most important asset.
2. **Polish the README** — rewrite as a landing page (not developer notes). Lead with the asciicast.
3. **Publish to npm** — `bun publish` with `rlmcode` name. Ensure `bunx rlmcode` works.
4. **Write "Building rlmcode" devlog** — the Effect architecture story. Publish on Effect blog or personal blog.
5. **Draft the HN Show HN post** — keep it to 3 paragraphs: what it is, what makes it different (orchestration + tree + OTel), link to GitHub.
6. **Post to Effect Discord** #showcase — with a screenshot of the tree and OTel traces.

---

*This plan is alive. Update it as the project evolves, as competitors move, and as the community grows.*
