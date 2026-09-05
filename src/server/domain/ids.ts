import { randomUUID } from "node:crypto";

export function newId(_prefix = "id") {
  return randomUUID();
}

export function stableUuid(seed: number) {
  const tail = seed.toString(16).padStart(12, "0");
  return `00000000-0000-4000-8000-${tail}`;
}
