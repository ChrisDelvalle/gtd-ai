import { DraftCell } from "./draft-store.ts";

/** Disposable screen snapshots, separate from unsaved drafts and write intents.
 * A bounded number of recently visited screens retain filters/pages/disclosures.
 * Evicted screens reload through their canonical URL; drafts remain available. */
export class ViewStore {
  private scenes = new Map<string, Map<string, DraftCell<unknown>>>();
  constructor(private readonly limit = 32) {}
  open(key: string) {
    const restored = this.scenes.has(key);
    const cells = this.scenes.get(key) || new Map<string, DraftCell<unknown>>();
    this.scenes.delete(key);
    this.scenes.set(key, cells);
    while (this.scenes.size > this.limit)
      this.scenes.delete(this.scenes.keys().next().value!);
    return {
      restored,
      cell<T>(key: string, initial: () => T) {
        let cell = cells.get(key) as DraftCell<T> | undefined;
        if (!cell) {
          cell = new DraftCell(
            initial,
            () => false,
            () => {},
          );
          cells.set(key, cell as DraftCell<unknown>);
        }
        return cell;
      },
    };
  }
  get size() {
    return this.scenes.size;
  }
}
