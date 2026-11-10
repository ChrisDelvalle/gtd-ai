# Demo design verification

## Inbox example and response formatting

Intended behavior: four independent conversations, including a small fictional inbox with two actionable emails and one newsletter. A collapsed “Read 3 emails” disclosure lets visitors inspect the sources. Sending creates two tasks exactly once with the requested deadlines, projects, and source context; it never sends a reply or creates a task from the newsletter. The Results card appears before the assistant's summary. Replies use short paragraphs, real lists, and selective bold emphasis, following the supplied live reference without copying personal content. Formatting stays stable while text streams, including within bold phrases. Verify both themes, phone/desktop, expansion, source disclosure, reset, and conversation isolation before publication.

The priorities exchange shows two separate cards: the chart, then the recommended replay task. Both cards belong to one conversation sandbox. Completing the replay must remove it from Next in the chart and unblock the refund check; undo restores both. Each card expands independently into a right-hand viewer with a 260ms slide, and slides out before returning to its own inline position and focus. Reduced motion skips both transitions. No extra model or network requests are introduced.

## Scripted chat streaming update

Intended behavior: sending a prepared message opens the ready widget with a restrained 380ms height/fade transition, then streams the reply in short word groups underneath. Keep each conversation's progress when switching chats; do not rerun captures or restart completed replies. Reduced-motion preferences show the complete reply and card immediately. Remove the composer's visible labels, footer annotation, and post-send instructions; keep its message and send control, accessible names, and the small host-level demo identifier. Verify phone/desktop, both themes, switching during streaming, reduced motion, and inline/expanded cards before publication.

The live reference composer and user message both use 16px, weight 400, 26px line height, normal letter spacing, and disabled `liga` features. Their font stack starts with `-apple-system-body`, then `ui-sans-serif`, `-apple-system`, and `system-ui`. Match those measured values in the demo; the previous composer used 24px line height and a different fallback order. No host font assets are copied.

The reference sidebar was measured separately: the same font stack, 14px regular text, 20px line height, normal letter spacing, and normal font features. The sidebar uses those values without inheriting the composer's disabled ligatures.

The update passes 34 demo browser checks and 24 existing WebKit surface-motion/expanded-header checks. Phone/light and desktop/dark screenshots were inspected. Coverage includes partial replies, widget-before-reply order, switching chats during streaming, reduced motion, and the measured composer typography. Resize writes now run outside observer delivery, and returning from expansion waits for the inline controls to mount before restoring focus.

Reference: the user-selected GTD Demo Reference conversation, inspected read-only. No model prompts were sent. Reference captures remain private and are not part of the Pages artifact.

## Intended presentation

- Website: the shared application, light by default, with a small Demo/reset/theme control. Priority squares center on the available content pane, not the viewport or sidebar.
- Chat: measured 52px navigation rail, 284px desktop sidebar, 768px conversation column, 16px system text at 26px line height, purple user messages, dark surfaces, and a bottom composer. Only the four prepared conversations and relevant demo controls are present.
- Expanded card: the existing live iframe remains mounted. Desktop uses a resizable split, with a minimum 353px conversation area beside the 52px rail, a 53px host toolbar, and a centered application area. Phone uses the full content width. Closing returns to the inline card and restores keyboard focus.

## Checks

Chromium and WebKit checks cover 390, 800, 1280, and 1440px website widths, light/dark themes, content-pane centering, concise mobile labels, task expansion, priority-list overlays, background scroll locking, local edits, undo, and reset. Both browsers exercise all four chats at 390 and 1440px, including inline/expanded cards and switching back without repeating a batch.

Representative website, inline-chat, expanded-chat, and overlay screenshots were inspected. Desktop and phone expanded views were compared alongside the live-reference captures at matching viewport sizes. The desktop application inset was corrected to match the reference; the sidebar closes when expansion would otherwise cover the conversation. The first reset test exposed an invalid task URL after clearing a newly created record; Reset now returns the website to Home.

The reconstruction intentionally replaces host branding and excludes account, model, upload, voice, billing, and unrelated chat controls. It uses the application's real components rather than screenshot replicas. Browser-emulated phone checks are not physical-device testing.

Generated evidence is in ignored `web/demo-results/` after running the browser suite. CI retains failure screenshots and traces for seven days. Publication and data-contract acceptance are recorded in [the demo documentation](docs/demos/README.md).

Screenshot review also caught Results task titles falling back to default bordered, centered buttons. Results now uses the same task-list styling wrapper as other shared views. A new border/alignment assertion was confirmed to fail on the previous build and pass on the candidate.

## Final reference fidelity pass

Intended behavior: the expanded iframe leaves no empty card slot in the conversation; its caption remains, and later content moves up. Preserve the same iframe and its edits, restore the inline position and keyboard focus on close, and slide the viewer in/out from the right. The desktop split is resizable with keyboard and pointer controls; a full-width viewer is available. Phone uses a full-width viewer. The website link appears only as text at the bottom of the sidebar.

Compare measured native message bubbles (70% desktop maximum width, 10px/16px padding, 22px radius, purple #4e2f88), 16px/26px body text, 14px/20px sidebar text, compact empty desktop composer, and 53px viewer toolbar. Keep the demo identity and omit account, model, voice, upload, and unrelated navigation controls. A brief local working/opening sequence precedes cards, then the readable reply streams beneath them. Copy controls act on the fictional text only.

Verification matrix: 360/390/768px phone/tablet, both sides of 800px and 1000px layout breakpoints, 1280/1440/1920px desktops, sidebar open/closed, light/dark, inline/split/full viewers, keyboard and reduced motion. Check geometry against the pane, not the viewport; no blank slot, iframe reload, horizontal overflow, focus loss, or duplicated scripted writes. Screenshots must be compared with the source at matching viewports. The source is the user-authorized reference conversation; its private content must stay out of the repository and published artifacts.

### Findings and corrections

- The reference removes the expanded card's inline height, leaving its caption in the conversation. The previous demo retained a blank slot. Expansion and return now preserve the caption's viewport position and retain the iframe; fullscreen height reports cannot overwrite its inline height.
- The source's desktop split varies with the viewport and can be resized. The demo now provides pointer and keyboard resizing plus a full-view toggle. Screenshot review caught text selection beginning during a divider drag; pointer-down now prevents native selection before the drag starts.
- The empty desktop composer measured 52px high; the previous demo remained nearly twice that height. The composer, bubble dimensions, sidebar foreground opacity, selected rows, and card-to-reply spacing now use the measured reference values.
- A final matched desktop split comparison caught the narrowed conversation overriding the bubble's 70% width. The split now retains that limit, with the reference's 20px side spacing and 24px composer bottom inset.
- The low-energy reply recommended a task that appeared on a later page. The scripted search now selects its two stated recommendations from the actual eligible results, and verifies that both still qualify.
- WebKit's child-frame click stability did not account for the moving parent iframe. The tests now assert that the expanded pane has reached its intended edge before clicking inside it. Animation tests still measure the start, midpoint, and end independently.

Screenshots are captured at 1× browser scale. Representative evidence includes `web/demo-results/browser-chat-fidelity-matrix-360-dark-webkit/chat-inline.png`, the corresponding 1280px split view, 1920px full view, and website priority overlays in both themes. Native phone and desktop references were inspected alongside the candidate at matching sizes. Reference images remain outside public assets.

Intentional differences: GTD AI branding, four authored conversations, a prepared read-only composer, and no model/account/voice/upload controls. The full-view host does not add a second chat composer because arbitrary conversation is outside the demo. Widgets use the maintained application components rather than copying an older production build's internal styling. These are scope choices, not unverified claims of pixel-identical host behavior.

Final local result: **passed**. All 74 Chromium/WebKit demo checks and 18 data/packaging checks pass. The two mobile animation interactions also pass five repetitions each. The unrelated refresh test passes ten WebKit repetitions after its setup race was corrected. No unresolved high- or medium-severity visual findings remain in the inspected scope. GitHub publication is checked separately after CI; phone checks are browser emulation, not physical devices.

Final published result: **passed**. CI run `42771159671` published revision `dd49c211d2bf0ad132ff059a0ac930b9ab135557`; all 74 demo cases passed again against GitHub Pages. Public website and chat screens were also inspected directly. The final matching desktop comparison confirmed conversation proportions, pane placement, application spacing, and inline removal. Physical-device and live-model checks remain unperformed, as intended for this deterministic demo release.

## Mobile drawer and floating composer correction

The user's physical iPhone screenshots exposed gaps in the previous visual checks: the mobile navigation rail covered only the header, the empty mobile composer retained a second row, and its opaque dock cut off the chat. Earlier tests checked typography and expansion but did not assert these outcomes.

Intended behavior: an open phone drawer has an opaque left rail for the full available height. The composer floats over the conversation with no opaque rectangle around it; the chat can scroll behind its surrounding gaps, and its last content remains reachable above the pill. Empty composers are 52px tall on every layout. Filled composers place the send button on the right, vertically centered beside the text, with no separate action row. Keep the same behavior in both themes and desktop split views. Respect safe-area bottom insets and preserve keyboard focus.

Verification before publication: run the new geometry and hit-testing assertions against the previous build to establish failure, then against the candidate. Check 360px phones, 390px phones with both short and tall viewports (Safari bars visible/hidden), both sides of 800px and 1000px breakpoints, and desktop. Inspect screenshots of empty/filled composers and the open drawer; rerun existing expansion, scrolling, and local-data checks. These browser checks supplement, rather than replace, the supplied physical-device evidence.

Local result: **passed**. The previous build failed the new WebKit checks: the empty composer was 89px tall, the send button was 43.5px below the form's center, the dock was opaque, and the phone rail was only 52px tall. The candidate passes all 106 Chromium/WebKit cases and 18 data/packaging checks. Inspected filled and empty phone composers, content scrolling behind the floating pill, the opaque drawer rail, light desktop composition, and split-pane screenshots. No live model or physical-device run was performed.

Follow-up scenario intent: the capture reply ends after its three task summaries, without the redundant "No messages sent" line. The school-pickup task card shows both recommendations from the response: the exception replay and the signed pickup authorization. Both remain expandable and editable, alongside the separate Priorities card.

Follow-up result: **passed**. The 40 affected streaming, recommendation-card, and floating-composer cases pass in Chromium/WebKit; all 18 data/packaging checks pass. The phone card visibly includes both tasks, and the capture reply ends at the last task summary.

System-theme intent: both demos use the visitor's system light/dark preference at first paint and follow subsequent system changes until the toggle is used. The toggle is a per-page override; reload/reset returns to the current system setting. Chat widgets follow their host's theme, including toggles before a card is created. Verify both initial preferences, live system changes, overrides, reset, and inline/expanded card colors in both browser engines.

System-theme result: **passed**. Eight new Chromium/WebKit cases verify the system default, live changes, manual override, reset, and card propagation. The suite passed 112 cases initially; the two reduced-motion cases still expected the deliberately removed capture sentence. After updating that expectation to the complete three-item reply, both passed. Total verified coverage is 114 browser cases and 18 data/packaging checks. Light and dark split-view screenshots were inspected.


## Host resize and CI reliability follow-up

Intended behavior: widget navigation becomes interactive after the host has
provided the space reserved for its menu, so resizing cannot move rows during a
click. A system theme change must retain keyboard focus in an expanded demo card.
The regression checks hold host resize delivery explicitly and change the system
theme while a child-frame control owns focus. Existing navigation, disclosure,
modal gesture, and refresh checks remain enabled, with no retries added.


The new held-resize assertion fails on the prior widget (menu visible in a
300 px viewport while reserving 450 px), then passes with the visibility fix.
Navigation at 390/900 px, animated/reduced-motion task expansion, and refresh
cancellation each passed eight consecutive runs in both Chromium and WebKit
(96 checks). All 114 demo browser cases and 18 demo data checks passed.

Reviewed the first-attempt jobs in the last 18 non-bot CI runs. Earlier failures
were corrected by waiting for mutation acknowledgments, selecting the intended
fixture directly, using supported WebKit input, waiting for native momentum to
end, and waiting for initial content before gating refresh requests. The recent
demo copy failures were stale expected text, not intermittent behavior. Repeated
chart tests also exposed shared fixture collisions; their queries now use their
own project, preserving real ranking and drilldown reads. Five successive WebKit
chart runs pass after that change. No retries, forced clicks, or disabled checks
were introduced.

The full GitHub run `42784336439` passed on its first attempt, including both
application browser suites, demo checks, source/PostgreSQL tests, installation,
recovery, and operator CLI rehearsal. Pages published revision `66d0588`.
The new cache exports total about 2.8 GiB (Rust source and browser dependencies,
Docker layers, npm downloads, and the advisory-checker binary). Local `just dev`
and `just demos` smoke checks served healthy loopback endpoints and were stopped;
argument forwarding for `just deploy-local` was checked without invoking an
installation. Production GTD services and data were not changed.

The follow-up warm-cache run exposed a build-wrapper issue: Compose did not pass
Bake's read entitlement for the external restored cache. Cached builds now use
Compose's resolved Bake definition and grant access only to the selected cache
directory. A disposable scratch-image check passed both cold export and warm
import with filesystem checks enabled. Uncached builds retain the ordinary
Compose path. The failed run is not counted as release acceptance.
