export function createId(prefix = 'id') {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
}

export function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function assertNever(value: never): never {
  throw new Error(`Unexpected value: ${value}`);
}
