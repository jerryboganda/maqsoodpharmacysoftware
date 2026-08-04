// Thin controller (§2.2), mirroring purchase-returns.controller.ts's shape. POST creates AND
// posts the manual voucher in one transaction; POST .../reverse creates the compensating entry
// in one transaction -- both protected by @RequireIdempotencyKey (§7.5).
import { Body, Controller, Get, HttpCode, Param, Post, Query } from "@nestjs/common";

import type { Actor } from "../../../common/auth/actor.js";
import { CurrentActor } from "../../../common/auth/current-actor.decorator.js";
import { RequirePermission } from "../../../common/authz/require-permission.decorator.js";
import { RequireIdempotencyKey } from "../../../common/idempotency/require-idempotency-key.decorator.js";
import { JournalEntryService } from "../application/journal-entry.service.js";
import {
  CreateJournalEntryDto,
  JournalEntryIdParamDto,
  ListJournalEntriesQueryDto,
  ReverseJournalEntryDto,
} from "./dto/journal-entry.dto.js";

@Controller("gl/journal-entries")
export class JournalEntriesController {
  constructor(private readonly journalEntryService: JournalEntryService) {}

  @RequirePermission("gl.voucher", "list")
  @Get()
  async list(@Query() query: ListJournalEntriesQueryDto, @CurrentActor() actor: Actor) {
    return this.journalEntryService.list(query, actor);
  }

  @RequirePermission("gl.voucher", "view")
  @Get(":id")
  async getById(@Param() params: JournalEntryIdParamDto, @CurrentActor() actor: Actor) {
    return this.journalEntryService.getById(params.id, actor);
  }

  /** Manual voucher (JV/CP/CR/BP/BR) -- create + post in one transaction. */
  @RequirePermission("gl.voucher", "create")
  @RequireIdempotencyKey()
  @Post()
  @HttpCode(201)
  async create(@Body() body: CreateJournalEntryDto, @CurrentActor() actor: Actor) {
    return this.journalEntryService.createManualVoucher(body, actor);
  }

  /** Compensating reversal entry -- the original's status becomes "reversed"; an entry that is
   *  already reversed 422s (LEDGER.ALREADY_REVERSED). */
  @RequirePermission("gl.voucher", "reverse")
  @RequireIdempotencyKey()
  @Post(":id/reverse")
  @HttpCode(201)
  async reverse(@Param() params: JournalEntryIdParamDto, @Body() body: ReverseJournalEntryDto, @CurrentActor() actor: Actor) {
    return this.journalEntryService.reverse(params.id, body, actor);
  }
}
