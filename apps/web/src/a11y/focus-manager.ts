// Blueprint: docs/system-analysis/17-technical-blueprint.md §8.5, §9.4 rule E-4 -- "the
// client focuses the first offending control, announces the summary in an aria-live
// region, and links summary -> field." This is the direct remedy for `04` §9.2 A9 (2,880
// modal messages, none inline, none focus-managing) -- accessibility is the client's stated
// #1 product feature, so this exists from Phase 1, not bolted on later.

/**
 * Given a set of field paths that failed validation (matching `ProblemFieldError.path`, e.g.
 * "lines[3].qty"), focuses the first corresponding form control and returns whether one was
 * found. Controls must be marked `data-field-path="lines[3].qty"` for this to find them --
 * that convention is established here so every form built later follows it.
 */
export function focusFirstInvalidField(paths: readonly string[], root: ParentNode = document): boolean {
  for (const path of paths) {
    const el = root.querySelector<HTMLElement>(`[data-field-path="${cssEscape(path)}"]`);
    if (el) {
      el.focus();
      el.scrollIntoView({ block: "center", behavior: "smooth" });
      return true;
    }
  }
  return false;
}

function cssEscape(value: string): string {
  return typeof CSS !== "undefined" && CSS.escape ? CSS.escape(value) : value.replace(/["\\]/g, "\\$&");
}

/** Traps focus within `container` (e.g. a modal) so Tab/Shift+Tab never escape it, and
 *  returns a cleanup function that restores focus to whatever was focused before the trap was
 *  installed. Remedy for `04` §9.2 A7 (130 stacked modal response windows with no return
 *  focus). TODO: wire into the shared `<Dialog>` once components/ has one (§8.6). */
export function trapFocus(container: HTMLElement): () => void {
  const previouslyFocused = document.activeElement as HTMLElement | null;
  const selector = 'a[href], button:not([disabled]), textarea, input, select, [tabindex]:not([tabindex="-1"])';

  function handleKeydown(event: KeyboardEvent): void {
    if (event.key !== "Tab") return;
    const focusable = Array.from(container.querySelectorAll<HTMLElement>(selector));
    if (focusable.length === 0) return;
    const first = focusable[0]!;
    const last = focusable[focusable.length - 1]!;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  container.addEventListener("keydown", handleKeydown);
  return () => {
    container.removeEventListener("keydown", handleKeydown);
    previouslyFocused?.focus();
  };
}
