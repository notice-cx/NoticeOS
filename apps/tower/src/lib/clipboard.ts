/**
 * Copy text from either a secure browser context or the Tower's trusted
 * plain-HTTP LAN origin. Clipboard.writeText is restricted to secure contexts;
 * the temporary selected textarea keeps copy actions usable on the machine's
 * plain-HTTP LAN name while they are still running directly inside the
 * operator's click gesture.
 */
export async function copyText(text: string): Promise<void> {
  const modernClipboardAvailable =
    window.isSecureContext !== false &&
    typeof navigator.clipboard?.writeText === "function";

  if (modernClipboardAvailable) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch (error) {
      if (copyWithSelectedTextarea(text)) return;
      throw error;
    }
  }

  if (copyWithSelectedTextarea(text)) return;
  throw new Error("No browser clipboard mechanism succeeded");
}

function copyWithSelectedTextarea(text: string): boolean {
  if (typeof document.execCommand !== "function") return false;

  const active =
    document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.readOnly = true;
  textarea.tabIndex = -1;
  textarea.setAttribute("aria-hidden", "true");
  textarea.dataset.clipboardFallback = "true";
  textarea.style.position = "fixed";
  textarea.style.inset = "0 auto auto 0";
  textarea.style.width = "1px";
  textarea.style.height = "1px";
  textarea.style.opacity = "0";
  textarea.style.pointerEvents = "none";

  document.body.appendChild(textarea);
  try {
    textarea.focus({ preventScroll: true });
    textarea.select();
    textarea.setSelectionRange(0, text.length);
    return document.execCommand("copy");
  } finally {
    textarea.remove();
    active?.focus({ preventScroll: true });
  }
}
