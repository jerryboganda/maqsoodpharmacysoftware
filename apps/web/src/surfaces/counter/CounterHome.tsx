// Blueprint: docs/system-analysis/17-technical-blueprint.md §8.9 -- "Counter (/counter):
// Sales Officer, Shift In-charge. Desktop, keyboard + scanner. Keyboard-first." Placeholder
// route for Phase 1; the real dispensing/POS screen (§7.2, §8.11 GS1 scanning) lands with the
// `sales` module.
export function CounterHome() {
  return (
    <section>
      <h1 className="text-xl font-semibold">Counter</h1>
      <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
        Keyboard-first dispensing + POS surface. Not yet built -- placeholder route.
      </p>
    </section>
  );
}
