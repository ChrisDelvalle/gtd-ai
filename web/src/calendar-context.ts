/** Default for new input and account-relative dates. Stored timing keeps its
 * own zone; changing this value must never rewrite a draft or schedule. */
export let defaultZone = "America/New_York";

export function setDefaultZone(zone: string) {
  new Intl.DateTimeFormat("en-US", { timeZone: zone });
  defaultZone = zone;
}
