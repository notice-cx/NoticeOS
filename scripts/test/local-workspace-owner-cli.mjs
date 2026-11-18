import { installScriptTestConfigGuard } from '../test-config-isolation.mjs';

if (!installScriptTestConfigGuard({ testFile: new URL('../local-customer-ntasks.test.mjs', import.meta.url) })) {
  throw new Error('The operator CLI must use frozen fixture configuration.');
}
