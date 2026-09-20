import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import autocannon from 'autocannon';
import { readFixture } from './fixture.js';
import { build as buildAuthLogin } from './scenarios/auth-login.js';
import { build as buildDashboardRead } from './scenarios/dashboard-read.js';
import { build as buildInvoiceCreation } from './scenarios/invoice-creation.js';
import { build as buildPublicInvoicePolling } from './scenarios/public-invoice-polling.js';

const dirname = path.dirname(fileURLToPath(import.meta.url));

const SCENARIOS: Record<string, (fixture: ReturnType<typeof readFixture>) => Partial<autocannon.Options>> = {
  'public-invoice-polling': buildPublicInvoicePolling,
  'invoice-creation': buildInvoiceCreation,
  'auth-login': buildAuthLogin,
  'dashboard-read': buildDashboardRead,
};

interface Args {
  scenario: string;
  connections: number;
  duration: number;
}

function parseArgs(argv: string[]): Args {
  const [scenario, ...rest] = argv;
  if (!scenario) {
    throw new Error(
      `usage: pnpm loadtest -- <scenario> [--connections N] [--duration S]\navailable scenarios: ${Object.keys(SCENARIOS).join(', ')}, all`,
    );
  }

  let connections = 20;
  let duration = 20;
  for (let i = 0; i < rest.length; i += 1) {
    if (rest[i] === '--connections') connections = Number(rest[++i]);
    if (rest[i] === '--duration') duration = Number(rest[++i]);
  }

  return { scenario, connections, duration };
}

function summarize(name: string, result: autocannon.Result): void {
  const errorRate = result.requests.sent === 0 ? 0 : ((result.non2xx + result.errors) / result.requests.sent) * 100;
  console.log(`\n--- ${name} ---`);
  console.log(`requests/sec: avg=${result.requests.average.toFixed(1)} p97.5=${result.requests.p97_5}`);
  console.log(
    `latency ms: avg=${result.latency.average.toFixed(1)} p50=${result.latency.p50} p90=${result.latency.p90} p99=${result.latency.p99} max=${result.latency.max}`,
  );
  console.log(
    `status: 2xx=${result['2xx']} 4xx=${result['4xx']} 5xx=${result['5xx']} errors=${result.errors} timeouts=${result.timeouts} (${errorRate.toFixed(2)}% non-2xx/error)`,
  );
}

async function runOne(name: string, options: Partial<autocannon.Options>, args: Args): Promise<autocannon.Result> {
  const result = await autocannon({
    connections: args.connections,
    duration: args.duration,
    ...options,
  } as autocannon.Options);

  summarize(name, result);

  const resultsDir = path.join(dirname, 'results');
  mkdirSync(resultsDir, { recursive: true });
  const outFile = path.join(resultsDir, `${name}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  writeFileSync(outFile, JSON.stringify(result, null, 2), 'utf8');
  console.log(`(full result: ${path.relative(process.cwd(), outFile)})`);

  return result;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const fixture = readFixture();

  if (args.scenario === 'all') {
    for (const [name, buildFn] of Object.entries(SCENARIOS)) {
      await runOne(name, buildFn(fixture), args);
      // Let the 'api'/'auth' rate-limit windows (60s fixed windows) roll over
      // so one scenario's bucket usage does not bleed into the next.
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
    return;
  }

  const buildFn = SCENARIOS[args.scenario];
  if (!buildFn) {
    throw new Error(`unknown scenario "${args.scenario}" - available: ${Object.keys(SCENARIOS).join(', ')}, all`);
  }
  await runOne(args.scenario, buildFn(fixture), args);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
