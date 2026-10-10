import { cn } from "@/lib/utils";

/** The Notice mark, drawn in the current ink so it reads on light and dark
 * surfaces. The same shape ships as public/brand/notice-mark.svg. */
export function NoticeMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 354 394"
      className={cn("brand-mark", className)}
      aria-hidden
      focusable="false"
    >
      <path
        fillRule="evenodd"
        fill="currentColor"
        d="M0 0H354V394H0ZM100 0H237V137ZM117 137H237V257H117ZM117 257V394H254Z"
      />
    </svg>
  );
}

/** The mark and the wordmark: one identity for the desk, the phone and the TV. */
export function BrandLockup({
  size = "default",
  className,
}: {
  /** `text`: set in a line of words, at their size and on their baseline. */
  size?: "default" | "compact" | "text";
  className?: string;
}) {
  return (
    <span className={cn("brand-lockup", `brand-lockup--${size}`, className)}>
      <NoticeMark />
      <span className="brand-wordmark">
        Notice<span className="brand-os">OS</span>
      </span>
    </span>
  );
}
