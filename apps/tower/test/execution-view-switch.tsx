import { useView } from '@/hooks/useView';
import { VIEW_IDS } from '@shared/views';
import { useLocation } from 'react-router-dom';

export function ExecutionViewSwitch() {
  const { setChoice } = useView();
  const location = useLocation();
  return <nav aria-label="Test purpose views">{VIEW_IDS.map(view => <button key={view} onClick={() => setChoice({ view, focus: [] })}>Use {view}</button>)}<output data-testid="current-route">{location.pathname}{location.search}</output></nav>;
}
