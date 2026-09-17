export interface Identified {
  id: string;
}

/** 数据驱动注册表 —— Core Runtime 不写死具体业务 ID，业务通过数据注册。 */
export class GenericRegistry<T extends Identified> {
  private readonly items = new Map<string, T>();

  constructor(initial: T[] = []) {
    for (const item of initial) this.register(item);
  }

  register(item: T): void {
    if (this.items.has(item.id)) {
      throw new Error(`Duplicate registry id: ${item.id}`);
    }
    this.items.set(item.id, item);
  }

  upsert(item: T): void {
    this.items.set(item.id, item);
  }

  get(id: string): T | undefined {
    return this.items.get(id);
  }

  require(id: string): T {
    const item = this.get(id);
    if (!item) throw new Error(`Registry item not found: ${id}`);
    return item;
  }

  list(): T[] {
    return [...this.items.values()];
  }
}
