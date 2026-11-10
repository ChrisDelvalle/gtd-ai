export type Command =
  | { action: "invite"; username: string; display_name: string | null }
  | {
      action: "regenerate" | "reset_password" | "revoke" | "disable";
      target_id: string;
    };
export type Operation = {
  id: string;
  target_id: string;
  kind: Command["action"];
  state: "pending" | "complete" | "cancelled";
  lease_until: string | null;
};
export type User = {
  id: string;
  username: string;
  display_name: string | null;
  administrator: boolean;
  enabled: boolean;
  state: "pending" | "active" | "expired" | "revoked";
  expires_at: string | null;
  operation: Operation | null;
};
export type Result = {
  operation: Operation;
  temporary_password: string | null;
  sign_in_url: string;
};
export type Selection = {
  action: Command["action"];
  user?: User;
  operation?: Operation;
};
