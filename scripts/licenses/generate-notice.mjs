#!/usr/bin/env node
// Phase 29 (C-IP) - third-party notices and attribution. Generates NOTICE
// at the repo root from the same `pnpm licenses list --json --prod` data
// `check-licenses.mjs` (Phase 15) and `generate-sbom.mjs` (Phase 15) already
// use, so the notice file never drifts from what CI actually allows: every
// production dependency's licence family is either MIT/Apache-2.0/ISC/BSD/
// 0BSD-style (no attribution obligation beyond what this file already gives)
// or, for the two families that impose one (LGPL-3.0-or-later, CC-BY-4.0),
// gets its own callout with the specific package, licence text location and
// what the obligation actually requires.
import { execFileSync } from 'node:child_process';
import { writeFileSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');

const ATTRIBUTION_REQUIRED = new Set(['CC-BY-4.0', 'Apache-2.0 AND LGPL-3.0-or-later']);

function loadLicenseData() {
  const raw = execFileSync('pnpm', ['licenses', 'list', '--json', '--prod'], {
    encoding: 'utf8',
    maxBuffer: 1024 * 1024 * 32,
    cwd: ROOT,
    shell: process.platform === 'win32',
  });
  return JSON.parse(raw);
}

function main() {
  const rootPkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  const licenseData = loadLicenseData();

  const families = Object.entries(licenseData).sort((a, b) => b[1].length - a[1].length);
  let totalPackages = 0;
  for (const [, pkgs] of families) totalPackages += pkgs.length;

  const lines = [];
  lines.push(`NOTICE`);
  lines.push(``);
  lines.push(`${rootPkg.name} includes third-party open-source software. This file`);
  lines.push(`lists every production dependency's licence family and gives the`);
  lines.push(`attribution required by the licences that impose one. It is generated`);
  lines.push(`by \`scripts/licenses/generate-notice.mjs\` from \`pnpm licenses list --json`);
  lines.push(`--prod\` - the same data source \`scripts/licenses/check-licenses.mjs\`'s CI`);
  lines.push(`gate and \`scripts/sbom/generate-sbom.mjs\`'s SBOM use - so this file cannot`);
  lines.push(`silently go stale relative to what CI actually allows. Regenerate after`);
  lines.push(`any dependency change with \`pnpm notice\`. CI regenerates and diffs this`);
  lines.push(`file against the committed copy on every build, so it cannot drift.`);
  lines.push(``);
  lines.push(`Total production dependencies: ${totalPackages} across ${families.length} licence families`);
  lines.push(``);
  lines.push(`---`);
  lines.push(``);
  lines.push(`## Attribution required`);
  lines.push(``);
  lines.push(`The following components are licensed under terms that require`);
  lines.push(`attribution beyond permissive-licence best practice. Both are satisfied`);
  lines.push(`by this NOTICE file plus the unmodified redistribution of the packages`);
  lines.push(`themselves (neither package's source is modified by this project).`);
  lines.push(``);

  for (const [license, pkgs] of families) {
    if (!ATTRIBUTION_REQUIRED.has(license)) continue;
    for (const pkg of pkgs) {
      lines.push(`### ${pkg.name}@${pkg.versions.join(', ')}`);
      lines.push(``);
      lines.push(`- Licence: ${license}`);
      if (pkg.author) lines.push(`- Author: ${pkg.author}`);
      if (pkg.homepage) lines.push(`- Homepage: ${pkg.homepage}`);
      if (pkg.description) lines.push(`- Description: ${pkg.description}`);
      if (license === 'CC-BY-4.0') {
        lines.push(
          `- Obligation: Creative Commons Attribution 4.0 requires credit to the` +
            ` creator, a link to the licence and an indication of changes made.` +
            ` No changes were made to this package; credit and licence link are` +
            ` given above and at https://creativecommons.org/licenses/by/4.0/.`,
        );
      } else {
        lines.push(
          `- Obligation: this component is a prebuilt native binary distributed` +
            ` under Apache-2.0 for the wrapper and LGPL-3.0-or-later for the` +
            ` bundled libvips library. LGPL-3.0 requires that recipients be able` +
            ` to obtain libvips's source and replace the bundled binary; both are` +
            ` satisfied by libvips's own upstream distribution at` +
            ` https://github.com/libvips/libvips, unmodified by this project.`,
        );
      }
      lines.push(``);
    }
  }

  lines.push(`---`);
  lines.push(``);
  lines.push(`## Full dependency inventory by licence family`);
  lines.push(``);
  lines.push(`Every other family below (MIT, Apache-2.0 alone, ISC, BSD-2-Clause,`);
  lines.push(`BSD-3-Clause, 0BSD) permits inclusion in a proprietary work without`);
  lines.push(`further attribution obligation; the full list is kept here for`);
  lines.push(`completeness.`);
  lines.push(``);

  for (const [license, pkgs] of families) {
    lines.push(`### ${license} (${pkgs.length})`);
    lines.push(``);
    const sorted = [...pkgs].sort((a, b) => a.name.localeCompare(b.name));
    for (const pkg of sorted) {
      lines.push(`- ${pkg.name}@${pkg.versions.join(', ')}`);
    }
    lines.push(``);
  }

  const outPath = join(ROOT, 'NOTICE');
  writeFileSync(outPath, lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n');

  console.log(`NOTICE written to ${outPath}`);
  console.log(`  ${totalPackages} packages across ${families.length} licence families`);
}

main();
