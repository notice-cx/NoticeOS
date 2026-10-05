import test from 'node:test';
import { withOwnedTaskProjects } from './test-fixtures/hosted-task-projects.mjs';

// Ordinary suites never start Docker. This explicit opt-in owns a new synthetic
// project; the helper seals exact tools, grants and awaited outer cleanup.
test(process.env.NOTICEOS_TEST_HOSTED_TASK_COMMENTS === '1'
  ? 'bounded repeated restricted comments retain every outcome without retries'
  : 'fixed hosted executor qualifies initialized restricted task projects', {
  skip: process.env.NOTICEOS_TEST_HOSTED_TASK_EXECUTOR !== '1', timeout: 240_000,
}, async () => {
  await withOwnedTaskProjects(async (_facts, controls) => process.env.NOTICEOS_TEST_HOSTED_TASK_COMMENTS === '1'
    ? controls.qualifyRepeatedComments() : controls.qualifyExecutor());
});
