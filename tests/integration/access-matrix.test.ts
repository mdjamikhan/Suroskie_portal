// Per-user access overrides, custom roles and exports, checked against the same fixture.
// Every assertion goes through the report services, i.e. the SQL scoping + metric projection.
import { beforeAll, describe, expect, it } from "vitest";
import { ctxFor, makeFixture, makeUser, RANGE, resetDb } from "../helpers/db";
import { prisma } from "@/lib/db";
import { createRole } from "@/lib/users/roles";
import { buildExport } from "@/lib/reporting/export";
import { getCampaignReport, getCreatives, getCreatorPerformance, getOverview, listCreators } from "@/lib/reporting/service";
import { ForbiddenError } from "@/lib/errors";

let f: Awaited<ReturnType<typeof makeFixture>>;
let admin: string;
const actor = (id: string) => ({ userId: id, email: `${id}@t` });
const val = (m: Record<string, { s: string; v?: number }>, k: string) => (m[k]?.s === "ok" ? m[k].v : m[k]?.s);
const csvRows = (body: string) => body.replace("﻿", "").trim().split("\r\n");

beforeAll(async () => {
  await resetDb();
  f = await makeFixture();
  admin = await makeUser({ email: "admin@matrix", role: "super_admin" });
});

describe("custom role", () => {
  it("limits a user to the role's accounts, reports and metrics, including exports", async () => {
    const role = await createRole(await ctxFor(admin), actor(admin), {
      name: "Agency analyst", description: "Second account only", permissions: ["reports.creatives", "reports.export"],
      metrics: ["purchases", "roas"], allAdAccounts: false, allCreators: true, maxLookbackDays: null,
    });
    const id = await makeUser({ email: "analyst@matrix", role: "content_manager", accounts: [f.acc2.id] });
    // Replace the default role with the custom one.
    await prisma.userRole.deleteMany({ where: { userId: id } });
    await prisma.userRole.create({ data: { userId: id, roleId: role.id } });
    const ctx = await ctxFor(id);

    const c = await getCreatives(ctx, { ...RANGE, minSpend: "0", minPurchases: "0" });
    expect(c.rows.map((r) => r.id)).toEqual([f.adC.id]);
    expect(Object.keys(c.rows[0].metrics).sort()).toEqual(["purchases", "roas"]);
    await expect(getOverview(ctx, RANGE)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(getCampaignReport(ctx, RANGE, "campaign")).rejects.toBeInstanceOf(ForbiddenError);

    const out = await buildExport(ctx, actor(id), "creatives", RANGE);
    const [header, ...rows] = csvRows(out.body);
    expect(header).toMatch(/Purchases,Purchase ROAS$/);
    expect(header).not.toMatch(/Amount spent|Impressions|CTR/);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toContain("adC");
  });
});

describe("per-user overrides", () => {
  it("a marketing manager only exports campaigns from assigned ad accounts", async () => {
    const id = await makeUser({ email: "mm@matrix", role: "marketing_manager", accounts: [f.acc1.id] });
    const [, ...rows] = csvRows((await buildExport(await ctxFor(id), actor(id), "campaigns", RANGE)).body);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toContain("Real account");
    const r = await getCampaignReport(await ctxFor(id), { ...RANGE, account: f.acc2.id }, "campaign");
    expect(r.rows).toEqual([]);
  });

  it("'no data before' date is enforced server-side", async () => {
    const id = await makeUser({ email: "early@matrix", role: "content_manager", creators: [f.creatorA.id] });
    await prisma.user.update({ where: { id }, data: { earliestDataDate: new Date("2026-10-03T00:00:00Z") } });
    const o = await getOverview(await ctxFor(id), RANGE);
    expect(o.range).toMatchObject({ from: "2026-10-03", clamped: true });
    expect(val(o.metrics, "purchases")).toBe(12); // creator A, one day
  });

  it("grants a metric beyond the role and denies a report the role includes", async () => {
    const viewer = await makeUser({ email: "viewer@matrix", role: "creator_viewer", creators: [f.creatorB.id], metricOverrides: [{ key: "purchase_value", granted: true }] });
    const p = await getCreatorPerformance(await ctxFor(viewer), f.creatorB.id, RANGE);
    expect(val(p.metrics, "purchase_value")).toBe((2000 + 1400) * 3);
    expect(p.metrics.spend).toBeUndefined();

    const cm = await makeUser({ email: "nocreatives@matrix", role: "content_manager", creators: [f.creatorA.id], permissionOverrides: [{ key: "reports.creatives", granted: false }] });
    await expect(getCreatives(await ctxFor(cm), RANGE)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(getOverview(await ctxFor(cm), RANGE)).resolves.toBeDefined();
  });

  it("'all creators' override widens a content manager without touching other users", async () => {
    const wide = await makeUser({ email: "wide@matrix", role: "content_manager" });
    await prisma.user.update({ where: { id: wide }, data: { allCreators: true } });
    const narrow = await makeUser({ email: "narrow@matrix", role: "content_manager", creators: [f.creatorA.id] });
    expect((await listCreators(await ctxFor(wide), RANGE)).total).toBe(2);
    expect((await listCreators(await ctxFor(narrow), RANGE)).total).toBe(1);
  });

  it("demo rows never leak into a scoped user's real-mode report", async () => {
    // The fixture's demo ad is mapped to creator A with huge numbers.
    const id = await makeUser({ email: "demo-check@matrix", role: "content_manager", creators: [f.creatorA.id] });
    const p = await getCreatorPerformance(await ctxFor(id), f.creatorA.id, RANGE);
    expect(val(p.metrics, "purchases")).toBe(12 * 3);
    expect(p.creatives.rows.map((r) => r.id)).not.toContain(f.adD.id);
  });
});
