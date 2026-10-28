import { describe, expect, it, vi } from "vitest";
import { MetaClient, parseUsageHeaders } from "@/lib/meta/client";
import { MetaApiError } from "@/lib/meta/errors";
import { appSecretProof } from "@/lib/crypto";

function json(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
}

const opts = (fetchImpl: typeof fetch) => ({ accessToken: "TOKEN123", appSecret: "SECRET", version: "v24.0", baseUrl: "https://graph.example", fetchImpl, sleep: async () => {}, random: () => 0.5 });

describe("MetaClient", () => {
  it("sends the token only in the Authorization header and adds appsecret_proof", async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => json(200, { id: "1" }));
    await new MetaClient(opts(fetchImpl as unknown as typeof fetch)).get("me", { fields: "id" });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(String(url)).not.toContain("TOKEN123");
    expect(String(url)).toContain(`appsecret_proof=${appSecretProof("TOKEN123", "SECRET")}`);
    expect((init!.headers as Record<string, string>).Authorization).toBe("Bearer TOKEN123");
  });

  it("retries transient errors then succeeds", async () => {
    let n = 0;
    const fetchImpl = vi.fn(async () => (++n < 3 ? json(500, { error: { code: 2, message: "temp", is_transient: true } }) : json(200, { ok: true })));
    const r = await new MetaClient(opts(fetchImpl as unknown as typeof fetch)).get("x");
    expect(r).toEqual({ ok: true });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("does not retry auth errors", async () => {
    const fetchImpl = vi.fn(async () => json(400, { error: { code: 190, error_subcode: 463, message: "expired" } }));
    await expect(new MetaClient(opts(fetchImpl as unknown as typeof fetch)).get("x")).rejects.toMatchObject({ kind: "auth" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("hands long rate-limit waits back to the queue with retryAfterMs", async () => {
    const fetchImpl = vi.fn(async () =>
      json(400, { error: { code: 80004, message: "too many calls" } }, { "x-business-use-case-usage": JSON.stringify({ b: [{ call_count: 100, estimated_time_to_regain_access: 10 }] }) }),
    );
    const err = await new MetaClient(opts(fetchImpl as unknown as typeof fetch)).get<never>("x").catch((e: unknown) => e as MetaApiError);
    expect(err).toBeInstanceOf(MetaApiError);
    expect(err.kind).toBe("rate_limit");
    expect(err.retryAfterMs).toBe(600_000);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("retries network failures and eventually reports them as transient", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    const err = await new MetaClient({ ...opts(fetchImpl as unknown as typeof fetch), maxRetries: 2 }).get<never>("x").catch((e: unknown) => e as MetaApiError);
    expect(err.kind).toBe("transient");
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("follows cursor pagination until there is no next page", async () => {
    const pages = [
      { data: [1, 2], paging: { cursors: { after: "A" }, next: "https://x" } },
      { data: [3], paging: { cursors: { after: "B" } } },
    ];
    const seen: string[] = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      seen.push(new URL(String(url)).searchParams.get("after") ?? "-");
      return json(200, pages[seen.length - 1]);
    });
    expect(await new MetaClient(opts(fetchImpl as unknown as typeof fetch)).getAll("act_1/ads")).toEqual([1, 2, 3]);
    expect(seen).toEqual(["-", "A"]);
  });

  it("halves the page size when Meta says to reduce the amount of data", async () => {
    const limits: string[] = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const limit = new URL(String(url)).searchParams.get("limit")!;
      limits.push(limit);
      if (Number(limit) > 50) return json(500, { error: { code: 1, message: "Please reduce the amount of data you're asking for, then retry your request", is_transient: true } });
      return json(200, { data: [1], paging: { cursors: { after: "A" } } });
    });
    expect(await new MetaClient(opts(fetchImpl as unknown as typeof fetch)).getAll("act_1/ads", { limit: 200 })).toEqual([1]);
    // 200 → 100 → 50, and the oversized requests are not retried at the same size.
    expect(limits).toEqual(["200", "100", "50"]);
  });

  it("reads the insights throttle header and slows down near the limit", async () => {
    const sleeps: number[] = [];
    const fetchImpl = vi.fn(async () => json(200, { ok: 1 }, { "x-fb-ads-insights-throttle": '{"app_id_util_pct":95,"acc_id_util_pct":10}' }));
    const c = new MetaClient({ ...opts(fetchImpl as unknown as typeof fetch), sleep: async (ms: number) => void sleeps.push(ms) });
    await c.get("x");
    expect(c.lastUsage.insightsThrottlePct).toBe(95);
    await c.get("x");
    expect(sleeps).toEqual([15_000]);
  });

  it("parses usage headers", () => {
    const h = new Headers({ "x-app-usage": '{"call_count":12,"total_time":5}', "x-ad-account-usage": '{"acc_id_util_pct":40.5,"reset_time_duration":0,"ads_api_access_tier":"standard_access"}' });
    expect(parseUsageHeaders(h)).toMatchObject({ appUsagePct: 12, adAccountUsagePct: 40.5, accessTier: "standard_access" });
  });
});
