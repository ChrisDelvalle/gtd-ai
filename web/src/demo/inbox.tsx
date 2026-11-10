import { ChevronRight, Mail } from "lucide-react";

export const inbox = [
  {
    id: "demo-mail-rehearsal",
    sender: "Priya Shah",
    subject: "Monday's retry rehearsal",
    time: "12:18 PM",
    received: "2026-11-06T17:18:00Z",
    body: "Hey Maya — can you send me the owner and backup for Monday's retry rehearsal by 4 today? I need to finish the handoff sheet before I log off. Just the two names is fine. Thanks!",
  },
  {
    id: "demo-mail-pickup",
    sender: "School office",
    subject: "Tuesday pickup",
    time: "11:46 AM",
    received: "2026-11-06T16:46:00Z",
    body: "Hi Maya, could you confirm who will collect Nico on Tuesday, November 10? Please reply by noon on Monday so we can update the pickup list. Thank you!",
  },
  {
    id: "demo-mail-library",
    sender: "Neighborhood library",
    subject: "This weekend at the library",
    time: "10:05 AM",
    received: "2026-11-06T15:05:00Z",
    body: "Join us Saturday for drop-in stories and crafts from 10 to 12. All ages welcome; no registration needed. Have a lovely weekend!",
  },
] as const;

export function InboxPreview() {
  return (
    <details className="inbox-preview">
      <summary>
        <Mail size={17} />
        Read 3 emails
        <ChevronRight size={15} />
      </summary>
      <div className="inbox-messages">
        {inbox.map((email) => (
          <details className="inbox-message" key={email.id}>
            <summary>
              <span>
                <strong>{email.sender}</strong>
                <span>{email.subject}</span>
              </span>
              <time dateTime={email.received}>{email.time}</time>
              <ChevronRight size={15} />
            </summary>
            <p>{email.body}</p>
          </details>
        ))}
      </div>
    </details>
  );
}
