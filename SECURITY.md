# Security Policy

## ⚠️ Unsandboxed execution

rlmcode is an agent that **executes model-generated shell commands and JavaScript without a
sandbox** in the working directory (`src/core/tools.ts`: `bash`, `write_file`, `edit_file`),
and the `workflow`/`live` paths let the model author and run code. Treat it like running
arbitrary code: use it only in a **trusted directory, container, or VM**, never against
sensitive data or production credentials you can't afford to lose.

The `workflow({ script })` tool runs the model-authored script body **in-process via
`new Function`** (`src/core/workflow.ts`). This is **not a sandbox**: although the orchestration
prims (`agent`/`parallel`/`judge`/`rlm`/…) are the intended interface, the body has full host
access and **can read `process.env` (including `CLOUDFLARE_API_TOKEN` and any other secrets in
the environment), `globalThis`, and `require`**. This authority is **≤ the `bash` tool** the agent
already has (`bash` can `printenv` just as readily), so it grants no new capability — but note
that a script reading `process.env` directly does so with **no `bash` tool-call row in the trace**,
so it is less auditable than the equivalent shell command. The script body is bounded only by the
per-run token budget and the wall-clock timeout (`RLM_WORKFLOW_TIMEOUT_MS`), not by a capability
boundary. A future hardening (post-0.0.1) runs the body in an `AxJSRuntime` isolate — already used
for the RLM executor (`src/core/rlm-node.ts`) — which would make the prims the real enforced
boundary. Until then, the same "trusted directory / container / VM" rule above is the mitigation.

## Reporting a vulnerability

Please report security issues privately via GitHub Security Advisories
(repo → Security → Report a vulnerability), not in public issues. We'll respond as soon as we can.
