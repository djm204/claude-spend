# claude-spend

## What it does

- **Dollar cost breakdown** — see exactly how much each conversation, prompt, and model costs in USD
- **Auto-detects billing context** — knows if you're on API billing, Pro ($20/mo), Max 5x ($100/mo), or Max 20x ($200/mo) and adjusts display accordingly
- **Cache efficiency tracking** — shows how much prompt caching saves you and flags low cache hit rates
- **Subagent cost attribution** — tracks costs from spawned subagents and attributes them to parent sessions
- **Per-conversation deep dive** — cumulative cost curve, per-message cost, cache hit rates, and subagent breakdown
- **13 actionable insights** — model downgrade savings, context bloat warnings, cache efficiency alerts, subscription value analysis, and more
- **All local** — reads from `~/.claude/` on your machine, nothing leaves localhost

## How it works

Just run `npx claude-spend` — everything shows automatically. No flags needed.

Your billing context (API, Pro, Max 5x, Max 20x) is auto-detected from `~/.claude/.credentials.json`. For API users, you see actual dollar costs. For subscription users, you see the equivalent API cost — what your usage *would* cost on pay-per-token billing, so you can gauge the value of your plan.

Dollar costs are calculated per-token using current Claude API rates:

| Model | Input | Output | Cache Write | Cache Read |
|-------|-------|--------|-------------|------------|
| Opus | $15/MTok | $75/MTok | $18.75/MTok | $1.50/MTok |
| Sonnet | $3/MTok | $15/MTok | $3.75/MTok | $0.30/MTok |
| Haiku | $1/MTok | $5/MTok | $1.25/MTok | $0.10/MTok |

## Options

```
claude-spend --port 8080              # custom port (default: 3456)
claude-spend --no-open                # don't auto-open browser
claude-spend --billing api            # override auto-detected billing context
```

## Development

```bash
npm run build          # compile TypeScript + copy public assets
npm run dev            # build and run (opens browser)
npm run dev:no-open    # build and run without opening browser
npm run clean          # remove dist/
npm run rebuild        # clean + build
npm start              # run from compiled dist/
```

## Project Structure

```
src/
  index.ts          # CLI entry point + argument parsing
  server.ts         # Express server with API endpoints
  parser.ts         # Session log parser + insight generation
  pricing.ts        # Billing detection + cost calculation engine
  types.ts          # Shared TypeScript interfaces
  public/
    index.html      # Single-page dashboard (vanilla JS + Chart.js)
```

## API Endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /api/data` | Full dashboard data (sessions, insights, aggregations, costs) |
| `GET /api/refresh` | Re-parse all sessions and refresh cache |
| `GET /api/session/:id` | Detailed session data with per-message cost curve |

## Privacy

All data stays local. claude-spend reads files from `~/.claude/` on your machine and serves a dashboard on localhost. No data is sent anywhere.

## License

MIT
