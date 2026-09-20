#!/usr/bin/env node
// Phase 15 (C5) - vulnerability scanning. Runs `pnpm audit` (the same tool
// ADR 0016/0025 already used by hand to count "17 production dependency
// advisories, 1 critical, 9 high") as a repeatable CI step instead of a
// one-off manual check, and writes a machine-readable report for the data
// room (Phase 20).
//
// Phase 17 pass 1 (ADR 0031) closed the gap this script used to report as
// open (the Fastify/@nestjs/platform-fastify advisory chain, plus a
// deepmerge-ts advisory via prisma's config loader) - `pnpm audit --prod`
// is now clean across every severity. This script exits non-zero on any
// unresolved critical/high finding from here on, and the CI workflow's
// `vulnerability-scan` job is a real gate (no more `continue-on-error`),
// matching the roadmap's "risk acceptance not permitted" exit criterion:
// a future advisory in this range fails the build instead of silently
// re-accumulating.
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');

function runAudit() {
  try {
    const raw = execFileSync('pnpm', ['audit', '--prod', '--json'], {
      encoding: 'utf8',
      maxBuffer: 1024 * 1024 * 64,
      cwd: ROOT,
      shell: process.platform === 'win32',
    });
    return JSON.parse(raw);
  } catch (err) {
    // pnpm audit exits non-zero when it finds any advisory - that's the
    // expected path, not a script failure. stdout still carries the JSON.
    if (err.stdout) return JSON.parse(err.stdout);
    throw err;
  }
}

function main() {
  const report = runAudit();
  const counts = report.metadata?.vulnerabilities ?? { info: 0, low: 0, moderate: 0, high: 0, critical: 0 };
  const criticalOrHigh = (counts.critical ?? 0) + (counts.high ?? 0);

  const outDir = join(ROOT, 'security-reports');
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'pnpm-audit.json'), JSON.stringify(report, null, 2) + '\n');

  console.log('Production dependency vulnerability scan (pnpm audit --prod):');
  console.log(`  critical=${counts.critical ?? 0} high=${counts.high ?? 0} moderate=${counts.moderate ?? 0} low=${counts.low ?? 0} info=${counts.info ?? 0}`);

  if (criticalOrHigh > 0) {
    console.log(
      `\n${criticalOrHigh} unresolved critical/high advisory(ies) - Phase 17 pass 1 (ADR 0031) made this a ` +
        'hard gate: "zero unresolved critical or high production dependency advisories, risk acceptance not ' +
        'permitted" (README.md#roadmap). Upgrade or override the affected dependency; do not ' +
        'suppress this check.',
    );
    process.exitCode = 1;
    return;
  }

  console.log('\nZero critical/high advisories - Phase 17 pass 1\'s dependency criterion holds.');
}

main();
