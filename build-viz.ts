// Reads the extraction workflow output and emits a single self-contained
// interactive HTML that visualizes the ax2 end-to-end state machine at
// multiple black-box depths.
import { readFileSync, writeFileSync } from "node:fs"

const SRC = "/private/tmp/claude-501/-Users-umang-hub-ax2/e34a2e8c-8af2-42c9-8684-328b4b53766d/tasks/w39m6860t.output"
const OUT = process.env.HOME + "/.agent/diagrams/ax2-system.html"

const raw = JSON.parse(readFileSync(SRC, "utf8"))
const components: any[] = raw.result.components
const critic = raw.result.critic

// ---- pipeline order + L1 grouping (the spine of the end-to-end view) ----
const order = [
  "opentui-react", "atom-react", "atom-registry", "atom-core",
  "tracer", "telemetry", "ax-forward", "otel-bridge",
  "motel-ingest", "motel-tui", "opentui-core",
]
// map component.component string -> short id
const idOf = (c: any): string => {
  const n = c.component.toLowerCase()
  if (n.includes("atom core")) return "atom-core"
  if (n.includes("atomregistry")) return "atom-registry"
  if (n.includes("atom-react") || n.includes("react bridge")) return "atom-react"
  if (n.includes("tracer + effect.fn") || n.includes("tracer + span") || n.includes("effect tracer")) return "tracer"
  if (n.includes("opentelemetry bridge")) return "otel-bridge"
  if (n.includes("telemetry")) return "telemetry"
  if (n.includes("opentui core")) return "opentui-core"
  if (n.includes("opentui/react") || n.includes("reconciler")) return "opentui-react"
  if (n.includes("ax-llm") || n.includes("forward")) return "ax-forward"
  if (n.includes("ingest")) return "motel-ingest"
  if (n.includes("tui")) return "motel-tui"
  return n.replace(/[^a-z0-9]+/g, "-").slice(0, 20)
}
const meta: Record<string, { short: string; group: string; stage: string }> = {
  "opentui-react": { short: "opentui ⟷ React", group: "ui", stage: "1 · input" },
  "atom-react": { short: "@effect/atom-react", group: "effect", stage: "2 · bridge" },
  "atom-registry": { short: "AtomRegistry", group: "effect", stage: "3 · store" },
  "atom-core": { short: "Atom core / runtime.fn", group: "effect", stage: "4 · fork" },
  "tracer": { short: "Effect Tracer / fn span", group: "agent", stage: "5 · span" },
  "telemetry": { short: "gen_ai semconv", group: "agent", stage: "5b · attrs" },
  "ax-forward": { short: "ax.forward → Cloudflare", group: "agent", stage: "6 · LLM" },
  "otel-bridge": { short: "OTel bridge → OTLP", group: "agent", stage: "7 · export" },
  "motel-ingest": { short: "motel OTLP ingest", group: "motel", stage: "8 · ingest" },
  "motel-tui": { short: "motel TUI viewer", group: "motel", stage: "9 · view" },
  "opentui-core": { short: "opentui paint loop", group: "ui", stage: "0 · paint" },
}
const groups: Record<string, { name: string; blurb: string }> = {
  ui: { name: "TERMINAL UI", blurb: "opentui — React reconciler whose host nodes ARE Renderables; Zig double-buffer paint loop. Shared by the chat app AND motel's TUI." },
  effect: { name: "EFFECT STATE", blurb: "Atoms = the UI's Effect interface. Registry is the reactive store; runtime.fn forks effects on the TracingLive layer." },
  agent: { name: "AGENT + TRACE", blurb: "Effect.fn opens spans; ax.forward calls Kimi on Cloudflare; @effect/opentelemetry turns Effect spans into real OTel spans → OTLP." },
  motel: { name: "MOTEL VIEWER", blurb: "Local OTLP server ingests spans/logs/metrics into SQLite; OpenTUI viewer renders the trace waterfall." },
}

const byId: Record<string, any> = {}
for (const c of components) byId[idOf(c)] = c

const data = {
  order,
  meta,
  groups,
  components: order.map((id) => ({ id, ...byId[id] })).filter((c) => c.component),
  handoffs: critic.handoffs,
  gaps: critic.gaps,
}

const json = JSON.stringify(data)

const html = String.raw`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>ax2 — end-to-end state machine</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500;600&display=swap" rel="stylesheet">
<style>
:root{
  --bg:#0c1118; --bg2:#0f1620; --surface:#131c28; --surface2:#18232f;
  --border:rgba(120,160,200,.14); --border2:rgba(120,160,200,.28);
  --text:#dfe8f2; --dim:#8aa0b6; --faint:#5d7390;
  --teal:#34d2c4; --teal-d:rgba(52,210,196,.13);
  --gold:#e0a73a; --gold-d:rgba(224,167,58,.13);
  --rose:#e0607a; --rose-d:rgba(224,96,122,.13);
  --grn:#5bd08a; --grn-d:rgba(91,208,138,.13);
  --blu:#5aa0ff; --blu-d:rgba(90,160,255,.13);
  --g-ui:var(--teal); --g-effect:var(--gold); --g-agent:var(--rose); --g-motel:var(--grn);
}
*{box-sizing:border-box}
html,body{margin:0;padding:0}
body{
  background:
    radial-gradient(1200px 600px at 80% -10%, rgba(52,210,196,.06), transparent 60%),
    radial-gradient(1000px 500px at 0% 110%, rgba(224,167,58,.05), transparent 60%),
    linear-gradient(var(--bg),var(--bg2));
  background-attachment:fixed;
  color:var(--text); font-family:"IBM Plex Sans",system-ui,sans-serif;
  font-size:15px; line-height:1.5; min-height:100vh;
}
body::before{content:"";position:fixed;inset:0;pointer-events:none;z-index:0;
  background-image:linear-gradient(rgba(120,160,200,.04) 1px,transparent 1px),linear-gradient(90deg,rgba(120,160,200,.04) 1px,transparent 1px);
  background-size:34px 34px;}
.wrap{position:relative;z-index:1;max-width:1280px;margin:0 auto;padding:30px 26px 120px}
code,pre,.mono{font-family:"IBM Plex Mono",ui-monospace,monospace}
header{margin-bottom:8px}
h1{font-size:30px;font-weight:700;letter-spacing:-.5px;margin:0 0 4px}
h1 .x{color:var(--teal)}
.sub{color:var(--dim);font-size:14.5px;max-width:880px}
.sub b{color:var(--text);font-weight:600}
.legend{display:flex;gap:16px;flex-wrap:wrap;margin:16px 0 4px;font-size:12px;color:var(--dim)}
.legend span{display:inline-flex;align-items:center;gap:6px}
.dot{width:9px;height:9px;border-radius:2px;display:inline-block}

/* tabs */
.tabs{display:flex;gap:4px;flex-wrap:wrap;margin:22px 0 18px;border-bottom:1px solid var(--border);padding-bottom:0}
.tab{appearance:none;background:none;border:0;border-bottom:2px solid transparent;color:var(--dim);
  font-family:inherit;font-size:13.5px;font-weight:600;padding:9px 13px;cursor:pointer;letter-spacing:.2px;margin-bottom:-1px;transition:.15s}
.tab:hover{color:var(--text)}
.tab.on{color:var(--text);border-bottom-color:var(--teal)}
.tab .n{font-family:"IBM Plex Mono";color:var(--faint);margin-right:6px;font-size:12px}
.tab.on .n{color:var(--teal)}
.lens{display:none;animation:fade .35s ease both}
.lens.on{display:block}
@keyframes fade{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}
@media (prefers-reduced-motion:reduce){.lens{animation:none}}

.panel-intro{color:var(--dim);font-size:13.5px;margin:0 0 18px;max-width:920px}
.panel-intro b{color:var(--text)}

/* ---- end to end pipeline ---- */
.pipe{display:flex;flex-direction:column;gap:0}
.hop{display:grid;grid-template-columns:230px 1fr;gap:0;align-items:stretch}
.hop .node{position:relative}
.chip{width:100%;text-align:left;background:var(--surface);border:1px solid var(--border);border-left:3px solid var(--gc,var(--teal));
  border-radius:9px;padding:11px 13px;cursor:pointer;transition:.16s;color:var(--text);font-family:inherit;display:block}
.chip:hover{background:var(--surface2);border-color:var(--border2);transform:translateX(2px)}
.chip.active{background:var(--surface2);box-shadow:0 0 0 1px var(--gc),0 10px 30px -16px var(--gc)}
.chip .stg{font-family:"IBM Plex Mono";font-size:10.5px;color:var(--gc,var(--teal));letter-spacing:.6px;text-transform:uppercase}
.chip .ttl{font-weight:600;font-size:14px;margin-top:2px}
.chip .grp{font-size:11px;color:var(--dim);margin-top:3px}
.edge{padding:5px 0 5px 18px;border-left:1px dashed var(--border2);margin-left:14px;position:relative}
.edge::before{content:"";position:absolute;left:-4px;top:50%;width:7px;height:7px;border-radius:50%;background:var(--gold);transform:translateY(-50%);box-shadow:0 0 0 3px var(--gold-d)}
.edge .h{font-family:"IBM Plex Mono";font-size:11.5px;color:var(--gold);font-weight:600;cursor:pointer}
.edge .h:hover{text-decoration:underline}
.edge .m{font-size:11.5px;color:var(--dim);margin-top:2px;display:none}
.edge.open .m{display:block}
.spine-pad{height:14px;border-left:1px dashed var(--border2);margin-left:14px}

/* token animation */
.playbar{display:flex;align-items:center;gap:12px;margin:6px 0 16px}
.btn{appearance:none;background:var(--surface);border:1px solid var(--border2);color:var(--text);font-family:"IBM Plex Mono";
  font-size:12px;font-weight:600;padding:7px 13px;border-radius:7px;cursor:pointer;transition:.15s}
.btn:hover{background:var(--surface2);border-color:var(--teal)}
.flash{box-shadow:0 0 0 1px var(--teal),0 0 24px -4px var(--teal)!important;background:var(--surface2)!important}

/* ---- black box depths ---- */
.depthwrap{display:flex;flex-direction:column;gap:14px}
.depth{border:1px solid var(--border);border-radius:12px;padding:16px 18px;background:linear-gradient(var(--surface),var(--bg2))}
.depth h3{margin:0 0 3px;font-size:15px;display:flex;align-items:center;gap:9px}
.depth h3 .lv{font-family:"IBM Plex Mono";font-size:11px;color:#0c1118;background:var(--teal);padding:2px 7px;border-radius:5px;font-weight:700}
.depth .cap{color:var(--dim);font-size:12.5px;margin:0 0 12px}
.l0box{text-align:center;padding:26px;border:1px dashed var(--border2);border-radius:10px;background:var(--surface);font-size:15px}
.l0box .big{font-size:19px;font-weight:600}
.l0box .arr{color:var(--teal);font-family:"IBM Plex Mono";margin:0 9px}
.fourgrid{display:grid;grid-template-columns:repeat(4,1fr);gap:10px}
@media(max-width:860px){.fourgrid{grid-template-columns:1fr 1fr}}
.gbox{border:1px solid var(--border);border-top:3px solid var(--gc);border-radius:9px;padding:12px;background:var(--surface)}
.gbox .gname{font-family:"IBM Plex Mono";font-size:12px;font-weight:700;color:var(--gc);letter-spacing:.5px}
.gbox .gblurb{font-size:11.5px;color:var(--dim);margin-top:6px}
.gbox .gmods{margin-top:9px;display:flex;flex-direction:column;gap:4px}
.gbox .gmods button{appearance:none;text-align:left;background:var(--bg2);border:1px solid var(--border);color:var(--text);font-family:"IBM Plex Mono";font-size:11px;padding:5px 7px;border-radius:5px;cursor:pointer;transition:.13s}
.gbox .gmods button:hover{border-color:var(--gc);color:var(--gc)}
.elevtree{font-family:"IBM Plex Mono";font-size:12px;line-height:1.85;color:var(--dim)}
.elevtree .f{color:var(--teal)}
.elevtree .ln{color:var(--gold)}

/* ---- component card / drawer ---- */
.cards{display:grid;grid-template-columns:1fr 1fr;gap:12px}
@media(max-width:900px){.cards{grid-template-columns:1fr}}
.card{border:1px solid var(--border);border-left:3px solid var(--gc,var(--teal));border-radius:10px;background:var(--surface);padding:14px 15px;cursor:pointer;transition:.15s}
.card:hover{background:var(--surface2);border-color:var(--border2)}
.card .ct{font-weight:600;font-size:14.5px;margin-bottom:3px}
.card .co{font-size:12.5px;color:var(--dim)}
.card .badge{font-family:"IBM Plex Mono";font-size:10px;color:var(--gc);text-transform:uppercase;letter-spacing:.5px}

/* drawer */
.drawer-bg{position:fixed;inset:0;background:rgba(4,8,12,.6);backdrop-filter:blur(3px);z-index:50;display:none;animation:fade .2s both}
.drawer-bg.on{display:block}
.drawer{position:fixed;top:0;right:0;height:100%;width:min(760px,94vw);background:var(--bg2);border-left:1px solid var(--border2);
  z-index:51;transform:translateX(100%);transition:transform .28s cubic-bezier(.2,.7,.2,1);overflow-y:auto;box-shadow:-30px 0 60px -30px #000}
.drawer.on{transform:none}
.drawer .dhead{position:sticky;top:0;background:linear-gradient(var(--bg2),rgba(15,22,32,.9));backdrop-filter:blur(6px);
  padding:18px 22px 14px;border-bottom:1px solid var(--border);z-index:2}
.drawer .dstage{font-family:"IBM Plex Mono";font-size:11px;color:var(--gc);text-transform:uppercase;letter-spacing:.7px}
.drawer h2{margin:3px 0 0;font-size:20px}
.drawer .one{color:var(--dim);font-size:13px;margin-top:7px}
.drawer .close{position:absolute;top:16px;right:18px;background:var(--surface);border:1px solid var(--border2);color:var(--text);
  width:30px;height:30px;border-radius:7px;cursor:pointer;font-size:16px;line-height:1}
.drawer .close:hover{border-color:var(--rose);color:var(--rose)}
.dbody{padding:18px 22px 60px}
.sect{margin-bottom:22px}
.sect .lab{font-family:"IBM Plex Mono";font-size:11px;color:var(--dim);text-transform:uppercase;letter-spacing:1px;margin-bottom:9px;display:flex;align-items:center;gap:8px}
.sect .lab::before{content:"";width:6px;height:6px;border-radius:50%;background:var(--gc,var(--teal))}
.mech{font-size:13.5px;line-height:1.62;color:var(--text)}
.mech code{background:var(--surface);padding:1px 5px;border-radius:4px;font-size:12px;color:var(--teal);border:1px solid var(--border)}
.feeds{font-size:13px;color:var(--dim);background:var(--surface);border:1px solid var(--border);border-left:3px solid var(--gold);border-radius:8px;padding:11px 13px}
.srcs{display:flex;flex-direction:column;gap:6px}
.src{font-family:"IBM Plex Mono";font-size:11.5px;background:var(--surface);border:1px solid var(--border);border-radius:7px;padding:8px 10px}
.src .p{color:var(--teal)}
.src .l{color:var(--gold)}
.src .r{color:var(--dim);display:block;margin-top:3px;font-family:"IBM Plex Sans";font-size:11.5px}
.excerpt{margin-bottom:12px;border:1px solid var(--border);border-radius:8px;overflow:hidden;background:var(--bg)}
.excerpt .xh{display:flex;justify-content:space-between;gap:8px;padding:6px 10px;background:var(--surface);border-bottom:1px solid var(--border);font-family:"IBM Plex Mono";font-size:10.5px}
.excerpt .xh .xp{color:var(--teal)}
.excerpt .xh .xl{color:var(--gold)}
.excerpt pre{margin:0;padding:11px 12px;font-size:11.5px;line-height:1.55;white-space:pre-wrap;word-break:break-word;color:#cfe0ee;overflow-x:auto}
.excerpt .xn{padding:7px 12px;font-size:11.5px;color:var(--dim);border-top:1px solid var(--border);background:rgba(0,0,0,.15)}
.excerpt .xn::before{content:"▸ ";color:var(--gold)}
.mermaid-box{border:1px solid var(--border);border-radius:8px;background:var(--surface);padding:12px;display:flex;justify-content:center;overflow:auto}
.mermaid{font-family:"IBM Plex Mono"!important}

/* state machine grid */
.smgrid{display:grid;grid-template-columns:1fr;gap:16px}
.smcard{border:1px solid var(--border);border-left:3px solid var(--gc);border-radius:10px;background:var(--surface);overflow:hidden}
.smcard .smh{padding:12px 15px;border-bottom:1px solid var(--border);cursor:pointer;display:flex;align-items:center;gap:10px}
.smcard .smh:hover{background:var(--surface2)}
.smcard .smh .smt{font-weight:600;font-size:14.5px}
.smcard .smh .smg{font-family:"IBM Plex Mono";font-size:10px;color:var(--gc);text-transform:uppercase;letter-spacing:.5px;margin-left:auto}
.smcard .smh .chev{color:var(--dim);transition:.2s}
.smcard.open .smh .chev{transform:rotate(90deg)}
.smbody{display:none;padding:14px}
.smcard.open .smbody{display:block}
.smbody .smo{font-size:12.5px;color:var(--dim);margin-bottom:12px}

/* trace tree */
.tracewrap{border:1px solid var(--border);border-radius:12px;background:var(--surface);padding:20px 22px}
.span{font-family:"IBM Plex Mono";font-size:13px;margin:0;padding:9px 12px;border-radius:7px;border:1px solid var(--border);background:var(--bg2);position:relative}
.span+.span{margin-top:8px}
.span .sk{font-size:10px;color:var(--dim);text-transform:uppercase;letter-spacing:.5px}
.span .sn{font-weight:600;color:var(--text)}
.span .sa{font-size:11px;color:var(--dim);margin-top:3px;white-space:pre-wrap}
.span.root{border-left:3px solid var(--gold)}
.span.turn{border-left:3px solid var(--rose)}
.span.gen{border-left:3px solid var(--grn)}
.indent1{margin-left:34px}
.indent2{margin-left:68px}
.tid{color:var(--teal)}
.callout{border:1px solid var(--border);border-left:3px solid var(--rose);border-radius:8px;background:var(--rose-d);padding:12px 14px;font-size:12.5px;color:var(--text);margin-top:16px}
.callout b{color:var(--rose)}
.gapwrap{display:flex;flex-direction:column;gap:8px;margin-top:8px}
.gap{font-size:12.5px;color:var(--dim);border:1px solid var(--border);border-left:3px solid var(--gold);border-radius:8px;padding:10px 12px;background:var(--surface)}
.footnote{margin-top:40px;color:var(--faint);font-size:11.5px;border-top:1px solid var(--border);padding-top:14px}
</style>
</head>
<body>
<div class="wrap">
<header>
  <h1><span class="x">ax2</span> — how the whole machine works, end to end</h1>
  <p class="sub">One keypress → <b>opentui</b> React reconciler → <b>Effect atom</b> set → fork on the tracing runtime → <b>ax.forward</b> hits Kimi on Cloudflare → <b>Effect spans</b> become real <b>OTel</b> spans → flushed per-span over OTLP → <b>motel</b> ingests to SQLite and paints the trace waterfall. Five tabs = five depths. Click any node for exact <span class="mono">file:line</span> + verbatim code + its own state machine.</p>
  <div class="legend">
    <span><i class="dot" style="background:var(--teal)"></i>terminal ui (opentui)</span>
    <span><i class="dot" style="background:var(--gold)"></i>effect state (atoms)</span>
    <span><i class="dot" style="background:var(--rose)"></i>agent + trace</span>
    <span><i class="dot" style="background:var(--grn)"></i>motel viewer</span>
  </div>
</header>

<nav class="tabs" id="tabs">
  <button class="tab on" data-l="flow"><span class="n">01</span>End-to-end flow</button>
  <button class="tab" data-l="depth"><span class="n">02</span>Black-box depths</button>
  <button class="tab" data-l="sm"><span class="n">03</span>State machines</button>
  <button class="tab" data-l="trace"><span class="n">04</span>The trace tree</button>
  <button class="tab" data-l="code"><span class="n">05</span>Components &amp; code</button>
</nav>

<section class="lens on" data-l="flow">
  <p class="panel-intro">The <b>spine</b> of the system: 11 stages, top to bottom. Solid boxes = components (click to open). Gold dots between them = the <b>load-bearing handoffs</b> the critic identified (click to expand the exact trigger + mechanism). Stage 0 (paint loop) sits at the bottom because both the chat UI and motel's TUI re-enter it.</p>
  <div class="playbar">
    <button class="btn" id="play">▶ animate a turn</button>
    <span style="font-size:12px;color:var(--dim)">watch a token travel keypress → Cloudflare → motel</span>
  </div>
  <div class="pipe" id="pipe"></div>
</section>

<section class="lens" data-l="depth">
  <p class="panel-intro">Same system, four nested zoom levels. <b>L0</b>: the whole thing as one box. <b>L1</b>: four subsystems. <b>L2</b>: the 11 real components (click to drill). <b>L3</b>: the exact source files that hold each piece.</p>
  <div class="depthwrap" id="depthwrap"></div>
</section>

<section class="lens" data-l="sm">
  <p class="panel-intro">Every box is itself a <b>state machine</b>. Each card renders the real transitions extracted from source. Click a header to expand its diagram + the component's one-liner.</p>
  <div class="smgrid" id="smgrid"></div>
</section>

<section class="lens" data-l="trace">
  <p class="panel-intro">Why a whole chat session shows up as <b>one trace</b> in motel — the span nesting and the trick that joins independent turn fibers under a single <span class="mono">traceId</span>.</p>
  <div class="tracewrap" id="tracewrap"></div>
</section>

<section class="lens" data-l="code">
  <p class="panel-intro">All 11 components. Click one for the full drawer: internal mechanism, exact <span class="mono">file:line</span> sources, verbatim excerpts, what it feeds into, and its state-machine diagram.</p>
  <div class="cards" id="cards"></div>
  <div class="sect" style="margin-top:30px">
    <div class="lab">Unverified hops / black boxes (critic)</div>
    <div class="gapwrap" id="gaps"></div>
  </div>
</section>

<div class="footnote">Generated from a deep-read of <span class="mono">../effect-smol</span>, <span class="mono">../opentui</span>, <span class="mono">../motel</span>, and <span class="mono">@ax-llm/ax</span>. Line numbers are from those sources at read time. Static, self-contained, offline.</div>
</div>

<div class="drawer-bg" id="dbg"></div>
<aside class="drawer" id="drawer">
  <div class="dhead">
    <button class="close" id="dclose">×</button>
    <div class="dstage" id="dstage"></div>
    <h2 id="dtitle"></h2>
    <div class="one" id="done"></div>
  </div>
  <div class="dbody" id="dbody"></div>
</aside>

<script src="https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js"></script>
<script id="DATA" type="application/json">__DATA__</script>
<script>
const D = JSON.parse(document.getElementById('DATA').textContent);
const GC = {ui:'var(--g-ui)',effect:'var(--g-effect)',agent:'var(--g-agent)',motel:'var(--g-motel)'};
const GCHEX = {ui:'#34d2c4',effect:'#e0a73a',agent:'#e0607a',motel:'#5bd08a'};
const byId = {}; D.components.forEach(c=>byId[c.id]=c);
const el=(t,c,h)=>{const e=document.createElement(t);if(c)e.className=c;if(h!=null)e.innerHTML=h;return e};

mermaid.initialize({startOnLoad:false,theme:'base',securityLevel:'loose',flowchart:{curve:'basis',padding:8},
  themeVariables:{background:'#131c28',primaryColor:'#18232f',primaryTextColor:'#dfe8f2',primaryBorderColor:'#3a5266',
    lineColor:'#6f8aa3',fontSize:'13px',fontFamily:'IBM Plex Mono'}});

let mid=0;
function smDef(sm,hex){
  if(!sm||!sm.states) return null;
  const idx=new Map(); sm.states.forEach((s,i)=>idx.set(s,'s'+i));
  const lab=s=>'"'+String(s).replace(/"/g,"'").replace(/[\[\]{}]/g,'').slice(0,46)+'"';
  let L='flowchart TD\n';
  sm.states.forEach((s,i)=>{L+='  s'+i+'('+lab(s)+')\n';});
  sm.transitions.forEach(t=>{
    const a=idx.get(t.from), b=idx.get(t.to);
    if(a==null||b==null) return;
    const on='"'+String(t.on||'').replace(/"/g,"'").replace(/[\[\]{}()<>]/g,'').slice(0,40)+'"';
    L+='  '+a+' -->|'+on+'| '+b+'\n';
  });
  L+='  classDef d fill:#18232f,stroke:'+hex+',color:#dfe8f2;\n';
  L+='  class '+sm.states.map((s,i)=>'s'+i).join(',')+' d;\n';
  return L;
}
async function renderMermaid(container,def){
  if(!def){container.innerHTML='<div style="color:var(--dim);font-size:12px">no state machine — pure transform</div>';return;}
  const id='m'+(mid++);
  try{const {svg}=await mermaid.render(id,def);container.innerHTML=svg;}
  catch(e){container.innerHTML='<pre style="color:var(--dim);font-size:11px;white-space:pre-wrap">'+def+'</pre>';}
}

/* ---------- drawer ---------- */
const drawer=document.getElementById('drawer'),dbg=document.getElementById('dbg');
function openComp(id){
  const c=byId[id]; if(!c) return;
  const hex=GCHEX[D.meta[id].group];
  drawer.style.setProperty('--gc',hex);
  document.getElementById('dstage').textContent=D.meta[id].stage+'  ·  '+D.groups[D.meta[id].group].name;
  document.getElementById('dstage').style.color=hex;
  document.getElementById('dtitle').textContent=c.component;
  document.getElementById('done').textContent=c.oneLiner||'';
  const b=document.getElementById('dbody'); b.innerHTML='';
  // mechanism
  let s=el('div','sect'); s.style.setProperty('--gc',hex);
  s.appendChild(el('div','lab','How it actually works'));
  const m=el('div','mech'); m.innerHTML=(c.mechanism||'').replace(/\`([^\`]+)\`/g,'<code>$1</code>'); s.appendChild(m); b.appendChild(s);
  // state machine
  if(c.stateMachine){
    let sm=el('div','sect'); sm.style.setProperty('--gc',hex);
    sm.appendChild(el('div','lab','State machine'));
    const box=el('div','mermaid-box'); sm.appendChild(box); b.appendChild(sm);
    renderMermaid(box,smDef(c.stateMachine,hex));
  }
  // excerpts
  if(c.codeExcerpts&&c.codeExcerpts.length){
    let s2=el('div','sect'); s2.style.setProperty('--gc',hex);
    s2.appendChild(el('div','lab','Verbatim code — the load-bearing lines'));
    c.codeExcerpts.forEach(x=>{
      const e=el('div','excerpt');
      const hd=el('div','xh'); hd.innerHTML='<span class="xp">'+esc(x.path)+'</span><span class="xl">L'+esc(x.lines)+'</span>'; e.appendChild(hd);
      const pre=el('pre'); pre.textContent=x.code; e.appendChild(pre);
      if(x.note){const n=el('div','xn'); n.textContent=x.note; e.appendChild(n);}
      s2.appendChild(e);
    });
    b.appendChild(s2);
  }
  // sources
  if(c.sources&&c.sources.length){
    let s3=el('div','sect'); s3.style.setProperty('--gc',hex);
    s3.appendChild(el('div','lab','All source spans that matter'));
    const sw=el('div','srcs');
    c.sources.forEach(x=>{const e=el('div','src');
      e.innerHTML='<span class="p">'+esc(x.path)+'</span> <span class="l">:'+esc(x.lines)+'</span><span class="r">'+esc(x.role)+'</span>'; sw.appendChild(e);});
    s3.appendChild(sw); b.appendChild(s3);
  }
  // feeds into
  if(c.feedsInto){
    let s4=el('div','sect'); s4.style.setProperty('--gc',hex);
    s4.appendChild(el('div','lab','Hands off to the next stage'));
    s4.appendChild(el('div','feeds',esc(c.feedsInto))); b.appendChild(s4);
  }
  drawer.classList.add('on'); dbg.classList.add('on');
}
function closeDrawer(){drawer.classList.remove('on');dbg.classList.remove('on');}
document.getElementById('dclose').onclick=closeDrawer; dbg.onclick=closeDrawer;
document.addEventListener('keydown',e=>{if(e.key==='Escape')closeDrawer();});
function esc(s){return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}

/* ---------- tabs ---------- */
document.querySelectorAll('.tab').forEach(t=>t.onclick=()=>{
  document.querySelectorAll('.tab').forEach(x=>x.classList.remove('on'));
  document.querySelectorAll('.lens').forEach(x=>x.classList.remove('on'));
  t.classList.add('on');
  document.querySelector('.lens[data-l="'+t.dataset.l+'"]').classList.add('on');
});

/* ---------- lens 1: pipeline ---------- */
const pipe=document.getElementById('pipe');
D.order.forEach((id,i)=>{
  const c=byId[id]; if(!c) return;
  const g=D.meta[id].group, hex=GCHEX[g];
  const hop=el('div','hop'); const node=el('div','node');
  const chip=el('button','chip'); chip.style.setProperty('--gc',hex); chip.dataset.id=id;
  chip.innerHTML='<div class="stg">'+esc(D.meta[id].stage)+'</div><div class="ttl">'+esc(D.meta[id].short)+'</div><div class="grp">'+esc(D.groups[g].name)+'</div>';
  chip.onclick=()=>openComp(id);
  node.appendChild(chip); hop.appendChild(node);
  // handoff slot (match by order position)
  const ho=D.handoffs[i];
  const side=el('div','');
  if(ho){
    const e=el('div','edge');
    e.innerHTML='<div class="h">⇣ '+esc(ho.name)+'</div><div class="m">'+esc(ho.mechanism)+'<br><span style="color:var(--teal);font-size:10.5px">'+esc(ho.fromRef)+'</span> → <span style="color:var(--gold);font-size:10.5px">'+esc(ho.toRef)+'</span></div>';
    e.querySelector('.h').onclick=()=>e.classList.toggle('open');
    side.appendChild(e);
  } else { side.appendChild(el('div','spine-pad')); }
  hop.appendChild(side);
  pipe.appendChild(hop);
});

/* token animation */
document.getElementById('play').onclick=()=>{
  const chips=[...pipe.querySelectorAll('.chip')];
  chips.forEach(c=>c.classList.remove('flash'));
  let i=0;const step=()=>{if(i>0)chips[i-1].classList.remove('flash');if(i<chips.length){chips[i].classList.add('flash');chips[i].scrollIntoView({block:'center',behavior:'smooth'});i++;setTimeout(step,520);}};
  step();
};

/* ---------- lens 2: depths ---------- */
const dw=document.getElementById('depthwrap');
// L0
let d0=el('div','depth');
d0.innerHTML='<h3><span class="lv">L0</span> The whole thing, one box</h3><p class="cap">What a user sees.</p>'+
  '<div class="l0box"><span class="big">you type</span><span class="arr">→</span> ax2 chat agent <span class="arr">→</span> <span class="big">Kimi replies</span><br><span style="color:var(--dim);font-size:13px">…and every turn shows up as a live trace in motel</span></div>';
dw.appendChild(d0);
// L1
let d1=el('div','depth'); d1.innerHTML='<h3><span class="lv">L1</span> Four subsystems</h3><p class="cap">The black box cracks into four. Click a module to drill straight to its code.</p>';
const fg=el('div','fourgrid');
['ui','effect','agent','motel'].forEach(g=>{
  const box=el('div','gbox'); box.style.setProperty('--gc',GCHEX[g]);
  let mods=D.order.filter(id=>D.meta[id].group===g);
  box.innerHTML='<div class="gname">'+esc(D.groups[g].name)+'</div><div class="gblurb">'+esc(D.groups[g].blurb)+'</div>';
  const mb=el('div','gmods');
  mods.forEach(id=>{const bt=el('button',null,esc(D.meta[id].short));bt.onclick=()=>openComp(id);mb.appendChild(bt);});
  box.appendChild(mb); fg.appendChild(box);
});
d1.appendChild(fg); dw.appendChild(d1);
// L2
let d2=el('div','depth'); d2.innerHTML='<h3><span class="lv">L2</span> The 11 components</h3><p class="cap">Each real module in execution order. Click to open the drawer.</p>';
const cw=el('div','cards');
D.order.forEach(id=>{const c=byId[id];if(!c)return;const card=el('div','card');card.style.setProperty('--gc',GCHEX[D.meta[id].group]);
  card.innerHTML='<div class="badge">'+esc(D.meta[id].stage)+'</div><div class="ct">'+esc(c.component)+'</div><div class="co">'+esc((c.oneLiner||'').slice(0,150))+'…</div>';
  card.onclick=()=>openComp(id);cw.appendChild(card);});
d2.appendChild(cw); dw.appendChild(d2);
// L3
let d3=el('div','depth'); d3.innerHTML='<h3><span class="lv">L3</span> Down to the files</h3><p class="cap">The exact source each component lives in.</p>';
const tree=el('div','elevtree');
let th='';
D.order.forEach(id=>{const c=byId[id];if(!c)return;
  th+='<span style="color:'+GCHEX[D.meta[id].group]+'">▾ '+esc(c.component)+'</span>\n';
  (c.sources||[]).slice(0,3).forEach(s=>{th+='   <span class="f">'+esc(s.path)+'</span><span class="ln">:'+esc(s.lines)+'</span>\n';});
});
tree.innerHTML=th; d3.appendChild(tree); dw.appendChild(d3);

/* ---------- lens 3: state machines ---------- */
const smg=document.getElementById('smgrid');
D.order.forEach(id=>{const c=byId[id];if(!c)return;const hex=GCHEX[D.meta[id].group];
  const card=el('div','smcard');card.style.setProperty('--gc',hex);
  const h=el('div','smh');h.innerHTML='<span class="chev">▶</span><span class="smt">'+esc(c.component)+'</span><span class="smg">'+(c.stateMachine?'state machine':'transform')+'</span>';
  const body=el('div','smbody');const o=el('div','smo');o.textContent=c.oneLiner||'';body.appendChild(o);
  const box=el('div','mermaid-box');body.appendChild(box);
  let rendered=false;
  h.onclick=()=>{card.classList.toggle('open');if(card.classList.contains('open')&&!rendered){rendered=true;renderMermaid(box,smDef(c.stateMachine,hex));}};
  card.appendChild(h);card.appendChild(body);smg.appendChild(card);
});

/* ---------- lens 4: trace tree ---------- */
const tw=document.getElementById('tracewrap');
tw.innerHTML=
'<div class="span root"><div class="sk">root span · kind=server</div><div class="sn">chat.session</div>'+
'<div class="sa">traceId <span class="tid">a1b2…(new 32-hex)</span> · spanId 0001 · session.id=s1\nopened+closed briefly in newSessionAtom, then kept as a Tracer.externalSpan handle</div></div>'+
'<div class="span turn indent1"><div class="sk">child · kind=client · Effect.fn</div><div class="sn">chat.turn  <span style="color:var(--dim)">(turn #1)</span></div>'+
'<div class="sa">traceId <span class="tid">a1b2…(inherited)</span> · spanId 0002 · parent=0001\ngen_ai.operation.name=chat · gen_ai.request.model=@cf/moonshotai/kimi-k2.7-code</div></div>'+
'<div class="span gen indent2"><div class="sk">child · kind=server · @opentelemetry/api startSpan (inside ax)</div><div class="sn">AI Chat Request</div>'+
'<div class="sa">traceId <span class="tid">a1b2…(inherited)</span> · spanId 0003 · parent=0002\ngen_ai.usage.input_tokens / output_tokens · POST api.cloudflare.com/.../ai/v1/chat/completions</div></div>'+
'<div class="span turn indent1" style="margin-top:14px"><div class="sk">child · kind=client · Effect.fn</div><div class="sn">chat.turn  <span style="color:var(--dim)">(turn #2)</span></div>'+
'<div class="sa">traceId <span class="tid">a1b2…(SAME)</span> · spanId 0004 · parent=0001 — a SEPARATE fiber, same trace</div></div>'+
'<div class="span gen indent2"><div class="sk">child</div><div class="sn">AI Chat Request</div><div class="sa">traceId <span class="tid">a1b2…</span> · spanId 0005 · parent=0004</div></div>'+
'<div class="callout"><b>The trick.</b> Each turn runs on its own fiber, so they don\'t share a live span. <code style="color:var(--rose)">newSessionAtom</code> mints <code style="color:var(--rose)">chat.session</code> once and stores only its IDs as a lifecycle-less <code style="color:var(--rose)">Tracer.externalSpan</code> (atoms.ts:42-47). Every <code style="color:var(--rose)">chat.turn</code> is <code style="color:var(--rose)">Effect.fn("chat.turn",{parent})</code> — passing that ExternalSpan via span <i>options</i> (NOT withParentSpan, which would wipe the fn\'s own span). <code style="color:var(--rose)">NativeSpan</code> inherits <code style="color:var(--rose)">parent.traceId</code> and mints a fresh spanId — so independent turn fibers all join one traceId, and motel\'s <code style="color:var(--rose)">buildTrace</code> groups them by parent_span_id into the single waterfall above.</div>';

/* ---------- lens 5: cards + gaps ---------- */
const cards=document.getElementById('cards');
D.order.forEach(id=>{const c=byId[id];if(!c)return;const card=el('div','card');card.style.setProperty('--gc',GCHEX[D.meta[id].group]);
  card.innerHTML='<div class="badge">'+esc(D.meta[id].stage)+' · '+esc(D.groups[D.meta[id].group].name)+'</div><div class="ct">'+esc(c.component)+'</div><div class="co">'+esc((c.oneLiner||'').slice(0,170))+'…</div>';
  card.onclick=()=>openComp(id);cards.appendChild(card);});
const gw=document.getElementById('gaps');
D.gaps.forEach(g=>{gw.appendChild(el('div','gap',esc(g)));});
</script>
</body>
</html>`

// bun's String.raw escapes non-ASCII glyphs to literal \uXXXX; decode them back.
// (json is injected AFTER, so its own encoding is untouched.)
const decoded = html.replace(/\\u([0-9a-fA-F]{4})/g, (_m, h) => String.fromCharCode(parseInt(h, 16)))
writeFileSync(OUT, decoded.replace("__DATA__", json.replace(/<\/script>/g, "<\\/script>")))
console.log("wrote", OUT, "(" + (decoded.length / 1024).toFixed(0) + "kb)")
