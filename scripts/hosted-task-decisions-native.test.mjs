import test from 'node:test';
import { withOwnedTaskProjects } from './test-fixtures/hosted-task-projects.mjs';

// No ordinary automated suite launches Docker or connects to an existing hub.
// This explicit fixture owns a new unique project and awaits exact cleanup.
test('pinned restricted human and gate verbs record decisions in owned projects', {
  skip: process.env.NOTICEOS_TEST_HOSTED_TASK_DECISIONS !== '1', timeout: 240000,
}, async () => {
  await withOwnedTaskProjects(async (_facts, controls) => controls.qualifyHumanDecisions());
});
