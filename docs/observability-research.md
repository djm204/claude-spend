# Claude-Spend Observability Deep Dive — Research & Implementation Plan

## Context

claude-spend currently tracks token counts across sessions, models, projects, and prompts. It generates 10 types of cost-optimization insights and renders a vanilla JS dashboard with charts and drilldowns. However, it has **no dollar-cost calculation**, **no per-conversation deep observability**, and **no actionable cost-reduction guidance tied to real numbers**. This plan adds all three.

---

## Part 1: Research Findings

### 1.1 What Data Claude Code Stores Locally

All data lives under `~/.claude/`. No API keys needed.

| Source | Path | Contents |
|--------|------|----------|
| **Session logs** | `projects/{project}/{sessionId}.jsonl` | Full message logs: role, content, model, token usage (input, output, cache_creation, cache_read), tool calls, timestamps, git branch |
| **Subagent logs** | `projects/{project}/{sessionId}/subagents/{agentId}.jsonl` | Same schema, tracked per spawned agent |
| **Stats cache** | `stats-cache.json` | Pre-aggregated daily activity, per-model token totals, hourly distribution |
| **History** | `history.jsonl` | Lightweight: display text, timestamp, project, sessionId |
| **Credentials** | `.credentials.json` | OAuth tokens, `subscriptionType`, `rateLimitTier` — **key for billing detection** |

#### Token Fields Per Message

```json
{
  "usage": {
    "input_tokens": 1,
    "cache_creation_input_tokens": 494,
    "cache_read_input_tokens": 82724,
    "output_tokens": 2,
    "service_tier": "standard"
  }
}
```

#### Additional Metadata Per Message

- `model` (e.g. `claude-opus-4-6`, `claude-sonnet-4-6`)
- `timestamp` (ISO 8601), `sessionId`, `project`, `gitBranch`, `cwd`, `version`
- Tool calls: tool name + input params
- `isSidechain` flag for parallel agent work

### 1.2 Billing Context Detection

We **can auto-detect** whether the user is on API billing vs Pro/Max subscription from local data:

| Indicator | API Key (pay-per-token) | Pro/Max Subscription |
|-----------|------------------------|----------------------|
| `.credentials.json` → `subscriptionType` | Missing/null | `"pro"` or `"max"` |
| `.credentials.json` → `rateLimitTier` | Missing/null | `"default_claude_max_5x"` etc |
| Token prefix | `sk-ant-api03-` | `sk-ant-oat01-` (OAuth) |
| `stats-cache.json` → `costUSD` | Actual dollar amounts | `0` |

**Priority rule**: If both an API key (`ANTHROPIC_API_KEY` env var) AND subscription exist, Claude Code bills via the API key.

### 1.3 Pricing Tiers (Feb 2026)

#### API Pricing (pay-per-token)

| Model | Input | Output | Cache Write (1.25x) | Cache Read (90% off) |
|-------|-------|--------|---------------------|---------------------|
| Opus 4.5/4.6 | $15/MTok | $75/MTok | $18.75/MTok | $1.50/MTok |
| Sonnet 4.5/4.6 | $3/MTok | $15/MTok | $3.75/MTok | $0.30/MTok |
| Haiku 4.5 | $1/MTok | $5/MTok | $1.25/MTok | $0.10/MTok |

#### Subscription Pricing

| Plan | Monthly Cost | Billing Model |
|------|-------------|---------------|
| Pro | $20/month | Flat rate, no per-token billing |
| Max 5x | $100/month | Flat rate, 5x capacity |
| Max 20x | $200/month | Flat rate, 20x capacity |

For subscription users, cost tracking shows **"equivalent API cost"** — what the usage *would cost* on API billing. This helps users understand the value of their subscription and gauge whether upgrading/downgrading makes sense.

### 1.4 What the Parser Already Does

`src/parser.ts` (596 lines) extracts:
- All four token types per query (input, output, cache_creation, cache_read)
- Groups queries by originating user prompt
- Aggregates by day, model, project
- Generates 10 insight types (vague prompts, context growth, marathon sessions, input-heavy, day patterns, model mismatch, tool-heavy, project dominance, conversation efficiency, heavy context)

### 1.5 What's Missing

1. **No dollar costs** — everything in raw token counts
2. **No per-conversation cost timeline** — drilldown exists but no cost curve
3. **No cache efficiency metrics** — tokens tracked but savings not calculated
4. **No subagent cost attribution** — subagent files exist on disk but aren't parsed
5. **No trend/budget analysis** — daily chart shows absolute usage, not burn rate
6. **Insights don't reference $$** — "expensive" is relative, not quantified

### 1.6 External Tools & APIs

| Tool | Approach | Notes |
|------|----------|-------|
| **Anthropic Admin API** | `/v1/organizations/usage_report` and `/v1/organizations/cost_report` | Requires `sk-ant-admin-` key, org-level |
| **ccusage** (ryoppippi) | CLI parsing local JSONL | Similar approach, no dashboard |
| **Claude Code `/cost`** | Built-in command | Per-session only, no history |
| **Claude Code `/stats`** | Built-in command | Basic usage patterns |

claude-spend's advantage: full local analysis with zero API keys, historical trends, and a visual dashboard.

---

## Part 2: Implementation Plan

### Phase 1: Pricing Engine + Billing Detection

**New file:** `src/pricing.ts`

1. **Auto-detect billing context**: Read `~/.claude/.credentials.json` for `subscriptionType` and `rateLimitTier`. Check `ANTHROPIC_API_KEY` env var (takes priority). Return `BillingContext`: `"api"` | `"pro"` | `"max_5x"` | `"max_20x"`.

2. **Pricing constants**: Map model ID patterns to per-token rates (input, output, cache_write, cache_read).

3. **`calculateCost(model, usage, billingContext)`**: Returns `CostBreakdown`:
   ```ts
   {
     inputCost: number
     outputCost: number
     cacheWriteCost: number
     cacheReadCost: number
     totalCost: number
     cacheSavings: number       // what cache reads saved vs uncached input
     isEquivalent: boolean      // true for subscription users
   }
   ```

4. **Override support**: Optional `~/.claude-spend/config.json` for custom rates or forcing a billing context.

**Modify:** `src/types.ts`
- Add `CostBreakdown`, `BillingContext` types
- Add `costUSD`, `cacheSavings`, `isEquivalentCost` to all aggregate types
- Add `billingContext` to `DashboardData`

### Phase 2: Wire Cost Through Parser

**Modify:** `src/parser.ts`

1. Import pricing engine, call `detectBillingContext()` at parse start
2. After token extraction per query, call `calculateCost()` to attach dollar values
3. Propagate costs through all aggregations (daily, model, project, grand totals)
4. Update insight generation to include dollar amounts

### Phase 3: Subagent Parsing + Conversation Depth

**Modify:** `src/parser.ts`, `src/types.ts`, `src/server.ts`

1. Parse `{sessionId}/subagents/*.jsonl`, attach to parent `Session`
2. Enrich `Session` with `costCurve`, `cacheEfficiency`, `subagentCost`, `subagentQueries`
3. Add `GET /api/session/:id` endpoint for full session detail

### Phase 4: Enhanced Cost-Aware Insights

**Modify:** `src/parser.ts`

| Insight | Trigger | Recommendation |
|---------|---------|---------------|
| **Model downgrade savings** | Opus used for simple convos | "Switching N sessions to Sonnet saves $X.XX" |
| **Cache efficiency alert** | Cache hit rate < 50% | "Low cache reuse cost $X.XX extra" |
| **Context bloat cost** | Input tokens grow >2x | "Context grew N×, costing $X.XX" |
| **Subagent overhead** | Subagent cost > 30% | "Subagents consumed $X.XX (N%)" |
| **Subscription value** | Subscription users | "Usage would cost $X.XX on API — plan saved $Z" |
| **Budget pace** | Budget configured | "Spent $X.XX today, N% of budget" |

### Phase 5: Dashboard Updates

**Modify:** `src/public/index.html`

1. Header cost cards (total spend, avg/session, cache savings)
2. Billing context badge
3. Daily chart with cost overlay
4. Model chart showing cost share (not just token share)
5. Project/prompt/session tables with cost columns
6. Conversation drilldown: cost timeline, cache efficiency, subagent breakdown
7. Cost Reduction panel with projected savings
8. Optional budget tracker widget

### Phase 6: CLI Configuration

**Modify:** `src/index.ts`

- `--budget-daily <n>` and `--budget-monthly <n>` flags
- `--billing <api|pro|max_5x|max_20x>` override
- Persist settings to `~/.claude-spend/config.json`

---

## File Change Summary

| File | Action | Changes |
|------|--------|---------|
| `src/pricing.ts` | **NEW** | Billing detection, pricing constants, cost calculation |
| `src/types.ts` | Modify | Cost fields, BillingContext, CostBreakdown types |
| `src/parser.ts` | Modify | Wire costs, parse subagents, enhance insights |
| `src/server.ts` | Modify | Add `/api/session/:id` endpoint |
| `src/index.ts` | Modify | Budget/billing CLI flags |
| `src/public/index.html` | Modify | Cost display, conversation timeline, budget widget |

## Verification

1. `npm run build` — no type errors
2. `npm start` — `/api/data` includes cost fields and `billingContext`
3. Dashboard shows $$ alongside tokens, billing badge correct
4. Session drilldown renders cost timeline and subagent costs
5. At least 2-3 cost-aware insights generate with real dollar amounts
6. Edge cases: no cache tokens, unknown models, empty sessions, sub vs API display
