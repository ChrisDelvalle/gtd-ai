import { authRequest } from "./website-login";
import { websiteIdentity, type SessionStatus } from "./website-identity";

/** Called directly by a user gesture. Only renews sign-in; it never retries the
 * sensitive action. A new same-account session must replace the old CSRF value. */
export function reauthenticate(): Promise<SessionStatus> {
  const before = websiteIdentity.headers()["X-GTD-CSRF"];
  const popup = window.open(
    "about:blank",
    "gtd-sign-in",
    "popup,width=480,height=720",
  );
  if (!popup)
    return Promise.reject(new Error("Allow the sign-in window to continue."));
  return new Promise((resolve, reject) => {
    let finished = false,
      checking = false,
      navigated = false;
    const finish = (value: SessionStatus | Error) => {
      if (finished) return;
      finished = true;
      clearInterval(timer);
      clearTimeout(deadline);
      window.removeEventListener("message", message);
      window.removeEventListener("focus", check);
      unsubscribe();
      popup.close();
      if (value instanceof Error) reject(value);
      else resolve(value);
    };
    const check = async () => {
      if (finished || checking || !navigated) return;
      checking = true;
      try {
        const status = await authRequest("session");
        if (status.authenticated && status.csrf && status.csrf !== before)
          finish(status);
        else if (popup.closed)
          finish(new Error("Sign-in was not completed. Please try again."));
      } catch (error) {
        finish(
          error instanceof Error
            ? error
            : new Error("Could not verify sign-in."),
        );
      } finally {
        checking = false;
      }
    };
    const message = (event: MessageEvent) => {
      if (
        event.origin === location.origin &&
        event.source === popup &&
        event.data === "gtd:sign-in-complete"
      )
        void check();
    };
    const unsubscribe = websiteIdentity.subscribe(() => {
      if (websiteIdentity.blocked)
        finish(new Error("The signed-in account changed. Reopen GTD."));
    });
    window.addEventListener("message", message);
    window.addEventListener("focus", check);
    const timer = window.setInterval(() => {
      if (popup.closed) void check();
    }, 1000);
    const deadline = window.setTimeout(
      () => finish(new Error("Sign-in timed out. Please try again.")),
      600000,
    );
    void authRequest("login", {
      reauthenticate: true,
      return_to: "/?gtd_sign_in=complete",
    })
      .then((result) => {
        if (finished) return;
        if (!result.authorization_url?.startsWith("https://"))
          throw new Error("Could not start sign-in.");
        popup.location.href = result.authorization_url;
        navigated = true;
      })
      .catch((error) =>
        finish(
          error instanceof Error
            ? error
            : new Error("Could not start sign-in."),
        ),
      );
  });
}
