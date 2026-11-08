import { afterEach, describe, expect, it, vi } from "vitest";
import { MobileApi } from "../src/infra/mobile-api.js";
import { MobileAccount } from "../src/domain/mobile-account.js";

// Keep unit tests deterministic: never auto-load a real stored OAuth token.
process.env.ALZA_TOKEN_FILE = "none";

type Seen = { url: string; method: string; headers: Record<string, string>; body: string | null };
type Handler = (req: Seen) => Response;

function withFetch(handler: Handler, seen: Seen[]): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const headers = Object.fromEntries(
      new Headers(init?.headers as Headers | Record<string, string> | undefined).entries(),
    ) as Record<string, string>;
    const body = init?.body == null ? null : String(init.body);
    seen.push({ url, method: init?.method ?? "GET", headers, body });
    return handler({ url, method: init?.method ?? "GET", headers, body });
  }) as typeof fetch;
}

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });

const makeAccount = () => new MobileAccount(new MobileApi({ visitorId: "visitor-test", baseUrl: "https://test.alza.invalid" }));
const UID = "100000001";

describe("task-6 account credential/identity mutations (A14–A18)", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("A14 change_password: validation + token guard + exact v2 password POST", async () => {
    const account = makeAccount();
    // token guard
    await expect(account.changePassword({ user_id: UID, old_password: "a", new_password: "b", new_password_confirm: "b" }, "nope")).rejects.toThrow(/change_password confirmation token/);
    // validation (prepared token per check)
    let t = account.prepareMutation("change_password");
    await expect(account.changePassword({ user_id: "abc", old_password: "a", new_password: "x".repeat(8), new_password_confirm: "x".repeat(8) }, t.confirmationToken)).rejects.toThrow(/user_id/);
    t = account.prepareMutation("change_password");
    await expect(account.changePassword({ user_id: UID, old_password: "a", new_password: "short", new_password_confirm: "short" }, t.confirmationToken)).rejects.toThrow(/at least 8/);
    t = account.prepareMutation("change_password");
    await expect(account.changePassword({ user_id: UID, old_password: "oldpw1", new_password: "newpw1234", new_password_confirm: "different1" }, t.confirmationToken)).rejects.toThrow(/must match/);
    t = account.prepareMutation("change_password");
    await expect(account.changePassword({ user_id: UID, old_password: "oldpassword1", new_password: "oldpassword1", new_password_confirm: "oldpassword1" }, t.confirmationToken)).rejects.toThrow(/differ from old/);

    // happy path — exact route + DTO (oldPassword, password1, password2 per the live dialog form)
    t = account.prepareMutation("change_password");
    vi.stubGlobal("fetch", withFetch((req) => {
      if (req.url.endsWith("/v2/getUserData")) return json({ user_id: Number(UID) }); // #79 identity check
      expect(req.url).toBe(`https://www.alza.cz/api/users/${UID}/v2/account/password`);
      expect(req.method).toBe("POST");
      const body = JSON.parse(req.body as string);
      expect(body).toEqual({ oldPassword: "oldpw1", password1: "newpw1234", password2: "newpw1234" });
      return json({ err: 0 });
    }, []));
    try {
      const out = (await account.changePassword({ user_id: UID, old_password: "oldpw1", new_password: "newpw1234", new_password_confirm: "newpw1234" }, t.confirmationToken)) as Record<string, unknown>;
      expect(out.err).toBe(0);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("A15 two_factor_set: boolean required, JSON-Patch body to /v1/account", async () => {
    const account = makeAccount();
    await expect(account.twoFactorSet({ user_id: UID, enabled: "yes" }, "nope")).rejects.toThrow(/two_factor_set confirmation token/);
    let t = account.prepareMutation("two_factor_set");
    await expect(account.twoFactorSet({ user_id: UID, enabled: "yes" }, t.confirmationToken)).rejects.toThrow(/boolean/);
    t = account.prepareMutation("two_factor_set");
    vi.stubGlobal("fetch", withFetch((req) => {
      if (req.url.endsWith("/v2/getUserData")) return json({ user_id: Number(UID) }); // #79 identity check
      expect(req.url).toBe(`https://www.alza.cz/api/users/${UID}/v1/account?country=CZ`);
      expect(req.method).toBe("PATCH");
      expect(JSON.parse(req.body as string)).toEqual({ op: "replace", path: "/2faEnabled", value: true });
      return json({ err: 0 });
    }, []));
    try {
      await expect(account.twoFactorSet({ user_id: UID, enabled: true }, t.confirmationToken)).resolves.toBeDefined();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("A16 phone_change: international format, JSON-Patch body to /phone", async () => {
    const account = makeAccount();
    await expect(account.phoneChange({ user_id: UID, phone: "12345" }, "nope")).rejects.toThrow(/phone_change confirmation token/);
    let t = account.prepareMutation("phone_change");
    await expect(account.phoneChange({ user_id: UID, phone: "12345" }, t.confirmationToken)).rejects.toThrow(/international/);
    t = account.prepareMutation("phone_change");
    await expect(account.phoneChange({ user_id: UID, phone: "601 234 567" }, t.confirmationToken)).rejects.toThrow(/international/);
    // separators are accepted and normalised to the compact international form
    t = account.prepareMutation("phone_change");
    vi.stubGlobal("fetch", withFetch((req) => {
      if (req.url.endsWith("/v2/getUserData")) return json({ user_id: Number(UID) }); // #79 identity check
      expect(req.url).toBe(`https://www.alza.cz/api/users/${UID}/v1/account?country=CZ`);
      expect(req.method).toBe("PATCH");
      expect(JSON.parse(req.body as string)).toEqual({ op: "replace", path: "/phone", value: "+420777123456" });
      return json({ err: 0 });
    }, []));
    try {
      await expect(account.phoneChange({ user_id: UID, phone: "+420 777-123 456" }, t.confirmationToken)).resolves.toBeDefined();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("A16 email_change: valid email, JSON-Patch body to /email", async () => {
    const account = makeAccount();
    await expect(account.emailChange({ user_id: UID, email: "not-an-email" }, "nope")).rejects.toThrow(/email_change confirmation token/);
    let t = account.prepareMutation("email_change");
    await expect(account.emailChange({ user_id: UID, email: "not-an-email" }, t.confirmationToken)).rejects.toThrow(/valid address/);
    t = account.prepareMutation("email_change");
    vi.stubGlobal("fetch", withFetch((req) => {
      if (req.url.endsWith("/v2/getUserData")) return json({ user_id: Number(UID) }); // #79 identity check
      expect(req.url).toBe(`https://www.alza.cz/api/users/${UID}/v1/account?country=CZ`);
      expect(req.method).toBe("PATCH");
      expect(JSON.parse(req.body as string)).toEqual({ op: "replace", path: "/email", value: "new@example.test" });
      return json({ err: 0 });
    }, []));
    try {
      await expect(account.emailChange({ user_id: UID, email: "new@example.test" }, t.confirmationToken)).resolves.toBeDefined();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("A18 delete_account: token guard + DELETE with acknowledgeAndDelete", async () => {
    const account = makeAccount();
    await expect(account.deleteAccount({ user_id: UID }, "nope")).rejects.toThrow(/delete_account confirmation token/);
    let t = account.prepareMutation("delete_account");
    await expect(account.deleteAccount({ user_id: "x" }, t.confirmationToken)).rejects.toThrow(/user_id/);
    t = account.prepareMutation("delete_account");
    vi.stubGlobal("fetch", withFetch((req) => {
      if (req.url.endsWith("/v2/getUserData")) return json({ user_id: Number(UID) }); // #79 identity check
      expect(req.url).toBe(`https://www.alza.cz/api/users/${UID}/v1/account?country=cz`);
      expect(req.method).toBe("DELETE");
      expect(JSON.parse(req.body as string)).toEqual({ acknowledgeAndDelete: true });
      return new Response(null, { status: 200 });
    }, []));
    try {
      const out = (await account.deleteAccount({ user_id: UID }, t.confirmationToken)) as Record<string, unknown>;
      expect(out.deleted).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("OR7 order_archive: typed read over the archiveOrders section (no token)", async () => {
    const account = makeAccount();
    // validation
    await expect(account.orderArchive({ user_id: "abc", hide_cancelled_orders: false })).rejects.toThrow(/user_id/);
    await expect(account.orderArchive({ user_id: UID, hide_cancelled_orders: "yes" as unknown as boolean })).rejects.toThrow(/hide_cancelled_orders/);
    await expect(account.orderArchive({ user_id: UID, limit: 0 })).rejects.toThrow(/limit/);
    await expect(account.orderArchive({ user_id: UID, limit: 101 })).rejects.toThrow(/limit/);
    await expect(account.orderArchive({ user_id: UID, offset: -1 })).rejects.toThrow(/offset/);

    const seen: Seen[] = [];
    vi.stubGlobal("fetch", withFetch((req) => {
      if (req.url.endsWith("/v2/getUserData")) return json({ user_id: Number(UID) }); // #79 identity check
      expect(req.url).toContain(`/api/users/${UID}/v1/orders/archive`);
      expect(req.url).toContain("hideCancelledOrders=false"); // the APK form default (include cancelled)
      expect(req.url).toContain("productFilterType=0");
      expect(req.method).toBe("GET");
      return json({ self: { appLink: "archiveUserOrders" }, paging: { limit: 10, size: 0 }, value: [] });
    }, seen));
    try {
      const out = (await account.orderArchive({ user_id: UID })) as { value: unknown[] };
      expect(out.value).toEqual([]);
    } finally {
      vi.unstubAllGlobals();
    }

    // the hide toggle + limit flow through to the query string
    vi.stubGlobal("fetch", withFetch((req) => {
      if (req.url.endsWith("/v2/getUserData")) return json({ user_id: Number(UID) }); // #79 identity check
      expect(req.url).toContain("hideCancelledOrders=true");
      expect(req.url).toContain("limit=25");
      expect(req.url).toContain("offset=100");
      return json({ value: [{ orderId: "1" }] });
    }, []));
    try {
      await account.orderArchive({ user_id: UID, hide_cancelled_orders: true, limit: 25, offset: 100 });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("AT3 product_by_ean: validates EANs and posts the static vision route", async () => {
    const account = makeAccount();
    // validation
    await expect(account.productByEan([])).rejects.toThrow(/non-empty/);
    await expect(account.productByEan(["abc"])).rejects.toThrow(/6-14 digit/);
    await expect(account.productByEan(["12345"])).rejects.toThrow(/6-14 digit/);
    await expect(account.productByEan(Array(21).fill("8594021283371"))).rejects.toThrow(/20/);

    const seen: Seen[] = [];
    vi.stubGlobal("fetch", withFetch((req) => {
      if (req.url.endsWith("/v2/getUserData")) return json({ user_id: Number(UID) }); // #79 identity check
      expect(req.url).toContain("/services/restservice.svc/v1/getProductByEANlist");
      expect(req.method).toBe("POST");
      expect(JSON.parse(req.body as string)).toEqual({ eanList: ["8594021283371"] });
      return json({ data: null, err: 1, msg: "No products found." });
    }, seen));
    try {
      const out = (await account.productByEan(["8594021283371"])) as { err: number; msg: string };
      expect(out.err).toBe(1);
      expect(out.msg).toBe("No products found.");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("mutate_list: the five account mutations are token-gated but not low-risk-whitelisted", async () => {
    const account = makeAccount();
    for (const action of ["change_password", "two_factor_set", "phone_change", "email_change", "delete_account"]) {
      const t = account.prepareMutation(action);
      await expect(
        account.mutateList(action, t.confirmationToken, { user_id: UID, new_password: "x".repeat(8) }),
      ).rejects.toThrow(/not a whitelisted low-risk mutation; use the matching typed tool/);
    }
    // and gdpr_export (low-risk) still flows through mutate_list
    const t = account.prepareMutation("gdpr_export");
    vi.stubGlobal("fetch", withFetch((req) => {
      if (req.url.endsWith("/v2/getUserData")) return json({ user_id: Number(UID) }); // #79 identity check
      expect(req.url).toContain("/v1/userAccount/gdprInformation");
      return new Response(null, { status: 202 });
    }, []));
    try {
      await expect(account.mutateList("gdpr_export", t.confirmationToken, { user_id: UID })).resolves.toBeDefined();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
