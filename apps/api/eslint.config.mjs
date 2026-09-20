import base from '../../eslint.config.base.mjs';

export default [
  ...base,
  {
    // `loadtest/` (ADR 0015) is a set of standalone CLI scripts run by hand
    // against a running API, not part of any service's request path -
    // printing progress to the terminal is its actual job, not a bypass of
    // the "secrets are never logged" logging path `no-console` guards
    // elsewhere in this project.
    files: ['loadtest/**/*.ts'],
    rules: { 'no-console': 'off' },
  },
  {
    // `demo/` (Phase 19, C9) is the same kind of standalone CLI script as
    // `loadtest/` above - printing progress against a real running stack is
    // the point, not a bypass of the request-path logging rule.
    files: ['demo/**/*.ts'],
    rules: { 'no-console': 'off' },
  },
];
