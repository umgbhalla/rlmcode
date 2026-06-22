// MULTI-MODEL registry — a NODE may run on a chosen model + thinking level. EXACTLY
// two entries, BOTH thinking models on Cloudflare Workers AI, BOTH reachable on the
// SAME CF v1 OpenAI-compat endpoint with the EXISTING CLOUDFLARE creds (no new keys,
// no separate AxAIService): routing is JUST swapping the per-forward `model` param.
//
// VERIFIED LIVE (this CF endpoint, existing token/account):
//   - @cf/moonshotai/kimi-k2.7-code  → returns content + a separate reasoning_content
//   - @cf/zai-org/glm-5.2            → returns content + a separate reasoning_content
// Both are THINKING models (reasoning_content distinct from content). Thinking-level
// control is via ax's thinkingTokenBudget / showThoughts (AxProgramForwardOptions).
//
// CRITICAL GOTCHA (verified live): at LOW max_tokens the model's reasoning eats the
// WHOLE completion budget and `content` comes back EMPTY (finish_reason:"length").
// e.g. GLM at max_tokens=64 returned content:"" with a full reasoning_content. So a
// routed leaf MUST be given adequate completion budget — see NODE_MAX_TOKENS below and
// modelConfigFor(), which floors maxTokens for both models so a thinking node always
// has room to emit real output AFTER its reasoning.
import type { AxModelConfig } from "@ax-llm/ax"

// The two model ids — the ONLY models in the pool. No opus/gpt/gemini, no roster.
export const KIMI = "@cf/moonshotai/kimi-k2.7-code"
export const GLM = "@cf/zai-org/glm-5.2"

// A thinking level passed by a caller. Mirrors AxModelConfig.effort
// ('low'|'medium'|'high'|'xhigh'|'max'); threaded straight through to forward().
export type Effort = "low" | "medium" | "high" | "xhigh" | "max"

// A model registry entry: the short routing name → the CF model id (+ a label/desc for
// the prompt). BOTH run on the shared `llm` service (runtime.ts) — the entry carries NO
// AxAIService, because routing is purely the per-forward `model` param swap.
export type ModelEntry = {
  readonly name: ModelName
  readonly id: string
  readonly label: string
  readonly thinking: true // both pool models are thinking models (reasoning_content)
  readonly desc: string
}

export type ModelName = "kimi" | "glm"

// EXACTLY two entries. kimi is the DEFAULT (the session model); glm is the alternate.
export const MODELS: Readonly<Record<ModelName, ModelEntry>> = {
  kimi: {
    name: "kimi",
    id: KIMI,
    label: "Kimi K2.7",
    thinking: true,
    desc: "@cf/moonshotai/kimi-k2.7-code — the default session model; a strong coding/thinking model.",
  },
  glm: {
    name: "glm",
    id: GLM,
    label: "GLM 5.2",
    thinking: true,
    desc: "@cf/zai-org/glm-5.2 — the alternate; a capable general/reasoning thinking model.",
  },
} as const

// The default routing name — the session model (Kimi K2.7). resolveModel(undefined)
// and any unknown name fall back here, so omitting `model` is UNCHANGED behaviour.
export const DEFAULT_MODEL: ModelName = "kimi"

// resolveModel — a routing name → its registry entry. undefined / unknown → kimi
// (the default), so a node with no explicit model runs on the session model exactly
// as before. Accepts the short name ('kimi'|'glm') OR the full CF id (so a caller that
// passes the resolved id round-trips). Case-insensitive on the short name.
export const resolveModel = (name?: string): ModelEntry => {
  if (name === undefined) return MODELS[DEFAULT_MODEL]
  const n = name.trim().toLowerCase()
  if (n === "kimi" || n === KIMI.toLowerCase()) return MODELS.kimi
  if (n === "glm" || n === GLM.toLowerCase()) return MODELS.glm
  return MODELS[DEFAULT_MODEL]
}

// COMPLETION-budget FLOOR for a routed node. Because BOTH pool models are thinking
// models that spend completion tokens on reasoning FIRST, a small maxTokens leaves no
// room for real `content` (verified: empty content at max_tokens=64). This floor
// guarantees a thinking node always has budget to emit output AFTER its reasoning.
// AX2_NODE_MAX_TOKENS overrides; default 8192 (ample for a node's text reply + thinking).
export const NODE_MAX_TOKENS = (() => {
  const v = Number(process.env.AX2_NODE_MAX_TOKENS ?? 8192)
  return Number.isFinite(v) && v > 0 ? Math.max(1024, Math.floor(v)) : 8192
})()

// modelConfigFor — build the per-forward AxModelConfig fragment for a routing choice:
// the effort hint (when given) PLUS the maxTokens FLOOR so a thinking node never starves
// its own content. The caller spreads this into forward() opts.modelConfig. effort is an
// AxModelConfig field (provider reasoning hint); thinkingTokenBudget is threaded as a
// SIBLING forward option (not inside modelConfig) — see nodeForwardOpts().
export const modelConfigFor = (effort?: Effort): AxModelConfig => ({
  maxTokens: NODE_MAX_TOKENS,
  ...(effort !== undefined ? { effort } : {}),
})

// A per-node routing choice threaded through the orchestration path. ALL fields
// optional: an absent choice = the default session model (Kimi) at default effort,
// i.e. UNCHANGED behaviour. thinkingTokenBudget is ax's string-level thinking control
// (AxAIServiceOptions['thinkingTokenBudget']); effort is the AxModelConfig effort hint.
export type NodeModelChoice = {
  readonly model?: string | undefined
  readonly effort?: Effort | undefined
  readonly thinkingTokenBudget?: "minimal" | "low" | "medium" | "high" | "highest" | "none" | undefined
}

// nodeForwardOpts — turn a routing choice into the forward()-opts FRAGMENT to spread
// onto a node's NodeOpts: the resolved CF model id, the modelConfig (effort + maxTokens
// floor), and the optional thinkingTokenBudget (a sibling forward option, NOT inside
// modelConfig). An EMPTY choice (or none) yields ONLY the maxTokens floor under the
// DEFAULT model — so default routing keeps Kimi behaviour, just with a safe content
// budget. Returns a plain object the node() boundary spreads into AxProgramForwardOptions.
export const nodeForwardOpts = (
  choice?: NodeModelChoice,
): { model: string; modelConfig: AxModelConfig; thinkingTokenBudget?: NodeModelChoice["thinkingTokenBudget"] | undefined } => {
  const entry = resolveModel(choice?.model)
  return {
    model: entry.id,
    modelConfig: modelConfigFor(choice?.effort),
    ...(choice?.thinkingTokenBudget !== undefined ? { thinkingTokenBudget: choice.thinkingTokenBudget } : {}),
  }
}

// choiceFromArgs — build a NodeModelChoice from loose tool args (the orchestrate tool's
// { model?, effort? }). Validates effort against the Effort union; resolves the model name
// to its CF id (resolveModel normalises unknown/absent → kimi). Returns undefined when
// NEITHER is given, so an unrouted orchestrate run stays on the default session model.
const EFFORTS: readonly Effort[] = ["low", "medium", "high", "xhigh", "max"]
export const choiceFromArgs = (args: { model?: string | undefined; effort?: string | undefined }): NodeModelChoice | undefined => {
  const effort = EFFORTS.includes(args?.effort as Effort) ? (args!.effort as Effort) : undefined
  if (args?.model === undefined && effort === undefined) return undefined
  return { model: resolveModel(args?.model).id, effort }
}

// MODEL_DOC — the two-model + thinking-level paragraph appended to BASE_PROMPT so a
// node (and the main agent) knows the pool and how to route. Pure prose, no behaviour.
export const MODEL_DOC = [
  "Model pool (a node may run on either): 'kimi' = Kimi K2.7 (@cf/moonshotai/kimi-k2.7-code, the default) and",
  "'glm' = GLM 5.2 (@cf/zai-org/glm-5.2). BOTH are thinking models (they reason before answering);",
  "thinking depth is controlled per-node via effort (low|medium|high|xhigh|max) or thinkingTokenBudget.",
  "Default = kimi at default effort. A node gets adequate completion budget so its reasoning never starves its reply.",
].join(" ")
