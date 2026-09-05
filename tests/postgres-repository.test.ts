import { describe, expect, it, vi } from "vitest";
import { MemoryRepository, PostgresRepository } from "@/server/db/repository";

describe("PostgreSQL repository boundary", () => {
  it("forwards the invocation reason into the scoped domain repository", async () => {
    const inner = new MemoryRepository(undefined, undefined, { fixtureAsync: false });
    const orbit = inner.world.cases.find((recoveryCase) => inner.world.customers.find((customer) => customer.id === recoveryCase.customerId)?.displayName === "Orbit Retail")!;
    const repository = Object.create(PostgresRepository.prototype) as PostgresRepository;
    const run = vi.fn(async (callback: (repo: MemoryRepository) => Promise<unknown>) => callback(inner));
    Object.defineProperty(repository, "run", { value: run });

    const result = await repository.investigateCase(orbit.id, "changed_circumstance");

    expect(result.runId).toBeTruthy();
    expect(run).toHaveBeenCalledOnce();
    expect(inner.world.agentRuns[0]).toMatchObject({ invocationReason: "changed_circumstance" });
    expect(inner.world.audit.some((event) => event.eventType === "agent.invocation.started" && event.invocationReason === "changed_circumstance")).toBe(true);
  });
});
