#!/usr/bin/env node
// Docker runtime smoke test (ADR 0021).
//
// Builds the four runtime targets (api/worker/monitor/web) from
// infrastructure/docker/Dockerfile, runs each one from its own image's own
// CMD as the `node` user (never source-mounted, never `debug`), and checks
// the same things a human would have to check by hand otherwise: the
// HEALTHCHECK reaches `healthy`, `/health`/`/ready`/`/metrics` answer on the
// right ports, `/metrics` is NOT reachable on api's public port, and a
// database-backed request (api login) actually round-trips.
//
// This exists because the bug it would have caught - `pnpm prune --prod`
// silently producing an image that builds fine and crashes on the first
// request - shipped and was claimed "verified" without ever running the
// runtime image. Building an image is not evidence it works; this script
// is the thing that actually runs it.
//
// Usage: node scripts/docker/smoke-test.mjs [--no-cache] [--keep]
//   --no-cache  build with `docker build --no-cache` (slow; proves the
//               build doesn't hang on a fresh cache, see ADR 0021)
//   --keep      don't remove the containers/network/postgres afterward
//               (useful for interactively poking at a failure)
//
// Requires Docker. Does not touch the host's local Postgres (ADR 0003) or
// any already-running dev containers - everything this script creates is
// named gateway-smoke-* on its own private network and is torn down on exit
// (unless --keep is passed).

import { spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const NO_CACHE = process.argv.includes('--no-cache');
const KEEP = process.argv.includes('--keep');

const NETWORK = 'gateway-smoke-net';
const POSTGRES = 'gateway-smoke-postgres';
const REDIS = 'gateway-smoke-redis';
const IMAGE_TAG = 'smoke';

const ENCRYPTION_KEY = 'YWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWE=';
const ENCRYPTION_KEY_ID = 'smoke-test';
const JWT_ACCESS_SECRET = 'a'.repeat(48);
const JWT_REFRESH_SECRET = 'b'.repeat(48);
const DATABASE_URL = `postgresql://gateway:gateway@${POSTGRES}:5432/gateway?schema=public`;

let failures = 0;
const cleanupNames = new Set();

function run(cmd, args, opts = {}) {
  const result = spawnSync(cmd, args, { encoding: 'utf8', ...opts });
  return result;
}

function must(cmd, args, opts = {}) {
  const result = run(cmd, args, opts);
  if (result.status !== 0) {
    throw new Error(`${cmd} ${args.join(' ')} failed (exit ${result.status}):\n${result.stdout}\n${result.stderr}`);
  }
  return result;
}

function check(name, condition, detail = '') {
  if (condition) {
    console.log(`  PASS  ${name}`);
  } else {
    console.log(`  FAIL  ${name}${detail ? ` - ${detail}` : ''}`);
    failures += 1;
  }
}

async function waitForHealthy(container, timeoutMs = 60_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const result = run('docker', ['inspect', container, '--format', '{{.State.Health.Status}}']);
    if (result.stdout.trim() === 'healthy') return true;
    if (result.stdout.trim() === 'unhealthy') return false;
    await delay(2000);
  }
  return false;
}

function httpGet(url) {
  const result = run('curl', ['-s', '-o', '-', '-w', '\n%{http_code}', url]);
  const output = result.stdout ?? '';
  const lastNewline = output.lastIndexOf('\n');
  return { body: output.slice(0, lastNewline), status: Number(output.slice(lastNewline + 1)) };
}

function httpPostJson(url, body) {
  const result = run('curl', ['-s', '-o', '-', '-w', '\n%{http_code}', '-X', 'POST', url, '-H', 'Content-Type: application/json', '-d', JSON.stringify(body)]);
  const output = result.stdout ?? '';
  const lastNewline = output.lastIndexOf('\n');
  return { body: output.slice(0, lastNewline), status: Number(output.slice(lastNewline + 1)) };
}

function dockerRun(name, image, { env = {}, ports = [] } = {}) {
  const args = ['run', '-d', '--name', name, '--network', NETWORK];
  for (const [k, v] of Object.entries(env)) args.push('-e', `${k}=${v}`);
  for (const [hostPort, containerPort] of ports) args.push('-p', `${hostPort}:${containerPort}`);
  args.push(image);
  must('docker', args);
  cleanupNames.add(name);
}

function cleanup() {
  if (KEEP) {
    console.log('\n--keep passed; leaving containers/network up for inspection.');
    console.log(`Containers: ${[...cleanupNames].join(', ')}, network: ${NETWORK}`);
    return;
  }
  for (const name of cleanupNames) run('docker', ['rm', '-f', name]);
  run('docker', ['network', 'rm', NETWORK]);
}

async function main() {
  console.log(`=== Docker runtime smoke test${NO_CACHE ? ' (--no-cache)' : ''} ===\n`);

  console.log('--- setup: network + postgres + redis ---');
  run('docker', ['network', 'rm', NETWORK]); // ignore failure if absent
  must('docker', ['network', 'create', NETWORK]);
  run('docker', ['rm', '-f', POSTGRES, REDIS]);
  dockerRun(POSTGRES, 'postgres:17-alpine', {
    env: { POSTGRES_USER: 'gateway', POSTGRES_PASSWORD: 'gateway', POSTGRES_DB: 'gateway' },
  });
  dockerRun(REDIS, 'redis:7-alpine', {});
  for (let i = 0; i < 30; i++) {
    const ready = run('docker', ['exec', POSTGRES, 'pg_isready', '-U', 'gateway', '-d', 'gateway']);
    if (ready.status === 0) break;
    await delay(1000);
  }

  console.log('--- building all four runtime targets ---');
  const targets = ['api', 'worker', 'monitor', 'web'];
  for (const target of targets) {
    const args = ['build', '-f', 'infrastructure/docker/Dockerfile', '--target', target, '-t', `gateway-${target}:${IMAGE_TAG}`, '.'];
    if (NO_CACHE) args.splice(1, 0, '--no-cache');
    console.log(`  building ${target}...`);
    must('docker', args, { cwd: process.cwd() });
  }

  console.log('\n--- migrating the smoke-test database ---');
  // Uses the `debug` target (has the full Prisma CLI + schema) purely as a
  // migration runner - never as a thing this script claims "is the runtime".
  must('docker', ['build', '-f', 'infrastructure/docker/Dockerfile', '--target', 'debug', '-t', `gateway-debug:${IMAGE_TAG}`, '.']);
  must('docker', [
    'run', '--rm', '--network', NETWORK,
    '-e', `DATABASE_URL=${DATABASE_URL}`,
    `gateway-debug:${IMAGE_TAG}`,
    'sh', '-c', 'cd /app && pnpm --filter @gateway/database migrate:deploy',
  ]);
  must('docker', [
    'run', '--rm', '--network', NETWORK,
    '-e', `DATABASE_URL=${DATABASE_URL}`, '-e', 'NODE_ENV=development', '-e', 'SEED_ALLOW_REMOTE=true',
    '-e', `ENCRYPTION_KEY=${ENCRYPTION_KEY}`, '-e', `ENCRYPTION_KEY_ID=${ENCRYPTION_KEY_ID}`,
    `gateway-debug:${IMAGE_TAG}`,
    'sh', '-c', 'cd /app && pnpm --filter @gateway/database exec tsx prisma/seed.ts',
  ]);

  // --- api ---
  console.log('\n--- api ---');
  dockerRun('gateway-smoke-api', `gateway-api:${IMAGE_TAG}`, {
    env: {
      DATABASE_URL, REDIS_URL: `redis://${REDIS}:6379`,
      JWT_ACCESS_SECRET, JWT_REFRESH_SECRET, ENCRYPTION_KEY, ENCRYPTION_KEY_ID,
      API_PORT: '4000', API_HOST: '0.0.0.0',
    },
    ports: [[14000, 4000], [19464, 9464]],
  });
  check('api container is running as `node`, not root', run('docker', ['exec', 'gateway-smoke-api', 'whoami']).stdout.trim() === 'node');
  const apiHealthy = await waitForHealthy('gateway-smoke-api');
  check('api HEALTHCHECK reaches healthy', apiHealthy);
  const apiHealth = httpGet('http://localhost:14000/v1/health');
  check('api GET /v1/health -> 200', apiHealth.status === 200, `got ${apiHealth.status}`);
  const apiMetricsPublic = httpGet('http://localhost:14000/metrics');
  check('api /metrics NOT served on the public port', apiMetricsPublic.status === 404, `got ${apiMetricsPublic.status}`);
  const apiMetricsOps = httpGet('http://localhost:19464/metrics');
  check('api /metrics served on the ops port', apiMetricsOps.status === 200, `got ${apiMetricsOps.status}`);
  // Login exercises argon2 (@node-rs/argon2) verification and a real Prisma
  // query in one request - the exact path `pnpm prune --prod` broke.
  const login = httpPostJson('http://localhost:14000/v1/auth/login', { email: 'merchant@example.test', password: 'DevPassword123!' });
  check('api POST /v1/auth/login -> 200 (argon2 + DB query)', login.status === 200, `got ${login.status}: ${login.body}`);

  // --- worker ---
  console.log('\n--- worker ---');
  dockerRun('gateway-smoke-worker', `gateway-worker:${IMAGE_TAG}`, {
    env: { DATABASE_URL, ENCRYPTION_KEY, ENCRYPTION_KEY_ID },
    ports: [[19465, 9465]],
  });
  const workerHealthy = await waitForHealthy('gateway-smoke-worker');
  check('worker HEALTHCHECK reaches healthy', workerHealthy);
  const workerReady = httpGet('http://localhost:19465/ready');
  check('worker GET /ready -> 200', workerReady.status === 200, `got ${workerReady.status}`);

  // --- monitor (idle: no RPC URLs configured, no RPC quota spent) ---
  console.log('\n--- monitor (idle mode) ---');
  dockerRun('gateway-smoke-monitor', `gateway-monitor:${IMAGE_TAG}`, {
    env: { DATABASE_URL },
    ports: [[19466, 9466]],
  });
  const monitorHealthy = await waitForHealthy('gateway-smoke-monitor');
  check('monitor HEALTHCHECK reaches healthy', monitorHealthy);
  const monitorReady = httpGet('http://localhost:19466/ready');
  check('monitor GET /ready -> 200', monitorReady.status === 200, `got ${monitorReady.status}`);

  // --- web ---
  console.log('\n--- web ---');
  dockerRun('gateway-smoke-web', `gateway-web:${IMAGE_TAG}`, { ports: [[13000, 3000], [19467, 9467]] });
  const webHealthy = await waitForHealthy('gateway-smoke-web');
  check('web HEALTHCHECK reaches healthy', webHealthy);
  const webHealth = httpGet('http://localhost:13000/health');
  check('web GET /health -> 200', webHealth.status === 200, `got ${webHealth.status}`);
  const webMetrics = httpGet('http://localhost:19467/metrics');
  check('web /metrics served on :9467', webMetrics.status === 200, `got ${webMetrics.status}`);

  // --- graceful shutdown: api, worker, monitor ---
  console.log('\n--- graceful shutdown (SIGTERM -> exit 0) ---');
  for (const name of ['gateway-smoke-api', 'gateway-smoke-worker', 'gateway-smoke-monitor']) {
    run('docker', ['kill', '--signal=TERM', name]);
    let status = 'running';
    for (let i = 0; i < 15; i++) {
      status = run('docker', ['inspect', name, '--format', '{{.State.Status}}']).stdout.trim();
      if (status === 'exited') break;
      await delay(1000);
    }
    const exitCode = run('docker', ['inspect', name, '--format', '{{.State.ExitCode}}']).stdout.trim();
    check(`${name} exits 0 on SIGTERM`, status === 'exited' && exitCode === '0', `status=${status} exitCode=${exitCode}`);
  }

  // --- image hygiene ---
  console.log('\n--- image hygiene ---');
  for (const target of targets) {
    const image = `gateway-${target}:${IMAGE_TAG}`;
    const leaked = run('docker', ['run', '--rm', image, 'sh', '-c', "find / -xdev -maxdepth 4 -iname '.env*' 2>/dev/null"]);
    check(`${target} image has no .env file`, leaked.stdout.trim() === '', leaked.stdout.trim());
    const size = run('docker', ['images', image, '--format', '{{.Size}}']).stdout.trim();
    console.log(`  ${target} image size: ${size}`);
  }

  console.log(`\n=== ${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`} ===`);
  cleanup();
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  cleanup();
  process.exit(1);
});
