// T-236: contract tests against the REAL Anthropic API. Skipped unless AI_CONTRACT=1 (they cost money: one structured-output
// call and one web-search fetch, about $0.30-$1 together). Inputs are synthetic only (rule 10): a made-up company, made-up mail
// metadata on example.test, and generic public news topics. Nothing is stored and no lane data is read.
//   AI_CONTRACT=1 ANTHROPIC_API_KEY=... ANTHROPIC_MODEL_ANALYSIS=... ANTHROPIC_MODEL_FAST=... pnpm --filter @nichols/web test:ai-contract
// What it proves: the API accepts our request shapes (output_config.format with our JSON schema; web_search with our options),
// the reply finishes inside the configured output limit (stopReason end_turn, not max_tokens) and passes our own validation.
import { getLLMProvider } from "@nichols/ai/config";
import { laneConfigSchema } from "@nichols/core/lane-config";
import { describe, expect, it } from "vitest";
import { BRIEFING_OUTPUT_SCHEMA, parseBriefingOutput } from "./briefing-output";
import { newsConfigFrom } from "./news-domain";
import { runNewsFetch, type NewsFinish } from "./news-run";

const ON = process.env.AI_CONTRACT === "1";

describe.skipIf(!ON)("AI contract (real API, AI_CONTRACT=1)", () => {
  const p = getLLMProvider({ timeoutMs: 120_000, maxRetries: 0 });

  it("briefing: structured output with our schema completes inside briefing.max_tokens and parses", async () => {
    if (!p.configured) throw new Error(`AI not configured: ${p.missing.join(", ")}`);
    const maxTokens = laneConfigSchema.parse({}).briefing.max_tokens;
    const res = await p.provider.complete({
      laneId: "PKG" as never,
      tier: "analysis",
      system: "You write a short daily briefing for a synthetic test company. Use only the facts given. Refs are the ids in brackets.",
      messages: [
        {
          role: "user",
          content: [
            "Now: 2026-11-12T13:00:00Z.",
            "Mail items needing attention (metadata):",
            "[r1] from dana@acme.example.test, subject 'Contract renewal date', received 2 h ago, unread",
            "[r2] from lee@harbor.example.test, subject 'Teaming agreement redlines', received 1 day ago, waiting on you",
            "Calendar: 15:00 'Capture review' (3 attendees).",
            "Write the briefing JSON now.",
          ].join("\n"),
        },
      ],
      maxTokens,
      outputSchema: BRIEFING_OUTPUT_SCHEMA,
    });
    console.info("[contract] briefing", { stopReason: res.stopReason, outputTokens: res.usage.outputTokens, maxTokens });
    expect(res.stopReason).toBe("end_turn");
    const text = res.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
    const parsed = parseBriefingOutput(text);
    expect(parsed.ok ? [] : parsed.issues).toEqual([]);
  }, 150_000);

  it("news: a web-search fetch on synthetic topics finishes (no truncation) and yields at least one valid story", async () => {
    if (!p.configured) throw new Error(`AI not configured: ${p.missing.join(", ")}`);
    const cfg = newsConfigFrom({ news: { enabled: true, topics: ["FAR and DFARS changes", "GSA and SAM.gov updates", "federal IT acquisition"] } });
    const finished: NewsFinish[] = [];
    const r = await runNewsFetch(
      { provider: p.provider, begin: async () => "contract", finish: async (_id, f) => void finished.push(f), signal: AbortSignal.timeout(140_000) },
      { laneId: "PKG", laneName: "Example Contracting Co", cfg, now: new Date() },
    );
    console.info("[contract] news", { status: r.status, failureCode: r.failureCode, items: r.items, searches: finished[0]?.searches, estCostUsd: finished[0]?.estCostUsd });
    expect(r.failureCode).not.toBe("output_truncated");
    expect(r.failureCode).not.toBe("output_unusable");
    expect(r.status).not.toBe("failed");
  }, 180_000);
});
