import { Children, useMemo, type ReactNode } from "react";
import Markdown, { type Components } from "react-markdown";
import { type Api } from "./api";
import { ExternalLink, NoteText, safeUrl } from "./task-context";

/** CommonMark rendered as React elements; no HTML execution, remote images or embeds. */
export default function Description({ text, api }: { text: string; api: Api }) {
  const components = useMemo<Components>(() => {
    // Preserve existing automatic URL links, without touching code or links that
    // the Markdown parser has already recognized.
    const links = (children: ReactNode) =>
      Children.map(children, (child) =>
        typeof child === "string" ? (
          <NoteText text={child} api={api} markdownLinks={false} />
        ) : (
          child
        ),
      );
    return {
      p: ({ children }) => <p>{links(children)}</p>,
      li: ({ children }) => <li>{links(children)}</li>,
      strong: ({ children }) => <strong>{links(children)}</strong>,
      em: ({ children }) => <em>{links(children)}</em>,
      // Descriptions sit underneath task/project titles in the page hierarchy.
      h1: ({ children }) => <h3>{links(children)}</h3>,
      h2: ({ children }) => <h4>{links(children)}</h4>,
      h3: ({ children }) => <h5>{links(children)}</h5>,
      h4: ({ children }) => <h6>{links(children)}</h6>,
      h5: ({ children }) => <h6>{links(children)}</h6>,
      h6: ({ children }) => <h6>{links(children)}</h6>,
      a: ({ href, children }) => (
        <ExternalLink api={api} url={href || ""}>
          {children}
        </ExternalLink>
      ),
      img: ({ alt }) => <span>{alt || ""}</span>,
    };
  }, [api]);
  return (
    <div className="task-reading-notes task-markdown">
      <Markdown
        components={components}
        urlTransform={(url) => safeUrl(url) || ""}
      >
        {text}
      </Markdown>
    </div>
  );
}
