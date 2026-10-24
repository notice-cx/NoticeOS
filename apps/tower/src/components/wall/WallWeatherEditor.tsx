import { useEffect, useId, useRef, useState } from "react";
import { wallWeatherSettings, type WallWeatherSettings } from "@shared/wall-layout";
import type { WeatherLocation } from "@shared/weather";
import { weatherClient } from "@/lib/weather";
import { useBrowserRuntime, useDemoReadonly } from "@/lib/browser-context";
import { Button } from "@/components/ui/button";

export interface WallWeatherEditorProps {
  value?: WallWeatherSettings;
  onChange: (value: WallWeatherSettings) => void;
  disabled?: boolean;
  searchLocations?: (query: string, signal?: AbortSignal) => Promise<WeatherLocation[]>;
}

/** City search supplies coordinates; the operator chooses a named place. */
export function WallWeatherEditor({ value, onChange, disabled: parentDisabled = false, searchLocations = weatherClient.searchLocations }: WallWeatherEditorProps) {
  const runtime = useBrowserRuntime();
  const demo = useDemoReadonly();
  const unavailable = runtime.owner.mode !== 'standalone' || demo;
  const disabled = parentDisabled || unavailable;
  const weather = wallWeatherSettings({ weather: value });
  const id = useId();
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<WeatherLocation[] | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), []);
  useEffect(() => {
    if (unavailable || !weather.enabled) {
      request.current?.abort(); request.current = null;
      setPending(false); setResults(null); setError(null);
    }
  }, [unavailable, weather.enabled]);
  const cancelSearch = () => {
    request.current?.abort(); request.current = null;
    setPending(false); setResults(null); setError(null);
  };
  const search = async () => {
    const text = query.trim();
    if (disabled || !weather.enabled || text.length < 2 || runtime.guard(() => true)() !== true) return;
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setPending(true); setError(null); setResults(null);
    try {
      const found = await runtime.queries.fetchQuery({
        queryKey: ['wall-weather-city-search', id, text],
        queryFn: ({ signal }) => searchLocations(text, AbortSignal.any([controller.signal, signal])),
        retry: false, staleTime: 0, gcTime: 0,
      });
      if (!controller.signal.aborted && runtime.guard(() => true)() === true) setResults(found);
    } catch {
      if (!controller.signal.aborted && runtime.guard(() => true)() === true) setError("City search is unavailable. Try again.");
    } finally {
      if (!controller.signal.aborted && runtime.guard(() => true)() === true) { setPending(false); request.current = null; }
    }
  };
  return <section className="flex flex-col gap-3 border-t border-border pt-3" data-wall-weather-editor>
    <h3 className="text-sm font-medium">Weather</h3>
    {unavailable ? <p className="text-xs text-muted-foreground">Weather is available for private and home TVs.</p> : null}
    <fieldset disabled={disabled} className="flex flex-wrap gap-3 text-sm">
      <legend className="sr-only">Weather</legend>
      {([true, false] as const).map(enabled => <label key={String(enabled)} className="flex items-center gap-1.5"><input type="radio" name={`${id}-enabled`} checked={weather.enabled === enabled} onChange={() => { if (!enabled) cancelSearch(); onChange({ ...weather, enabled }); }} />{enabled ? "On" : "Off"}</label>)}
    </fieldset>
    <fieldset disabled={disabled || !weather.enabled} className="flex flex-wrap gap-3 text-sm">
      <legend className="mb-1 text-xs text-muted-foreground">Temperature</legend>
      {([['fahrenheit', '°F'], ['celsius', '°C']] as const).map(([unit, label]) => <label key={unit} className="flex items-center gap-1.5"><input type="radio" name={`${id}-unit`} checked={weather.unit === unit} onChange={() => onChange({ ...weather, unit })} />{label}</label>)}
    </fieldset>
    <div className="flex flex-wrap gap-2" role="group" aria-label="Weather location">
      <Button type="button" size="sm" variant="outline" disabled={disabled || !weather.enabled} aria-pressed={weather.location.mode === 'automatic' && !searchOpen} onClick={() => { cancelSearch(); setSearchOpen(false); onChange({ ...weather, location: { mode: 'automatic' } }); }}>Automatic location</Button>
      <Button type="button" size="sm" variant="outline" disabled={disabled || !weather.enabled} aria-pressed={searchOpen || weather.location.mode === 'fixed'} onClick={() => setSearchOpen(true)}>Search city</Button>
    </div>
    <p className="text-xs text-muted-foreground" data-weather-location>{weather.location.mode === 'fixed' ? weather.location.name : "Approximate location from this TV’s public IP address"}</p>
    {searchOpen && weather.enabled ? <div className="flex flex-col gap-2">
      <label htmlFor={`${id}-city`} className="text-xs">City</label>
      <div className="flex gap-2">
        <input id={`${id}-city`} className="min-w-0 flex-1 rounded-md border border-input bg-background px-2 py-1 text-sm" value={query} disabled={disabled} onChange={event => { cancelSearch(); setQuery(event.target.value); }} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); void search(); } }} />
        <Button type="button" size="sm" variant="outline" disabled={disabled || pending || query.trim().length < 2} onClick={() => void search()}>Search</Button>
      </div>
      <div role="status" className="text-xs text-muted-foreground">{pending ? "Searching cities…" : error ?? (results?.length === 0 ? "No cities found. Try another name." : null)}</div>
      {results?.length ? <ul className="flex flex-col gap-1" aria-label="Matching cities">{results.map((location, index) => <li key={`${location.latitude}:${location.longitude}:${index}`}><Button type="button" size="sm" variant="outline" className="h-auto w-full justify-start whitespace-normal text-left" disabled={disabled} onClick={() => { onChange({ ...weather, location: { mode: 'fixed', name: location.name, latitude: location.latitude, longitude: location.longitude } }); cancelSearch(); setSearchOpen(false); }}>{location.name}</Button></li>)}</ul> : null}
    </div> : null}
    <p className="text-xs text-muted-foreground">Weather by <a className="underline" href="https://open-meteo.com/" target="_blank" rel="noreferrer">Open-Meteo</a>. The free service is for personal, non-commercial use.</p>
  </section>;
}
