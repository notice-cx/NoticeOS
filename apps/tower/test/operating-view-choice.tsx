import { useView } from "@/hooks/useView";
import { VIEW_IDS } from "@shared/views";

export function OperatingViewChoice() {
  const { setChoice } = useView();
  return <nav aria-label="Test view choice">{VIEW_IDS.map((view) => <button key={view} onClick={() => setChoice({ view, focus: [] })}>{`Choose ${view}`}</button>)}</nav>;
}
