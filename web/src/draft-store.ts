/** Session-only user intent. Never serialized into URLs, browser storage or SSR
 * output. Clean drafts are an LRU cache; unsaved drafts are never evicted. */
export class DraftStore {
  private cells = new Map<string, DraftCell<unknown>>();
  constructor(private readonly cleanLimit = 32) {}
  cell<T>(key: string, initial: () => T, dirty: (value: T) => boolean): DraftCell<T> {
    let cell = this.cells.get(key) as DraftCell<T> | undefined;
    if (!cell) {
      cell = new DraftCell(initial, dirty, () => this.trim());
      this.cells.set(key, cell as DraftCell<unknown>);
    } else {
      this.cells.delete(key);
      this.cells.set(key, cell as DraftCell<unknown>);
    }
    this.trim(cell as DraftCell<unknown>);
    return cell;
  }
  private trim(protectedCell?: DraftCell<unknown>) {
    const clean = [...this.cells].filter(([, cell]) => !cell.dirty && !cell.observed && cell !== protectedCell);
    for (const [key] of clean.slice(0, Math.max(0, clean.length - this.cleanLimit)))
      this.cells.delete(key);
  }
  discard(key: string) { this.cells.get(key)?.reset(); }
  get size() { return this.cells.size; }
}

export class DraftCell<T> {
  private listeners = new Set<() => void>();
  private value: T;
  constructor(private initial: () => T, private isDirty: (value: T) => boolean, private collect: () => void) { this.value = initial(); }
  get dirty() { return this.isDirty(this.value); }
  get observed() { return this.listeners.size > 0; }
  snapshot = () => this.value;
  reset = () => this.update(this.initial());
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); this.collect(); };
  };
  update = (value: T | ((previous: T) => T)) => {
    this.value = typeof value === "function" ? (value as (previous: T) => T)(this.value) : value;
    for (const listener of this.listeners) listener();
    this.collect();
  };
}
