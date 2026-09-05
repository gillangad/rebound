let counter = 0;

export function newId(prefix = "id") {
  counter += 1;
  return `${prefix}_${Date.now().toString(36)}_${counter.toString(36)}`;
}

export function stableUuid(seed: number) {
  const tail = seed.toString(16).padStart(12, "0");
  return `00000000-0000-4000-8000-${tail}`;
}
