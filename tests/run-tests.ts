// Simple test runner using vite-node
type TestFn = () => Promise<void> | void;
const tests: { name: string; fn: TestFn }[] = [];
export function test(name: string, fn: TestFn) {
  tests.push({ name, fn });
}

async function main() {
  // Register all test suites
  await import('./suites/mapping.test');

  let passed = 0;
  let failed = 0;
  for (const t of tests) {
    try {
      await t.fn();
      console.log(`✓ ${t.name}`);
      passed++;
    } catch (e: any) {
      console.error(`✗ ${t.name}: ${e?.message || e}`);
      failed++;
    }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main();

