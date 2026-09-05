import { describe, expect, it } from "vitest";
import { attachDemoSession, DEMO_SESSION_COOKIE, getDemoSession } from "@/server/workspace/session";
import { resetMemoryRepositoryForTests, getRepository } from "@/server/db/repository";

describe("anonymous demo workspace boundaries", () => {
  it("uses a signed, HttpOnly cookie to reuse a browser workspace and rejects tampering", () => {
    const first = getDemoSession(new Request("http://localhost:3000/"));
    expect(first.isNew).toBe(true);
    expect(first.setCookie).toContain(`${DEMO_SESSION_COOKIE}=`);
    expect(first.setCookie).toContain("HttpOnly");
    expect(first.setCookie).toContain("SameSite=Lax");

    const response = attachDemoSession(Response.json({ ok: true }), first);
    const cookie = response.headers.get("set-cookie");
    expect(cookie).toBeTruthy();

    const reused = getDemoSession(new Request("http://localhost:3000/", { headers: { cookie: cookie! } }));
    expect(reused).toMatchObject({ workspaceId: first.workspaceId, isNew: false });

    const [cookiePair, ...cookieAttributes] = cookie!.split("; ");
    const [cookieName, cookieValue] = cookiePair.split("=");
    const alteredValue = `${cookieValue.slice(0, -1)}${cookieValue.endsWith("a") ? "b" : "a"}`;
    const tampered = [`${cookieName}=${alteredValue}`, ...cookieAttributes].join("; ");
    expect(getDemoSession(new Request("http://localhost:3000/", { headers: { cookie: tampered } })).isNew).toBe(true);
  });

  it("keeps provider state isolated by workspace key without a process-global singleton", async () => {
    resetMemoryRepositoryForTests();
    const first = getRepository({ workspaceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", fixtureAsync: false });
    const second = getRepository({ workspaceId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", fixtureAsync: false });
    const firstBootstrap = await first.bootstrap();
    const secondBootstrap = await second.bootstrap();
    expect(firstBootstrap.merchant.workspaceId).toBe("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    expect(secondBootstrap.merchant.workspaceId).toBe("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
    expect(firstBootstrap.cases.map((item) => item.id)).not.toEqual(secondBootstrap.cases.map((item) => item.id));

    const atelier = firstBootstrap.cases.find((item) => item.customer.displayName === "Atelier Works Pvt Ltd")!;
    await first.investigateCase(atelier.id);
    expect((await first.bootstrap()).cases.find((item) => item.id === atelier.id)?.documents).toHaveLength(1);
    expect((await second.bootstrap()).cases.find((item) => item.customer.displayName === "Atelier Works Pvt Ltd")?.documents).toHaveLength(0);
    expect((await second.bootstrap()).proposals).toHaveLength(1);
  });
});
