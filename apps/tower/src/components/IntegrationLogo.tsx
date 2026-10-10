import { CalendarDays, ListTodo, Plug } from "lucide-react";
import { BEADS } from "@shared/task-source";
import { useState } from "react";
import { cn } from "@/lib/utils";

const PROVIDER_LOGOS: Readonly<Record<string, string>> = {
  google: "/integrations/google.svg",
  "google-oauth-app": "/integrations/google.svg",
  "bing-webmaster": "/integrations/bing.png",
  dataforseo: "/integrations/dataforseo.png",
  clarity: "/integrations/clarity.png",
  posthog: "/integrations/posthog.svg",
  mediavine: "/integrations/mediavine.webp",
  discord: "/integrations/discord.svg",
};

/** Decorative identity beside a visible provider name; connection state is separate. */
export function IntegrationLogo({
  provider,
  size = "default",
  className,
}: {
  provider: string;
  size?: "small" | "default" | "large";
  className?: string;
}) {
  const source = Object.hasOwn(PROVIDER_LOGOS, provider)
    ? PROVIDER_LOGOS[provider]
    : undefined;
  const [failedSource, setFailedSource] = useState<string | null>(null);
  const showLogo = source !== undefined && source !== failedSource;
  // The task hub wears the Tasks glyph the sidebar uses.
  const Icon = provider === "calendar" ? CalendarDays : provider === BEADS ? ListTodo : Plug;
  return (
    <span
      aria-hidden
      className={cn("integration-logo", className)}
      data-provider-logo={provider}
      data-size={size}
      data-has-logo={showLogo}
    >
      {showLogo ? (
        <img
          src={source}
          alt=""
          width={40}
          height={40}
          className="integration-logo__image"
          onError={() => setFailedSource(source)}
        />
      ) : (
        <Icon className="integration-logo__glyph" />
      )}
    </span>
  );
}
