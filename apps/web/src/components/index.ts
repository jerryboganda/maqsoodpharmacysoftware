// Blueprint: docs/system-analysis/17-technical-blueprint.md §8.6 Decision D-09 [BINDING] --
// "React Aria Components as the behavioural primitive layer, styled with Tailwind CSS 4,
// wrapped in a thin in-house design system in apps/web/src/components." No RAC dependency is
// installed yet (Phase 1 has no form/grid/modal screens to justify it) -- the first component
// that needs accessible behaviour beyond a plain <button>/<a> (a combobox, a data grid, a
// modal) is what should pull in `react-aria-components` and start this design system for
// real, per the non-negotiable component contracts in §8.6.
export {};
