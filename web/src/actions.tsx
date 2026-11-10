import {
  createContext,
  useContext,
  useState,
  useEffect,
  useRef,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { AlertCircle, LoaderCircle, Undo2 } from "lucide-react";
import { type Api, type Task, type Mutation } from "./api";
import { MutationController, type SaveState } from "./mutations";
import { DraftStore } from "./draft-store";

type Actions = {
  state: SaveState;
  drafts: DraftStore;
  run: MutationController["run"];
  controller: MutationController;
  busy: boolean;
  uncertain: boolean;
  confirmed: Mutation | null;
};
const ActionsContext = createContext<Actions>(null!);
export function Mutations({
  api,
  onChange,
  children,
  session,
}: {
  api: Api;
  onChange: () => void;
  children: ReactNode;
  quiet?: boolean;
  session?: { mutations: MutationController; drafts: DraftStore };
}) {
  const callback = useRef(onChange);
  callback.current = onChange;
  const [controller] = useState(
    () => session?.mutations || new MutationController(api, () => callback.current()),
  );
  const [drafts] = useState(() => session?.drafts || new DraftStore());
  // A newly server-rendered island must hydrate against the same empty local
  // write state as its HTML, then resume the browser session's existing writes.
  const [serverState] = useState(()=>new MutationController(api,()=>{}).state);
  const state = useSyncExternalStore(
    controller.subscribe,
    controller.snapshot,
    () => serverState,
  );

  return (
    <ActionsContext.Provider
      value={{
        state,
        drafts,
        controller,
        run: controller.run.bind(controller),
        busy: [...state.intents.values()].some((i) => i.phase !== "error"),
        uncertain: [...state.intents.values()].some((i) => i.error?.uncertain),
        confirmed: state.lastTaskId
          ? state.saved.get(state.lastTaskId) || null
          : null,
      }}
    >
      {children}
    </ActionsContext.Provider>
  );
}
export function useActions() {
  return useContext(ActionsContext);
}
export function useTaskState(task: Task) {
  const { controller, state } = useActions();
  return {
    task: controller.project(task, state),
    intent: state.intents.get(task.id),
    controller,
  };
}
export function SaveIcon({ taskId }: { taskId: string }) {
  const { state } = useActions();
  const intent = state.intents.get(taskId);
  const [show, setShow] = useState(false);
  useEffect(() => {
    setShow(false);
    const timer = setTimeout(() => setShow(true), 350);
    return () => clearTimeout(timer);
  }, [intent?.started]);
  return intent?.phase === "error" ? (
    <AlertCircle className="save-error" />
  ) : intent && show ? (
    <LoaderCircle className="spinning" />
  ) : null;
}
export function Recovery({
  taskId,
  onEdit,
}: {
  taskId: string;
  onEdit?: () => void;
}) {
  const { controller, state } = useActions();
  const intent = state.intents.get(taskId);
  if (intent?.phase !== "error") return null;
  return (
    <div className="recovery" role="alert">
      <p>{intent.error?.message}</p>
      {intent.error?.uncertain ? (
        <button type="button" onClick={() => void controller.retry(taskId)}>
          Retry original change
        </button>
      ) : (
        <>
          {onEdit && (
            <button
              type="button"
              onClick={() => {
                controller.dismiss(taskId);
                onEdit();
              }}
            >
              Review edit
            </button>
          )}
          <button type="button" onClick={() => controller.dismiss(taskId)}>
            Dismiss
          </button>
        </>
      )}
    </div>
  );
}
export function UndoButton() {
  const { controller, state, confirmed, run } = useActions();
  if (
    !confirmed?.change ||
    confirmed.task.last_change_id !== confirmed.change.id
  )
    return null;
  const task = controller.project(confirmed.task, state),
    disabled = state.intents.has(task.id);
  if (task.last_change_id !== confirmed.change.id) return null;
  const previous =
    confirmed.change.before ??
    (confirmed.change.operation === "capture"
      ? { ...task, deleted: true }
      : undefined);
  return (
    <button
      className="icon-button"
      aria-label="Undo last change"
      title="Undo last change"
      disabled={disabled}
      onClick={() =>
        void run(
          "undo_change",
          {
            change_id: task.last_change_id,
            expected_version: task.version,
            reason: "Undid the last change using the task interface.",
          },
          task,
          previous ? { ...previous, version: task.version } : undefined,
        )
      }
    >
      <Undo2 />
    </button>
  );
}
