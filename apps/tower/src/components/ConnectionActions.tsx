import { KeyRound, Trash2, Unplug } from "lucide-react";
import { useState } from "react";
import { PropertyFavicon } from "@/components/PropertyFavicon";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/** A site a connection collects for, as the confirmation names it. */
export interface ConnectionSite {
  id: string;
  label: string;
  domain: string | null;
}

export interface ConnectionActionsProps {
  /** The provider's short name, for the confirming press ("Disconnect Bing
   * Webmaster Tools"). */
  name: string;
  /** What the secret is called (`secretNoun`): "API key", "login". Replace
   * is labelled with it, and the confirmation says it is deleted. Null offers
   * no Replace — a sign-in is renewed by signing in again. */
  secret: string | null;
  /** Open the replacement form. Absent: no Replace on this surface. */
  onReplace?: () => void;
  /** The form Replace opened is on screen. */
  replacing?: boolean;
  /** Replace cannot store anything on this install yet. */
  replaceDisabled?: boolean;
  /** The connection is failing: replacing its secret is the fix, so it leads. */
  failing?: boolean;
  /** The sites that stop collecting when the connection goes. */
  stops: readonly ConnectionSite[];
  /** Disconnecting also revokes a sign-in at the provider (Google). */
  revokesGrant?: boolean;
  onDisconnect: () => Promise<void>;
  /** Told when the confirmation opens and closes, so a panel can give it the
   * whole body. */
  onConfirming?: (open: boolean) => void;
  className?: string;
}

/**
 * THE CONNECTION'S OWN ACTIONS (bead `ro-ujb9.96.7.10`): Replace and
 * Disconnect, on the connection itself — the connect panel's connected view
 * and a provider's page — instead of a Settings step and a typed id.
 *
 * REPLACE (Stripe's roll key, Zapier's Reconnect) opens the key form; on a
 * provider that connects in the panel the new key is shown to the provider
 * before it is kept, so the old one keeps collecting until the new one passes.
 *
 * DISCONNECT keeps exactly one confirmation, because it cannot be undone: the
 * secret is deleted (and a Google grant revoked). The confirmation names what
 * stops — the sites, then what is deleted — as values, never a sentence, and
 * its press names the provider, so it can never be mistaken for the first.
 */
export function ConnectionActions({
  name,
  secret,
  onReplace,
  replacing = false,
  replaceDisabled = false,
  failing = false,
  stops,
  revokesGrant = false,
  onDisconnect,
  onConfirming,
  className,
}: ConnectionActionsProps) {
  const [confirming, setConfirming] = useState(false);
  const [working, setWorking] = useState(false);
  const [failed, setFailed] = useState(false);
  const open = (next: boolean) => {
    setConfirming(next);
    setFailed(false);
    onConfirming?.(next);
  };

  if (!confirming) {
    return (
      <div className={cn("flex flex-wrap items-center gap-2", className)} data-connection-actions>
        {secret && onReplace ? (
          <Button
            type="button"
            size="sm"
            variant={failing && !replacing ? "default" : "outline"}
            aria-pressed={replacing}
            disabled={replaceDisabled}
            className="aria-pressed:border-primary/40 aria-pressed:bg-accent-soft aria-pressed:text-primary"
            onClick={onReplace}
            data-connection-replace
          >
            <KeyRound aria-hidden />
            Replace {secret}
          </Button>
        ) : null}
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="text-error hover:bg-error-soft hover:text-error"
          onClick={() => open(true)}
          data-disconnect-open
        >
          <Unplug aria-hidden />
          Disconnect
        </Button>
      </div>
    );
  }

  return (
    <div
      role="group"
      aria-label={`Disconnect ${name}`}
      className={cn("flex w-full flex-col gap-3 rounded-lg border border-error/35 bg-error-soft p-3", className)}
      data-disconnect-confirm
    >
      {stops.length > 0 ? (
        <div className="flex flex-col gap-1.5" data-disconnect-stops>
          <span className="inline-flex items-center gap-1.5 text-xs font-medium text-error">
            <Unplug className="size-3.5 shrink-0" aria-hidden />
            Stops
          </span>
          <ul aria-label="Sites that stop" className="flex flex-wrap gap-x-3 gap-y-1">
            {stops.map((site) => (
              <li key={site.id} className="inline-flex min-w-0 items-center gap-1.5 text-sm" data-disconnect-stop={site.id}>
                <PropertyFavicon domain={site.domain ?? site.id} displayName={site.label} className="size-4" />
                <span className="truncate">{site.label}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <ul className="flex flex-col gap-1 text-xs text-muted-foreground" data-disconnect-effects>
        <li className="flex items-center gap-1.5">
          <Trash2 className="size-3.5 shrink-0" aria-hidden />
          {secret ? `${secret.charAt(0).toUpperCase()}${secret.slice(1)} deleted` : "Sign-in deleted"} · no undo
        </li>
        {revokesGrant ? (
          <li className="flex items-center gap-1.5">
            <Unplug className="size-3.5 shrink-0" aria-hidden />
            Google sign-in revoked
          </li>
        ) : null}
      </ul>
      {failed ? (
        <p className="text-xs text-error" data-disconnect-failure>
          Not disconnected · try again
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={working}
          autoFocus
          className="border-error/40 text-error hover:bg-error-soft hover:text-error"
          onClick={() => {
            setWorking(true);
            setFailed(false);
            void (async () => {
              try {
                await onDisconnect();
                open(false);
              } catch {
                setFailed(true);
              } finally {
                setWorking(false);
              }
            })();
          }}
          data-disconnect-confirm-button
        >
          <Trash2 aria-hidden />
          {working ? "Disconnecting" : `Disconnect ${name}`}
        </Button>
        <Button type="button" size="sm" variant="ghost" disabled={working} onClick={() => open(false)}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

export default ConnectionActions;
