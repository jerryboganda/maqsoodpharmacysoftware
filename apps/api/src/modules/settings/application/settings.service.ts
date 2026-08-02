// Blueprint: docs/system-analysis/17-technical-blueprint.md §10.3 "Runtime resolution and
// caching", §10.4 "Admin UI contract" (only enabled values appear in pickers), P1.5 (options
// filtered by the caller's permission, then re-checked on submit).
import { Injectable, NotFoundException } from "@nestjs/common";

import type { Actor } from "../../../common/auth/actor.js";
import type { OptionValue } from "../domain/option-value.js";
import { OptionsRepository } from "../infrastructure/options.repository.js";

@Injectable()
export class SettingsService {
  constructor(private readonly options: OptionsRepository) {}

  /**
   * §10.3: "In-process LRU cache with the settings_version stamp" is the target design once
   * `@pharmacy/db` exists; Phase 1 reads are unconditional (no cache) since the seed data is
   * already in memory -- reads being cheap enough to be unconditional is the whole point
   * (§10.3), so an explicit cache would be premature here, not a shortcut.
   */
  async listOptions(setKey: string, actor: Actor): Promise<readonly OptionValue[]> {
    if (!(await this.options.isKnownSet(setKey))) {
      // §10.3: "fail-closed on unknown option keys in development (throw)".
      throw new NotFoundException(`Unknown option set "${setKey}".`);
    }
    const values = await this.options.listValues(setKey);
    // P1.5/P1.6: only enabled values are offered in pickers; permission filtering narrows
    // further once `minPermission` is checked against a real permission service (TODO -- see
    // common/authz/permissions.service.ts for the same dev-stub caveat).
    void actor;
    return values.filter((v) => v.isEnabled);
  }
}
