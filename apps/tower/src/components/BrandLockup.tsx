import { cn } from "@/lib/utils";

/** The Notice mark (D35): the N cut by a square notch, as www.notice.cx draws
 * it. Drawn in the current ink, so it is dark on light surfaces and light on
 * dark ones, and crisp at every size from the phone header to the TV. The
 * same shape ships as a file at public/brand/notice-mark.svg. */
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

/** The NoticeOS lockup: the Notice mark and the wordmark set in Stack Sans
 * Notch. One identity for desk navigation, the phone's header and the TV. */
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
