// The public surface of `settings` (§3.1, B4). Every other module reads options through
// `SettingsService`; none defines its own enum (§2.3 module #13).
export { SettingsModule } from "./settings.module.js";
export { SettingsService } from "./application/settings.service.js";
export type { OptionSet, OptionValue } from "./domain/option-value.js";
