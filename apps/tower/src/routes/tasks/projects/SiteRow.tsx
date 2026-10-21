import { Link } from "react-router-dom";
import { siteAddress } from "@shared/first-run";
import { formatInt } from "@/lib/format";
import { cn } from "@/lib/utils";
import { ProjectCard } from "./ProjectCard";
import { SiteMark } from "./project-face";
import type { ProjectRecord, SiteProjects } from "./project-model";

/** The All tasks list narrowed to one site's project. */
export function siteTasksPath(asset: string): string {
  return `/tasks/all?${new URLSearchParams({ project: asset })}`;
}

/** A count the snapshot's sample can only bound from below. */
export function countWord(n: number, complete: boolean): string {
  return `${formatInt(n)}${complete ? "" : "+"}`;
}

/**
 * One site's projects: the site and what it asks of the operator on the left,
 * its project cards on the right, each card as wide as its open work. Below a
 * phone's width the two stack.
 */
export function SiteRow({ group, cardHref, projectScope }: {
  group: SiteProjects;
  cardHref: (record: ProjectRecord) => string;
  projectScope?: string;
}) {
  const { site } = group;
  return (
    <div className="flex flex-wrap gap-x-5 gap-y-3 border-t border-border py-4" data-site-row={site.asset}>
      <div className="flex w-[232px] shrink-0 flex-col gap-1 max-sm:w-full">
        <Link to={siteAddress(site.asset)} className="flex min-w-0 items-center gap-2 text-sm font-semibold text-foreground underline-offset-4 hover:underline">
          <SiteMark asset={site.asset} name={site.name} />
          <span className="min-w-0 [overflow-wrap:anywhere]">{site.name}</span>
        </Link>
        <span className="flex flex-wrap gap-x-2 text-xs tabular-nums" data-site-state="">
          {group.unread ? <span className="text-warn">Couldn't read its tasks</span> : (
            <>
              {group.forYou > 0 ? <span className="font-medium text-warn">{formatInt(group.forYou)} for you</span> : null}
              <span className="text-muted-foreground">{countWord(group.open, group.complete)} open</span>
            </>
          )}
        </span>
      </div>
      <SiteProjectCards group={group} cardHref={cardHref} projectScope={projectScope} className="min-w-0 flex-1 basis-[280px]" />
    </div>
  );
}

/** A site's cards, then its work outside any project as one line. */
export function SiteProjectCards({ group, cardHref, projectScope, className }: {
  group: SiteProjects;
  cardHref: (record: ProjectRecord) => string;
  projectScope?: string;
  className?: string;
}) {
  if (group.unread) return null;
  const link = "text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline";
  if (group.projects.length === 0) {
    return (
      <div className={cn("flex items-center", className)}>
        <Link to={siteTasksPath(group.site.asset)} className={link} data-site-no-projects="">
          No projects yet · {countWord(group.loose, group.complete)} {group.loose === 1 && group.complete ? "task" : "tasks"}
        </Link>
      </div>
    );
  }
  return (
    <div className={cn("flex flex-wrap items-stretch gap-3", className)}>
      {group.projects.map((record) => (
        <ProjectCard key={record.id} record={record} href={cardHref(record)} projectScope={projectScope} />
      ))}
      {group.loose > 0 ? (
        <Link to={siteTasksPath(group.site.asset)} className={cn(link, "self-center text-xs")} data-site-loose={group.loose}>
          Not in a project · {countWord(group.loose, group.complete)} open
        </Link>
      ) : null}
    </div>
  );
}
