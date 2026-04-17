import { afterEach } from 'vitest';

// jest-dom matchers + RTL `cleanup` only make sense in a DOM environment.
// This setup file runs for every test — .test.ts files run in `node` and have
// no `document`, so we gate the imports and afterEach on that check.
if (typeof document !== 'undefined') {
  // Dynamic imports so the jest-dom + RTL modules aren't evaluated at all in
  // node-only test runs (they probe for DOM globals during initialization).
  await import('@testing-library/jest-dom/vitest');
  const { cleanup } = await import('@testing-library/react');
  afterEach(() => {
    cleanup();
  });
}
