// orch-journal — RESUME JOURNAL: crash/network resilience for orchestration nodes.
// NEVER lose a completed leaf (node). A per-run journal maps a stable, deterministic
// key (nodeId, hash(input), hash(opts-relevant)) → the stored node result. On a re-run
// with the SAME key the journal REPLAYS the cached result instead of re-calling the
// model — so a process crash / network blip mid-orchestration costs at most the IN-FLIGHT
// nodes, never the ones already finished.
//
// OFF BY DEFAULT: a normal turn() forward never touches this file. Only an opt-in caller
// (an orchestration driver, or a dynamic .ax/orch script) wraps a node via journaledNode()
// with `{ enabled: true }` + a Journal. With `enabled` false (or no Journal), journaledNode
// is a thin pass-through to the core node() prim — identical behavior, zero persistence.
//
// UNIFIED VOCABULARY: the orchestration unit is a NODE. journaledNode() wraps the core
// `node` prim (orch.ts) — it is NOT a 6th core prim, just a userland resilience wrapper
// (like the orch-recipes.ts recipes), so orch.ts stays exactly 5 prims.
//
// DETERMINISM: the key is hashed from a STABLE serialization (object keys sorted) of the
// input + an explicit allowlist of opts fields — NO Date.now / random / wall-clock in the
// key, so the SAME (nodeId, input, opts) always resolves to the SAME entry across restarts.
import { mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises"
import { resolve as resolvePath } from "node:path"
import type { AxAIService, AxGen, AxGenIn, AxGenOut } from "@ax-llm/ax"
import { type NodeOpts, node } from "./orch.ts"

// Where journals live: .ax/journal/<sessionId>.json (one file per run/session). Sits
// under the same trusted .ax/ root as the orch scripts dir; created on first save.
export const JOURNAL_DIR = resolvePath(process.cwd(), ".ax/journal")
export const journalPath = (sessionId: string): string =>
  resolvePath(JOURNAL_DIR, `${sanitizeSessionId(sessionId)}.json`)

// A sessionId is part of a filename, so neutralize separators / traversal — a journal
// file must never escape JOURNAL_DIR. Replace anything outside [A-Za-z0-9._-] with '_'.
const sanitizeSessionId = (sessionId: string): string => {
  const s = sessionId.trim().replace(/[^A-Za-z0-9._-]/g, "_")
  return s.length === 0 ? "session" : s
}

// One recorded node outcome: the stored result + when it was recorded (provenance only —
// recordedAt is NEVER part of the key, so it cannot perturb determinism).
export type JournalEntry = {
  readonly nodeId: string
  readonly key: string
  readonly result: AxGenOut
  readonly recordedAt: number // wall clock, provenance ONLY (not hashed into the key)
}

// The on-disk shape: a flat map keyed by the deterministic node key. `version` lets a
// future format change reject/upgrade stale files instead of mis-replaying.
export type JournalFile = {
  readonly version: 1
  readonly sessionId: string
  readonly entries: Record<string, JournalEntry>
}

// The live, in-memory journal for one run: the loaded entries + a dirty flag so we only
// re-persist after a new record. `entries` is a Map for O(1) has/get on the hot replay path.
export type Journal = {
  readonly sessionId: string
  readonly entries: Map<string, JournalEntry>
  dirty: boolean
}

// STABLE serialization for hashing: recursively sort object keys so {a,b} and {b,a}
// serialize identically. Arrays keep order (order is semantic). Primitives stringify as-is.
// This is the determinism backbone — the SAME logical input always yields the SAME string.
const stableStringify = (value: unknown): string => {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null"
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`
  const obj = value as Record<string, unknown>
  const keys = Object.keys(obj).sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`
}

// A small, stable, dependency-free string hash (FNV-1a, 32-bit) rendered as hex. Not
// cryptographic — it only needs to be STABLE and collision-resistant enough to key a
// per-run journal. ponytail: FNV-1a 32-bit (low collision risk for a single run's node
// keys). Upgrade: a wider/crypto digest (e.g. crypto.subtle SHA-256) if a run's key
// space grows enough that 32-bit collisions become plausible.
const fnv1a = (s: string): string => {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16).padStart(8, "0")
}

// The OPTS allowlist: only the fields that actually change a node's OUTPUT belong in the
// key. mem/tracer/traceContext/abortSignal/sessionId are per-run plumbing (NOT output-
// determining) and are EXCLUDED — including them would make every restart miss the cache
// (a fresh AxMemory / AbortController is a new object every run). maxSteps + functionCall
// DO shape the model's behavior, so they ARE in the key.
const optsFingerprint = (opts: NodeOpts): string =>
  stableStringify({ maxSteps: opts.maxSteps, functionCall: opts.functionCall ?? "auto", stream: opts.stream })

// journalKey — the deterministic (nodeId, hash(input), hash(opts-relevant)) key. Same
// inputs ⇒ same key across process restarts. Exported so a caller can pre-check / dedupe.
export const journalKey = (nodeId: string, input: AxGenIn, opts: NodeOpts): string =>
  `${nodeId}:${fnv1a(stableStringify(input))}:${fnv1a(optsFingerprint(opts))}`

// loadJournal — read .ax/journal/<sessionId>.json on run start (RESUME). A missing file
// (first run) or a corrupt/old-version file yields a FRESH empty journal rather than
// throwing — a bad journal must never block a run; the worst case is re-running nodes.
export const loadJournal = async (sessionId: string): Promise<Journal> => {
  const fresh = (): Journal => ({ sessionId, entries: new Map(), dirty: false })
  try {
    const text = await readFile(journalPath(sessionId), "utf8")
    const parsed = JSON.parse(text) as JournalFile
    if (parsed?.version !== 1 || typeof parsed.entries !== "object" || parsed.entries === null) return fresh()
    const entries = new Map<string, JournalEntry>()
    for (const [k, v] of Object.entries(parsed.entries)) {
      if (v && typeof v === "object" && typeof (v as JournalEntry).key === "string") entries.set(k, v as JournalEntry)
    }
    return { sessionId, entries, dirty: false }
  } catch {
    return fresh()
  }
}

// ADVISORY LOCKING (upgrade of the old single-writer ponytail). Two layers guard a save:
//   1. IN-PROCESS: a per-sessionId promise chain serializes saves of the SAME journal within
//      this process, so two overlapping saveJournal() awaits never interleave their read-merge-
//      write. (allSettled-style: a failed save still lets the next one run.)
//   2. CROSS-PROCESS: an exclusive lockfile (open with 'wx' — atomic create-or-fail) around
//      the read-merge-write-rename, with bounded retry. While locked, the save MERGES any
//      records another process already wrote to disk into its own set before writing, so two
//      processes journaling the same sessionId UNION their records instead of last-writer-wins
//      clobbering. A stale lock (a crashed holder) is broken after LOCK_STALE_MS.
const saveChains = new Map<string, Promise<unknown>>()
const LOCK_RETRY_MS = 25
const LOCK_MAX_TRIES = 40 // ~1s total before giving up the lock attempt
const LOCK_STALE_MS = 10_000 // a lockfile older than this is assumed abandoned (crashed holder)
const lockPath = (finalPath: string): string => `${finalPath}.lock`
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

// Acquire the exclusive lockfile, breaking a stale one. Returns true once held.
const acquireLock = async (lock: string): Promise<boolean> => {
  for (let i = 0; i < LOCK_MAX_TRIES; i++) {
    try {
      const fh = await open(lock, "wx")
      await fh.writeFile(`${process.pid}:${Date.now()}`)
      await fh.close()
      return true
    } catch (e) {
      if ((e as NodeJS.ErrnoException)?.code !== "EEXIST") throw e
      // Break a stale lock left by a crashed holder, then retry immediately.
      try {
        const body = await readFile(lock, "utf8")
        const ts = Number(body.split(":")[1] ?? 0)
        if (Number.isFinite(ts) && Date.now() - ts > LOCK_STALE_MS) {
          await rm(lock, { force: true })
          continue
        }
      } catch {
        /* the holder released it between our open and read — just retry */
      }
      await sleep(LOCK_RETRY_MS)
    }
  }
  return false
}

// saveJournal — persist the in-memory journal so it survives a process crash. ATOMIC:
// write the full JSON to a temp sibling, then rename() over the real path — a crash mid-
// write leaves the OLD journal intact (rename is atomic on POSIX), never a half-written
// file. No-op when not dirty (nothing new to record). Clears the dirty flag on success.
// SERIALIZED + LOCKED: in-process saves of the same sessionId chain; cross-process saves
// take an advisory lockfile and MERGE on-disk records before writing (see above).
export const saveJournal = async (journal: Journal): Promise<void> => {
  // Chain on the per-session promise so two in-process saves never overlap; clear the
  // chain slot once it settles so the Map doesn't grow unbounded.
  const prev = saveChains.get(journal.sessionId) ?? Promise.resolve()
  const run = prev.catch(() => {}).then(() => saveJournalLocked(journal))
  saveChains.set(journal.sessionId, run)
  try {
    await run
  } finally {
    if (saveChains.get(journal.sessionId) === run) saveChains.delete(journal.sessionId)
  }
}

const saveJournalLocked = async (journal: Journal): Promise<void> => {
  if (!journal.dirty) return
  await mkdir(JOURNAL_DIR, { recursive: true })
  const finalPath = journalPath(journal.sessionId)
  const lock = lockPath(finalPath)
  const held = await acquireLock(lock)
  try {
    // CROSS-PROCESS MERGE: fold any records ANOTHER process wrote since we loaded into our
    // own set first, so concurrent writers UNION rather than clobber. Our newer in-memory
    // entry wins on a key collision (the result is deterministic for a key anyway).
    const onDisk = await loadJournal(journal.sessionId)
    for (const [k, v] of onDisk.entries) if (!journal.entries.has(k)) journal.entries.set(k, v)
    const file: JournalFile = {
      version: 1,
      sessionId: journal.sessionId,
      entries: Object.fromEntries(journal.entries),
    }
    // A unique-ish temp name so two saves of the SAME journal don't collide.
    const tmpPath = `${finalPath}.${process.pid}.${journal.entries.size}.tmp`
    await writeFile(tmpPath, JSON.stringify(file, null, 2), "utf8")
    await rename(tmpPath, finalPath)
    journal.dirty = false
  } finally {
    if (held) await rm(lock, { force: true }).catch(() => {})
  }
}

// record — fold a completed node's result into the journal (marks it dirty so the next
// saveJournal persists it). Idempotent on the key: re-recording the same key overwrites
// with the latest result (the result is deterministic for a given key anyway).
export const record = (journal: Journal, nodeId: string, key: string, result: AxGenOut): void => {
  journal.entries.set(key, { nodeId, key, result, recordedAt: Date.now() })
  journal.dirty = true
}

// The journaledNode opt bag: the Journal to consult/record into, the nodeId (the human/
// stable identity that anchors the key), an `enabled` switch (OFF by default — a false /
// omitted journal makes journaledNode a pure pass-through to node()), and an optional
// persist hook fired AFTER a fresh record so the caller can flush to disk per-node (so a
// crash right after a node completes still has it journaled).
export type JournaledNodeSpec = {
  readonly journal?: Journal
  readonly nodeId: string
  readonly enabled?: boolean
  // Called once, AFTER a NEW node result is recorded (not on a replay), so the caller can
  // persist immediately. Defaults to saveJournal(journal). Awaited if it returns a Promise.
  readonly persist?: (journal: Journal) => void | Promise<void>
}

// journaledNode — wrap the core node() prim with resume-journal semantics. Curried like
// node(): bind (gen, opts, spec) once, then (ai, input) runs/replays.
//
//   - DISABLED (spec.enabled !== true OR no journal): a thin pass-through to node() — the
//     model is called exactly as without journaling, nothing is read or written. This is
//     the DEFAULT so normal turns are unaffected.
//   - ENABLED + key HIT: REPLAY the cached result — gen.forward() is NEVER called (the
//     headless test asserts exactly this: the fake model fn does not run on the 2nd pass).
//   - ENABLED + key MISS: run node() (the real forward), record the result under the key,
//     fire persist() so it survives a crash, then return it.
export const journaledNode =
  <I extends AxGenIn, O extends AxGenOut>(gen: AxGen<I, O>, opts: NodeOpts, spec: JournaledNodeSpec) =>
  async (ai: AxAIService, input: I): Promise<O> => {
    const { journal, nodeId, enabled = false, persist = saveJournal } = spec
    if (!enabled || journal === undefined) return node(gen, opts)(ai, input)
    const key = journalKey(nodeId, input, opts)
    const hit = journal.entries.get(key)
    if (hit !== undefined) return hit.result as O // REPLAY — no forward() call
    const result = await node(gen, opts)(ai, input)
    record(journal, nodeId, key, result)
    await persist(journal)
    return result
  }
