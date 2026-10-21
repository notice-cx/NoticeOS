import { ArrowDown, ArrowRight, Check, CircleHelp, CircleX, Folder } from 'lucide-react';
import type { ReactNode } from 'react';
import type { WorkflowRun, WorkflowsPayload } from '@shared/workflows';
import { formatNextRun, utcRunReference } from '@shared/scheduled-jobs';
import type { BackupLocation, BackupPart, BackupStatus } from '../../../../../packages/contract/src/backup-evidence.mjs';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { cn } from '@/lib/utils';

const PART: Record<BackupPart, { name: string; unit: string; folder: string }> = {
  postgres: { name: 'Operational database', unit: 'databases', folder: 'postgres/' },
  r2: { name: 'Reports and stored files', unit: 'files', folder: 'r2/' },
  taskHub: { name: 'Task databases', unit: 'databases', folder: 'beads/' },
  assets: { name: 'Site databases', unit: 'databases', folder: 'cloudflare-d1/ · assets/' },
  history: { name: 'Historical reports', unit: 'sets', folder: 'history/' },
  recovery: { name: 'Recovery keys and settings', unit: 'files', folder: 'recovery/' },
};
const STATUS: Record<BackupStatus, string> = { completed: 'Copied', failed: 'Failed', blocked: 'Not copied', not_configured: 'Not selected', unrecorded: 'Not recorded' };
function Status({ status, label }: { status: BackupStatus; label?: string }) {
  const Icon = status === 'completed' ? Check : status === 'failed' ? CircleX : CircleHelp;
  return <span className={cn('inline-flex items-center gap-1.5 text-sm font-medium', status === 'completed' ? 'text-healthy' : status === 'failed' || status === 'blocked' ? 'text-error' : 'text-muted-foreground')}>
    <Icon className="size-4 shrink-0" aria-hidden />{label ?? STATUS[status]}
  </span>;
}
function Destination({ name, location }: { name: string; location: BackupLocation }) {
  return <div className="min-w-0 space-y-2 p-4">
    <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="flex items-center gap-2 text-sm font-semibold"><Folder className="size-4" aria-hidden />{name}</h3><Status status={location.status} /></div>
    <p className="break-words font-mono text-xs [overflow-wrap:anywhere]">{location.path ?? (location.status === 'not_configured' ? 'No destination configured' : 'Folder path was not recorded for this run')}</p>
    {location.path && <p className="text-xs text-muted-foreground">{location.context === 'host' ? 'Folder on the host machine' : location.context === 'backup-worker' ? 'Path inside the backup worker; the host path was not recorded' : 'Recorded path; host mapping was not recorded'}</p>}
  </div>;
}
export function BackupExecutionDetails({ children }: { children: ReactNode }) {
  return <details className="border-t border-border pt-4"><summary className="cursor-pointer text-sm font-medium">Execution details</summary><div className="mt-4">{children}</div></details>;
}
export function BackupRunDetails({ run, captured, pending }: { run: WorkflowRun | null; captured: WorkflowsPayload['backup']; pending: boolean }) {
  const recorded = run && captured?.runId === run.id ? captured : null;
  if (!recorded) return <section aria-label="Backup contents" className="space-y-3 rounded-lg border border-border p-5">
    <h2 className="text-lg font-semibold">{pending ? 'Loading backup contents' : run?.state === 'running' ? 'Backup in progress' : !run ? 'No backup run available' : 'Backup contents unavailable'}</h2>
    <p className="text-sm text-muted-foreground">{pending ? 'Loading this run’s backup evidence.' : run?.state === 'running' ? 'Captured contents and destinations appear when this run finishes.' : !run ? 'Select a recorded run to inspect its contents and destinations.' : 'This run has no matching contents or destination record. Its success status alone does not establish which sites or offsite copies it contains.'}</p>
  </section>;
  const { evidence } = recorded;
  const sites = evidence.parts.find(part => part.id === 'assets')!;
  return <section aria-label="Backup contents" className="space-y-5">
    <div className="flex flex-wrap items-end justify-between gap-3 border-b border-border pb-4">
      <div><h2 className="text-2xl font-semibold">{evidence.complete ? 'Local backup complete' : 'Backup incomplete'}</h2>
        <p className="mt-1 text-sm text-muted-foreground">{sites.status === 'not_configured' ? 'No site databases were selected for this run.' : 'Contents captured by this execution.'}</p></div>
      <time dateTime={evidence.finishedAt} title={utcRunReference(evidence.finishedAt)} className="text-sm text-muted-foreground tabular-nums">{formatNextRun(evidence.finishedAt)}</time>
    </div>
    <div className="grid items-stretch overflow-hidden rounded-lg border border-border md:grid-cols-[1fr_auto_1fr]">
      <Destination name="Local backup set" location={evidence.local} />
      <span className="flex items-center justify-center border-y border-border px-2 py-1 md:border-x md:border-y-0"><ArrowRight className="hidden size-5 text-muted-foreground md:block" aria-hidden /><ArrowDown className="size-4 text-muted-foreground md:hidden" aria-hidden /></span>
      <Destination name="Sync-folder copy" location={evidence.offsite} />
    </div>
    <Table stacked aria-label="Captured backup contents"><TableHeader><TableRow><TableHead>Contents</TableHead><TableHead>Captured</TableHead><TableHead>Local set</TableHead><TableHead>Sync folder</TableHead></TableRow></TableHeader>
      <TableBody>{evidence.parts.map(part => <TableRow key={part.id}>
        <TableCell label="Contents"><span className="font-medium">{PART[part.id].name}</span><code className="mt-1 block text-xs text-muted-foreground">{PART[part.id].folder}</code>
          {part.targets.length > 0 && <p className="mt-1 break-words text-xs text-muted-foreground">{part.status === 'completed' ? 'Included' : 'Selected'}: {part.targets.join(', ')}{part.totalTargets > part.targets.length ? ` · ${part.totalTargets - part.targets.length} more` : ''}</p>}
        </TableCell>
        <TableCell label="Captured" className="tabular-nums">{part.status === 'not_configured' ? 'None selected' : part.status === 'unrecorded' ? 'Unknown' : <>{part.copied.toLocaleString()} / {part.expected?.toLocaleString() ?? '?'} <span className="text-xs text-muted-foreground">{PART[part.id].unit}</span></>}</TableCell>
        <TableCell label="Local set"><Status status={part.status === 'completed' ? evidence.local.status : part.status} /></TableCell>
        <TableCell label="Sync folder">{part.id === 'recovery' && part.status !== 'unrecorded' ? <span className="text-sm text-muted-foreground">Excluded</span> : <Status status={part.status === 'completed' ? evidence.offsite.status : part.status} />}</TableCell>
      </TableRow>)}</TableBody>
    </Table>
    <div className="flex flex-wrap gap-x-8 gap-y-2 border-y border-border py-3 text-sm text-muted-foreground"><span className="inline-flex items-center gap-2"><CircleHelp className="size-4" aria-hidden />Cloud upload: unverified</span><span className="inline-flex items-center gap-2"><CircleHelp className="size-4" aria-hidden />Restore test: unverified</span></div>
    <p className="text-xs text-muted-foreground">Recovery keys are excluded from sync-folder copies. Keep their recovery folder in your password manager.</p>
  </section>;
}
