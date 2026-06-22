#!/usr/bin/env bun
// FRAME GATE — CJK / IME COMPOSITION SUBMIT (the gap focus.test never hits).
//
// focus.test types ASCII only ("first message", "after tab"), so the IME-defer path in
// chat.tsx submit() — `queueMicrotask(() => queueMicrotask(run))`, the DOUBLE defer that lets
// a CJK composition commit its last composed char into the textarea's plainText BEFORE the
// Enter-triggered read — is never exercised by a frame. If the double-defer regressed (or was
// dropped to a single defer), an ASCII test stays green while CJK input drops or doubles its
// final character.
//
// This test drives multi-codepoint CJK input (你好世界 — 4 Han chars, each a multi-byte UTF-8
// sequence terminal-control sends as a text atom) through the REAL composer + submit path, and
// asserts the captured transcript row carries the string INTACT: all four characters present,
// in order, with no loss and no duplication. A second CJK turn proves the input reclaims and
// keeps committing CJK across turns.
//
// HONEST SCOPE (ponytail: PTY can't replay the IME compose-race; Upgrade: an opentui textarea
// unit that injects a pending-composition then an Enter, asserting the double-defer reads the
// committed plainText): terminal-control sends `你好世界` as ONE already-committed text atom, so
// it does NOT reproduce the real IME race the double-defer guards (an Enter firing BEFORE the
// composition commits its last char into plainText). Removing the second queueMicrotask does
// NOT fail this gate. What this DOES catch is the broader CJK path: multi-byte UTF-8 round-trips
// the composer's plainText read, the paste-substitution loop, history.push, and the transcript
// render with no truncation/encoding corruption — the input class the ASCII-only focus.test
// can't see. The defer itself is pinned by code review + the inline rationale at submit().
import { launchDriver } from "./driver.ts"
import { report } from "./assert.ts"

const CJK = "你好世界"
const CJK2 = "再来一次"

await report("ime.test", async (a) => {
  const d = await launchDriver()
  try {
    await d.waitFor((f) => /no sessions/.test(f), { label: "list" })
    await d.type("n")
    await d.waitFor((f) => /message kimi/.test(f), { label: "composer" })

    // ── type CJK, submit → it lands as a transcript `│ <cjk>` row, intact ────────────────
    await d.type(CJK)
    await d.key("Enter")
    const sent = await d.waitFor((f) => f.includes(CJK), { label: "cjk user row", timeoutMs: 8000 })
    a.has(sent, CJK, "CJK input submitted intact (all four Han chars, in order, via the IME-defer read)")
    // No dropped/duplicated final char: the exact 4-char string appears, and NOT a 3-char
    // truncation ("你好世") nor a doubled tail ("你好世界界") — the two classic IME-race bugs.
    a.hasNot(sent, /你好世(?!界)/, "the final composed char is not dropped (no '你好世' without '界')")
    a.hasNot(sent, /你好世界界/, "the final composed char is not duplicated (no doubled '界')")

    // ── a real (mock) turn runs → reply lands; the composer reclaims for the next CJK turn ─
    await d.waitFor((f) => /Done\./.test(f), { label: "reply", timeoutMs: 40000 })
    await d.type(CJK2)
    await d.key("Enter")
    const sent2 = await d.waitFor((f) => f.includes(CJK2), { label: "second cjk row", timeoutMs: 8000 })
    a.has(sent2, CJK2, "a second CJK message also submits intact (defer is per-submit, input reclaimed)")
    a.has(sent2, CJK, "the first CJK message stays in the transcript")
  } finally {
    await d.stop()
  }
})
