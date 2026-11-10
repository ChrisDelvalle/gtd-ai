import { DemoStore, type Fixture } from "./store";
import { runScenario, type ScenarioId } from "./scenarios";

/** One store and one scripted execution per conversation, shared by its cards. */
export class DemoConversations {
  private sessions = new Map<
    ScenarioId,
    Promise<{
      store: DemoStore;
      script: ReturnType<typeof runScenario>;
    }>
  >();
  private fixture?: Promise<Fixture>;
  constructor(private load: () => Promise<Fixture>) {}
  get(id: ScenarioId) {
    let session = this.sessions.get(id);
    if (!session) {
      this.fixture ||= this.load().catch((error) => {
        this.fixture = undefined;
        throw error;
      });
      session = this.fixture
        .then((fixture) => {
          const store = new DemoStore(fixture, id);
          return { store, script: runScenario(store, id) };
        })
        .catch((error) => {
          this.sessions.delete(id);
          throw error;
        });
      this.sessions.set(id, session);
    }
    return session;
  }
}
