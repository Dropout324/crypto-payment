#!/usr/bin/env node
// Phase 15 (C5) - combines each workspace project's own
// `coverage/coverage-summary.json` (written by that project's own
// `vitest run --coverage`, see `test:coverage` in each package.json and the
// shared settings in vitest.coverage.base.mjs) into one whole-repo baseline.
// Run after `pnpm test:coverage` - it does not run tests itself, only reads
// what that already produced, so it stays fast and works the same locally
// and in CI.
import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');

const PROJECTS = [
  'packages/shared',
  'packages/security',
  'packages/observability',
  'packages/signing',
  'packages/blockchain',
  'packages/payments',
  'packages/exchange-rate',
  'packages/database',
  'packages/ledger',
  'packages/webhooks',
  'apps/api',
  'apps/blockchain-monitor',
  'apps/worker',
];

const METRICS = ['lines', 'statements', 'functions', 'branches'];

function main() {
  const perProject = [];
  const totals = Object.fromEntries(METRICS.map((m) => [m, { total: 0, covered: 0 }]));
  const missing = [];

  for (const project of PROJECTS) {
    const summaryPath = join(ROOT, project, 'coverage', 'coverage-summary.json');
    if (!existsSync(summaryPath)) {
      missing.push(project);
      continue;
    }
    const summary = JSON.parse(readFileSync(summaryPath, 'utf8'));
    const total = summary.total;
    for (const metric of METRICS) {
      totals[metric].total += total[metric].total;
      totals[metric].covered += total[metric].covered;
    }
    perProject.push({
      project,
      lines: total.lines.pct,
      statements: total.statements.pct,
      functions: total.functions.pct,
      branches: total.branches.pct,
    });
  }

  if (missing.length > 0) {
    console.error(`Missing coverage-summary.json for: ${missing.join(', ')}`);
    console.error('Run `pnpm test:coverage` first.');
    process.exit(1);
  }

  const overall = Object.fromEntries(
    METRICS.map((m) => [m, totals[m].total === 0 ? 0 : Number(((totals[m].covered / totals[m].total) * 100).toFixed(2))]),
  );

  console.log('Coverage baseline - per project:');
  for (const p of perProject.sort((a, b) => a.project.localeCompare(b.project))) {
    console.log(`  ${p.project.padEnd(28)} lines=${p.lines}% statements=${p.statements}% functions=${p.functions}% branches=${p.branches}%`);
  }
  console.log('\nCoverage baseline - repo-wide (line-weighted across all projects):');
  console.log(`  lines=${overall.lines}% statements=${overall.statements}% functions=${overall.functions}% branches=${overall.branches}%`);

  const outDir = join(ROOT, 'coverage');
  mkdirSync(outDir, { recursive: true });
  const report = { generatedAt: new Date().toISOString(), overall, perProject };
  writeFileSync(join(outDir, 'summary.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(`\nWritten to ${join(outDir, 'summary.json')}`);
}

main();
