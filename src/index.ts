#!/usr/bin/env node

import { createServer } from './server.js';

const args = process.argv.slice(2);

if (args.includes('--help') || args.includes('-h')) {
  console.log(`
claude-spend - See where your Claude Code tokens go

Usage:
  claude-spend [options]

Options:
  --port <port>       Port to run dashboard on (default: 3456)
  --no-open           Don't auto-open browser
  --billing <context> Override billing context detection
                      Values: api, pro, max_5x, max_20x
  --help, -h          Show this help message

Examples:
  npx claude-spend                    Open dashboard in browser
  claude-spend --port 8080            Use custom port
  claude-spend --billing api          Force API pricing display
`);
  process.exit(0);
}

const portIndex = args.indexOf('--port');
const port = portIndex !== -1 ? parseInt(args[portIndex + 1], 10) : 3456;
const noOpen = args.includes('--no-open');

const billingIndex = args.indexOf('--billing');
if (billingIndex !== -1) {
  const billingValue = args[billingIndex + 1];
  const valid = ['api', 'pro', 'max_5x', 'max_20x'];
  if (!billingValue || !valid.includes(billingValue)) {
    console.error(`Error: --billing must be one of: ${valid.join(', ')}`);
    process.exit(1);
  }
  process.env.CLAUDE_SPEND_BILLING = billingValue;
}

if (isNaN(port)) {
  console.error('Error: --port must be a number');
  process.exit(1);
}

const app = createServer();

const server = app.listen(port, '127.0.0.1', async () => {
  const url = `http://localhost:${port}`;
  console.log(`\n  claude-spend dashboard running at ${url}\n`);

  if (!noOpen) {
    try {
      const open = (await import('open')).default;
      await open(url);
    } catch {
      console.log('  Could not auto-open browser. Open the URL manually.');
    }
  }
});

server.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${port} is already in use. Try --port <other-port>`);
    process.exit(1);
  }
  throw err;
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n  Shutting down...');
  server.close();
  process.exit(0);
});
