import type { BillingContext, CostBreakdown } from './pricing.js';

// Raw JSONL entry types (input from ~/.claude files)

export interface ContentBlock {
  type: string;
  text?: string;
  name?: string;
}

export interface MessageUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

export interface JournalEntry {
  type: string;
  timestamp?: string;
  isMeta?: boolean;
  message?: {
    role?: string;
    content?: string | ContentBlock[];
    usage?: MessageUsage;
    model?: string;
  };
}

export interface HistoryEntry {
  sessionId?: string;
  display?: string;
}

// Parsed/derived types (output)

export interface Query {
  userPrompt: string | null;
  userTimestamp: string | null;
  assistantTimestamp: string | undefined;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  totalTokens: number;
  costUSD: number;
  cacheSavings: number;
  cumulativeCost: number;
  tools: string[];
}

export interface PromptData {
  prompt: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUSD: number;
  date: string;
  sessionId: string;
  model: string;
}

export interface ProjectPromptData extends PromptData {
  continuations: number;
  toolCounts: Record<string, number>;
}

export interface CostCurvePoint {
  messageIndex: number;
  timestamp: string;
  cumulativeCost: number;
}

export interface Session {
  sessionId: string;
  project: string;
  date: string;
  timestamp: string | undefined;
  firstPrompt: string;
  model: string;
  queryCount: number;
  queries: Query[];
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUSD: number;
  cacheSavings: number;
  cacheEfficiency: number;
  costCurve: CostCurvePoint[];
  subagentCost: number;
  subagentQueries: Query[];
}

export interface DailyUsage {
  date: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUSD: number;
  sessions: number;
  queries: number;
}

export interface ModelBreakdown {
  model: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUSD: number;
  queryCount: number;
}

export interface ProjectBreakdown {
  project: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUSD: number;
  sessionCount: number;
  queryCount: number;
  modelBreakdown: ModelBreakdown[];
  topPrompts: ProjectPromptData[];
}

export interface DateRange {
  from: string;
  to: string;
}

export interface GrandTotals {
  totalSessions: number;
  totalQueries: number;
  totalTokens: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCostUSD: number;
  totalCacheSavings: number;
  avgTokensPerQuery: number;
  avgTokensPerSession: number;
  avgCostPerSession: number;
  avgCostPerQuery: number;
  dateRange: DateRange | null;
}

export interface Insight {
  id: string;
  type: 'warning' | 'info' | 'neutral';
  title: string;
  description: string;
  action: string | null;
}

// Top-level API response

export interface DashboardData {
  sessions: Session[];
  dailyUsage: DailyUsage[];
  modelBreakdown: ModelBreakdown[];
  projectBreakdown: ProjectBreakdown[];
  topPrompts: PromptData[];
  totals: GrandTotals;
  insights: Insight[];
  billingContext: BillingContext;
  isEquivalentCost: boolean;
}

export type { BillingContext, CostBreakdown };
