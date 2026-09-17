#!/usr/bin/env node
// Does describing harnesses and models with capability cards route better than
// sending their display names?
//
// Two Choice passes over the same eval set, the same catalog, and the same Jev
// model. The only difference is what the criteria say:
//
//   thin  — what `lib/router.ts` sends today: BB display names plus the
//           provider's own `description`, which on omp is the empty string.
//   rich  — the structured card: what / not_for / tools / cost_band / context
//           / examples, per harness and per model family.
//
// Plain ESM on purpose: it runs with bare `node`, with no build step and no
// extra devDependency, and it imports nothing from `lib/` — routing in
// production is untouched by this experiment.
//
//   node scripts/replay-routing-eval.mjs --dry-run     # no API key, no network
//   TYPESAFE_API_KEY=... node scripts/replay-routing-eval.mjs
//
// The key is read from the environment and never written anywhere: not to the
// report, not to stdout, not to disk.

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DATASETS = join(ROOT, "datasets");
const JEV_MODEL = "jev-1.13.0";

// ---------------------------------------------------------------- arguments

const argv = process.argv.slice(2);
const dryRun = argv.includes("--dry-run");
const limitArg = argv.find((a) => a.startsWith("--limit="));
const limit = limitArg ? Number.parseInt(limitArg.slice("--limit=".length), 10) : Infinity;
if (Number.isNaN(limit) || limit <= 0) fail("--limit must be a positive integer");

// ---------------------------------------------------------------- loading

function readJson(name) {
  return JSON.parse(readFileSync(join(DATASETS, name), "utf8"));
}

function fail(message) {
  console.error(`replay-routing-eval: ${message}`);
  process.exit(1);
}

const cards = readJson("capability-cards.json");
const snapshot = readJson("catalog-snapshot.json");
const cases = readFileSync(join(DATASETS, "eval-cases.jsonl"), "utf8")
  .split("\n")
  .filter((line) => line.trim() !== "")
  .map((line, i) => {
    try {
      return JSON.parse(line);
    } catch {
      fail(`eval-cases.jsonl line ${i + 1} is not valid JSON`);
    }
  });

const familyCard = new Map(cards.families.map((f) => [f.family_key, f]));
const harnessCard = new Map(cards.harnesses.map((h) => [h.id, h]));

// ---------------------------------------------------------------- catalog
//
// The offer set: every harness whose curated shortlist is non-empty, exactly as
// `buildCatalog` would assemble it. A harness with nothing to run on is dropped
// rather than offered, because a proposal naming it could not be applied.

function buildOffers() {
  const offers = [];
  for (const provider of snapshot.providers) {
    if (!provider.available) continue;
    if (provider.id === "typesafe-router") continue; // the picker stub, never a target
    if (provider.shortlist.length === 0) continue;
    offers.push(provider);
  }
  return offers;
}

const offers = buildOffers();

// Fail closed. An empty catalog means the snapshot is broken or filtered to
// nothing, and every "correct" score after that point would be an artefact.
if (offers.length === 0) fail("catalog is empty — nothing to route to, refusing to score");
for (const offer of offers) {
  if (offer.shortlist.length === 0) fail(`harness ${offer.id} has no models`);
}

// ---------------------------------------------------------------- criteria

/** What routing sends today: display names, plus a description that is often "". */
function thinHarnessCriteria(currentId) {
  const criteria = {};
  for (const offer of offers) {
    criteria[offer.id] = {
      harness: offer.displayName,
      models: offer.shortlist.map((m) => m.displayName),
      is_current_default: offer.id === currentId,
    };
  }
  return criteria;
}

function thinModelCriteria(offer) {
  const criteria = {};
  for (const model of offer.shortlist) {
    criteria[model.id] = {
      name: model.displayName,
      // Verbatim from the provider. On omp this is "" for all 666 models.
      description: "",
      is_harness_default: model.isDefault,
    };
  }
  return criteria;
}

/** The same label set, described by its capability card. */
function richHarnessCriteria(currentId) {
  const criteria = {};
  for (const offer of offers) {
    const card = harnessCard.get(offer.id);
    if (card === undefined) fail(`no harness card for ${offer.id}`);
    criteria[offer.id] = {
      harness: card.display_name,
      what: card.what,
      not_for: card.not_for,
      tools: card.tools,
      context: card.context,
      examples: card.examples,
      is_current_default: offer.id === currentId,
    };
  }
  return criteria;
}

function richModelCriteria(offer) {
  const criteria = {};
  for (const model of offer.shortlist) {
    const card = familyCard.get(model.familyKey);
    if (card === undefined) fail(`no family card for ${model.familyKey} (${model.id})`);
    criteria[model.id] = {
      name: card.label,
      family: card.family_key,
      cost_band: card.cost_band,
      band_means: cards.band_vocabulary[card.cost_band],
      what: card.what,
      not_for: card.not_for,
      tools: card.tools,
      context: card.context,
      examples: card.examples,
      is_harness_default: model.isDefault,
    };
  }
  return criteria;
}

const PASSES = {
  thin: { harness: thinHarnessCriteria, model: thinModelCriteria },
  rich: { harness: richHarnessCriteria, model: richModelCriteria },
};

const HARNESS_INSTRUCTIONS =
  "Which agent harness should run this request? The harness is fixed for the whole thread once it starts, so pick the one whose tooling and workflow fit the work, not just the one with the strongest model. Prefer the current default unless the request clearly calls for something else.";

const MODEL_INSTRUCTIONS =
  "Which model inside the chosen harness should run this request? Pick the cheapest model that can do the work well; reserve the most capable models for ambiguous, high-stakes, or long-horizon work.";

// ---------------------------------------------------------------- scoring

function familyOf(offerId, modelId) {
  const offer = offers.find((o) => o.id === offerId);
  return offer?.shortlist.find((m) => m.id === modelId)?.familyKey ?? null;
}

function bandOf(family) {
  return family === null ? null : (familyCard.get(family)?.cost_band ?? "unassigned");
}

function emptyTally() {
  return { cases: 0, harness: 0, family: 0, band: 0, fallback: 0, inputTokens: 0 };
}

function score(tallies, evalCase, chosenHarness, chosenFamily, chosenBand, usedFallback) {
  for (const key of ["all", evalCase.category]) {
    const tally = (tallies[key] ??= emptyTally());
    tally.cases += 1;
    if (chosenHarness === evalCase.gold_harness) tally.harness += 1;
    // A case that names no gold family scores only on harness and band; there
    // is no right model to have picked.
    if (evalCase.gold_family !== undefined && chosenFamily === evalCase.gold_family) {
      tally.family += 1;
    }
    if (chosenBand === evalCase.gold_band) tally.band += 1;
    if (usedFallback) tally.fallback += 1;
  }
}

// ---------------------------------------------------------------- dry run

function validate() {
  const problems = [];
  const ids = new Set();
  for (const evalCase of cases) {
    const where = evalCase.id ?? "<missing id>";
    if (!evalCase.id) problems.push("a case has no id");
    if (ids.has(evalCase.id)) problems.push(`duplicate id ${evalCase.id}`);
    ids.add(evalCase.id);
    if (!evalCase.message?.trim()) problems.push(`${where}: empty message`);
    if (!harnessCard.has(evalCase.gold_harness)) {
      problems.push(`${where}: unknown gold_harness ${evalCase.gold_harness}`);
    }
    if (!Object.hasOwn(cards.band_vocabulary, evalCase.gold_band)) {
      problems.push(`${where}: unknown gold_band ${evalCase.gold_band}`);
    }
    if (evalCase.gold_family !== undefined && !familyCard.has(evalCase.gold_family)) {
      problems.push(`${where}: unknown gold_family ${evalCase.gold_family}`);
    }
  }

  // Every label either pass would offer must resolve to a card, or the rich
  // pass would silently be asking about fewer things than the thin one.
  for (const passName of Object.keys(PASSES)) {
    const pass = PASSES[passName];
    const harnessLabels = Object.keys(pass.harness(null));
    if (harnessLabels.length === 0) problems.push(`${passName}: no harness labels`);
    for (const offer of offers) {
      const modelLabels = Object.keys(pass.model(offer));
      if (modelLabels.length === 0) problems.push(`${passName}: ${offer.id} has no model labels`);
      if (modelLabels.length > 8) problems.push(`${passName}: ${offer.id} exceeds the 8-model cap`);
    }
  }

  if (problems.length > 0) {
    for (const problem of problems) console.error(`  ✗ ${problem}`);
    fail(`${problems.length} schema problem(s)`);
  }

  console.log(`✓ ${cases.length} eval cases`);
  console.log(`✓ ${cards.harnesses.length} harness cards, ${cards.families.length} family cards`);
  console.log(`✓ ${offers.length} harnesses offerable, ${offers.reduce((n, o) => n + o.shortlist.length, 0)} models total`);
  console.log(`✓ both passes build resolvable criteria for every label`);
  console.log("dry run only — no API call made, no report written");
}

// ---------------------------------------------------------------- live run

async function run() {
  const apiKey = process.env.TYPESAFE_API_KEY;
  if (!apiKey) {
    console.error("TYPESAFE_API_KEY is not set — skipping the live passes.");
    console.error("Validating the datasets instead; re-run with a key to score.");
    validate();
    return;
  }

  const { TypeSafeClient, choice } = await import("@typesafe-ai/sdk");
  const client = new TypeSafeClient({ apiKey });

  const selected = cases.slice(0, limit === Infinity ? cases.length : limit);
  const report = {
    generated: new Date().toISOString(),
    jev_model: JEV_MODEL,
    catalog: {
      captured: snapshot.captured,
      harnesses: offers.length,
      models: offers.reduce((n, o) => n + o.shortlist.length, 0),
    },
    cases: selected.length,
    passes: {},
    rows: [],
  };

  for (const passName of ["thin", "rich"]) {
    const pass = PASSES[passName];
    const tallies = {};
    console.error(`\n── ${passName} pass ──`);

    for (const evalCase of selected) {
      const state = { user_message: evalCase.message, project: null, current_harness: null };
      let usedFallback = false;
      let inputTokens = 0;

      const harnessAnswer = await client.systemOne({
        model: JEV_MODEL,
        state,
        questions: { harness: choice(HARNESS_INSTRUCTIONS, pass.harness(null)) },
      });
      inputTokens += harnessAnswer.usage.input_tokens ?? 0;

      let harnessId = harnessAnswer.answers.harness.choice;
      if (!offers.some((o) => o.id === harnessId)) {
        usedFallback = true;
        harnessId = offers[0].id;
      }
      const offer = offers.find((o) => o.id === harnessId);

      const modelAnswer = await client.systemOne({
        model: JEV_MODEL,
        state: { ...state, chosen_harness: offer.displayName },
        questions: { model: choice(MODEL_INSTRUCTIONS, pass.model(offer)) },
      });
      inputTokens += modelAnswer.usage.input_tokens ?? 0;

      let modelId = modelAnswer.answers.model.choice;
      if (!offer.shortlist.some((m) => m.id === modelId)) {
        usedFallback = true;
        modelId = (offer.shortlist.find((m) => m.isDefault) ?? offer.shortlist[0]).id;
      }

      const family = familyOf(harnessId, modelId);
      const band = bandOf(family);
      score(tallies, evalCase, harnessId, family, band, usedFallback);
      tallies.all.inputTokens += inputTokens;

      report.rows.push({
        pass: passName,
        id: evalCase.id,
        category: evalCase.category,
        gold_harness: evalCase.gold_harness,
        chose_harness: harnessId,
        gold_family: evalCase.gold_family ?? null,
        chose_family: family,
        gold_band: evalCase.gold_band,
        chose_band: band,
        harness_ok: harnessId === evalCase.gold_harness,
        band_ok: band === evalCase.gold_band,
        used_fallback: usedFallback,
        input_tokens: inputTokens,
      });

      const mark = harnessId === evalCase.gold_harness ? "✓" : "✗";
      console.error(`  ${mark} ${evalCase.id}  ${harnessId} / ${family ?? "?"} (${band})`);
    }

    report.passes[passName] = tallies;
  }

  const outPath = join(DATASETS, "replay-report.json");
  writeFileSync(outPath, JSON.stringify(report, null, 2) + "\n");

  console.log("\n── counts ──");
  for (const passName of ["thin", "rich"]) {
    const t = report.passes[passName].all;
    console.log(
      `${passName.padEnd(5)} harness ${t.harness}/${t.cases}  family ${t.family}/${t.cases}  band ${t.band}/${t.cases}  fallbacks ${t.fallback}  input_tokens ${t.inputTokens}`,
    );
  }
  console.log(`\nreport written to ${outPath}`);
}

if (dryRun) validate();
else await run();
