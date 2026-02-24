import fs from 'fs';
import path from 'path';
import os from 'os';
import readline from 'readline';
import type {
  JournalEntry,
  HistoryEntry,
  Query,
  PromptData,
  ProjectPromptData,
  Session,
  DailyUsage,
  ModelBreakdown,
  GrandTotals,
  Insight,
  DashboardData,
  ContentBlock,
  CostCurvePoint,
  BillingContext,
} from './types.js';
import {
  detectBillingContext,
  calculateCost,
  isSubscription,
  getSubscriptionMonthlyCost,
  fmtCost,
} from './pricing.js';

interface ProjectAggregate {
  project: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUSD: number;
  sessionCount: number;
  queryCount: number;
  modelMap: Record<string, ModelBreakdown>;
  allPrompts: ProjectPromptData[];
}

function getClaudeDir(): string {
  return path.join(os.homedir(), '.claude');
}

async function parseJSONLFile(filePath: string): Promise<JournalEntry[]> {
  const lines: JournalEntry[] = [];
  const stream = fs.createReadStream(filePath, { encoding: 'utf-8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      lines.push(JSON.parse(line));
    } catch {
      // Skip malformed lines
    }
  }
  return lines;
}

function extractSessionData(entries: JournalEntry[], billingContext: BillingContext): Query[] {
  const queries: Query[] = [];
  let pendingUserMessage: { text: string | null; timestamp: string | undefined } | null = null;
  let cumulativeCost = 0;

  for (const entry of entries) {
    if (entry.type === 'user' && entry.message?.role === 'user') {
      const content = entry.message.content;
      if (entry.isMeta) continue;
      if (typeof content === 'string' && (
        content.startsWith('<local-command') ||
        content.startsWith('<command-name')
      )) continue;

      const textContent = typeof content === 'string'
        ? content
        : (content as ContentBlock[]).filter(b => b.type === 'text').map(b => b.text ?? '').join('\n').trim();
      pendingUserMessage = {
        text: textContent || null,
        timestamp: entry.timestamp,
      };
    }

    if (entry.type === 'assistant' && entry.message?.usage) {
      const usage = entry.message.usage;
      const model = entry.message.model || 'unknown';
      if (model === '<synthetic>') continue;

      const rawInput = usage.input_tokens || 0;
      const cacheCreation = usage.cache_creation_input_tokens || 0;
      const cacheRead = usage.cache_read_input_tokens || 0;
      const outputTokens = usage.output_tokens || 0;

      // Total input includes all input token types
      const inputTokens = rawInput + cacheCreation + cacheRead;

      const tools: string[] = [];
      if (Array.isArray(entry.message.content)) {
        for (const block of entry.message.content) {
          if (block.type === 'tool_use' && block.name) tools.push(block.name);
        }
      }

      const cost = calculateCost(model, {
        inputTokens: rawInput,
        outputTokens,
        cacheCreationTokens: cacheCreation,
        cacheReadTokens: cacheRead,
      }, billingContext);

      cumulativeCost += cost.totalCost;

      queries.push({
        userPrompt: pendingUserMessage?.text || null,
        userTimestamp: pendingUserMessage?.timestamp ?? null,
        assistantTimestamp: entry.timestamp,
        model,
        inputTokens,
        outputTokens,
        cacheCreationTokens: cacheCreation,
        cacheReadTokens: cacheRead,
        totalTokens: inputTokens + outputTokens,
        costUSD: cost.totalCost,
        cacheSavings: cost.cacheSavings,
        cumulativeCost,
        tools,
      });
    }
  }

  return queries;
}

async function parseSubagentSessions(
  sessionDir: string,
  billingContext: BillingContext,
): Promise<Query[]> {
  const subagentsDir = path.join(sessionDir, 'subagents');
  if (!fs.existsSync(subagentsDir)) return [];

  const allQueries: Query[] = [];
  try {
    const files = fs.readdirSync(subagentsDir).filter(f => f.endsWith('.jsonl'));
    for (const file of files) {
      const entries = await parseJSONLFile(path.join(subagentsDir, file));
      const queries = extractSessionData(entries, billingContext);
      allQueries.push(...queries);
    }
  } catch {
    // Skip if subagents dir can't be read
  }
  return allQueries;
}

async function parseAllSessions(): Promise<DashboardData> {
  const claudeDir = getClaudeDir();
  const projectsDir = path.join(claudeDir, 'projects');
  const billingContext = detectBillingContext();

  const emptyResult: DashboardData = {
    sessions: [],
    dailyUsage: [],
    modelBreakdown: [],
    projectBreakdown: [],
    topPrompts: [],
    totals: {
      totalSessions: 0,
      totalQueries: 0,
      totalTokens: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCostUSD: 0,
      totalCacheSavings: 0,
      avgTokensPerQuery: 0,
      avgTokensPerSession: 0,
      avgCostPerSession: 0,
      avgCostPerQuery: 0,
      dateRange: null,
    },
    insights: [],
    billingContext,
    isEquivalentCost: isSubscription(billingContext),
  };

  if (!fs.existsSync(projectsDir)) {
    return emptyResult;
  }

  // Read history.jsonl for prompt display text
  const historyPath = path.join(claudeDir, 'history.jsonl');
  const historyEntries: HistoryEntry[] = fs.existsSync(historyPath)
    ? await parseJSONLFile(historyPath) as unknown as HistoryEntry[]
    : [];

  // Build a map: sessionId -> first meaningful prompt
  const sessionFirstPrompt: Record<string, string> = {};
  for (const entry of historyEntries) {
    if (entry.sessionId && entry.display && !sessionFirstPrompt[entry.sessionId]) {
      const display = entry.display.trim();
      if (display.startsWith('/') && display.length < 30) continue;
      sessionFirstPrompt[entry.sessionId] = display;
    }
  }

  const projectDirs = fs.readdirSync(projectsDir).filter(d => {
    return fs.statSync(path.join(projectsDir, d)).isDirectory();
  });

  const sessions: Session[] = [];
  const dailyMap: Record<string, DailyUsage> = {};
  const modelMap: Record<string, ModelBreakdown> = {};
  const allPrompts: PromptData[] = [];

  for (const projectDir of projectDirs) {
    const dir = path.join(projectsDir, projectDir);
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.jsonl'));

    for (const file of files) {
      const filePath = path.join(dir, file);
      const sessionId = path.basename(file, '.jsonl');

      let entries: JournalEntry[];
      try {
        entries = await parseJSONLFile(filePath);
      } catch {
        continue;
      }
      if (entries.length === 0) continue;

      const queries = extractSessionData(entries, billingContext);
      if (queries.length === 0) continue;

      // Parse subagent sessions
      const sessionDir = path.join(dir, sessionId);
      const subagentQueries = await parseSubagentSessions(sessionDir, billingContext);

      let inputTokens = 0, outputTokens = 0, costUSD = 0, cacheSavings = 0;
      let totalCacheRead = 0, totalInputAll = 0;
      for (const q of queries) {
        inputTokens += q.inputTokens;
        outputTokens += q.outputTokens;
        costUSD += q.costUSD;
        cacheSavings += q.cacheSavings;
        totalCacheRead += q.cacheReadTokens;
        totalInputAll += q.inputTokens;
      }
      const totalTokens = inputTokens + outputTokens;

      let subagentCost = 0;
      for (const q of subagentQueries) {
        subagentCost += q.costUSD;
        costUSD += q.costUSD;
        cacheSavings += q.cacheSavings;
      }

      // Cache efficiency: ratio of cache reads to total input
      const cacheEfficiency = totalInputAll > 0 ? totalCacheRead / totalInputAll : 0;

      // Build cost curve
      const costCurve: CostCurvePoint[] = queries
        .filter(q => q.assistantTimestamp)
        .map((q, i) => ({
          messageIndex: i,
          timestamp: q.assistantTimestamp!,
          cumulativeCost: q.cumulativeCost,
        }));

      const firstTimestamp = entries.find(e => e.timestamp)?.timestamp;
      const date = firstTimestamp ? firstTimestamp.split('T')[0] : 'unknown';

      // Primary model
      const modelCounts: Record<string, number> = {};
      for (const q of queries) {
        modelCounts[q.model] = (modelCounts[q.model] || 0) + 1;
      }
      const primaryModel = Object.entries(modelCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || 'unknown';

      const firstPrompt = sessionFirstPrompt[sessionId]
        || queries.find(q => q.userPrompt)?.userPrompt
        || '(no prompt)';

      // Collect per-prompt data for "most expensive prompts"
      let currentPrompt: string | null = null;
      let promptInput = 0, promptOutput = 0, promptCost = 0;
      const flushPrompt = (): void => {
        if (currentPrompt && (promptInput + promptOutput) > 0) {
          allPrompts.push({
            prompt: currentPrompt.substring(0, 300),
            inputTokens: promptInput,
            outputTokens: promptOutput,
            totalTokens: promptInput + promptOutput,
            costUSD: promptCost,
            date,
            sessionId,
            model: primaryModel,
          });
        }
      };
      for (const q of queries) {
        if (q.userPrompt && q.userPrompt !== currentPrompt) {
          flushPrompt();
          currentPrompt = q.userPrompt;
          promptInput = 0;
          promptOutput = 0;
          promptCost = 0;
        }
        promptInput += q.inputTokens;
        promptOutput += q.outputTokens;
        promptCost += q.costUSD;
      }
      flushPrompt();

      sessions.push({
        sessionId,
        project: projectDir,
        date,
        timestamp: firstTimestamp,
        firstPrompt: firstPrompt.substring(0, 200),
        model: primaryModel,
        queryCount: queries.length,
        queries,
        inputTokens,
        outputTokens,
        totalTokens,
        costUSD,
        cacheSavings,
        cacheEfficiency,
        costCurve,
        subagentCost,
        subagentQueries,
      });

      // Daily
      if (date !== 'unknown') {
        if (!dailyMap[date]) {
          dailyMap[date] = { date, inputTokens: 0, outputTokens: 0, totalTokens: 0, costUSD: 0, sessions: 0, queries: 0 };
        }
        dailyMap[date].inputTokens += inputTokens;
        dailyMap[date].outputTokens += outputTokens;
        dailyMap[date].totalTokens += totalTokens;
        dailyMap[date].costUSD += costUSD;
        dailyMap[date].sessions += 1;
        dailyMap[date].queries += queries.length;
      }

      // Model
      for (const q of queries) {
        if (q.model === '<synthetic>' || q.model === 'unknown') continue;
        if (!modelMap[q.model]) {
          modelMap[q.model] = { model: q.model, inputTokens: 0, outputTokens: 0, totalTokens: 0, costUSD: 0, queryCount: 0 };
        }
        modelMap[q.model].inputTokens += q.inputTokens;
        modelMap[q.model].outputTokens += q.outputTokens;
        modelMap[q.model].totalTokens += q.totalTokens;
        modelMap[q.model].costUSD += q.costUSD;
        modelMap[q.model].queryCount += 1;
      }
    }
  }

  sessions.sort((a, b) => b.totalTokens - a.totalTokens);

  // Build per-project aggregation
  const projectMap: Record<string, ProjectAggregate> = {};
  for (const session of sessions) {
    const proj = session.project;
    if (!projectMap[proj]) {
      projectMap[proj] = {
        project: proj,
        inputTokens: 0, outputTokens: 0, totalTokens: 0, costUSD: 0,
        sessionCount: 0, queryCount: 0,
        modelMap: {},
        allPrompts: [],
      };
    }
    const p = projectMap[proj];
    p.inputTokens += session.inputTokens;
    p.outputTokens += session.outputTokens;
    p.totalTokens += session.totalTokens;
    p.costUSD += session.costUSD;
    p.sessionCount += 1;
    p.queryCount += session.queryCount;

    for (const q of session.queries) {
      if (q.model === '<synthetic>' || q.model === 'unknown') continue;
      if (!p.modelMap[q.model]) {
        p.modelMap[q.model] = { model: q.model, inputTokens: 0, outputTokens: 0, totalTokens: 0, costUSD: 0, queryCount: 0 };
      }
      const m = p.modelMap[q.model];
      m.inputTokens += q.inputTokens;
      m.outputTokens += q.outputTokens;
      m.totalTokens += q.totalTokens;
      m.costUSD += q.costUSD;
      m.queryCount += 1;
    }

    // Per-project prompt grouping with tool tracking
    let curPrompt: string | null = null, curInput = 0, curOutput = 0, curConts = 0, curCost = 0;
    let curModels: Record<string, number> = {}, curTools: Record<string, number> = {};
    const flushProjectPrompt = (): void => {
      if (curPrompt && (curInput + curOutput) > 0) {
        const topModel = Object.entries(curModels).sort((a, b) => b[1] - a[1])[0]?.[0] || session.model;
        p.allPrompts.push({
          prompt: curPrompt.substring(0, 300),
          inputTokens: curInput,
          outputTokens: curOutput,
          totalTokens: curInput + curOutput,
          costUSD: curCost,
          continuations: curConts,
          model: topModel,
          toolCounts: { ...curTools },
          date: session.date,
          sessionId: session.sessionId,
        });
      }
    };
    for (const q of session.queries) {
      if (q.userPrompt && q.userPrompt !== curPrompt) {
        flushProjectPrompt();
        curPrompt = q.userPrompt;
        curInput = 0; curOutput = 0; curConts = 0; curCost = 0;
        curModels = {}; curTools = {};
      } else if (!q.userPrompt) {
        curConts++;
      }
      curInput += q.inputTokens;
      curOutput += q.outputTokens;
      curCost += q.costUSD;
      if (q.model && q.model !== '<synthetic>') curModels[q.model] = (curModels[q.model] || 0) + 1;
      for (const t of q.tools || []) curTools[t] = (curTools[t] || 0) + 1;
    }
    flushProjectPrompt();
  }

  const projectBreakdown = Object.values(projectMap).map(p => ({
    project: p.project,
    inputTokens: p.inputTokens,
    outputTokens: p.outputTokens,
    totalTokens: p.totalTokens,
    costUSD: p.costUSD,
    sessionCount: p.sessionCount,
    queryCount: p.queryCount,
    modelBreakdown: Object.values(p.modelMap).sort((a, b) => b.totalTokens - a.totalTokens),
    topPrompts: (p.allPrompts || []).sort((a, b) => b.totalTokens - a.totalTokens).slice(0, 10),
  })).sort((a, b) => b.totalTokens - a.totalTokens);

  const dailyUsage = Object.values(dailyMap).sort((a, b) => a.date.localeCompare(b.date));

  // Top 20 most expensive individual prompts
  allPrompts.sort((a, b) => b.totalTokens - a.totalTokens);
  const topPrompts = allPrompts.slice(0, 20);

  const grandTotals: GrandTotals = {
    totalSessions: sessions.length,
    totalQueries: sessions.reduce((sum, s) => sum + s.queryCount, 0),
    totalTokens: sessions.reduce((sum, s) => sum + s.totalTokens, 0),
    totalInputTokens: sessions.reduce((sum, s) => sum + s.inputTokens, 0),
    totalOutputTokens: sessions.reduce((sum, s) => sum + s.outputTokens, 0),
    totalCostUSD: sessions.reduce((sum, s) => sum + s.costUSD, 0),
    totalCacheSavings: sessions.reduce((sum, s) => sum + s.cacheSavings, 0),
    avgTokensPerQuery: 0,
    avgTokensPerSession: 0,
    avgCostPerSession: 0,
    avgCostPerQuery: 0,
    dateRange: dailyUsage.length > 0
      ? { from: dailyUsage[0].date, to: dailyUsage[dailyUsage.length - 1].date }
      : null,
  };
  if (grandTotals.totalQueries > 0) {
    grandTotals.avgTokensPerQuery = Math.round(grandTotals.totalTokens / grandTotals.totalQueries);
    grandTotals.avgCostPerQuery = grandTotals.totalCostUSD / grandTotals.totalQueries;
  }
  if (grandTotals.totalSessions > 0) {
    grandTotals.avgTokensPerSession = Math.round(grandTotals.totalTokens / grandTotals.totalSessions);
    grandTotals.avgCostPerSession = grandTotals.totalCostUSD / grandTotals.totalSessions;
  }

  // Generate insights
  const insights = generateInsights(sessions, allPrompts, grandTotals, billingContext);

  return {
    sessions,
    dailyUsage,
    modelBreakdown: Object.values(modelMap),
    projectBreakdown,
    topPrompts,
    totals: grandTotals,
    insights,
    billingContext,
    isEquivalentCost: isSubscription(billingContext),
  };
}

function generateInsights(
  sessions: Session[],
  allPrompts: PromptData[],
  totals: GrandTotals,
  billingContext: BillingContext,
): Insight[] {
  const insights: Insight[] = [];

  // 1. Short, vague messages that cost a lot
  const shortExpensive = allPrompts.filter(p => p.prompt.trim().length < 30 && p.totalTokens > 100_000);
  if (shortExpensive.length > 0) {
    const totalWasted = shortExpensive.reduce((s, p) => s + p.totalTokens, 0);
    const totalWastedCost = shortExpensive.reduce((s, p) => s + p.costUSD, 0);
    const examples = [...new Set(shortExpensive.map(p => p.prompt.trim()))].slice(0, 4);
    insights.push({
      id: 'vague-prompts',
      type: 'warning',
      title: `Short, vague messages cost you ${fmtCost(totalWastedCost)}`,
      description: `${shortExpensive.length} times you sent a short message like ${examples.map(e => '"' + e + '"').join(', ')} -- and each time, Claude used over 100K tokens (${fmtCost(totalWastedCost)} total) to respond. When you say just "Yes" or "Do it", Claude doesn't know exactly what you want, so it tries harder -- reading more files, running more tools, making more attempts. Each of those steps re-sends the entire conversation, which multiplies the cost.`,
      action: 'Try being specific. Instead of "Yes", say "Yes, update the login page and run the tests." It gives Claude a clear target, so it finishes faster and uses fewer tokens.',
    });
  }

  // 2. Long conversations getting more expensive over time
  const longSessions = sessions.filter(s => s.queries.length > 50);
  if (longSessions.length > 0) {
    const growthData = longSessions.map(s => {
      const first5 = s.queries.slice(0, 5).reduce((sum, q) => sum + q.costUSD, 0) / Math.min(5, s.queries.length);
      const last5 = s.queries.slice(-5).reduce((sum, q) => sum + q.costUSD, 0) / Math.min(5, s.queries.length);
      return { session: s, first5, last5, ratio: last5 / Math.max(first5, 0.0001) };
    }).filter(g => g.ratio > 2);

    if (growthData.length > 0) {
      const avgGrowth = (growthData.reduce((s, g) => s + g.ratio, 0) / growthData.length).toFixed(1);
      const worstSession = growthData.sort((a, b) => b.ratio - a.ratio)[0];
      const extraCost = growthData.reduce((s, g) => s + g.session.costUSD, 0);
      insights.push({
        id: 'context-growth',
        type: 'warning',
        title: `Long conversations cost ${avgGrowth}x more per message by the end`,
        description: `In ${growthData.length} conversations (${fmtCost(extraCost)} total), messages near the end cost ${avgGrowth}x more than at the start. Every message re-reads the entire history. Your longest ("${worstSession.session.firstPrompt.substring(0, 50)}...") grew ${worstSession.ratio.toFixed(1)}x more expensive by the end.`,
        action: 'Start a fresh conversation when you move to a new task. Paste a short summary in your first message instead of re-reading hundreds of old messages.',
      });
    }
  }

  // 3. Marathon conversations
  const turnCounts = sessions.map(s => s.queryCount);
  const medianTurns = turnCounts.sort((a, b) => a - b)[Math.floor(turnCounts.length / 2)] || 0;
  const longCount = sessions.filter(s => s.queryCount > 200).length;
  if (longCount >= 3) {
    const longTokens = sessions.filter(s => s.queryCount > 200).reduce((s, ses) => s + ses.totalTokens, 0);
    const longCost = sessions.filter(s => s.queryCount > 200).reduce((s, ses) => s + ses.costUSD, 0);
    const longPct = ((longTokens / Math.max(totals.totalTokens, 1)) * 100).toFixed(0);
    insights.push({
      id: 'marathon-sessions',
      type: 'info',
      title: `${longCount} marathon conversations cost ${fmtCost(longCost)} (${longPct}% of total)`,
      description: `You have ${longCount} conversations with over 200 messages each. These consumed ${fmt(longTokens)} tokens (${fmtCost(longCost)}). Your typical conversation is about ${medianTurns} messages. Long conversations are disproportionately expensive due to context buildup.`,
      action: 'Keep one conversation per task. When a conversation drifts into different topics, start a new one.',
    });
  }

  // 4. Most tokens are re-reading, not writing
  if (totals.totalTokens > 0) {
    const outputPct = (totals.totalOutputTokens / totals.totalTokens) * 100;
    if (outputPct < 2) {
      insights.push({
        id: 'input-heavy',
        type: 'info',
        title: `Only ${outputPct.toFixed(1)}% of your spend is Claude actually writing`,
        description: `Out of ${fmtCost(totals.totalCostUSD)} total, the vast majority is Claude re-reading your conversation history, files, and context. Only ${fmt(totals.totalOutputTokens)} tokens (${outputPct.toFixed(1)}%) are actual output.`,
        action: 'Keeping conversations shorter has more impact than asking for shorter answers.',
      });
    }
  }

  // 5. Day-of-week pattern
  if (sessions.length >= 10) {
    const dayOfWeekMap: Record<number, { tokens: number; cost: number; sessions: number }> = {};
    for (const s of sessions) {
      if (!s.timestamp) continue;
      const d = new Date(s.timestamp);
      const day = d.getDay();
      if (!dayOfWeekMap[day]) dayOfWeekMap[day] = { tokens: 0, cost: 0, sessions: 0 };
      dayOfWeekMap[day].tokens += s.totalTokens;
      dayOfWeekMap[day].cost += s.costUSD;
      dayOfWeekMap[day].sessions += 1;
    }
    const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const days = Object.entries(dayOfWeekMap).map(([d, v]) => ({
      day: dayNames[Number(d)],
      ...v,
      avgCost: v.cost / v.sessions,
      avg: v.tokens / v.sessions,
    }));
    if (days.length >= 3) {
      days.sort((a, b) => b.avgCost - a.avgCost);
      const busiest = days[0];
      const quietest = days[days.length - 1];
      insights.push({
        id: 'day-pattern',
        type: 'neutral',
        title: `${busiest.day}s cost the most: ${fmtCost(busiest.avgCost)}/session avg`,
        description: `Your ${busiest.day} conversations average ${fmtCost(busiest.avgCost)} each (${fmt(Math.round(busiest.avg))} tokens), compared to ${fmtCost(quietest.avgCost)} on ${quietest.day}s. This could mean bigger tasks on ${busiest.day}s or longer conversations.`,
        action: null,
      });
    }
  }

  // 6. Model mismatch -- Opus used for simple conversations
  const opusSessions = sessions.filter(s => s.model.includes('opus'));
  if (opusSessions.length > 0) {
    const simpleOpus = opusSessions.filter(s => s.queryCount < 10 && s.totalTokens < 200_000);
    if (simpleOpus.length >= 3) {
      const wastedCost = simpleOpus.reduce((s, ses) => s + ses.costUSD, 0);
      // Estimate Sonnet cost: roughly 1/5 of Opus for input, 1/5 for output
      const estimatedSonnetCost = wastedCost * 0.2;
      const savings = wastedCost - estimatedSonnetCost;
      const examples = simpleOpus.slice(0, 3).map(s => '"' + s.firstPrompt.substring(0, 40) + '"').join(', ');
      insights.push({
        id: 'model-mismatch',
        type: 'warning',
        title: `${simpleOpus.length} simple Opus conversations cost ${fmtCost(wastedCost)} — Sonnet would save ${fmtCost(savings)}`,
        description: `These conversations had fewer than 10 messages and cost ${fmtCost(wastedCost)} on Opus: ${examples}. Switching to Sonnet for these simple tasks would cost ~${fmtCost(estimatedSonnetCost)}, saving ${fmtCost(savings)}.`,
        action: 'Use /model to switch to Sonnet or Haiku for simple tasks. Save Opus for complex multi-file changes, architecture decisions, or tricky debugging.',
      });
    }
  }

  // 7. Tool-heavy conversations
  if (sessions.length >= 5) {
    const toolHeavy = sessions.filter(s => {
      const userMessages = s.queries.filter(q => q.userPrompt).length;
      const toolCalls = s.queryCount - userMessages;
      return userMessages > 0 && toolCalls > userMessages * 3;
    });
    if (toolHeavy.length >= 3) {
      const totalToolCost = toolHeavy.reduce((s, ses) => s + ses.costUSD, 0);
      const avgRatio = toolHeavy.reduce((s, ses) => {
        const userMsgs = ses.queries.filter(q => q.userPrompt).length;
        return s + (ses.queryCount - userMsgs) / Math.max(userMsgs, 1);
      }, 0) / toolHeavy.length;
      insights.push({
        id: 'tool-heavy',
        type: 'info',
        title: `${toolHeavy.length} tool-heavy conversations cost ${fmtCost(totalToolCost)}`,
        description: `In these conversations, Claude made ~${Math.round(avgRatio)} tool calls per message you sent. Each tool call re-reads the entire conversation. These ${toolHeavy.length} conversations cost ${fmtCost(totalToolCost)} total.`,
        action: 'Point Claude to specific files and line numbers. "Fix the bug in src/auth.js line 42" triggers fewer tool calls than "fix the login bug".',
      });
    }
  }

  // 8. One project dominates usage
  if (sessions.length >= 5) {
    const projectCosts: Record<string, { tokens: number; cost: number }> = {};
    for (const s of sessions) {
      const proj = s.project || 'unknown';
      if (!projectCosts[proj]) projectCosts[proj] = { tokens: 0, cost: 0 };
      projectCosts[proj].tokens += s.totalTokens;
      projectCosts[proj].cost += s.costUSD;
    }
    const sorted = Object.entries(projectCosts).sort((a, b) => b[1].cost - a[1].cost);
    if (sorted.length >= 2) {
      const [topProject, topData] = sorted[0];
      const pctNum = (topData.cost / Math.max(totals.totalCostUSD, 0.01)) * 100;
      const pct = pctNum.toFixed(0);
      if (pctNum >= 60) {
        const projName = topProject.replace(/^C--Users-[^-]+-?/, '').replace(/^Projects-?/, '').replace(/-/g, '/') || '~';
        insights.push({
          id: 'project-dominance',
          type: 'info',
          title: `${pct}% of spend (${fmtCost(topData.cost)}) went to one project: ${projName}`,
          description: `Your "${projName}" project cost ${fmtCost(topData.cost)} out of ${fmtCost(totals.totalCostUSD)} total. The next closest project cost ${fmtCost(sorted[1][1].cost)}.`,
          action: 'Not necessarily a problem, but worth knowing. If this project has long-running conversations, breaking them into smaller sessions could reduce its footprint.',
        });
      }
    }
  }

  // 9. Conversation efficiency -- short vs long conversations cost per message
  if (sessions.length >= 10) {
    const shortSessions = sessions.filter(s => s.queryCount >= 3 && s.queryCount <= 15);
    const longSessions2 = sessions.filter(s => s.queryCount > 80);
    if (shortSessions.length >= 3 && longSessions2.length >= 2) {
      const shortAvgCost = shortSessions.reduce((s, ses) => s + ses.costUSD / ses.queryCount, 0) / shortSessions.length;
      const longAvgCost = longSessions2.reduce((s, ses) => s + ses.costUSD / ses.queryCount, 0) / longSessions2.length;
      const ratioNum = longAvgCost / Math.max(shortAvgCost, 0.0001);
      const ratio = ratioNum.toFixed(1);
      if (ratioNum >= 2) {
        insights.push({
          id: 'conversation-efficiency',
          type: 'warning',
          title: `Each message costs ${ratio}x more in long conversations (${fmtCost(longAvgCost)} vs ${fmtCost(shortAvgCost)})`,
          description: `In short conversations (under 15 messages), each message costs ~${fmtCost(shortAvgCost)}. In long ones (80+ messages), each message costs ~${fmtCost(longAvgCost)}. That is ${ratio}x more per message.`,
          action: 'This is the single biggest lever for reducing costs. Start fresh conversations more often.',
        });
      }
    }
  }

  // 10. Heavy context on first message
  if (sessions.length >= 5) {
    const heavyStarts = sessions.filter(s => {
      const firstQuery = s.queries[0];
      return firstQuery && firstQuery.inputTokens > 50_000;
    });
    if (heavyStarts.length >= 5) {
      const avgStartCost = heavyStarts.reduce((s, ses) => s + ses.queries[0].costUSD, 0) / heavyStarts.length;
      const totalOverheadCost = heavyStarts.reduce((s, ses) => s + ses.queries[0].costUSD, 0);
      insights.push({
        id: 'heavy-context',
        type: 'info',
        title: `${heavyStarts.length} conversations start with ${fmtCost(avgStartCost)} of context overhead`,
        description: `Before you even type your first message, Claude reads your CLAUDE.md, project files, and system context. Across ${heavyStarts.length} conversations, this setup overhead cost ${fmtCost(totalOverheadCost)} total -- and it gets re-read with every message.`,
        action: 'Keep your CLAUDE.md files concise. A smaller starting context compounds into savings across every message.',
      });
    }
  }

  // 11. Cache efficiency insight
  const sessionsWithLowCache = sessions.filter(s =>
    s.queries.length > 20 && s.cacheEfficiency < 0.5 && s.costUSD > 0.50
  );
  if (sessionsWithLowCache.length >= 2) {
    const totalLowCacheCost = sessionsWithLowCache.reduce((s, ses) => s + ses.costUSD, 0);
    const avgEfficiency = (sessionsWithLowCache.reduce((s, ses) => s + ses.cacheEfficiency, 0) / sessionsWithLowCache.length * 100).toFixed(0);
    insights.push({
      id: 'cache-efficiency',
      type: 'warning',
      title: `Low cache reuse in ${sessionsWithLowCache.length} sessions cost ${fmtCost(totalLowCacheCost)} extra`,
      description: `These sessions had only ${avgEfficiency}% cache hit rate. When Claude can't reuse cached context, every message pays full price for re-reading. Better cache utilization could cut these costs significantly.`,
      action: 'Keep sessions focused on one task. Switching topics or heavily editing context breaks cache reuse.',
    });
  }

  // 12. Subagent overhead
  const sessionsWithSubagents = sessions.filter(s => s.subagentCost > 0);
  if (sessionsWithSubagents.length >= 2) {
    const totalSubagentCost = sessionsWithSubagents.reduce((s, ses) => s + ses.subagentCost, 0);
    const totalParentCost = sessionsWithSubagents.reduce((s, ses) => s + ses.costUSD, 0);
    const pct = ((totalSubagentCost / Math.max(totalParentCost, 0.01)) * 100).toFixed(0);
    if (Number(pct) > 20) {
      insights.push({
        id: 'subagent-overhead',
        type: 'info',
        title: `Subagents consumed ${fmtCost(totalSubagentCost)} (${pct}% of those sessions)`,
        description: `In ${sessionsWithSubagents.length} sessions, subagent tasks (parallel searches, file exploration, etc.) cost ${fmtCost(totalSubagentCost)} out of ${fmtCost(totalParentCost)}. Each subagent re-reads context independently.`,
        action: 'Consider whether parallel agent tasks are worth the cost. For simple lookups, direct file references may be cheaper than spawning agents.',
      });
    }
  }

  // 13. Subscription value insight (for subscription users)
  if (isSubscription(billingContext) && totals.totalCostUSD > 0) {
    const monthlyFee = getSubscriptionMonthlyCost(billingContext);
    const planName = billingContext === 'pro' ? 'Pro' : billingContext === 'max_5x' ? 'Max 5x' : 'Max 20x';

    // Calculate days in data range
    let daysInRange = 30;
    if (totals.dateRange) {
      const from = new Date(totals.dateRange.from);
      const to = new Date(totals.dateRange.to);
      daysInRange = Math.max(1, Math.ceil((to.getTime() - from.getTime()) / (1000 * 60 * 60 * 24)) + 1);
    }
    const monthlyEquivalent = (totals.totalCostUSD / daysInRange) * 30;
    const savings = monthlyEquivalent - monthlyFee;

    if (savings > 0) {
      insights.push({
        id: 'subscription-value',
        type: 'info',
        title: `Your ${planName} plan ($${monthlyFee}/mo) is saving you ~${fmtCost(savings)}/month`,
        description: `At API rates, your usage over ${daysInRange} days would cost ${fmtCost(totals.totalCostUSD)} (projected ${fmtCost(monthlyEquivalent)}/month). Your ${planName} subscription at $${monthlyFee}/month saves ~${fmtCost(savings)}/month.`,
        action: null,
      });
    } else {
      insights.push({
        id: 'subscription-value',
        type: 'neutral',
        title: `Your ${planName} plan ($${monthlyFee}/mo) may be more than you need`,
        description: `At API rates, your usage over ${daysInRange} days would cost ${fmtCost(totals.totalCostUSD)} (projected ${fmtCost(monthlyEquivalent)}/month). Your ${planName} subscription at $${monthlyFee}/month costs ${fmtCost(monthlyFee - monthlyEquivalent)} more than API billing would.`,
        action: 'Consider whether a lower plan tier would better match your usage.',
      });
    }
  }

  return insights;
}

function fmt(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 10_000) return (n / 1_000).toFixed(0) + 'K';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
  return n.toLocaleString();
}

export { parseAllSessions };
