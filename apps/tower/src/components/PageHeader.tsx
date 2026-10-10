import { Fragment, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { cn } from "@/lib/utils";
import { useDocumentTitle } from "@/lib/document-title";

export interface PageHeaderCrumb {
  label: string;
  to: string;
}

export interface PageHeaderProps {
  /** What this page is. A plain string, or a rich identity row (favicon, name,
   * severity dot, badges) — either way it is the page's one `h1`. */
  title: ReactNode;
  /** One line saying what the page answers. */
  description?: ReactNode;
  /** Where this page sits, above the title. Rendered small, separated by `/`. */
  breadcrumb?: PageHeaderCrumb[];
  /** Right-aligned page-level controls; wraps under the title on narrow widths. */
  actions?: ReactNode;
  /** A fact about the page rather than a control — an age badge, a period —
   * seated inline beside the description. */
  meta?: ReactNode;
  /** Full-width slot under the header, for tabs and section navigators. */
  children?: ReactNode;
  /** What the browser tab names this page, when `title` is not plain text.
   * `null` keeps the title the app shipped with (Home). */
  documentTitle?: string | null;
  className?: string;
}

/**
 * One page header for every desk surface. Navigation lives in the shell, so
 * there is no back link here. It is layout only: no state colour, chip or word
 * of its own.
 */
export function PageHeader({
  title,
  description,
  breadcrumb,
  actions,
  meta,
  children,
  documentTitle,
  className,
}: PageHeaderProps) {
  useDocumentTitle(documentTitle !== undefined ? documentTitle : typeof title === "string" ? title : null);
  return (
    <header className={cn("flex flex-col gap-2", className)} data-page-header>
      {breadcrumb && breadcrumb.length > 0 ? (
        <nav
          aria-label="Breadcrumb"
          className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground"
        >
          {breadcrumb.map((crumb, index) => (
            <Fragment key={crumb.to}>
              {index > 0 ? <span aria-hidden>/</span> : null}
              <Link
                to={crumb.to}
                // A crumb is a nav target, so the 44px phone floor covers it;
                // the negative margin hands the height back to the layout.
                className="underline-offset-4 outline-none hover:text-foreground hover:underline focus-visible:text-foreground focus-visible:underline max-sm:-my-3.5 max-sm:inline-flex max-sm:min-h-11 max-sm:min-w-11 max-sm:items-center"
              >
                {crumb.label}
              </Link>
            </Fragment>
          ))}
        </nav>
      ) : null}

      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="flex min-w-0 flex-col gap-1">
          <h1 className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-xl font-semibold">
            {title}
          </h1>
          {description || meta ? (
            <div className="flex flex-wrap items-center gap-2">
              {description ? (
                <p className="text-sm text-muted-foreground">{description}</p>
              ) : null}
              {meta}
            </div>
          ) : null}
        </div>
        {actions ? (
          <div className="flex flex-wrap items-center gap-2">{actions}</div>
        ) : null}
      </div>

      {children}
    </header>
  );
}

export default PageHeader;
