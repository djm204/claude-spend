import fs from 'fs';
import path from 'path';
import os from 'os';

// Billing context types

export type BillingContext = 'api' | 'pro' | 'max_5x' | 'max_20x';

export interface CostBreakdown {
  inputCost: number;
  outputCost: number;
  cacheWriteCost: number;
  cacheReadCost: number;
  totalCost: number;
  cacheSavings: number;
  isEquivalent: boolean;
}

// Per-million-token rates

interface ModelRates {
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
}

const PRICING: Record<string, ModelRates> = {
  opus: {
    input: 15,
    output: 75,
    cacheWrite: 18.75,
    cacheRead: 1.50,
  },
  sonnet: {
    input: 3,
    output: 15,
    cacheWrite: 3.75,
    cacheRead: 0.30,
  },
  haiku: {
    input: 1,
    output: 5,
    cacheWrite: 1.25,
    cacheRead: 0.10,
  },
};

function resolveModelFamily(model: string): string {
  const lower = model.toLowerCase();
  if (lower.includes('opus')) return 'opus';
  if (lower.includes('sonnet')) return 'sonnet';
  if (lower.includes('haiku')) return 'haiku';
  return 'sonnet'; // default fallback
}

function getRates(model: string): ModelRates {
  return PRICING[resolveModelFamily(model)];
}

/**
 * Detects the user's billing context from local Claude Code data.
 *
 * Priority: ANTHROPIC_API_KEY env var > credentials file > default to 'api'
 */
export function detectBillingContext(): BillingContext {
  // CLI override via --billing flag
  const override = process.env.CLAUDE_SPEND_BILLING;
  if (override && ['api', 'pro', 'max_5x', 'max_20x'].includes(override)) {
    return override as BillingContext;
  }

  // API key env var takes priority over subscription
  if (process.env.ANTHROPIC_API_KEY) {
    return 'api';
  }

  const credPath = path.join(os.homedir(), '.claude', '.credentials.json');
  try {
    if (fs.existsSync(credPath)) {
      const creds = JSON.parse(fs.readFileSync(credPath, 'utf-8'));
      const oauth = creds.claudeAiOauth;
      if (oauth) {
        const sub = oauth.subscriptionType;
        const tier = oauth.rateLimitTier || '';

        if (sub === 'max' || tier.includes('max_20x')) return 'max_20x';
        if (sub === 'max' || tier.includes('max_5x')) return 'max_5x';
        if (sub === 'pro' || tier.includes('pro')) return 'pro';
      }
    }
  } catch {
    // Fall through to default
  }

  return 'api';
}

const SUBSCRIPTION_MONTHLY: Record<BillingContext, number> = {
  api: 0,
  pro: 20,
  max_5x: 100,
  max_20x: 200,
};

export function getSubscriptionMonthlyCost(ctx: BillingContext): number {
  return SUBSCRIPTION_MONTHLY[ctx];
}

export function isSubscription(ctx: BillingContext): boolean {
  return ctx !== 'api';
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
}

/**
 * Calculate cost breakdown for a given model + token usage.
 * For subscription users, costs are marked as "equivalent API cost".
 */
export function calculateCost(
  model: string,
  usage: TokenUsage,
  billingContext: BillingContext,
): CostBreakdown {
  const rates = getRates(model);
  const M = 1_000_000;

  const inputCost = (usage.inputTokens / M) * rates.input;
  const outputCost = (usage.outputTokens / M) * rates.output;
  const cacheWriteCost = (usage.cacheCreationTokens / M) * rates.cacheWrite;
  const cacheReadCost = (usage.cacheReadTokens / M) * rates.cacheRead;

  // Cache savings = what cache reads would have cost at full input price
  const cacheSavings = (usage.cacheReadTokens / M) * rates.input - cacheReadCost;

  return {
    inputCost,
    outputCost,
    cacheWriteCost,
    cacheReadCost,
    totalCost: inputCost + outputCost + cacheWriteCost + cacheReadCost,
    cacheSavings,
    isEquivalent: isSubscription(billingContext),
  };
}

/**
 * Format a dollar amount for display.
 */
export function fmtCost(cost: number): string {
  if (cost >= 100) return '$' + cost.toFixed(0);
  if (cost >= 1) return '$' + cost.toFixed(2);
  if (cost >= 0.01) return '$' + cost.toFixed(2);
  if (cost >= 0.001) return '$' + cost.toFixed(3);
  return '$' + cost.toFixed(4);
}
