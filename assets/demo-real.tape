# vhs recipe → assets/demo.gif (+ assets/tui.png) — a REAL (non-mock) recording of the rlmcode
# TUI. Launches the REAL chat.tsx against REAL Cloudflare Kimi (RLM_MOCK empty; `bun --env-file=.env`
# loads CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID — NO creds baked into this tape), then drives a
# prompt that makes the model AUTHOR a `workflow` script and fan out parallel agents over src/core,
# src/tui, scripts. The live orchestration node-tree (fan-out → parallel agent nodes → per-node tool
# rings → Σ footer) builds on-screen from a REAL run — the money shot.
#
# Real CF turns are SLOW (a fan-out can run minutes); the Sleeps are generous so the tree actually
# fans out and tools stream under the nodes. PlaybackSpeed compresses the gif so it isn't minutes long.
# Render:  vhs assets/demo-real.tape    (writes assets/demo.gif + assets/tui.png)
Output assets/demo.gif

Set Shell bash
Set FontSize 16
Set Width 1500
Set Height 1100
Set Theme "Catppuccin Mocha"
Set Padding 28
Set Framerate 24
Set PlaybackSpeed 2.0

# Real CF path: RLM_MOCK empty ⇒ runtime.ts builds the real Cloudflare service. The creds come from
# .env via bun's --env-file (they are NOT written into this tape).
Env RLM_MOCK ""
Env RLM_ORCH_MAX_SHOWN "999"

# Boot the real TUI (give it a beat to mount + load the project doc).
Hide
Type "bun --env-file=.env src/tui/chat.tsx" Enter
Sleep 5s
Show
Sleep 1s

# New session → chat view.
Type "n"
Sleep 1500ms

# The workflow prompt — bounded per-agent work so the parallel nodes fill out (and some settle) fast.
Type "use a workflow to explore this codebase in parallel — fan out one agent over src/core, one over src/tui, one over scripts. Each agent: list the dir and read just 2-3 key files, then give a 3-line summary. Then judge/merge into one architecture summary."
Sleep 800ms
Enter

# Let the REAL turn run: the model authors the script, the fan-out tree appears, then per-node tool
# rings (Bash/Read/Search) stream in under the parallel agent nodes. ~38s lands a rich live tree.
Sleep 38s
Screenshot assets/tui.png

# A little more so the tree keeps building (nodes settling to ✓, tokens ticking on the Σ footer).
Sleep 14s
