# vhs recipe → assets/demo.gif (+ tui.png / palette.png). Drives the REAL chat.tsx in mock mode
# (zero network) through the showpiece: new session → orchestrate turn (live node-tree) → ⌘K
# palette. macOS-style window chrome (traffic-light bar, rounded, transparent margin) for a
# polished capture; the PNGs get a drop-shadow in post (magick). RLM_MOCK_DELAY_MS paces the
# stream so thinking + tree growth read like a real turn.
# Render:  vhs assets/demo.tape   (then the shadow post-process — see scripts/shot.sh)
Output assets/demo.gif

Set Shell bash
Set FontSize 16
Set Width 1460
Set Height 900
Set Theme "Catppuccin Mocha"
Set Padding 28

Env RLM_MOCK "1"
Env RLM_MOCK_STREAM "1"
Env RLM_MOCK_DELAY_MS "1100"
Env RLM_ORCH_MAX_SHOWN "999"

Hide
Type "bun src/tui/chat.tsx" Enter
Sleep 3s
Show
Sleep 1s

# new session → chat view
Type "n"
Sleep 1s

# an orchestrate turn → the live fan-out node-tree + streamed reply
Type "orchestrate the auth refactor"
Sleep 600ms
Enter
Sleep 4s
Screenshot assets/tui.png

# the ⌘K command palette — open, filter (screenshot the filtered result)
Ctrl+K
Sleep 1300ms
Type "scroll"
Sleep 1100ms
Screenshot assets/palette.png
Sleep 700ms
Escape
Sleep 1200ms
