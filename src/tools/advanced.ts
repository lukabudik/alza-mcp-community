import { z } from "zod";
import { OUTPUT_SCHEMAS } from "./output-schemas.js";
import type { MobileAccount } from "../domain/mobile-account.js";
import { assertNotRejected } from "../infra/errors.js";
import type { RegisterableTool, ToolDeps, ToolResult } from "./types.js";
import { formatOrder, formatOrderDocument, formatPaymentMethods, formatProfile, jsonResult, withConciseText } from "./account-format.js";

function apiAccount(deps: ToolDeps): MobileAccount {
  if (!deps.mobileAccount) throw new Error("mobile API account tools are not configured");
  return deps.mobileAccount;
}

function result(value: unknown): ToolResult {
  // Issue #73: the text channel is capped; structuredContent keeps the full value.
  return jsonResult(value);
}

const jsonObject = z.record(z.string(), z.unknown());
const typedValues = z
  .array(
    z.object({
      name: z.string().min(1).max(64).describe("Form field name exactly as returned by the form response."),
      value: z.unknown().describe("Field value."),
      kind: z.enum(["text", "integer", "boolean", "decimal", "text-array", "integer-array"]).optional().describe("Field type from the form response, if provided."),
    }),
  )
  .max(20)
  .describe("Extra typed form values copied verbatim from the form response (installment/consent fields; names containing password, token, card, payment, iban and similar are refused). Omit if the form returned none.");
const appAction = jsonObject.describe(
  "An AppAction object copied verbatim from a prior tool response (e.g. `profile`); it must contain form.meta.href. Never hand-craft URLs. " +
    "Each tool only executes actions of its own route family (address, review, warranty claim, subscription, attachment); read tools are GET-only and write tools POST-only; credential, payment, order and basket-write routes and sensitive field names (password, token, card, payment, iban, ...) are always refused.",
);
const confirmationToken = z
  .string()
  .min(32)
  .describe("One-time token from `prepare_mutation` prepared with the matching action.");
const AUTH_PREREQ =
  "Requires a loaded mobile API access token — check `account_status` first; if none is loaded, run `auth_start`, have the user complete the browser sign-in, then `auth_exchange` with the returned code and state.";
/** Issue #79: credential/identity mutations confirm `user_id` before sending. */
const IDENTITY_CHECK =
  " Before anything is sent, `user_id` is checked against the signed-in account with a fresh `user_data` read; a different id, or a session whose user id cannot be read, is refused.";

export function createAdvancedTools(deps: ToolDeps): RegisterableTool[] {
  const profile: RegisterableTool = {
    name: "profile",
    register(server, wrap) {
      return server.registerTool(
        "profile",
        {
          title: "Read Alza user profile and address book",
          description:
            "Read the authenticated user's Alza profile: personal data, the delivery-address book with per-address HATEOAS actions (create/edit/delete/search), and account sections. " +
            "Use to inspect the account, to confirm the account binding (`user_id`, email), and to obtain the per-address `action` objects required by `address_upsert` and `address_delete` (present only when the account has saved addresses; `address_search` works without one). " +
            "The numeric `user_id` is the input for the user-scoped reads (`order`, `order_archive`, `order_search`, `complaint_claims`, `subscription_overview`). " +
            AUTH_PREREQ +
            " Read-only. Honest caveat: with a stale or missing token the API may still answer HTTP 200 with an anonymous shape (`user_id: -1`, null email) — treat `user_id` as the binding signal, and refresh the token via `auth_start`/`auth_exchange` if it is -1.",
          inputSchema: {},
          annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: true },
          outputSchema: OUTPUT_SCHEMAS["profile"],
        },
        async () => wrap("profile", async () => withConciseText(await apiAccount(deps).profile(), formatProfile)),
      );
    },
  };
  const contacts: RegisterableTool = {
    name: "contacts",
    register(server, wrap) {
      return server.registerTool(
        "contacts",
        {
          title: "Read Alza account contacts",
          description:
            "Read the authenticated user's Alza contact list (mobile API v4/contacts endpoint). " +
            "Use to list or search the account's saved contacts, e.g. for complaint/claim context. " +
            "Do not use for the catalog category tree — that is `list_categories`. " +
            AUTH_PREREQ + " Read-only.",
          inputSchema: {},
          annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: true },
          outputSchema: OUTPUT_SCHEMAS["contacts"],
        },
        async () => wrap("contacts", async () => result(await apiAccount(deps).contacts())),
      );
    },
  };
  const register: RegisterableTool = {
    name: "register",
    register(server, wrap) {
      return server.registerTool(
        "register",
        {
          title: "Register a new Alza account",
          description:
            "Register a new Alza account (mobile API CreateUser): submit email, phone, and password plus an optional verification code. " +
            "High-impact, credential-bearing side effect: creates a real Alza account the user will have to manage. " +
            "Use only with explicit user confirmation; requires a one-time token from `prepare_mutation` (action=`register`) passed as `confirmation_token`. " +
            "Do not use to sign in an existing account — that is the `auth_start`/`auth_exchange` flow.",
          inputSchema: {
            email: z.string().min(3).max(100).describe("Account email address (the login)."),
            phone: z.string().min(6).max(20).describe("Phone number, e.g. '+420 777 123 456'."),
            pwd: z.string().min(8).max(64).describe("Initial password. It is a credential — confirm with the user before sending."),
            code: z.string().max(32).optional().describe("Verification code, if Alza required one for this registration."),
            confirmation_token: confirmationToken,
          },
          annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: true, openWorldHint: true },
          outputSchema: OUTPUT_SCHEMAS["register"],
        },
        async (args) => wrap("register", async () => result(await apiAccount(deps).register({ email: args.email, phone: args.phone, pwd: args.pwd, code: args.code }, args.confirmation_token))),
      );
    },
  };
  const addressUpsert: RegisterableTool = {
    name: "address_upsert",
    register(server, wrap) {
      return server.registerTool(
        "address_upsert",
        {
          title: "Create or edit a delivery address",
          description:
            "Create or edit a delivery address on the Alza account by executing the server-provided address form action from `profile` (createAddressAction for create, the address's editAction for edit) with typed fields. " +
            "Use when the user wants to add a new shipping address or fix an existing one. " +
            "Mutating: requires a one-time token from `prepare_mutation` (action=`address_create` or `address_edit`); `kind=edit` additionally requires `address_id`. " +
            "Side effect: persists the address to the account's address book.",
          inputSchema: z
            .object({
              kind: z.enum(["create", "edit"]).describe("'create' for a new address, 'edit' to modify an existing one."),
              action: appAction,
              name: z.string().min(1).max(100).describe("Recipient name."),
              street: z.string().min(1).max(100).describe("Street and house number."),
              city: z.string().min(1).max(100).describe("City."),
              zip_code: z.string().min(3).max(10).describe("Postal code."),
              firm: z.string().max(100).optional().describe("Company name, for business addresses."),
              phone: z.string().min(6).max(20).optional().describe("Contact phone."),
              email: z.string().max(100).optional().describe("Contact email."),
              note: z.string().max(100).optional().describe("Delivery note for the courier."),
              address_type: z.enum(["HOME", "WORK", "OTHER"]).optional().describe("Address classification."),
              address_id: z.number().int().positive().optional().describe("Existing address id from `profile`. Required for kind=edit."),
              confirmation_token: confirmationToken,
            })
            .superRefine((v, ctx) => {
              if (v.kind === "edit" && v.address_id === undefined)
                ctx.addIssue({ code: z.ZodIssueCode.custom, message: "address_id is required when kind=edit", path: ["address_id"] });
            }),
          annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: true, openWorldHint: true },
          outputSchema: OUTPUT_SCHEMAS["address_upsert"],
        },
        async (args) => wrap("address_upsert", async () => result(await apiAccount(deps).addressUpsert(args.kind, args.action, { name: args.name, street: args.street, city: args.city, zip_code: args.zip_code, firm: args.firm, phone: args.phone, email: args.email, note: args.note, address_type: args.address_type, address_id: args.address_id }, args.confirmation_token))),
      );
    },
  };
  const addressDelete: RegisterableTool = {
    name: "address_delete",
    register(server, wrap) {
      return server.registerTool(
        "address_delete",
        {
          title: "Delete a delivery address",
          description:
            "Delete a delivery address from the Alza account by executing the per-address delete action from the `profile` response. " +
            "Destructive: removes the address (id=`address_id`) from the account's address book. " +
            "Use only with explicit user confirmation, after showing which address will be deleted. " +
            "Requires a one-time token from `prepare_mutation` (action=`address_delete`).",
          inputSchema: {
            action: appAction,
            address_id: z.number().int().positive().describe("The address id to delete, from the `profile` address book."),
            confirmation_token: confirmationToken,
          },
          annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: true, openWorldHint: true },
          outputSchema: OUTPUT_SCHEMAS["address_delete"],
        },
        async (args) => wrap("address_delete", async () => result(await apiAccount(deps).addressDelete(args.action, { address_id: args.address_id }, args.confirmation_token))),
      );
    },
  };
  const addressSearch: RegisterableTool = {
    name: "address_search",
    register(server, wrap) {
      return server.registerTool(
        "address_search",
        {
          title: "Search delivery addresses",
          description:
            "Search Alza's zip/city database. Use to suggest a valid address before `address_upsert`, or to verify a zip/city combination. " +
            "Without `action` it uses the live-verified zip-code lookup (`getZipCodes`, no token needed). " +
            "If a `profile` response carries an `addressSearchAction`, you may pass that object verbatim as `action` instead — never hand-craft it. " +
            "Read-only; no confirmation token required.",
          inputSchema: {
            action: appAction.optional().describe("Optional `addressSearchAction` copied verbatim from `profile` (it must contain form.meta.href). Omit to use the zip-code lookup."),
            query: z.string().min(1).max(50).describe("Zip or city query, e.g. '110 00' or 'Brno'."),
          },
          annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: true },
          outputSchema: OUTPUT_SCHEMAS["address_search"],
        },
        async (args) => wrap("address_search", async () => result(args.action ? await apiAccount(deps).addressSearch(args.action, args.query) : await apiAccount(deps).zipCitySearch(args.query))),
      );
    },
  };
  const paymentMethods: RegisterableTool = {
    name: "payment_methods",
    register(server, wrap) {
      return server.registerTool(
        "payment_methods",
        {
          title: "List available payment methods",
          description:
            "List the payment-method groups available for the current Alza account cart (mobile API getDeliveryPaymentGroups payment projection). " +
            "Use after `delivery_options` and before order submission, to show the user payment choices and to obtain the `payment_id` needed by `web_place_order` (e.g. 103 proforma) or the mobile checkout. " +
            "Requires a non-empty cart. " +
            AUTH_PREREQ + " Read-only.",
          inputSchema: {
            selected_delivery_option_id: z.number().int().positive().optional().describe("Delivery option id from `delivery_options` to list the payments valid for that delivery. Omit for the default set."),
          },
          annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: true },
          outputSchema: OUTPUT_SCHEMAS["payment_methods"],
        },
        async (args) => wrap("payment_methods", async () => withConciseText(await apiAccount(deps).paymentMethods(args.selected_delivery_option_id), formatPaymentMethods)),
      );
    },
  };
  const afterOrderPayments: RegisterableTool = {
    name: "after_order_payments",
    register(server, wrap) {
      return server.registerTool(
        "after_order_payments",
        {
          title: "List after-order payment options",
          description:
            "List the after-order payment options for an unpaid order part (mobile API getafterorderpayments). An `err:1` answer (e.g. the order does not exist) is returned as an error carrying Alza's message. " +
            "Use when the user has an unpaid order (see `order`) and wants to pay it through the mobile API; pass the returned payment id to `pay_after_order`. " +
            "Do not use for legacy web WCF orders — that path is `web_pay_after_order` (list ids via `mobile_read` operation=`web_after_payment_dialog`). " +
            AUTH_PREREQ + " Read-only.",
          inputSchema: {
            order_id: z.string().min(1).max(64).describe("The unpaid order id (from `order`)."),
            part_id: z.string().min(1).max(64).describe("The order part id to pay (from `order`)."),
          },
          annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: true },
          outputSchema: OUTPUT_SCHEMAS["after_order_payments"],
        },
        async (args) => wrap("after_order_payments", async () => result(await apiAccount(deps).afterOrderPayments(args.order_id, args.part_id))),
      );
    },
  };
  const payAfterOrder: RegisterableTool = {
    name: "pay_after_order",
    register(server, wrap) {
      return server.registerTool(
        "pay_after_order",
        {
          title: "Execute an after-order payment (mobile API)",
          description:
            "Execute an after-order payment on an unpaid mobile-API order (AfterOrderRequestBody: order id, invoice number, payment id from `after_order_payments`, optional stored-card id and device fingerprint). " +
            "High-impact, money movement: requires a one-time token from `prepare_mutation` (action=`after_order_payment`) and explicit user confirmation. " +
            "Do not use for legacy web WCF orders — that is `web_pay_after_order`. " +
            AUTH_PREREQ,
          inputSchema: {
            order_id: z.string().min(1).max(64).describe("The unpaid order id (from `order`)."),
            invoice_number: z.string().min(1).max(64).describe("Invoice number for the payment (from the order detail)."),
            payment_id: z.number().int().positive().describe("Payment method id from `after_order_payments`."),
            card_id: z.number().int().positive().optional().describe("Stored-card id to pay with, if the user has one on file."),
            device_fingerprint: z.string().max(128).optional().describe("Device fingerprint expected by the payment gateway, if known."),
            confirmation_token: confirmationToken,
          },
          annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: true, openWorldHint: true },
          outputSchema: OUTPUT_SCHEMAS["pay_after_order"],
        },
        async (args) => wrap("pay_after_order", async () => result(await apiAccount(deps).payAfterOrder({ order_id: args.order_id, invoice_number: args.invoice_number, payment_id: args.payment_id, card_id: args.card_id, device_fingerprint: args.device_fingerprint }, args.confirmation_token))),
      );
    },
  };
  const order: RegisterableTool = {
    name: "order",
    register(server, wrap) {
      return server.registerTool(
        "order",
        {
          title: "Read an Alza order",
          description:
            "Read an authenticated user's Alza order: lines, parts, milestones/tracking, and invoice document references; with `part_id`, the part detail as well. " +
            "Use to check order status, delivery tracking, or to collect the order/part ids needed by `after_order_payments`/`pay_after_order`. " +
            "Pass `user_id` — the numeric Alza user id from the `profile`/`user_data` read (`user_id` field); the read is `GET /api/users/{user_id}/v1/orders/{order_id}`. " +
            AUTH_PREREQ + " Read-only. An `err:1` answer (e.g. unknown order) is returned as an error carrying Alza's message.",
          inputSchema: {
            order_id: z.string().min(1).max(64).describe("The order id to read (e.g. from `order_archive`/`order_search`)."),
            part_id: z.string().min(1).max(64).optional().describe("Order part id for the part detail read. Omit for the whole order."),
            user_id: z.string().regex(/^\d{1,16}$/).describe("Numeric Alza user id (the `user_id` field of the `profile`/`user_data` response)."),
            initial_created: z.boolean().default(false).describe("Include the initial-creation view of the order. Default false."),
          },
          annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: true },
          outputSchema: OUTPUT_SCHEMAS["order"],
        },
        async (args) => wrap("order", async () => {
          const out = (await apiAccount(deps).order(args.order_id, args.part_id, args.user_id, args.initial_created)) as { order?: unknown; part?: unknown };
          // Issue #79: a nested `err:1` envelope is a failed read, reported as isError with Alza's msg.
          assertNotRejected(out.order);
          assertNotRejected(out.part);
          return withConciseText(out, formatOrder);
        }),
      );
    },
  };
  const cancelOrder: RegisterableTool = {
    name: "cancel_order",
    register(server, wrap) {
      return server.registerTool(
        "cancel_order",
        {
          title: "Cancel an order (OR11)",
          description:
            "Cancel an order part via Alza's HATEOAS cancel flow (OR11): reads the `cancelForm` (validating the order/part/hash are cancellable), then commits the cancellation with the given `reason`. " +
            "Live-verified against a real `web_place_order`-created order (2026-09-26): pass `hash` from that order's `?x=` link (`order_detail_link`/`GetOrderDetailAction.webLink`) and `part_id` from the order detail's `parts[].self.href`. " +
            "High-impact, money-relevant side effect: cancels a real order — use only after explicit user confirmation. " +
            "A 202 response means the cancellation was accepted; the order may briefly show a transitional \"processing changes\" state before settling to cancelled — re-read the order to confirm. " +
            "Requires a one-time token from `prepare_mutation` (action=`cancel_order`).",
          inputSchema: {
            order_id: z.string().min(1).max(64).describe("The order id to cancel (from `place_order`/`web_place_order`'s result, or `order`/`order_search`)."),
            part_id: z.string().min(1).max(64).describe("The order part id to cancel (from the order's `parts[].self.href`, or the `web_place_order` result if surfaced)."),
            hash: z.string().min(1).max(128).describe("The order's `?x=` access token from `order_detail_link`/`GetOrderDetailAction.webLink`."),
            reason: z.number().int().min(0).max(5).default(0).describe("Cancellation reason: 0=no reason given, 1=want different goods, 2=cheaper elsewhere, 3=don't want to wait, 4=need to change delivery, 5=other. Default 0."),
            confirmation_token: confirmationToken,
          },
          annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: true, openWorldHint: true },
          outputSchema: OUTPUT_SCHEMAS["cancel_order"],
        },
        async (args) => wrap("cancel_order", async () => result(await apiAccount(deps).cancelOrder(args.order_id, args.hash, args.part_id, args.reason, args.confirmation_token))),
      );
    },
  };
  const reviewSubmit: RegisterableTool = {
    name: "review_submit",
    register(server, wrap) {
      return server.registerTool(
        "review_submit",
        {
          title: "Submit a product review",
          description:
            "Submit a product review (1–5 rating plus optional text) by executing the server-provided review form action from the product detail (writeReviewAction/onSubmitReview or the rating form). " +
            "Use when the user wants to publish a review for a product they bought. " +
            "Mutating: the review becomes public on the product page — requires a one-time token from `prepare_mutation` (action=`review_submit`) and explicit user confirmation. " +
            "Optional `values` carries extra typed form fields verbatim from the form response.",
          inputSchema: {
            action: appAction,
            rating: z.number().int().min(1).max(5).describe("Star rating, 1 (worst) to 5 (best)."),
            text: z.string().max(10000).optional().describe("Review text, if the user wants to write one."),
            values: typedValues.optional(),
            confirmation_token: confirmationToken,
          },
          annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: false, openWorldHint: true },
          outputSchema: OUTPUT_SCHEMAS["review_submit"],
        },
        async (args) => wrap("review_submit", async () => result(await apiAccount(deps).reviewSubmit(args.action, { rating: args.rating, text: args.text, values: args.values }, args.confirmation_token))),
      );
    },
  };
  const complaintClaims: RegisterableTool = {
    name: "complaint_claims",
    register(server, wrap) {
      return server.registerTool(
        "complaint_claims",
        {
          title: "List warranty claims",
          description:
            "List the account's warranty claims (row K1): `GET /api/users/{user_id}/v1/warrantyClaims/{scope}` — `scope` `active` (default) or `archive`. " +
            "Use to show the user their claims before filing or attaching evidence (see `upload_attachment`); each claim's `detailAction` goes to `claim_detail`. " +
            "Pass `user_id` (the numeric id from `profile`). Alternatively pass a warranty-claims link or AppAction verbatim from a prior response as `action`. " +
            AUTH_PREREQ + " Read-only.",
          inputSchema: {
            user_id: z.string().regex(/^\d{1,16}$/).optional().describe("Numeric Alza user id (the `user_id` field of the `profile`/`user_data` response). Required unless `action` is given."),
            scope: z.enum(["active", "archive"]).default("active").describe("Which claim list to read: 'active' (open claims, default) or 'archive' (closed claims)."),
            action: jsonObject.optional().describe("Optional: a warranty-claims link (`{href}`) or AppAction copied verbatim from a prior response. Omit to use `user_id` + `scope`."),
          },
          annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: true },
          outputSchema: OUTPUT_SCHEMAS["complaint_claims"],
        },
        async (args) => wrap("complaint_claims", async () => result(args.action ? await apiAccount(deps).complaintClaims(args.action) : await apiAccount(deps).warrantyClaims(args.user_id, args.scope))),
      );
    },
  };
  const subscriptionOverview: RegisterableTool = {
    name: "subscription_overview",
    register(server, wrap) {
      return server.registerTool(
        "subscription_overview",
        {
          title: "Read AlzaSubscription overview",
          description:
            "Read the account's subscription section — the resource Alza's authenticated navigation links as `userSubscription` (`GET https://webapi.alza.cz/api/users/{user_id}/v1/subscription?country=CZ`). " +
            "Use to show the user their subscription state before `subscription_activate` or `subscription_update_installment`. " +
            "Caveat: the link is observed live but its response has not been verified yet, so treat the returned shape as unverified (row S1). " +
            "Pass `user_id` (the numeric id from `profile`), or pass the `userSubscription` link / an AppAction verbatim as `action`. " +
            AUTH_PREREQ + " Read-only.",
          inputSchema: {
            user_id: z.string().regex(/^\d{1,16}$/).optional().describe("Numeric Alza user id (the `user_id` field of the `profile`/`user_data` response). Required unless `action` is given."),
            action: jsonObject.optional().describe("Optional: the `userSubscription` link (`{href}`) or an AppAction copied verbatim from a prior response. Omit to use `user_id`."),
          },
          annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: true },
          outputSchema: OUTPUT_SCHEMAS["subscription_overview"],
        },
        async (args) => wrap("subscription_overview", async () => result(args.action ? await apiAccount(deps).subscriptionOverview(args.action) : await apiAccount(deps).userSubscription(args.user_id))),
      );
    },
  };
  const subscriptionActivate: RegisterableTool = {
    name: "subscription_activate",
    register(server, wrap) {
      return server.registerTool(
        "subscription_activate",
        {
          title: "Activate AlzaSubscription",
          description:
            "Activate AlzaSubscription by executing the server-provided activateAction form. " +
            "High-impact: starts a paid, recurring subscription — use only with explicit user confirmation after showing the terms from `subscription_overview`. " +
            "Requires a one-time token from `prepare_mutation` (action=`subscription_activate`). " +
            "Optional `values` carries the payment/installment fields verbatim from the form response.",
          inputSchema: {
            action: appAction,
            values: typedValues.optional(),
            confirmation_token: confirmationToken,
          },
          annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: true, openWorldHint: true },
          outputSchema: OUTPUT_SCHEMAS["subscription_activate"],
        },
        async (args) => wrap("subscription_activate", async () => result(await apiAccount(deps).subscriptionActivate(args.action, { values: args.values }, args.confirmation_token))),
      );
    },
  };
  const subscriptionUpdateInstallment: RegisterableTool = {
    name: "subscription_update_installment",
    register(server, wrap) {
      return server.registerTool(
        "subscription_update_installment",
        {
          title: "Update AlzaSubscription installment plan",
          description:
            "Change the AlzaSubscription installment plan by executing the server-provided updateInstallmentAction form. " +
            "High-impact: changes the payment schedule of a paid subscription — use only with explicit user confirmation. " +
            "Requires a one-time token from `prepare_mutation` (action=`subscription_update_installment`). " +
            "Optional `values` carries the installment fields verbatim from the form response.",
          inputSchema: {
            action: appAction,
            values: typedValues.optional(),
            confirmation_token: confirmationToken,
          },
          annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: true, openWorldHint: true },
          outputSchema: OUTPUT_SCHEMAS["subscription_update_installment"],
        },
        async (args) => wrap("subscription_update_installment", async () => result(await apiAccount(deps).subscriptionUpdateInstallment(args.action, { values: args.values }, args.confirmation_token))),
      );
    },
  };
  const webPlaceOrder: RegisterableTool = {
    name: "web_place_order",
    register(server, wrap) {
      return server.registerTool(
        "web_place_order",
        {
          title: "Place an order (legacy web WCF — working path)",
          description:
            "Place an order through the live-verified legacy web WCF checkout pipeline (EShopService.svc: SaveOrder2 → SaveOrder3 → SaveAndConfirmOrder2 with the documented AlzaPlus 113-gate retry → CheckOrder4 → SendOrder4). " +
            "This is the currently-working order-submission path — the mobile `place_order` (sendOrder3) returns HTTP 500 (https://github.com/lukabudik/alza-mcp-community/blob/main/docs/gap-analysis.md G1/G5). " +
            "Cart note (live-verified 2026-09-26): this submits whatever is in the cart populated by `add_to_cart` (mobile `restservice.svc/v2/basket/add`) — NOT the separate HATEOAS cart from `web_add_to_cart`. Neither `add_to_cart` nor `delivery_options` actually require login despite their usual auth prerequisite (falls back to an anonymous visitor-keyed cart) — this whole chain works anonymously end to end. " +
            "Typed inputs only: `delivery_id`/`delivery_group_id` from `delivery_options`, `parcel_shop_id` from `web_pickup_places` (using the `orderId`/`groupId` parsed from `delivery_options`' AlzaBox `deliveryOption.href` — see `web_pickup_places`'s description), `payment_id` from `delivery_options`' payment groups, plus the contact/address block. " +
            "High-impact, money-relevant: creates a real Alza order — use only with explicit user confirmation, with a one-time token from `prepare_mutation` (action=`web_place_order`). " +
            "Example: `web_place_order({delivery_id: 2680, parcel_shop_id: \"1128203\", payment_id: 103, name: \"Jan Novák\", street: \"Praha 110 00\", city: \"Praha\", zip_code: \"110 00\", phone: \"+420 777 123 456\", email: \"jan@example.cz\", confirmation_token: \"...\"})`.",
          inputSchema: {
            delivery_id: z.number().int().positive().describe("Delivery option id (e.g. 2680 for AlzaBox; from `delivery_options`)."),
            delivery_group_id: z.number().int().min(0).optional().describe("Live delivery group id (from `delivery_options`; omit or 0 for the server default)."),
            parcel_shop_id: z.string().max(32).optional().describe("Pickup place id (an AlzaBox parcelShopId from `web_pickup_places`), when delivering to a pickup point."),
            payment_id: z.number().int().positive().describe("Payment method id (e.g. 103 proforma; from `payment_methods`)."),
            name: z.string().min(1).max(100).describe("Recipient name."),
            street: z.string().min(1).max(100).describe("Street and house number."),
            city: z.string().min(1).max(100).describe("City."),
            zip_code: z.string().min(3).max(12).describe("Postal code."),
            phone: z.string().min(6).max(20).describe("Contact phone."),
            email: z.string().min(3).max(100).describe("Contact email (order confirmation goes here)."),
            register_user: z.boolean().default(false).describe("Register the buyer as a new account as part of checkout. Default false."),
            login: z.string().max(100).optional().describe("Existing login to buy as (defaults to the email)."),
            country_id: z.number().int().default(0).describe("Country id for the order. Default 0 (server default, CZ)."),
            quotation: z.boolean().default(false).describe("Treat the order as a quotation instead of a purchase. Default false."),
            internal_description: z.string().max(2000).optional().describe("Internal order note, if required."),
            user_consents: z.array(z.object({ consent_id: z.string().min(1).max(64), value: z.boolean() })).max(10).optional().describe("User consent flags verbatim from the checkout context (consent_id → accepted)."),
            basket_consents: z.array(z.object({ consent_id: z.string().min(1).max(64), value: z.boolean() })).max(10).optional().describe("Basket-level consent flags verbatim from the checkout context (consent_id → accepted)."),
            confirmation_token: confirmationToken,
          },
          annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: true, openWorldHint: true },
          outputSchema: OUTPUT_SCHEMAS["web_place_order"],
        },
        async (args) => wrap("web_place_order", async () => result(await apiAccount(deps).webPlaceOrder({ delivery_id: args.delivery_id, delivery_group_id: args.delivery_group_id, parcel_shop_id: args.parcel_shop_id, payment_id: args.payment_id, name: args.name, street: args.street, city: args.city, zip_code: args.zip_code, phone: args.phone, email: args.email, register_user: args.register_user, login: args.login, country_id: args.country_id, quotation: args.quotation, internal_description: args.internal_description, user_consents: args.user_consents, basket_consents: args.basket_consents }, args.confirmation_token))),
      );
    },
  };
  const webPayAfterOrder: RegisterableTool = {
    name: "web_pay_after_order",
    register(server, wrap) {
      return server.registerTool(
        "web_pay_after_order",
        {
          title: "Execute a web after-order payment (working path)",
          description:
            "Execute the after-order payment for an unpaid legacy-web order through the live-verified EShopService.svc CreateAfterPayment chain (the recorded real-payment path: e.g. MojePlatba 144 → KB SSO gateway). " +
            "Use when the user needs to pay a web-placed order that is still unpaid. " +
            "First list the available payment ids via `mobile_read` with operation=`web_after_payment_dialog` (GetAfterPaymentDialog). " +
            "High-impact, money movement: requires a one-time token from `prepare_mutation` (action=`web_after_order_payment`) and explicit user confirmation.",
          inputSchema: {
            order_id: z.string().min(1).max(64).describe("The unpaid order id (from `order` or the order-detail link)."),
            payment_id: z.number().int().positive().describe("Payment method id from the after-payment dialog (e.g. 144 MojePlatba, 143 Platba 24, 103 proforma)."),
            order_hash: z.string().max(64).optional().describe("The `?x=` order hash from the order-detail link, if present."),
            invoice_id: z.string().max(32).optional().default("0").describe("Invoice id for the payment. Default \"0\" (server default)."),
            price: z.number().min(0).optional().describe("Override the amount to pay in CZK. Omit to pay the full due amount."),
            confirmation_token: confirmationToken,
          },
          annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: true, openWorldHint: true },
          outputSchema: OUTPUT_SCHEMAS["web_pay_after_order"],
        },
        async (args) => wrap("web_pay_after_order", async () => result(await apiAccount(deps).webAfterOrderPayment({ order_id: args.order_id, payment_id: args.payment_id, order_hash: args.order_hash, invoice_id: args.invoice_id, price: args.price }, args.confirmation_token))),
      );
    },
  };
  const uploadAttachment: RegisterableTool = {
    name: "upload_attachment",
    register(server, wrap) {
      return server.registerTool(
        "upload_attachment",
        {
          title: "Upload complaint/claim attachments",
          description:
            "Upload 1–5 image attachments (base64 data URLs, whitelisted image MIME types, max 10 MiB each) by executing the server-provided multipart action (uploadImageAction / complaint attachment actions) — typically for a warranty claim from `complaint_claims`. " +
            "Use when the user needs to attach photos (damage, label, invoice) to a claim or complaint. " +
            "Mutating: requires a one-time token from `prepare_mutation` (action=`attachment_upload`) and user confirmation. " +
            "Optional `values` carries extra typed form fields verbatim from the form response.",
          inputSchema: {
            action: appAction,
            files: z
              .array(
                z.object({
                  part_name: z.string().min(1).max(64).describe("Form part name from the form response."),
                  file_name: z.string().min(1).max(200).describe("Original file name, e.g. \"damage-1.jpg\"."),
                  mime_type: z.string().max(64).optional().describe("MIME type, e.g. \"image/jpeg\" (whitelisted image types only)."),
                  data_url: z.string().regex(/^data:/, "must start with \"data:\"").describe("Full base64 data URL, e.g. \"data:image/jpeg;base64,...\"."),
                }),
              )
              .min(1)
              .max(5)
              .describe("The image files to upload (1–5, ≤10 MiB each)."),
            values: typedValues.optional(),
            confirmation_token: confirmationToken,
          },
          annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: false, openWorldHint: true },
          outputSchema: OUTPUT_SCHEMAS["upload_attachment"],
        },
        async (args) => wrap("upload_attachment", async () => result(await apiAccount(deps).uploadAttachment(args.action, { files: args.files, values: args.values }, args.confirmation_token))),
      );
    },
  };
  const orderSearch: RegisterableTool = {
    name: "order_search",
    register(server, wrap) {
      return server.registerTool(
        "order_search",
        {
          title: "Search the account's orders",
          description:
            "Search the authenticated user's Alza orders by term (row OR6 — the `userOrdersSearch` form from the orders navigation): order number/fragment or product term; returns matching `orders[]` (status, phase, price, created, and `documents[]` invoice refs) plus `commodities[]`. " +
            "Use to find an order the user remembers partially (e.g. part of the order number) and to collect its invoice `documents[]` for `order_document`. " +
            "Pass `user_id` — the numeric Alza user id from the `user_data`/`profile` read (`user_id` field). " +
            AUTH_PREREQ + " Read-only.",
          inputSchema: {
            search_term: z.string().min(1).max(64).describe("Search term, e.g. an order number or part of one ('1058 423 434', '1058')."),
            user_id: z.string().regex(/^\d{1,16}$/).describe("Numeric Alza user id (the `user_id` field of the `profile`/`user_data` response)."),
          },
          annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: true },
          outputSchema: OUTPUT_SCHEMAS["order_search"],
        },
        async (args) => wrap("order_search", async () => result(await apiAccount(deps).orderSearch(args.search_term, args.user_id))),
      );
    },
  };
  const orderArchive: RegisterableTool = {
    name: "order_archive",
    register(server, wrap) {
      return server.registerTool(
        "order_archive",
        {
          title: "Read the account's archived orders",
          description:
            "Read the authenticated user's archived orders (row OR7 — the `archiveOrders` section of the orders navigation): returns `{self, paging, value[]}` — the same order shape as `order_search` results (status, phase, price, created, invoice `documents[]` for `order_document`). " +
            "`hide_cancelled_orders` mirrors the app's 'Skrýt zrušené' (hide cancelled) toggle: default `false` includes cancelled orders; `true` hides them. " +
            "Pass `user_id` — the numeric Alza user id from the `user_data`/`profile` read (`user_id` field). " +
            AUTH_PREREQ + " Read-only.",
          inputSchema: {
            user_id: z.string().regex(/^\d{1,16}$/).describe("Numeric Alza user id (the `user_id` field of the `profile`/`user_data` response)."),
            hide_cancelled_orders: z.boolean().optional().describe("The app's 'Skrýt zrušené' (hide cancelled orders) toggle. Default false — cancelled orders are included."),
            limit: z.number().int().min(1).max(100).optional().describe("Page size (server default 10). Use `paging.next` for the next page."),
            offset: z.number().int().min(0).optional().describe("Number of orders to skip (the `offset` of `paging.next`). Default 0."),
          },
          annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: true },
          outputSchema: OUTPUT_SCHEMAS["order_archive"],
        },
        async (args) => wrap("order_archive", async () => result(await apiAccount(deps).orderArchive({ user_id: args.user_id, hide_cancelled_orders: args.hide_cancelled_orders, limit: args.limit, offset: args.offset }))),
      );
    },
  };
  const productByEan: RegisterableTool = {
    name: "product_by_ean",
    register(server, wrap) {
      return server.registerTool(
        "product_by_ean",
        {
          title: "Look up catalog products by barcode (EAN)",
          description:
            "Look up Alza catalog products by EAN/barcode (row AT3 — the app's camera barcode-scan API, APK `cz.alza.base.{api,lib,android}.vision`): `POST /services/restservice.svc/v1/getProductByEANlist` with `{eanList}`. " +
            "Returns the matching product data on success, or `err:1` with `msg` (\"No products found.\") for codes not in the catalog. " +
            "Accepts 1-20 barcodes (6-14 digits, EAN-8/13/14). No account required; read-only.",
          inputSchema: {
            eans: z
              .array(z.string().regex(/^\d{6,14}$/).describe("A barcode, digits only (EAN-8/13/14)."))
              .min(1)
              .max(20)
              .describe("One or more EAN barcodes to look up (up to 20)."),
          },
          annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: true },
          outputSchema: OUTPUT_SCHEMAS["product_by_ean"],
        },
        async (args) => wrap("product_by_ean", async () => result(await apiAccount(deps).productByEan(args.eans))),
      );
    },
  };
  const gdprInfo: RegisterableTool = {
    name: "gdpr_info",
    register(server, wrap) {
      return server.registerTool(
        "gdpr_info",
        {
          title: "Read the GDPR section and export dialog",
          description:
            "Read the account's GDPR section (row A17, APK `PersonalGdprDetails`): the `gdprInfoAction` (export request), the `deleteAccountAction`, and the export dialog (`AccountGdprDialog`: title, description, `emailInfo` with the login email the export is sent to, and the `sendGdprInfoForm`). " +
            "Use before `prepare_mutation`/`mutate_list` with action `gdpr_export` to show the user where their data will be sent. " +
            "Pass `user_id` — the numeric Alza user id from the `user_data`/`profile` read. " +
            AUTH_PREREQ + " Read-only.",
          inputSchema: {
            user_id: z.string().regex(/^\d{1,16}$/).describe("Numeric Alza user id (the `user_id` field of the `profile`/`user_data` response)."),
          },
          annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: true },
          outputSchema: OUTPUT_SCHEMAS["gdpr_info"],
        },
        async (args) => wrap("gdpr_info", async () => result(await apiAccount(deps).gdprInfo(args.user_id))),
      );
    },
  };
  const claimDetail: RegisterableTool = {
    name: "claim_detail",
    register(server, wrap) {
      return server.registerTool(
        "claim_detail",
        {
          title: "Read a warranty claim detail",
          description:
            "Read the detail of a single warranty claim/complaint (row K2) by following that claim's `detailAction`, copied verbatim from a `complaint_claims` list response. " +
            "Use to show the full claim state, message banners, and complaint items for one claim. " +
            "Pass the `action` object verbatim — never hand-craft it; plain links (`{href}`) must point at the account's `.../v1/warrantyClaims/...` routes. " +
            "Read-only; no confirmation token. " +
            AUTH_PREREQ,
          inputSchema: {
            action: jsonObject.describe("The claim's `detailAction` copied verbatim from `complaint_claims`: a link `{href, appLink?}` or an AppAction with form.meta.href."),
          },
          annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: true },
          outputSchema: OUTPUT_SCHEMAS["claim_detail"],
        },
        async (args) => wrap("claim_detail", async () => result(await apiAccount(deps).claimDetail(args.action))),
      );
    },
  };
  const orderDocument: RegisterableTool = {
    name: "order_document",
    register(server, wrap) {
      return server.registerTool(
        "order_document",
        {
          title: "Download an order invoice/document",
          description:
            "Download an order invoice or document (row OR10) by following the server-provided `self.href` of a `Document`/`Attachment` object copied verbatim from a prior MCP response (e.g. the `documents[]` entries of `order_search` results or an order detail). " +
            "The href is origin-validated to Alza's host family (invoices serve from `pdf.alza.cz`) — no arbitrary URLs. " +
            "Returns the content in structuredContent as UTF-8 `text` (JSON/XML/text) or `base64` (PDF/binary), with `contentType` and `byteLength` (max 8 MiB); the text reply carries only the metadata (plus a capped preview of text documents), never the base64 body. " +
            "Read-only; no token required. " +
            "Example: `order_document({document: {name: 'Faktura', self: {href: 'https://pdf.alza.cz/Apps/pdfdoc.asp?d=…'}}})`.",
          inputSchema: {
            document: z
              .object({
                name: z.string().max(200).optional().describe("Document name from the source response, if present."),
                self: z.object({ href: z.string().min(10).max(800).describe("The document `self.href` copied verbatim (must be an https Alza origin)."), appLink: z.string().max(100).optional() }).describe("The document `self` descriptor copied verbatim from the prior response."),
              })
              .passthrough()
              .describe("The Document/Attachment object copied verbatim from a prior MCP response (order search result or order detail `documents[]`)."),
          },
          annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: true },
          outputSchema: OUTPUT_SCHEMAS["order_document"],
        },
        async (args) => wrap("order_document", async () => withConciseText(await apiAccount(deps).orderDocument(args.document), formatOrderDocument)),
      );
    },
  };

  // ---- Account credential/identity mutations (A14–A18, 2026-09-22) ----
  const changePassword: RegisterableTool = {
    name: "change_password",
    register(server, wrap) {
      return server.registerTool(
        "change_password",
        {
          title: "Change the account password",
          description:
            "Change the Alza account password (row A14, `POST /v2/account/password`): submit the current password and the new password twice (new + confirm). " +
            "Credential mutation: requires a one-time token from `prepare_mutation` (action=`change_password`). " + IDENTITY_CHECK +
            "Side effect: on success Alza logs the user out of every device — the current access token stops working, so re-run `auth_start`/`auth_exchange` with the new password.",
          inputSchema: {
            user_id: z.string().regex(/^\d{1,16}$/).describe("Numeric Alza user id (from the `profile`/`user_data` read)."),
            old_password: z.string().min(4).max(64).describe("Current password."),
            new_password: z.string().min(8).max(64).describe("New password (min 8 chars)."),
            new_password_confirm: z.string().min(8).max(64).describe("New password again (must match `new_password`)."),
            confirmation_token: confirmationToken,
          },
          annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: true, openWorldHint: true },
          outputSchema: OUTPUT_SCHEMAS["change_password"],
        },
        async (args) => wrap("change_password", async () => result(await apiAccount(deps).changePassword({ user_id: args.user_id, old_password: args.old_password, new_password: args.new_password, new_password_confirm: args.new_password_confirm }, args.confirmation_token))),
      );
    },
  };
  const twoFactorSet: RegisterableTool = {
    name: "two_factor_set",
    register(server, wrap) {
      return server.registerTool(
        "two_factor_set",
        {
          title: "Enable or disable SMS two-factor",
          description:
            "Turn SMS two-factor on or off (row A15, `PATCH /v1/account` → `/2faEnabled`): `enabled=true` to activate, `false` to deactivate. " +
            "2FA sends a code by SMS to the account's contact phone, so set the phone first if it is wrong. " +
            "Requires a one-time token from `prepare_mutation` (action=`two_factor_set`). " + IDENTITY_CHECK,
          inputSchema: {
            user_id: z.string().regex(/^\d{1,16}$/).describe("Numeric Alza user id (from the `profile`/`user_data` read)."),
            enabled: z.boolean().describe("true to enable 2FA, false to disable it."),
            confirmation_token: confirmationToken,
          },
          annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: true, openWorldHint: true },
          outputSchema: OUTPUT_SCHEMAS["two_factor_set"],
        },
        async (args) => wrap("two_factor_set", async () => result(await apiAccount(deps).twoFactorSet({ user_id: args.user_id, enabled: args.enabled }, args.confirmation_token))),
      );
    },
  };
  const phoneChange: RegisterableTool = {
    name: "phone_change",
    register(server, wrap) {
      return server.registerTool(
        "phone_change",
        {
          title: "Change the contact phone number",
          description:
            "Change the account's contact phone number (row A16, `PATCH /v1/account` → `/phone`): the number that receives pickup codes and 2FA SMS. " +
            "Requires a one-time token from `prepare_mutation` (action=`phone_change`). " + IDENTITY_CHECK +
            "Side effect: the new number becomes the SMS destination for the account.",
          inputSchema: {
            user_id: z.string().regex(/^\d{1,16}$/).describe("Numeric Alza user id (from the `profile`/`user_data` read)."),
            phone: z.string().min(6).max(20).describe("New phone in international form, e.g. '+420777123456'."),
            confirmation_token: confirmationToken,
          },
          annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: true, openWorldHint: true },
          outputSchema: OUTPUT_SCHEMAS["phone_change"],
        },
        async (args) => wrap("phone_change", async () => result(await apiAccount(deps).phoneChange({ user_id: args.user_id, phone: args.phone }, args.confirmation_token))),
      );
    },
  };
  const emailChange: RegisterableTool = {
    name: "email_change",
    register(server, wrap) {
      return server.registerTool(
        "email_change",
        {
          title: "Change the contact email",
          description:
            "Change the account's contact email (row A16 bonus, `PATCH /v1/account` → `/email`): the address that receives invoices and order/claim notifications. " +
            "Requires a one-time token from `prepare_mutation` (action=`email_change`). " + IDENTITY_CHECK,
          inputSchema: {
            user_id: z.string().regex(/^\d{1,16}$/).describe("Numeric Alza user id (from the `profile`/`user_data` read)."),
            email: z.string().min(3).max(100).describe("New contact email address."),
            confirmation_token: confirmationToken,
          },
          annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: true, openWorldHint: true },
          outputSchema: OUTPUT_SCHEMAS["email_change"],
        },
        async (args) => wrap("email_change", async () => result(await apiAccount(deps).emailChange({ user_id: args.user_id, email: args.email }, args.confirmation_token))),
      );
    },
  };
  const deleteAccount: RegisterableTool = {
    name: "delete_account",
    register(server, wrap) {
      return server.registerTool(
        "delete_account",
        {
          title: "Delete the Alza account",
          description:
            "Delete the Alza account and its personal data (row A18, `DELETE /v1/account` with `acknowledgeAndDelete`). " +
            "Irreversible: the account, invoices, e-library, and claims are removed. " +
            "Use only on a disposable account with the user's explicit double confirmation — never the standing E2E account. " +
            "Requires a one-time token from `prepare_mutation` (action=`delete_account`). " + IDENTITY_CHECK,
          inputSchema: {
            user_id: z.string().regex(/^\d{1,16}$/).describe("Numeric Alza user id to delete (from the `profile`/`user_data` read)."),
            confirmation_token: confirmationToken,
          },
          annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: true, openWorldHint: true },
          outputSchema: OUTPUT_SCHEMAS["delete_account"],
        },
        async (args) => wrap("delete_account", async () => result(await apiAccount(deps).deleteAccount({ user_id: args.user_id }, args.confirmation_token))),
      );
    },
  };

  return [profile, contacts, register, addressUpsert, addressDelete, addressSearch, paymentMethods, afterOrderPayments, payAfterOrder, webPayAfterOrder, order, orderSearch, orderArchive, productByEan, gdprInfo, claimDetail, orderDocument, changePassword, twoFactorSet, phoneChange, emailChange, deleteAccount, reviewSubmit, complaintClaims, subscriptionOverview, subscriptionActivate, subscriptionUpdateInstallment, uploadAttachment, webPlaceOrder, cancelOrder];
}
