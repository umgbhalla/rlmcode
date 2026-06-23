# Security Policy

## ⚠️ Unsandboxed execution

rlmcode is an agent that **executes model-generated shell commands and JavaScript without a
sandbox** in the working directory (`src/core/tools.ts`: `bash`, `write_file`, `edit_file`),
and the `workflow`/`live` paths let the model author and run code. Treat it like running
arbitrary code: use it only in a **trusted directory, container, or VM**, never against
sensitive data or production credentials you can't afford to lose.

## Reporting a vulnerability

Please report security issues privately via GitHub Security Advisories
(repo → Security → Report a vulnerability), not in public issues. We'll respond as soon as we can.
