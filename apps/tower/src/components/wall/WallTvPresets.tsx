import { useEffect, useState } from "react";
import { wallTvViewport, type WallTvPreset, type WallTvPreview } from "@shared/wall-layout";
import { Button } from "@/components/ui/button";
import { fieldClass } from "@/components/ui/field";

interface Fields { name: string; width: string; height: string; scale: string }
export interface WallTvPresetsProps {
  value: WallTvPreview;
  onChange: (value: WallTvPreview) => void;
  onValidityChange: (valid: boolean) => void;
  disabled?: boolean;
}
const fieldsOf = (preset: WallTvPreset): Fields => ({ name: preset.name, width: String(preset.width), height: String(preset.height), scale: String(preset.scale) });
const RESOLUTIONS = [
  { id: "720p", label: "720p", width: 1280, height: 720 },
  { id: "1080p", label: "1080p", width: 1920, height: 1080 },
  { id: "1440p", label: "1440p", width: 2560, height: 1440 },
  { id: "4k", label: "4K", width: 3840, height: 2160 },
  { id: "8k", label: "8K", width: 7680, height: 4320 },
] as const;
const SCALES = [50, 75, 100, 125, 150, 175, 200, 225, 250, 300];
const automaticName = (preset: WallTvPreset) => `${RESOLUTIONS.find(resolution => resolution.width === preset.width && resolution.height === preset.height)?.label ?? `${preset.width} × ${preset.height}`} · ${preset.scale}%`;
function errorsOf(fields: Fields): Partial<Record<keyof Fields, string>> {
  const errors: Partial<Record<keyof Fields, string>> = {};
  if (!fields.name.trim() || fields.name.length > 60) errors.name = "Enter a name of 1–60 characters.";
  for (const [field, minimum, maximum] of [["width", 640, 7680], ["height", 360, 4320], ["scale", 50, 300]] as const) {
    if (!fields[field].trim() || !Number.isInteger(Number(fields[field])) || Number(fields[field]) < minimum || Number(fields[field]) > maximum) errors[field] = `Enter a whole number from ${minimum} to ${maximum}.`;
  }
  if (!errors.width && !errors.height && !errors.scale) {
    const viewport = wallTvViewport({ id: "draft", name: fields.name, width: Number(fields.width), height: Number(fields.height), scale: Number(fields.scale) });
    if (viewport.width < 320 || viewport.height < 180) errors.scale = "Keep the preview at least 320 × 180.";
  }
  return errors;
}

export function WallTvPresets({ value, onChange, onValidityChange, disabled = false }: WallTvPresetsProps) {
  const selected = value.presets.find(preset => preset.id === value.selectedId) ?? value.presets[0]!;
  const [fields, setFields] = useState<Fields>(() => fieldsOf(selected));
  const [customResolution, setCustomResolution] = useState(false);
  const [customScaling, setCustomScaling] = useState(false);
  useEffect(() => setFields(fieldsOf(selected)), [selected.id, selected.name, selected.width, selected.height, selected.scale]);
  useEffect(() => { setCustomResolution(false); setCustomScaling(false); }, [selected.id]);
  const errors = errorsOf(fields);
  const valid = Object.keys(errors).length === 0;
  useEffect(() => { onValidityChange(valid); }, [valid, onValidityChange]);
  const viewport = wallTvViewport(selected);
  const resolution = RESOLUTIONS.find(resolution => resolution.width === Number(fields.width) && resolution.height === Number(fields.height));
  const showResolutionInputs = customResolution || !resolution;
  const showScalingInput = customScaling || !SCALES.includes(Number(fields.scale));
  const update = (patch: Partial<Fields>) => {
    const next = { ...fields, ...patch };
    setFields(next);
    const valid = Object.keys(errorsOf(next)).length === 0;
    onValidityChange(valid);
    if (!valid) return;
    const changed: WallTvPreset = { ...selected, name: next.name, width: Number(next.width), height: Number(next.height), scale: Number(next.scale) };
    if (next.name === selected.name && selected.name === automaticName(selected)) changed.name = automaticName(changed);
    onChange({ ...value, presets: value.presets.map(preset => preset.id === selected.id ? changed : preset) });
  };
  const add = () => {
    const ids = new Set(value.presets.map(preset => preset.id));
    let number = 1;
    while (ids.has(`tv-${number}`)) number++;
    const id = `tv-${number}`;
    onChange({ selectedId: id, presets: [...value.presets, { ...selected, id, name: selected.name.length <= 55 ? `${selected.name} copy` : "New TV" }] });
  };
  const remove = () => {
    const presets = value.presets.filter(preset => preset.id !== selected.id);
    if (!presets.length) return;
    onChange({ selectedId: presets[Math.min(value.presets.findIndex(preset => preset.id === selected.id), presets.length - 1)]!.id, presets });
  };
  return <section className="flex min-w-0 flex-col gap-2 text-sm" data-wall-tv-presets>
    <div className="flex flex-wrap items-center gap-3">
      <div className="flex min-w-0 max-w-full items-center gap-2">
      <label htmlFor="wall-tv-preset" className="font-medium">TV preset</label>
      <select id="wall-tv-preset" className={`${fieldClass} min-w-0`} value={selected.id} disabled={disabled} onChange={event => onChange({ ...value, selectedId: event.target.value })}>{value.presets.map(preset => <option key={preset.id} value={preset.id}>{preset.name}</option>)}</select>
      </div>
      <div className="flex min-w-0 max-w-full items-center gap-2">
      <label htmlFor="wall-tv-resolution" className="font-medium">Resolution</label>
      <select id="wall-tv-resolution" className={fieldClass} disabled={disabled} value={showResolutionInputs ? "custom" : resolution!.id} onChange={event => {
        if (event.target.value === "custom") { setCustomResolution(true); return; }
        const resolution = RESOLUTIONS.find(resolution => resolution.id === event.target.value)!;
        setCustomResolution(false);
        update({ width: String(resolution.width), height: String(resolution.height) });
      }}>{RESOLUTIONS.map(resolution => <option key={resolution.id} value={resolution.id}>{resolution.label} · {resolution.width} × {resolution.height}</option>)}<option value="custom">Custom</option></select>
      </div>
      <div className="flex min-w-0 max-w-full items-center gap-2">
      <label htmlFor="wall-tv-scaling" className="font-medium">Display scaling</label>
      <select id="wall-tv-scaling" className={fieldClass} disabled={disabled} value={showScalingInput ? "custom" : fields.scale} aria-invalid={!!errors.scale} aria-describedby={!showScalingInput && errors.scale ? "wall-tv-scale-error" : undefined} onChange={event => {
        if (event.target.value === "custom") { setCustomScaling(true); return; }
        setCustomScaling(false);
        update({ scale: event.target.value });
      }}>{SCALES.map(scale => <option key={scale} value={String(scale)}>{scale}%</option>)}<option value="custom">Custom</option></select>
      </div>
      <output className="text-xs tabular-nums text-muted-foreground" aria-live="polite" data-wall-tv-summary>{selected.width} × {selected.height} · {selected.scale}% scaling · {viewport.width} × {viewport.height} preview</output>
    </div>
    {!showScalingInput && errors.scale ? <p id="wall-tv-scale-error" className="text-xs text-error" role="alert">{errors.scale}</p> : null}
    {showResolutionInputs || showScalingInput ? <fieldset disabled={disabled} className="flex flex-wrap gap-3" aria-label="Custom display settings">
      {([{ key: "width", label: "Width", min: 640, max: 7680 }, { key: "height", label: "Height", min: 360, max: 4320 }, { key: "scale", label: "Custom scaling", min: 50, max: 300 }] as const).filter(field => field.key === "scale" ? showScalingInput : showResolutionInputs).map(field => <div key={field.key} className="flex flex-col gap-1">
        <label htmlFor={`wall-tv-${field.key}`}>{field.label}{field.key === "scale" ? " (%)" : " (px)"} *</label>
        <input id={`wall-tv-${field.key}`} aria-label={field.label} className={fieldClass} type="number" required value={fields[field.key]} min={field.min} max={field.max} step={1} aria-invalid={!!errors[field.key]} aria-describedby={errors[field.key] ? `wall-tv-${field.key}-error` : undefined} onChange={event => update({ [field.key]: event.target.value })} />
        {errors[field.key] ? <p id={`wall-tv-${field.key}-error`} className="max-w-56 text-xs text-error" role="alert">{errors[field.key]}</p> : null}
      </div>)}
    </fieldset> : null}
    <details>
      <summary className="w-fit cursor-pointer text-sm font-medium">Edit presets</summary>
      <fieldset disabled={disabled} className="mt-3 flex flex-wrap items-start gap-3">
        <legend className="sr-only">Selected TV preset</legend>
        <div className="flex flex-col gap-1"><label htmlFor="wall-tv-name">Preset name *</label><input id="wall-tv-name" aria-label="Preset name" className={fieldClass} required value={fields.name} maxLength={60} aria-invalid={!!errors.name} aria-describedby={errors.name ? "wall-tv-name-error" : undefined} onChange={event => update({ name: event.target.value })} />{errors.name ? <p id="wall-tv-name-error" className="max-w-56 text-xs text-error" role="alert">{errors.name}</p> : null}</div>
        <div className="flex gap-2 self-center"><Button type="button" size="sm" variant="outline" disabled={disabled || !valid || value.presets.length >= 12} onClick={add}>Add preset</Button><Button type="button" size="sm" variant="ghost" disabled={disabled || value.presets.length <= 1} onClick={remove}>Remove preset</Button></div>
      </fieldset>
    </details>
  </section>;
}
