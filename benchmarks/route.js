#!/usr/bin/env node
// auto-gear routing benchmark.
//
// Asks a model to pick a tier for each labeled task, with and without the
// auto-gear rubric in context, and scores it. Two numbers matter and they pull
// against each other:
//
//   accuracy  — how often the chosen tier matched the label
//   spend     — relative cost of the chosen routing vs routing everything top-tier
//
// A router that always answers "top" scores 33% accuracy at 100% spend; one
// that always answers "cheapest" is cheap and wrong on the tasks where being
// wrong is expensive. Report both or the number means nothing.
//
// No dependencies. Two backends:
//   --via api   Anthropic API directly. Needs ANTHROPIC_API_KEY. (default)
//   --via cli   `claude -p`, using your existing Claude Code auth. No API key.
//               Runs each question in an empty temp cwd with skills disabled so
//               a stray CLAUDE.md or skill can't answer for the model. (`--bare`
//               would be cleaner but skips keychain reads, so it needs an API
//               key anyway — defeating the point.) Session hooks from installed
//               plugins DO still fire; see benchmarks/README.md.
//
//   node benchmarks/route.js --via cli --model haiku --repeat 3

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const TIERS = ['cheapest', 'mid', 'top'];
// Relative price weights from published output-token pricing, cheapest = 1:
// Haiku 4.5 $5/Mtok, Sonnet 5 $15, Opus 5 $25 → 1 / 3 / 5.
// Only the ratios matter. Re-check against the `claude-api` skill when pricing
// drifts — a stale ratio here quietly misprices the whole spend column.
const WEIGHT = { cheapest: 1, mid: 3, top: 5 };

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? fallback : argv[i + 1];
};

const VIA = arg('via', 'api');
const MODEL = arg('model', VIA === 'cli' ? 'haiku' : 'claude-sonnet-5');
const REPEAT = Number(arg('repeat', 3));
// A whole Claude Code process per question; too many at once just thrashes.
const CONCURRENCY = Number(arg('concurrency', 6));
const TASKS = JSON.parse(fs.readFileSync(path.join(__dirname, 'tasks.json'), 'utf8'));

const RUBRIC = fs.readFileSync(path.join(__dirname, '..', 'skills', 'auto-gear', 'SKILL.md'), 'utf8')
  .split('## Routing')[1].split('## Clamping')[0];

const ARMS = {
  baseline: t =>
    `You are about to delegate this task to a subagent. Which model tier should it run on: cheapest, mid, or top? Answer with one word.\n\nTask: ${t}`,
  'auto-gear': t =>
    `${RUBRIC}\n\nApply the rubric above. Which tier should this task be dispatched on: cheapest, mid, or top? Answer with one word.\n\nTask: ${t}`,
};

const CLEAN_CWD = fs.mkdtempSync(path.join(require('os').tmpdir(), 'auto-gear-bench-'));

function askCli(prompt) {
  return new Promise((resolve, reject) => {
    execFile('claude', ['-p', prompt, '--model', MODEL, '--disable-slash-commands', '--output-format', 'json'], {
      timeout: 180000,
      cwd: CLEAN_CWD,
      // ponytail's session hook injects a "be lazy" persona that would tilt tier
      // choice downward in both arms. Off, so we measure the rubric, not it.
      env: { ...process.env, PONYTAIL_DEFAULT_MODE: 'off' },
      stdio: ['ignore', 'pipe', 'pipe'],
    }, (err, stdout) => {
      if (err && !stdout) return reject(err);
      resolve(stdout);
    });
  });
}

async function askApi(prompt) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({ model: MODEL, max_tokens: 16, messages: [{ role: 'user', content: prompt }] }),
  });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  const body = await res.json();
  return (body.content?.[0]?.text || '');
}

// Per-call cost and latency, appended by ask(). The CLI reports both directly;
// the API arm only gets latency (token pricing varies by model, and this
// benchmark is about routing, not about pricing the classifier).
const meter = { costUSD: [], ms: [] };

async function ask(prompt) {
  const started = process.hrtime.bigint();
  let raw = VIA === 'cli' ? await askCli(prompt) : await askApi(prompt);
  const wallMs = Number(process.hrtime.bigint() - started) / 1e6;

  if (VIA === 'cli') {
    try {
      const j = JSON.parse(raw);
      // `result` is the answer text; the rest is the harness's own accounting.
      raw = j.result ?? '';
      if (typeof j.total_cost_usd === 'number') meter.costUSD.push(j.total_cost_usd);
      meter.ms.push(typeof j.duration_api_ms === 'number' ? j.duration_api_ms : wallMs);
    } catch (e) {
      meter.ms.push(wallMs); // Non-JSON output still counts as a (failed) call.
    }
  } else {
    meter.ms.push(wallMs);
  }

  const text = String(raw).toLowerCase();
  // Take the LAST tier word mentioned, not the first: the question itself lists
  // "cheapest, mid, or top", and a chatty answer that echoes the question would
  // otherwise always score as "cheapest".
  let answer = 'unparseable';
  for (const t of TIERS) {
    const i = text.lastIndexOf(t);
    if (i !== -1 && (answer === 'unparseable' || i > text.lastIndexOf(answer))) answer = t;
  }
  // An unparseable answer is a routing failure, not a missing data point —
  // count it, don't drop it, or the arm that rambles scores artificially well.
  return answer;
}

// Bounded fan-out; Promise.all over 18 Claude Code processes is not kind to a laptop.
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  }));
  return out;
}

function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
}

(async () => {
  if (VIA === 'api' && !process.env.ANTHROPIC_API_KEY) {
    console.error('Set ANTHROPIC_API_KEY, or use --via cli to go through the claude CLI.');
    process.exit(1);
  }

  const allTop = TASKS.length * WEIGHT.top;
  const rows = [];

  for (const [arm, build] of Object.entries(ARMS)) {
    meter.costUSD.length = 0;
    meter.ms.length = 0;
    const accuracies = [];
    const spends = [];
    const confusion = {};
    // The two asymmetric failures. Under-routing a top task is the expensive
    // one: you pay for a weak answer AND for redoing it. Over-routing a cheap
    // task just wastes money. Cheap-and-wrong must not read as a win.
    let under = 0;
    let over = 0;

    for (let run = 0; run < REPEAT; run++) {
      const answers = await mapLimit(TASKS, CONCURRENCY, t => ask(build(t.task)));
      let hits = 0;
      let spend = 0;
      answers.forEach((got, i) => {
        const want = TASKS[i].tier;
        if (got === want) hits++;
        else confusion[`${want}→${got}`] = (confusion[`${want}→${got}`] || 0) + 1;
        const gi = TIERS.indexOf(got);
        if (want === 'top' && gi !== -1 && gi < 2) under++;
        if (want === 'cheapest' && got === 'top') over++;
        spend += WEIGHT[got] ?? WEIGHT.top;
      });
      accuracies.push(hits / TASKS.length);
      spends.push(spend / allTop);
      process.stderr.write(`${arm} run ${run + 1}/${REPEAT}: ${(hits / TASKS.length * 100).toFixed(0)}% acc\n`);
    }

    const topRuns = TASKS.filter(t => t.tier === 'top').length * REPEAT;
    const cheapRuns = TASKS.filter(t => t.tier === 'cheapest').length * REPEAT;
    rows.push({
      arm,
      acc: median(accuracies),
      spend: median(spends),
      under: under / topRuns,
      over: over / cheapRuns,
      // Cost of *making the routing decision*, per task. Distinct from `spend`,
      // which is the cost of the work the decision routes to.
      decideUSD: meter.costUSD.length ? meter.costUSD.reduce((a, b) => a + b, 0) / meter.costUSD.length : null,
      decideMs: meter.ms.length ? median(meter.ms) : null,
      confusion,
    });
  }

  console.log(`\nvia: ${VIA}   model: ${MODEL}   tasks: ${TASKS.length}   runs: ${REPEAT}   (medians)\n`);
  console.log('arm         accuracy   spend vs all-top   under-routed top   over-routed cheap');
  for (const r of rows) {
    console.log(
      `${r.arm.padEnd(11)} ${(r.acc * 100).toFixed(0).padStart(6)}%   ${(r.spend * 100).toFixed(0).padStart(14)}%   ` +
      `${(r.under * 100).toFixed(0).padStart(15)}%   ${(r.over * 100).toFixed(0).padStart(16)}%`
    );
  }
  console.log('\ncost and speed of making the decision itself (per task):');
  console.log('arm         decision cost   decision latency (median)');
  for (const r of rows) {
    console.log(
      `${r.arm.padEnd(11)} ${(r.decideUSD === null ? 'n/a' : '$' + r.decideUSD.toFixed(4)).padStart(13)}   ` +
      `${(r.decideMs === null ? 'n/a' : (r.decideMs / 1000).toFixed(1) + 's').padStart(24)}`
    );
  }

  console.log('\nmisroutes (want→got, all runs):');
  for (const r of rows) console.log(`  ${r.arm}: ${JSON.stringify(r.confusion)}`);
})();
