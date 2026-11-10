# Demo design verification

## Scripted chat streaming update

Intended behavior: sending a prepared message opens the ready widget with a restrained 380ms height/fade transition, then streams the reply in short word groups underneath. Keep each conversation's progress when switching chats; do not rerun captures or restart completed replies. Reduced-motion preferences show the complete reply and card immediately. Remove the composer's visible labels, footer annotation, and post-send instructions; keep its message and send control, accessible names, and the small host-level demo identifier. Verify phone/desktop, both themes, switching during streaming, reduced motion, and inline/expanded cards before publication.

The live reference composer and user message both use 16px, weight 400, 26px line height, normal letter spacing, and disabled `liga` features. Their font stack starts with `-apple-system-body`, then `ui-sans-serif`, `-apple-system`, and `system-ui`. Match those measured values in the demo; the previous composer used 24px line height and a different fallback order. No host font assets are copied.

The update passes 34 demo browser checks and 24 existing WebKit surface-motion/expanded-header checks. Phone/light and desktop/dark screenshots were inspected. Coverage includes partial replies, widget-before-reply order, switching chats during streaming, reduced motion, and the measured composer typography. Resize writes now run outside observer delivery, and returning from expansion waits for the inline controls to mount before restoring focus.

Reference: the user-selected GTD Demo Reference conversation, inspected read-only. No model prompts were sent. Reference captures remain private and are not part of the Pages artifact.

## Intended presentation

- Website: the shared application, light by default, with a small Demo/reset/theme control. Priority squares center on the available content pane, not the viewport or sidebar.
- Chat: measured 52px navigation rail, 284px desktop sidebar, 768px conversation column, 16px system text at 26px line height, purple user messages, dark surfaces, and a bottom composer. Only the three prepared conversations and relevant demo controls are present.
- Expanded card: the existing live iframe remains mounted. Desktop uses a viewer beginning 405px from the left, a 53px host toolbar, and a centered 780px application area. Phone uses the full content width. Closing returns to the inline card and restores keyboard focus.

## Checks

Chromium and WebKit checks cover 390, 800, 1280, and 1440px website widths, light/dark themes, content-pane centering, concise mobile labels, task expansion, priority-list overlays, background scroll locking, local edits, undo, and reset. Both browsers exercise all three chats at 390 and 1440px, including inline/expanded cards and switching back without repeating a batch.

Representative website, inline-chat, expanded-chat, and overlay screenshots were inspected. Desktop and phone expanded views were compared alongside the live-reference captures at matching viewport sizes. The desktop application inset was corrected to match the reference; the sidebar closes when expansion would otherwise cover the conversation. The first reset test exposed an invalid task URL after clearing a newly created record; Reset now returns the website to Home.

The reconstruction intentionally replaces host branding and excludes account, model, upload, voice, billing, and unrelated chat controls. It uses the application's real components rather than screenshot replicas. Browser-emulated phone checks are not physical-device testing.

Generated evidence is in ignored `web/demo-results/` after running the browser suite. CI retains failure screenshots and traces for seven days. Publication and data-contract acceptance are recorded in [the demo documentation](docs/demos/README.md).

Screenshot review also caught Results task titles falling back to default bordered, centered buttons. Results now uses the same task-list styling wrapper as other shared views. A new border/alignment assertion was confirmed to fail on the previous build and pass on the candidate.
