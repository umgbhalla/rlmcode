# vhs recipe → assets/demo.gif (+ assets/tui.png + assets/theme.png) — a REAL (non-mock) recording
# of the rlmcode TUI at HIGHER RESOLUTION. Launches the REAL chat.tsx against REAL Cloudflare Kimi
# (RLM_MOCK empty; `bun --env-file=.env` loads CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID — NO creds
# baked into this tape), then drives a prompt that makes the model AUTHOR a `workflow` script and fan
# out parallel agents over src/core, src/tui, scripts. The live orchestration node-tree (fan-out →
# parallel agent nodes → per-node tool rings + token badge → Σ footer) builds on-screen from a REAL
# run — the money shot. The sticky header "rlmcode · session <id>" anchors at the top throughout
# (the motel trace-correlation handle). Then it opens the /theme picker and switches palette LIVE.
#
# Real CF turns are SLOW (a fan-out can run minutes); the Sleeps are generous so the tree actually
# fans out and tools stream under the nodes. PlaybackSpeed compresses the gif so it isn't minutes long.
# Render:  vhs assets/demo-real.tape    (writes assets/demo.gif + assets/tui.png + assets/theme.png)
Output assets/demo.gif

Set Shell bash
Set FontSize 22
Set Width 2080
Set Height 1520
Set Theme "Catppuccin Mocha"
Set Padding 32
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

# New session → chat view. The sticky header "rlmcode · session <id>" anchors at the top.
Type "n"
Sleep 1500ms

# The workflow prompt — bounded per-agent work so the parallel nodes fill out (and some settle) fast.
Type "use a workflow to explore this codebase in parallel — fan out one agent over src/core, one over src/tui, one over scripts. Each agent: list the dir and read just 2-3 key files, then give a 3-line summary. Then judge/merge into one architecture summary."
Sleep 800ms
Enter

# Let the REAL turn run: the model authors the script, the fan-out tree appears, then per-node tool
# rings (Bash/Read/Search) + token badges stream in under the parallel agent nodes. ~58s lets nodes
# settle to ✓ + the Σ footer tokens accumulate (the rich, settled tree — not a just-fanned-out one).
Sleep 58s
Screenshot assets/tui.png

# A little more so the tree keeps building (nodes settling to ✓, tokens ticking on the Σ footer).
Sleep 5s

# ── THEME SUPPORT (the headline new feature) — ⌘K → "theme" → the /theme picker, switch palette LIVE.
Ctrl+K
Sleep 1300ms
Type "theme"
Sleep 1000ms
Enter
Sleep 1500ms
Screenshot assets/theme.png
Down
Sleep 1000ms
Enter
Sleep 2500ms
