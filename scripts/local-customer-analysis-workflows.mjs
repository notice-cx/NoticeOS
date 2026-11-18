import { analysisId } from './analysis-workflow-request.mjs';
import { loadCustomerWorkflowModule } from './local-customer-workflow-module.mjs';

const PREFIX = 'analysis-workflow-';

export function scheduledAnalysisId(job) {
  const id = job.startsWith(PREFIX) ? job.slice(PREFIX.length) : null;
  return analysisId(id) ? id : null;
}

export function localCustomerAnalysisWorkflows({ sourceRoot, root }) {
  let helpers;
  return Object.freeze({
    async targets(store) {
      return store.read(async tx => {
        const rows = await tx.query(`SELECT workflow_id, enabled, trigger_config, updated_at
          FROM noticeos.analysis_workflows WHERE workspace_id=$1::uuid AND trigger_config->>'kind'='weekly'
          ORDER BY workflow_id LIMIT 64`, [tx.workspaceId]);
        return rows.map(row => {
          const { weekday, hour, minute, timeZone } = JSON.parse(row.trigger_config);
          return { job: PREFIX + row.workflow_id, assets: [null], availableFrom: Date.parse(row.updated_at),
            schedule: { enabled: row.enabled, cron: `${minute} ${hour} * * ${weekday}`, timezone: timeZone } };
        });
      });
    },
    async run({ store, principalId, workflowId, scheduledAt }) {
      const { startAnalysisWorkflowRun, AnalysisWorkflowRefused } = await (helpers ??= loadCustomerWorkflowModule(sourceRoot, root, `
        export { AnalysisWorkflowRefused, startAnalysisWorkflowRun } from '../../../apps/tower/worker/analysis-workflow-store.ts';
      `).catch(error => { helpers = undefined; throw error; }));
      try {
        await startAnalysisWorkflowRun(store, workflowId, { source: 'weekly', scheduledAt }, { principalId });
      } catch (error) {
        if (!(error instanceof AnalysisWorkflowRefused) || ![404, 409].includes(error.status)) throw error;
      }
    },
  });
}
