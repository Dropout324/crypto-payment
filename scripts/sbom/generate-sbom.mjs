#!/usr/bin/env node
// Phase 15 (C5) - SBOM generation, feeding Phase 29's IP documentation. Emits a CycloneDX 1.5 JSON document built
// directly from `pnpm licenses list --json --prod` (the same tool the
// readiness roadmap's Phase 29 section used to inventory this project's 211
// production dependencies) rather than
// pulling in a third-party SBOM generator - `@cyclonedx/cyclonedx-npm`
// expects a `package-lock.json`, not a pnpm lockfile, and a pnpm-specific
// generator would be one more unaudited supply-chain dependency for a tool
// this project runs exactly once per CI build. The output is a real,
// schema-shaped CycloneDX document (bomFormat/specVersion/components), not a
// custom format - any tooling that reads CycloneDX can ingest
// it directly.
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');

function loadLicenseData() {
  const raw = execFileSync('pnpm', ['licenses', 'list', '--json', '--prod'], {
    encoding: 'utf8',
    maxBuffer: 1024 * 1024 * 32,
    cwd: ROOT,
    shell: process.platform === 'win32',
  });
  return JSON.parse(raw);
}

function toPurl(name, version) {
  const encodedName = name.startsWith('@') ? name.replace('/', '%2F') : name;
  return `pkg:npm/${encodedName}@${version}`;
}

function main() {
  const rootPkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  const licenseData = loadLicenseData();

  const components = [];
  for (const [license, packages] of Object.entries(licenseData)) {
    for (const pkg of packages) {
      for (const version of pkg.versions) {
        components.push({
          type: 'library',
          'bom-ref': `${pkg.name}@${version}`,
          name: pkg.name,
          version,
          licenses: [{ license: { name: license } }],
          purl: toPurl(pkg.name, version),
          ...(pkg.author ? { authors: [{ name: String(pkg.author) }] } : {}),
          ...(pkg.description ? { description: pkg.description } : {}),
        });
      }
    }
  }

  components.sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));

  const commitSha = process.env.GITHUB_SHA ?? process.env.GIT_COMMIT ?? 'local';
  const buildRef = process.env.GITHUB_RUN_ID ?? 'local-build';

  const sbom = {
    bomFormat: 'CycloneDX',
    specVersion: '1.5',
    serialNumber: `urn:uuid:${randomUUID()}`,
    version: 1,
    metadata: {
      timestamp: new Date().toISOString(),
      tools: [{ vendor: 'crypto-pga', name: 'scripts/sbom/generate-sbom.mjs', version: '1.0.0' }],
      component: {
        type: 'application',
        name: rootPkg.name,
        version: rootPkg.version,
      },
      properties: [
        { name: 'gateway:commit', value: String(commitSha) },
        { name: 'gateway:build', value: String(buildRef) },
      ],
    },
    components,
  };

  const outDir = join(ROOT, 'sbom');
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, 'sbom.cdx.json');
  writeFileSync(outPath, JSON.stringify(sbom, null, 2) + '\n');

  console.log(`SBOM written to ${outPath}`);
  console.log(`  ${components.length} components across ${Object.keys(licenseData).length} licence families`);
  console.log(`  commit=${commitSha} build=${buildRef}`);
}

main();
