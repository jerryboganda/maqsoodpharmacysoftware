import { SetMetadata } from "@nestjs/common";

export const REQUIRE_IDEMPOTENCY_KEY = "pharmacy:requireIdempotencyKey";

/** Blueprint §7.5: every mutating request to a financial endpoint must carry an
 *  `Idempotency-Key` header. Apply to `POST /sales`, `/sale-returns`, `/purchases`,
 *  `/purchase-returns`, `/adjustments`, `/supplier-payments`, `/expenses`, and every
 *  `…/post` action, once those endpoints exist. */
export const RequireIdempotencyKey = () => SetMetadata(REQUIRE_IDEMPOTENCY_KEY, true);
