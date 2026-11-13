import { Link } from "react-router-dom";
import { DISCORD_REVENUE_KEY, TOWER_CONFIG_FILES } from "@noticeos/contract/configuration";
import { KnobEditor } from "@/components/KnobEditor";
import { SettingsPanel } from "./SettingsPanel";

export function NotificationsPanel({ dailyRevenue }: { dailyRevenue: boolean }) {
  return (
    <SettingsPanel id="discord" title="Discord" aside={
      <Link to="/integrations?provider=discord" className="text-sm underline underline-offset-4">Manage Discord connection</Link>
    }>
      <KnobEditor
        label="Daily revenue"
        explain="When an asset’s daily revenue first arrives, send its amount, collection time, week-over-week change, and month outlook."
        current={dailyRevenue}
        format={(value) => value === true ? "On" : "Off"}
        makeOp={(value, current) => ({
          kind: "file-json-set",
          file: TOWER_CONFIG_FILES.constants,
          pointer: `/${DISCORD_REVENUE_KEY}`,
          expect: current,
          value,
        })}
        control={{ type: "toggle", onValue: true, offValue: false, onLabel: "On", offLabel: "Off", groupLabel: "Daily revenue" }}
        slug="discord-revenue"
        autosave
        statesReadOnly={false}
      />
    </SettingsPanel>
  );
}
