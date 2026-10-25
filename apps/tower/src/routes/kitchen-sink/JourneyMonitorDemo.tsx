import { useState } from "react";
import { JourneyMonitor } from "@/components/JourneyMonitor";
import { JOURNEY_DEMO_DEFINITIONS, JOURNEY_DEMO_SNAPSHOT } from "./journey-fixture";
export function JourneyMonitorDemo() {
    const [definitions, setDefinitions] = useState(JOURNEY_DEMO_DEFINITIONS);
    return <JourneyMonitor illustrative definitions={definitions} snapshot={{ ...JOURNEY_DEMO_SNAPSHOT, definitions }} eventNames={["page_view", "calculation_complete", "plan_save_click", "auth_initiate", "sign_up", "plan_save", "tracker_log"]} onSave={async (next) => {
            const previous = definitions;
            setDefinitions(next);
            return { saved: true, undo: async () => { setDefinitions(previous); return { undone: true }; } };
        }}/>;
}
