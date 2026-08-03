// Blueprint: docs/system-analysis/17-technical-blueprint.md §7.6 (document numbering MR-1/MR-2):
// user-visible numbers come from a transactional counter locked with FOR UPDATE; allocated as
// late as possible inside the business transaction (N-1); never held across user interaction
// (N-2); cancelled documents keep their number (N-3); counters never reset by default (N-4).
//
// TX-6 lock order: `doc_counter` is the FIRST lock every posting flow takes -- callers must
// invoke `allocate` before touching item/stock_lot/gl rows.
import { Injectable } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { docSeries, docSeriesCounters } from "@pharmacy/db";

import type { Tx } from "../db/index.js";
import { AppException } from "../errors/index.js";

export interface AllocatedDocNumber {
  readonly docNumber: string;
  readonly docSeriesId: number;
  readonly documentTypeId: number;
}

@Injectable()
export class DocNumberService {
  /**
   * Allocate the next number in `seriesCode` for `tenantId`, inside the caller's transaction.
   * Locks the counter row (`FOR UPDATE`), increments it, and returns the formatted number
   * (`prefix` + zero-padded value). The lock is held until the caller commits -- which is why
   * N-1 says call this last-ish and never across user interaction.
   */
  async allocate(tx: Tx, tenantId: number, seriesCode: string): Promise<AllocatedDocNumber> {
    const [series] = await tx
      .select()
      .from(docSeries)
      .where(and(eq(docSeries.tenantId, tenantId), eq(docSeries.code, seriesCode)));
    if (!series || !series.isEnabled) {
      throw new AppException({
        status: 422,
        code: "DOC.SERIES_MISSING",
        title: "Numbering series unavailable",
        detail: `No enabled numbering series '${seriesCode}' is configured.`,
      });
    }

    // Default never-reset policy -> single '*' period row (§7.6 N-4). Yearly/monthly reset would
    // derive periodKey from posting date; deferred until an admin actually configures it.
    const periodKey = "*";
    const [counter] = await tx
      .select()
      .from(docSeriesCounters)
      .where(and(eq(docSeriesCounters.docSeriesId, series.docSeriesId), eq(docSeriesCounters.periodKey, periodKey)))
      .for("update");

    let value: number;
    if (counter) {
      value = counter.nextValue;
      await tx
        .update(docSeriesCounters)
        .set({ nextValue: value + 1, updatedAt: new Date() })
        .where(and(eq(docSeriesCounters.docSeriesId, series.docSeriesId), eq(docSeriesCounters.periodKey, periodKey)));
    } else {
      // First allocation in this series/period -- seed the counter at 2, hand out 1.
      value = 1;
      await tx.insert(docSeriesCounters).values({
        docSeriesId: series.docSeriesId,
        periodKey,
        nextValue: 2,
        updatedAt: new Date(),
      });
    }

    return {
      docNumber: `${series.prefix}${String(value).padStart(series.padWidth, "0")}`,
      docSeriesId: series.docSeriesId,
      documentTypeId: series.documentTypeId,
    };
  }
}
