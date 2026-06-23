# Third-Party Licenses

This project ports/reuses code and design from the following MIT-licensed projects.
Their copyright and permission notices are reproduced below as required by the MIT License.

---

## opencode

The TUI transcript/card/composer chrome under `src/tui/` (`messages.tsx`, `shell.tsx`,
`composer.tsx`, `chat.tsx`, `atoms.ts`, `icons.ts`) was ported (Solid → React) from
opencode. In-file comments cite the original `file:line` provenance.

Source: https://github.com/sst/opencode

```
MIT License

Copyright (c) 2025 opencode

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

---

## terminal-control (termctrl)

The headless TUI test gate (`scripts/tui/driver.ts`) drives the `termctrl` binary from
terminal-control by Kit Langton (opentui's author). The binary is installed at test time
via `cargo install` — no source is vendored in this repo.

Source: https://github.com/kitlangton/terminal-control · Copyright (c) 2026 Kit Langton (MIT)

---

## termcast

The theme token vocabulary in `src/tui/theme.ts` (the `ResolvedTheme` role-name shape) was
modeled on termcast. Only field-name vocabulary and the Catppuccin-Mocha palette were reused.

Source: https://github.com/termcast/termcast · Copyright (c) 2026 Tommy D. Rossi (MIT)
