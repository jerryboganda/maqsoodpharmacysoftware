// The public surface of `payments` (§3.1, B4). Grows as the follow-up agent adds
// controllers/services beneath this directory -- keep exports here in sync with what other
// modules are meant to consume (mirror settings/index.ts's convention).
export { PaymentsModule } from "./payments.module.js";
export { PaymentMethodService } from "./application/payment-method.service.js";
export { PaymentService } from "./application/payment.service.js";
