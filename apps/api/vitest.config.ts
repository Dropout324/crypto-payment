import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';
import { coverage } from '../../vitest.coverage.base.mjs';

export default defineConfig({
  // Vitest's default esbuild transform does not implement
  // `emitDecoratorMetadata`, so `Reflect.getMetadata('design:paramtypes', ...)`
  // comes back empty for every controller method under test - Nest's
  // `ValidationPipe` relies on exactly that metadata to know which DTO class
  // to validate a `@Body()` against, and silently skips validation entirely
  // when it is missing (see `ValidationPipe.toValidate()`). Concretely this
  // meant every e2e test ran with `whitelist`/`forbidNonWhitelisted`/DTO
  // validation switched off - malformed or mass-assignment request bodies
  // reached services unchecked, even though the real `tsc`-compiled build
  // (which does emit this metadata) has always enforced it correctly in
  // production. `unplugin-swc` compiles test files through SWC instead, which
  // does emit design-type metadata, so tests now exercise the same
  // ValidationPipe behaviour production does.
  plugins: [
    swc.vite({
      jsc: {
        parser: { syntax: 'typescript', decorators: true },
        transform: { legacyDecorator: true, decoratorMetadata: true },
        target: 'es2022',
        keepClassNames: true,
      },
      module: { type: 'es6' },
    }),
  ],
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    setupFiles: ['./test/setup-env.ts'],
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
    coverage,
  },
});
