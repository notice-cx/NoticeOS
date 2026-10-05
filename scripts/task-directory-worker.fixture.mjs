// Fixture-only endpoint. Its inputs never define a production task capability.
import { openTaskDirectory } from '../packages/postgres/src/task-directory.mjs';

export default {
  async fetch(request, env) {
    const reader = openTaskDirectory({ connectionString: env.FIXTURE_CONNECTION });
    try {
      const url = new URL(request.url);
      const facts = await reader.project(url.searchParams.get('workspace'), url.searchParams.get('project'));
      return Response.json(facts);
    } catch {
      return Response.json({ refused: true }, { status: 403 });
    } finally {
      await reader.close();
    }
  },
};
