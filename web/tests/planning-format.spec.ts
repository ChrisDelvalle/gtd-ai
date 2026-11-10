import { test, expect } from "@playwright/test";
import { momentLabel, plannedLines, shortTimezone } from "../src/planning-fields";

const zone = "America/New_York";
test("display zones follow the date, including both occurrences of a repeated hour", () => {
  expect(shortTimezone({ date: "2027-07-01", time: "12:00", timezone: zone })).toBe("EDT");
  expect(shortTimezone({ date: "2027-01-01", time: "12:00", timezone: zone })).toBe("EST");
  for (const [offset, abbreviation] of [[-240, "EDT"], [-300, "EST"]] as const) {
    expect(shortTimezone({ date: "2027-11-07", time: "01:30", timezone: zone, utc_offset_minutes: offset })).toBe(abbreviation);
  }
  expect(shortTimezone({ date: "2027-07-01", time: "12:00", timezone: "Asia/Kolkata" })).toBe("GMT+5:30");
  expect(momentLabel({ date: "2027-07-01", timezone: zone })).toBe("Jul 1, 2027");
});

test("planned ranges stay concise without losing date or clock-change distinctions", () => {
  const start = { date: "2027-04-14", time: "14:00", timezone: zone };
  expect(plannedLines(start, { ...start, time: "15:00" })).toEqual(["Apr 14, 2027", "2:00 PM–3:00 PM EDT"]);
  const [overnightDate, overnightTime] = plannedLines(start, { ...start, date: "2027-04-15", time: "01:00" });
  expect(overnightDate.replace(/\s*–\s*/, "–")).toBe("Apr 14–15, 2027");
  expect(overnightTime).toBe("2:00 PM–1:00 AM EDT");
  const repeated = { date: "2027-11-07", time: "01:30", timezone: zone };
  expect(plannedLines({ ...repeated, utc_offset_minutes: -240 }, { ...repeated, utc_offset_minutes: -300 })).toEqual(["Nov 7, 2027", "1:30 AM EDT – 1:30 AM EST"]);
});
