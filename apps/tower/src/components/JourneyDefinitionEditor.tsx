import { useId, useLayoutEffect, useRef, useState } from "react";
import { ArrowDown, ArrowUp, Plus, X } from "lucide-react";
import { journeyDefinitionId, journeyDefinitionsRefusal, type JourneyDefinition, type JourneyStep } from "@noticeos/contract/journeys";
import { Button } from "@/components/ui/button";
import { fieldClass } from "@/components/ui/field";
import type { JourneyMonitorProps, JourneySaveOutcome } from "@/components/JourneyMonitor";
function JourneyEvents({ step, index, disabled, eventId, onChange }: {
    step: JourneyStep;
    index: number;
    disabled: boolean;
    eventId: string;
    onChange: (alternatives: JourneyStep["alternatives"]) => void;
}) {
    return <div>{step.alternatives.map((alternative, ai) => {
            const update = (change: Partial<JourneyStep["alternatives"][number]>) => onChange(step.alternatives.map((item, i) => i === ai ? { ...item, ...change } : item));
            return <div key={ai}>
      <div className="journey-event-row">
            <span>{ai === 0 ? "When" : "OR"}</span>
        <label>GA4 event *<input required className={fieldClass} list={eventId} value={alternative.eventName} disabled={disabled} onChange={(event) => update({ eventName: event.target.value })}/>
            </label>
        <label>Exact page path<input className={fieldClass} value={alternative.pagePath ?? ""} placeholder="/page" disabled={disabled} onChange={(event) => update({ pagePath: event.target.value })}/>
            </label>
        {step.alternatives.length > 1 ? <Button variant="ghost" size="icon" aria-label={`Remove alternative ${ai + 1} from step ${index + 1}`} disabled={disabled} onClick={() => onChange(step.alternatives.filter((_, i) => i !== ai))}>
                <X aria-hidden/>
                </Button> : null}
      </div>
      <div className="journey-event-filters">
        {(alternative.parameters ?? []).map((parameter, pi) => <div className="journey-filter-row" key={pi}>
          <label>Parameter name *<input required className={fieldClass} disabled={disabled} value={parameter.name} onChange={(event) => update({ parameters: alternative.parameters!.map((item, i) => i === pi ? { ...item, name: event.target.value } : item) })}/>
                </label>
          <label>Exact value *<input required className={fieldClass} disabled={disabled} value={parameter.value} onChange={(event) => update({ parameters: alternative.parameters!.map((item, i) => i === pi ? { ...item, value: event.target.value } : item) })}/>
                </label>
          <Button size="icon" variant="ghost" disabled={disabled} aria-label={`Remove parameter ${pi + 1} from alternative ${ai + 1}, step ${index + 1}`} onClick={() => update({ parameters: alternative.parameters!.filter((_, i) => i !== pi) })}>
                <X aria-hidden/>
                </Button>
        </div>)}
        <Button size="sm" variant="ghost" disabled={disabled || (alternative.parameters?.length ?? 0) >= 4} onClick={() => update({ parameters: [...(alternative.parameters ?? []), { name: "", value: "" }] })}>Add exact parameter</Button>
      </div>
    </div>;
        })}</div>;
}
const clone = (definition: JourneyDefinition): JourneyDefinition => JSON.parse(JSON.stringify(definition)) as JourneyDefinition;
function newDefinition(template: string, ids: readonly string[]): JourneyDefinition {
    let id = "journey";
    let number = 1;
    while (ids.includes(id))
        id = `journey-${++number}`;
    const planned = template === "Paid subscription" || template === "Exploration";
    const labels = template === "Account creation" ? ["Account entry", "Account created"]
        : template === "Activation" ? ["Account created", "First useful action"]
        : template === "Paid subscription" ? ["View offer", "Begin checkout", "First payment confirmed"]
        : template === "Exploration" ? ["Useful page", "Next useful destination"] : ["Entry", "Outcome"];
    const seconds = template === "Activation" ? 604800 : template === "Paid subscription" ? 2592000 : 86400;
    return {
        id, label: template === "Blank journey" ? "" : template,
        goal: template === "Blank journey" ? "Journey" : template,
        status: planned ? "planned" : "active", kind: template === "Exploration" ? "exploration" : "funnel", version: 1,
        steps: labels.map((label, i) => ({ id: `step-${i + 1}`, label, alternatives: [{ eventName: "" }], ...(i > 0 && template !== "Exploration" ? { withinSeconds: seconds } : {}) })),
    };
}
export function JourneyDefinitionEditor({ definition, definitions, eventNames, onSave, readOnlyReason, onClose, onSelected }: {
    definition: JourneyDefinition | null;
    definitions: readonly JourneyDefinition[];
    eventNames: readonly string[];
    onSave?: JourneyMonitorProps["onSave"];
    readOnlyReason?: string | null;
    onClose: () => void;
    onSelected: (id: string) => void;
}) {
    const [draft, setDraft] = useState(() => definition ? clone(definition) : newDefinition("Blank journey", definitions.map((item) => item.id)));
    const [saving, setSaving] = useState(false);
    const [message, setMessage] = useState<string | null>(null);
    const [undo, setUndo] = useState<JourneySaveOutcome["undo"]>();
    const [failed, setFailed] = useState(false);
    const [savedValue, setSavedValue] = useState<JourneyDefinition | null>(null);
    const [deleted, setDeleted] = useState(false);
    const eventId = useId();
    const editorRef = useRef<HTMLElement>(null);
    const pendingFocus = useRef<string | null>(null);
    useLayoutEffect(() => {
        if (pendingFocus.current) {
            editorRef.current?.querySelector<HTMLInputElement>(`[data-step-label="${pendingFocus.current}"]`)?.focus();
            pendingFocus.current = null;
        }
    }, [draft.steps]);
    const update = (index: number, change: Partial<JourneyDefinition["steps"][number]>) => setDraft((value) => ({ ...value, steps: value.steps.map((step, i) => i === index ? { ...step, ...change } : step) }));
    async function save() {
        if (!onSave)
            return;
        const next = clone(draft);
        next.label = next.label.trim();
        next.goal = next.goal.trim();
        next.steps = next.steps.map((step, i) => ({ ...step, label: step.label.trim(), ...(i === 0 ? { withinSeconds: undefined } : {}), alternatives: step.alternatives.map((a) => ({ eventName: a.eventName.trim(), ...(a.pagePath?.trim() ? { pagePath: a.pagePath.trim() } : {}), ...(a.parameters?.length ? { parameters: a.parameters.map((parameter) => ({ name: parameter.name.trim(), value: parameter.value.trim() })) } : {}) })) }));
        const previous = savedValue ?? definitions.find((item) => item.id === next.id);
        if (previous) {
            next.version = previous.version;
            if (journeyDefinitionId(next) !== journeyDefinitionId(previous))
                next.version++;
        }
        const list = definitions.some((item) => item.id === next.id) ? definitions.map((item) => item.id === next.id ? next : item) : [...definitions, next];
        const refusal = journeyDefinitionsRefusal(list);
        if (refusal) {
            setMessage(refusal);
            setFailed(true);
            return;
        }
        setSaving(true);
        setFailed(false);
        try {
            const outcome = await onSave(list);
            setMessage(outcome.saved ? "Saved" : outcome.refusal ?? "The definition could not be saved.");
            setFailed(!outcome.saved);
            if (outcome.saved) {
                setUndo(() => outcome.undo);
                setSavedValue(next);
                onSelected(next.id);
            }
        }
        catch {
            setMessage("The definition could not be saved.");
            setFailed(true);
        }
        finally {
            setSaving(false);
        }
    }
    async function revert() { if (!undo)
        return; setSaving(true); try {
        const outcome = await undo();
        setFailed(!outcome.undone);
        setMessage(outcome.undone ? "Previous definition restored" : outcome.refusal ?? "Undo was refused.");
        if (outcome.undone) {
            setUndo(undefined);
            setSavedValue(null);
            setDeleted(false);
            if (definition)
                setDraft(clone(definition));
        }
    }
    finally {
        setSaving(false);
    } }
    async function remove() {
        if (!onSave || !definition)
            return;
        setSaving(true);
        try {
            const outcome = await onSave(definitions.filter((item) => item.id !== definition.id));
            setFailed(!outcome.saved);
            setMessage(outcome.saved ? "Journey removed" : outcome.refusal ?? "The journey could not be removed.");
            if (outcome.saved) {
                setUndo(() => outcome.undo);
                setDeleted(true);
            }
        }
        finally {
            setSaving(false);
        }
    }
    const disabled = saving || !onSave || deleted;
    return <section ref={editorRef} className="journey-editor" aria-label="Journey definition">
    <div className="journey-editor-heading">
    <div>
    <div className="journey-eyebrow">{definition ? "EDIT DEFINITION" : "CREATE JOURNEY"}</div>
    <h3>{definition ? definition.label : "New journey"}</h3>
    </div>
    <Button variant="ghost" size="sm" onClick={onClose}>Close</Button>
    </div>{!definition ? <label>Start from<select className={fieldClass} disabled={disabled} onChange={(event) => setDraft(newDefinition(event.target.value, definitions.map((item) => item.id)))}>{["Blank journey", "Account creation", "Activation", "Paid subscription", "Exploration"].map((template) => <option key={template}>{template}</option>)}</select>
        </label> : null}<div className="journey-editor-fields">
    <label>Journey name *<input required className={fieldClass} disabled={disabled} value={draft.label} onChange={(event) => setDraft({ ...draft, label: event.target.value })}/>
    </label>
    <label>Goal *<input required className={fieldClass} disabled={disabled} value={draft.goal} onChange={(event) => setDraft({ ...draft, goal: event.target.value })}/>
    </label>
    <label>Status<select className={fieldClass} disabled={disabled} value={draft.status} onChange={(event) => setDraft({ ...draft, status: event.target.value as JourneyDefinition["status"] })}>
    <option value="active">Active</option>
    <option value="planned">Planned</option>
    </select>
    </label>
    <label>Measurement<select className={fieldClass} disabled={disabled} value={draft.kind} onChange={(event) => setDraft({ ...draft, kind: event.target.value as JourneyDefinition["kind"] })}>
    <option value="funnel">Ordered users</option>
    <option value="exploration">Session exploration</option>
    </select>
    </label>
    </div><p className="journey-editor-note">Active journeys are collected with the daily Google Analytics report. Planned journeys are saved without collection.</p>{draft.kind === "exploration" ? <p className="journey-editor-note">Session paths require separate collection. These definitions do not produce ordered user conversion reports.</p> : <p className="journey-editor-note">Each step may match any of its event alternatives. A page path matches exactly. Time limits apply from the preceding step.</p>}<p className="journey-editor-note">Event suggestions come from this asset’s declarations. Enter other GA4 event names directly.</p><datalist id={eventId}>{eventNames.map((event) => <option key={event} value={event}/>)}</datalist>
    <ol className="journey-editor-steps">{draft.steps.map((step, index) => <li key={step.id}>
        <div className="journey-edit-step-heading">
        <span>{index + 1}</span>
        <label>Business label *<input data-step-label={step.id} className={fieldClass} required disabled={disabled} value={step.label} onChange={(event) => update(index, { label: event.target.value })}/>
        </label>
        <div>{[-1, 1].map((direction) => <Button key={direction} variant="ghost" size="icon" disabled={disabled || index + direction < 0 || index + direction >= draft.steps.length} aria-label={`Move step ${index + 1} ${direction === -1 ? "up" : "down"}`} onClick={() => { pendingFocus.current = step.id; const steps = [...draft.steps]; [steps[index], steps[index + direction]] = [steps[index + direction]!, steps[index]!]; setDraft({ ...draft, steps: steps.map((item, i) => i === 0 ? { ...item, withinSeconds: undefined } : item) }); }}>{direction === -1 ? <ArrowUp aria-hidden/> : <ArrowDown aria-hidden/>}</Button>)}<Button variant="ghost" size="icon" disabled={disabled || draft.steps.length <= 2} aria-label={`Remove step ${index + 1}`} onClick={() => setDraft({ ...draft, steps: draft.steps.filter((_, i) => i !== index) })}>
        <X aria-hidden/>
        </Button>
        </div>
        </div>
        <JourneyEvents step={step} index={index} disabled={disabled} eventId={eventId} onChange={(alternatives) => update(index, { alternatives })}/>
        <div className="journey-step-options">
        <Button variant="ghost" size="sm" disabled={disabled || step.alternatives.length >= 8} onClick={() => update(index, { alternatives: [...step.alternatives, { eventName: "" }] })}>Add OR event</Button>{index > 0 ? <label>Within<select className={fieldClass} value={step.withinSeconds ?? ""} disabled={disabled} onChange={(event) => update(index, { withinSeconds: event.target.value ? Number(event.target.value) : undefined })}>
            <option value="">No step time limit</option>{[3600, 86400, 604800, 2592000].map((seconds) => <option key={seconds} value={seconds}>{seconds === 3600 ? "1 hour" : seconds === 86400 ? "1 day" : `${seconds / 86400} days`}</option>)}{step.withinSeconds && ![3600, 86400, 604800, 2592000].includes(step.withinSeconds) ? <option value={step.withinSeconds}>{step.withinSeconds} seconds</option> : null}</select>
            </label> : null}</div>
        </li>)}</ol>
    <div className="journey-editor-footer">
    <Button variant="outline" size="sm" disabled={disabled || draft.steps.length >= 10} onClick={() => { let id = `step-${draft.steps.length + 1}`; while (draft.steps.some((step) => step.id === id))
        id += "-new"; setDraft({ ...draft, steps: [...draft.steps, { id, label: "", alternatives: [{ eventName: "" }], withinSeconds: 86400 }] }); }}>
    <Plus aria-hidden/>Add step</Button>
    <Button size="sm" disabled={disabled} onClick={() => void save()}>{saving ? "Saving…" : "Save definition"}</Button>{definition ? <Button size="sm" variant="ghost" disabled={disabled} onClick={() => void remove()}>Remove journey</Button> : null}{undo ? <Button size="sm" variant="ghost" disabled={saving} onClick={() => void revert()}>Undo</Button> : null}{message ? <span data-status-for="field:journeys" role={failed ? "alert" : "status"} className={failed ? "text-error" : "text-muted-foreground"}>{message}</span> : null}</div>{!onSave ? <p className="journey-editor-note">{readOnlyReason ?? "Settings cannot be saved right now."}</p> : null}</section>;
}
