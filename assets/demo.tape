# vhs recipe → assets/demo.gif. Drives the REAL TUI in mock mode (no network) through the
# showpiece flow: new session → a turn → the live orchestration node-tree → ⌘K palette.
# Render:  vhs assets/demo.tape       (needs vhs + ffmpeg; mock = zero network)
# NOTE: keystroke flow finalized after the tui-migrate landing (palette key / prompts may shift).
Output assets/demo.gif

Set Shell bash
Set FontSize 13
Set Width 1280
Set Height 860
Set Theme "Catppuccin Mocha"
Set Padding 24
Set Margin 12
Set BorderRadius 10

Env RLM_MOCK "1"
Env RLM_MOCK_STREAM "1"
Env RLM_ORCH_MAX_SHOWN "999"

Hide
Type "bun src/tui/chat.tsx" Enter
Sleep 2.5s
Show
Sleep 1s

# new session
Type "n"
Sleep 900ms

# a turn that triggers the mock orchestration tree + streaming reply
Type "orchestrate the auth refactor"
Sleep 600ms
Enter
Sleep 4s

# focus + expand the node tree (the showpiece)
Tab
Sleep 1s
Enter
Sleep 2.5s

# command palette
Ctrl+K
Sleep 2s
Escape
Sleep 1.2s
