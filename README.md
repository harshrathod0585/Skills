# auto-gear

**A lightweight, transparent model-routing proxy for Claude Code.**

`auto-gear` sits between Claude Code and `api.anthropic.com` as a local HTTP proxy. It looks at every outgoing request — including the main conversation itself, not just subagents — and rewrites the model and reasoning effort to match how complex the request actually looks, clamped to a ceiling you set. Simple turns run on Haiku, standard engineering work runs on Sonnet, and only genuinely hard requests reach Opus (or whatever ceiling you allow).

Nothing is injected into your prompts and there's no visible ceremony in the transcript — it works silently at the network layer. The only trace is a `[routed:tier(effort)]` tag on the first line of each response, so you can see what happened.

---

## Why

By default, every request in a Claude Code session runs on whatever model the session is pinned to — a one-line "what's 2+2" costs the same tier as a multi-file refactor. `auto-gear` makes that judgment call per-request instead, so cheap turns actually stay cheap.

---

## Install

`auto-gear` is a plugin skill + a small Node proxy — no build step, no dependencies beyond Node's standard library.

### Claude Code (plugin marketplace)

```
/plugin marketplace add harshrathod0585/auto-gear
```
```
/plugin install auto-gear@auto-gear
```
(send these as two separate prompts — the install has to see the marketplace already added)

Restart Claude Code, or run `/plugin` to reload, so the `auto-gear` and `auto-gear-set` skills and their slash commands are picked up. Confirm it loaded via `/plugin` (it should list `auto-gear` as installed).

### Manual (any host, or to run the proxy standalone)

```bash
git clone https://github.com/harshrathod0585/auto-gear ~/.claude/plugins/auto-gear
```

then reload plugins the same way as above.

Requires Node.js (any version with `node:http`/`node:https`, i.e. anything reasonably recent) — nothing else to `npm install`.

### Uninstall

```
/plugin remove auto-gear
```

---

## Quick Start

### 1. (Optional) Set a ceiling to control spend

With no policy file at all, the proxy runs **uncapped** by default — the classifier picks whatever tier a request actually needs, up to Opus, so a fresh install never silently downgrades a hard task you didn't ask to restrict. If you want to cap spend instead:

```
/auto-gear-set
```

Choose a model ceiling (e.g. `sonnet`) and per-tier effort caps. This writes `~/.claude/model-policy.json`, which the proxy re-reads on every request — no restart needed when you change it later.

The concrete model id behind each tier (`haiku` → `claude-haiku-4-5-...`, etc.) isn't hand-typed into that file. `/auto-gear-set` resolves it from Anthropic's live model catalog before writing (`node proxy.js latest-models`), and once the proxy is running it keeps doing this on its own — once at startup and once every 24 hours — writing any newer model id straight back into `~/.claude/model-policy.json`. A new Claude release shows up in your routing without you touching this repo or rerunning any command.

This needs `ANTHROPIC_API_KEY` in the environment. Without it (or if the network call fails), the refresh silently no-ops and keeps whatever's already in the policy file — a refresh failing is never allowed to be the reason routing stops working.

### 2. Start the proxy

```
/auto-gear start
```

or manually:

```bash
node proxy.js &
```

### 3. Point Claude Code at it

```bash
export ANTHROPIC_BASE_URL=http://127.0.0.1:8787
claude
```

That's it — routing is now live for this shell's Claude Code sessions. Unset `ANTHROPIC_BASE_URL` (or stop the proxy) to go back to talking to the real API directly.

---

## Routing Rubric

| Query Complexity | Model | Reasoning Effort | Response Tag | Example |
| :--- | :--- | :--- | :--- | :--- |
| **Simple** | Haiku | none (dropped) | `[routed:haiku]` | General questions, short chat, quick follow-ups |
| **Standard** | Sonnet | medium | `[routed:sonnet(medium)]` | Regular engineering tasks, single-file edits |
| **Heavy current turn** | Sonnet | high | `[routed:sonnet(high)]` | The turn itself carries tool results, images, or attachments |
| **High** | Opus (or ceiling) | high | `[routed:opus(high)]` | Long/complex prompts: architecture, security, migrations |

Classification looks only at the **current turn**, not the whole transcript — so a session that used a tool a few turns back doesn't get permanently stuck on the expensive tier once the conversation goes back to plain chat. Everything is then clamped to your configured `max_model` / `max_effort` ceiling regardless of what the classifier picked.

---

## Commands

Run these inside Claude Code:

| Command | Action |
| :--- | :--- |
| `/auto-gear start` | Starts `proxy.js` on port `8787` in the background |
| `/auto-gear status` | Shows live routing stats from the running proxy |
| `/auto-gear stop` | Stops the background proxy |
| `/auto-gear-set` | Interactively set the model ceiling and per-tier effort caps |

You can also hit the stats endpoint directly:

```bash
curl -s http://127.0.0.1:8787/stats
```

---

## Testing & Verification

Unit tests cover the parts that would silently break routing if regressed: the complexity classifier, the ceiling clamp, and the streaming response-header injector (including a request whose `"text"` field lands split across two network chunks — the kind of bug that only shows up under real traffic, not a single-shot test).

```bash
npm test
```

There's also a classifier eval — 100 labeled prompts with the tier/effort a correct classification should produce, run with `npm run eval`. It's the check that catches routing-*quality* drift (e.g. a keyword-list mismatch that quietly misclassified "plan a database migration" as trivial chat — this eval caught exactly that once, see `benchmarks/results/`), as opposed to `npm test`'s exact-behavior checks. See [`benchmarks/README.md`](benchmarks/README.md) for the methodology.

To sanity-check it end to end against the real proxy:

1. Start it (`/auto-gear start` or `node proxy.js &`).
2. Send a trivial message ("hi") and a clearly complex one (a multi-file refactor request) through a session pointed at `ANTHROPIC_BASE_URL=http://127.0.0.1:8787`.
3. Check the first line of each response — you should see `[routed:haiku]` on the trivial one and `[routed:opus(high)]` (or your ceiling) on the complex one.
4. `curl -s http://127.0.0.1:8787/stats` to see the running tally of what routed where, and how many requests the ceiling clamped.

`/stats` plus the response tag is your *live* check against real traffic; `npm run eval` is the *offline* check against a fixed, known-correct set, so a classifier change gets validated before it ever sees a real request. If you want to check one specific prompt's classification without spending an API call, `classifyQuery()` is exported from `proxy.js` and is a pure function over a message payload — call it directly from a Node REPL.

---

## Architecture Notes

- **Proxy, not hooks.** Earlier versions of this tool used `SessionStart`/`PreToolUse` hooks to advise and clamp subagent dispatches. That approach could only ever cheapen `Agent`-tool calls — the main conversation always ran on the session's pinned model, turn after turn, regardless of complexity. Routing at the HTTP layer instead means every request gets classified, including the very first prompt of a session.
- **Policy is hot-reloaded.** `~/.claude/model-policy.json` is read fresh on every request, so `/auto-gear-set` never requires restarting the proxy.
- **Fails open.** An unparseable request body, a missing policy file, or a malformed config are all forwarded/handled with defaults rather than blocking the request — a routing bug should never be the reason a message doesn't get through.

---

## How this compares to similar tools

Several tools do LLM request routing; the honest differences are in *where* they sit and *what* they need, not raw capability:

| Tool | Where it runs | Needs an account/service? | Scope |
| :--- | :--- | :--- | :--- |
| **auto-gear** | Local proxy on your machine | No — talks straight to `api.anthropic.com` with your existing key | Claude-only, Claude-Code-specific (main loop + subagents) |
| [LiteLLM Proxy](https://github.com/BerriAI/litellm) | Self-hosted proxy | No | Any provider, general-purpose routing/load-balancing — you write the routing rules |
| [RouteLLM](https://github.com/lm-sys/RouteLLM) | Library/self-hosted | No | Router *models* trained to predict strong-vs-weak-model quality gap; general-purpose, not Claude-Code-aware |
| [OpenRouter](https://openrouter.ai/) | Hosted service | Yes — separate account, traffic goes through their infra | Any provider, marketplace-style routing |
| [Martian](https://withmartian.com/) / [Not Diamond](https://www.notdiamond.ai/) | Hosted service | Yes | Any provider, ML-based routing-as-a-service |

`auto-gear` trades the more sophisticated routing models those tools use (some train a classifier on quality/cost tradeoffs; `auto-gear`'s classifier is a length + keyword heuristic, see `classifyQuery()` in `proxy.js`) for being local, dependency-free, and aware of Claude Code's specific shape — it's the only one of these that also intercepts your main conversation loop, not just tool/subagent calls, and the only one where "install" means cloning a repo rather than creating an account with a third party that proxies your traffic. If you want ML-grade routing quality across many providers, LiteLLM or RouteLLM are the more mature choice; if you specifically want a zero-dependency, no-third-party, main-loop-aware router for Claude Code, that's the gap this fills.

---

## License

MIT
