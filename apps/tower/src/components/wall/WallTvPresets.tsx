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
  useEffect(() => setFields(fieldsOf(selected)), [selected.id, selected.name, selected.width, selected.height, selected.scale]);
  const errors = errorsOf(fields);
  const valid = Object.keys(errors).length === 0;
  useEffect(() => { onValidityChange(valid); }, [valid, onValidityChange]);
  const viewport = wallTvViewport(selected);
  const update = (field: keyof Fields, text: string) => {
    const next = { ...fields, [field]: text };
    setFields(next);
    const valid = Object.keys(errorsOf(next)).length === 0;
    onValidityChange(valid);
    if (!valid) return;
    const changed: WallTvPreset = { ...selected, name: next.name, width: Number(next.width), height: Number(next.height), scale: Number(next.scale) };
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
      <label htmlFor="wall-tv-preset" className="font-medium">TV preset</label>
      <select id="wall-tv-preset" className={fieldClass} value={selected.id} disabled={disabled} onChange={event => onChange({ ...value, selectedId: event.target.value })}>{value.presets.map(preset => <option key={preset.id} value={preset.id}>{preset.name}</option>)}</select>
      <output className="text-xs tabular-nums text-muted-foreground" aria-live="polite" data-wall-tv-summary>{selected.width} × {selected.height} · {selected.scale}% scaling · {viewport.width} × {viewport.height} preview</output>
    </div>
    <details>
      <summary className="w-fit cursor-pointer text-sm font-medium">Edit presets</summary>
      <fieldset disabled={disabled} className="mt-3 flex flex-wrap items-start gap-3">
        <legend className="sr-only">Selected TV preset</legend>
        {([{ key: "name", label: "Preset name", type: "text", min: undefined, max: undefined }, { key: "width", label: "Width", type: "number", min: 640, max: 7680 }, { key: "height", label: "Height", type: "number", min: 360, max: 4320 }, { key: "scale", label: "Display scaling", type: "number", min: 50, max: 300 }] as const).map(field => <div key={field.key} className="flex flex-col gap-1">
          <label htmlFor={`wall-tv-${field.key}`}>{field.label}{field.key === "scale" ? " (%)" : field.key === "width" || field.key === "height" ? " (px)" : ""} *</label>
          <input id={`wall-tv-${field.key}`} aria-label={field.label} className={fieldClass} type={field.type} required value={fields[field.key]} min={field.min} max={field.max} step={field.type === "number" ? 1 : undefined} maxLength={field.key === "name" ? 60 : undefined} list={field.key === "scale" ? "wall-tv-scales" : undefined} aria-invalid={!!errors[field.key]} aria-describedby={errors[field.key] ? `wall-tv-${field.key}-error` : undefined} onChange={event => update(field.key, event.target.value)} />
          {errors[field.key] ? <p id={`wall-tv-${field.key}-error`} className="max-w-56 text-xs text-error" role="alert">{errors[field.key]}</p> : null}
        </div>)}
        <datalist id="wall-tv-scales">{[50, 75, 100, 125, 150, 175, 200, 225, 250, 300].map(scale => <option key={scale} value={scale} />)}</datalist>
        <div className="flex gap-2 self-center"><Button type="button" size="sm" variant="outline" disabled={disabled || !valid || value.presets.length >= 12} onClick={add}>Add preset</Button><Button type="button" size="sm" variant="ghost" disabled={disabled || value.presets.length <= 1} onClick={remove}>Remove preset</Button></div>
      </fieldset>
    </details>
  </section>;
}
