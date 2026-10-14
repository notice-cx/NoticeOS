import { useState } from "react";
import { agentMaker, type AgentMaker } from "@/lib/agent-work";
import { cn } from "@/lib/utils";

const MARKS: Readonly<Record<AgentMaker, string>> = {
  anthropic: "/agents/claude.svg",
  openai: "/agents/openai.png",
  google: "/agents/gemini.png",
};

/** Decorative identity beside a visible worker name: its maker's published
 * mark, else the name's first letter. */
export function AgentMark({
  name,
  models = [],
  size = "default",
  className,
}: {
  name: string;
  /** The models the worker named; a name that matches no maker is read by these. */
  models?: readonly (string | null)[];
  /** `feed` fills the Wall feed's glyph tile, so a row keeps its height. */
  size?: "small" | "default" | "feed";
  className?: string;
}) {
  const maker = agentMaker(name, models);
  const source = maker === null ? undefined : MARKS[maker];
  const [failedSource, setFailedSource] = useState<string | null>(null);
  const showMark = source !== undefined && source !== failedSource;
  return (
    <span
      aria-hidden
      className={cn("agent-mark", className)}
      data-agent-maker={maker ?? ""}
      data-size={size}
      data-has-mark={showMark}
    >
      {showMark ? (
        <img src={source} alt="" width={32} height={32} className="agent-mark__image" onError={() => setFailedSource(source)} />
      ) : (
        [...name.trim()][0]?.toUpperCase() ?? "?"
      )}
    </span>
  );
}
