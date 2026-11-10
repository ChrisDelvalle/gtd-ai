import {
  ArrowRight,
  Inbox,
  Timer,
  Layers,
  Folder,
  Repeat2,
  CalendarDays,
  Lightbulb,
  ListTodo,
  CheckCheck,
  Archive,
} from "lucide-react";
import type { Destination } from "./app-context";

import { navigationModel } from "./navigation-model";
export { isDestination } from "./navigation-model";
const icons = {"arrow-right":ArrowRight,inbox:Inbox,timer:Timer,layers:Layers,folder:Folder,"repeat-2":Repeat2,"calendar-days":CalendarDays,lightbulb:Lightbulb,"list-todo":ListTodo,"check-check":CheckCheck,archive:Archive};
export const navigationGroups = navigationModel.map(group => group.map(item => ({...item, icon:icons[item.icon as keyof typeof icons]})));
