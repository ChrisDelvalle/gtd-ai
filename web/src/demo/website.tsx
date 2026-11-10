import { createRoot } from "react-dom/client";
import { Moon, Sun, RotateCcw } from "lucide-react";
import { Application } from "../application";
import { useHashRouting } from "../routes";
import { DemoStore } from "./store";
import { loadDemo, localLinks, preparePreferences } from "./bootstrap";
import { useDemoTheme } from "./theme";
useHashRouting();
localLinks();
preparePreferences("website", "website");
const root = createRoot(document.getElementById("root")!);
function Website({ store }: { store: DemoStore }) {
  const [theme, toggle] = useDemoTheme();
  return (
    <>
      <div className="demo-controls" aria-label="Demo controls">
        <span>Demo</span>
        <button
          onClick={() => {
            location.hash = "/";
            location.reload();
          }}
        >
          <RotateCcw size={14} />
          Reset demo
        </button>
        <button
          aria-label={`Use ${theme === "light" ? "dark" : "light"} theme`}
          onClick={toggle}
        >
          {theme === "light" ? <Moon size={16} /> : <Sun size={16} />}
        </button>
      </div>
      <Application
        api={store.api}
        account={
          <span className="sidebar-account-name">Maya Rivera · Demo</span>
        }
      />
    </>
  );
}
loadDemo()
  .then((fixture) =>
    root.render(<Website store={new DemoStore(fixture, "website")} />),
  )
  .catch((error) =>
    root.render(
      <main className="demo-error" role="alert">
        {error.message}
        <button onClick={() => location.reload()}>Retry</button>
      </main>,
    ),
  );
