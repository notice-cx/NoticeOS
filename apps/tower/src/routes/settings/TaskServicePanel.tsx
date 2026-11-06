import { useDemoReadonly } from "@/lib/browser-context";
import { useQueryClient } from "@tanstack/react-query";
import { CircleDashed } from "lucide-react";
import { useState } from "react";
import type { TaskServiceStatus } from "@shared/tasks";
import { connectBlockers } from "@shared/integrations-page";
import type { DerivedColumn } from "@/components/CollectionEditor";
import { SeverityDot } from "@/components/SeverityDot";
import { StateChip } from "@/components/StateChip";
import { Button } from "@/components/ui/button";
import { useConnections } from "@/hooks/useConnections";
import { INTEGRATION_HEALTH_KEY } from "@/hooks/useIntegrationHealth";
import { INTEGRATION_PROVIDERS_KEY, useIntegrationProviders } from "@/hooks/useIntegrationProviders";
import { TASK_SERVICE_KEY, useTaskService } from "@/hooks/useTaskService";
import { TASK_SOURCE_KEY } from "@/hooks/useTaskSource";
import { ProviderConnectPanel, providerPanelOpening, type ProviderPanelOpening } from "@/routes/integrations/ProviderConnectPanel";

/** Settings → Task projects' Ntasks row: whether this installation's tasks
 * live in an Ntasks Worker, where, and the connect panel Integrations opens
 * for its address and service credential. */
export function NtasksConnection() {
  const service = useTaskService();
  const providers = useIntegrationProviders();
  const { items } = useConnections();
  const demoReadonly = useDemoReadonly();
  const queryClient = useQueryClient();
  const [opened, setOpened] = useState<ProviderPanelOpening | null>(null);
  const status = providers.data?.providers.find((entry) => entry.provider.id === "ntasks") ?? null;
  const blockers = providers.data ? connectBlockers(providers.data) : [];
  const state = service.data?.connected;
  const checking = service.isPending;
  const changed = async () => {
    await Promise.all([INTEGRATION_PROVIDERS_KEY, INTEGRATION_HEALTH_KEY, TASK_SERVICE_KEY, TASK_SOURCE_KEY]
      .map((queryKey) => queryClient.invalidateQueries({ queryKey })));
  };
  return (
    <div className="flex flex-wrap items-center gap-3"
      data-ntasks-connection={checking ? "checking" : state === true ? "connected" : state === false ? "not-connected" : "unknown"}>
      <span className="font-medium">Ntasks</span>
      <StateChip tone={checking ? "na" : state === true ? "affirmative" : state === false ? "na" : "caution"}
        label={checking ? "Checking" : state === true ? "Connected" : state === false ? "Not connected" : "Unknown"} subject="tasks:ntasks" />
      {service.data?.origin ? <span className="min-w-0 break-all font-mono text-[11px] text-muted-foreground">{service.data.origin}</span> : null}
      {status && !demoReadonly ? (
        <Button type="button" size="sm" variant={state === true ? "outline" : "default"} onClick={() => setOpened(providerPanelOpening(status))}>
          {state === true ? "Manage" : "Connect"}
        </Button>
      ) : null}
      {status && opened ? (
        <ProviderConnectPanel status={status} opened={opened} asset={null} canConnect={blockers.length === 0} blockers={blockers}
          items={items ?? []} names={new Map()} onClose={() => setOpened(null)} onChanged={changed} />
      ) : null}
    </div>
  );
}

/** The Projects table's column while tasks live in Ntasks: the Ntasks
 * project holding each site's tasks, the one whose prefix the row carries. */
export function ntasksProjectColumn(status: TaskServiceStatus): DerivedColumn {
  const byAsset = new Map((status.projects ?? []).map((entry) => [entry.asset, entry]));
  return {
    name: "ntasks",
    label: "Ntasks project",
    render: (row) => {
      const entry = byAsset.get(row.key);
      // A row saved after the status was read is not in it yet: unknown, not unmapped.
      if (status.projects === null || entry === undefined) {
        return (
          <span className="inline-flex items-center gap-1 text-xs text-muted-foreground" title={status.reason} data-ntasks-project-unknown>
            <CircleDashed aria-hidden className="size-3.5 shrink-0" />
            Unknown
          </span>
        );
      }
      const project = entry.project;
      if (project === null) {
        return (
          <span className="inline-flex items-center gap-1.5 text-xs text-warn" data-ntasks-unmapped>
            <SeverityDot severity="warn" size="sm" />
            No project with this prefix
          </span>
        );
      }
      return <span className="text-sm text-foreground" data-ntasks-project={project.logicalKey}>{project.displayName}</span>;
    },
  };
}
