#!/usr/bin/env node
// Phase 15 (C5) - licence check, feeding Phase 29 (IP/licensing). Fails the
// pipeline the moment any production dependency carries a licence outside
// this allowlist, so a newly added dependency with an incompatible licence
// (GPL/AGPL/SSPL copyleft, or no licence at all) is caught in CI rather than
// discovered later in a licence audit. The allowlist below is exactly
// the 8 licence families `README.md#roadmap`'s Phase 29
// section already inventoried across this project's 211 production
// dependencies (`pnpm licenses list --json --prod`) - none of them is
// a problem; the LGPL and CC-BY entries require attribution, tracked by
// Phase 29's own scope (not started as of Phase 15), not blocked here.
import { execFileSync } from 'node:child_process';

const ALLOWED_LICENSES = new Set([
  'MIT',
  'Apache-2.0',
  'ISC',
  'BSD-2-Clause',
  'BSD-3-Clause',
  '0BSD',
  'CC-BY-4.0',
  'Apache-2.0 AND LGPL-3.0-or-later',
  'CC0-1.0',
  'Unlicense',
  'BlueOak-1.0.0',
]);

function loadLicenseData() {
  const raw = execFileSync('pnpm', ['licenses', 'list', '--json', '--prod'], {
    encoding: 'utf8',
    maxBuffer: 1024 * 1024 * 32,
    shell: process.platform === 'win32',
  });
  return JSON.parse(raw);
}

function main() {
  const data = loadLicenseData();
  const byLicense = Object.entries(data);
  const violations = [];
  let total = 0;

  for (const [license, packages] of byLicense) {
    total += packages.length;
    if (!ALLOWED_LICENSES.has(license)) {
      for (const pkg of packages) {
        violations.push({ license, name: pkg.name, versions: pkg.versions });
      }
    }
  }

  console.log(`Checked ${total} production dependencies across ${byLicense.length} licence families.`);
  for (const [license, packages] of byLicense.sort((a, b) => b[1].length - a[1].length)) {
    const flag = ALLOWED_LICENSES.has(license) ? 'ok' : 'DISALLOWED';
    console.log(`  [${flag}] ${license}: ${packages.length}`);
  }

  if (violations.length > 0) {
    console.error('\nLicence check FAILED - disallowed licence(s) found:');
    for (const v of violations) {
      console.error(`  - ${v.name}@${v.versions.join(',')}: ${v.license}`);
    }
    console.error(
      '\nIf this dependency is genuinely required, add its exact licence string to ' +
        'ALLOWED_LICENSES in scripts/licenses/check-licenses.mjs only after confirming ' +
        'it does not create a copyleft/IP-cleanliness problem (Phase 29) - ' +
        'this is a deliberate, reviewed decision, not a rubber stamp.',
    );
    process.exit(1);
  }

  console.log('\nLicence check PASSED - every production dependency is within the allowlist.');
}

main();
