// What the witness needs of a Durable Object's storage, in memory.
export class MemoryStore {
  m = new Map();
  async get(k) {
    return structuredClone(this.m.get(k));
  }
  async put(k, v) {
    await new Promise((r) => setTimeout(r, 1)); // storage takes time: calls must not interleave
    this.m.set(k, structuredClone(v));
  }
  async delete(k) {
    return this.m.delete(k);
  }
  async list({ prefix = '' } = {}) {
    return new Map([...this.m].filter(([k]) => k.startsWith(prefix)).sort());
  }
}
