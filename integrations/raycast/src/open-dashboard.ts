import { closeMainWindow, open } from "@raycast/api";
import { dashboardUrl } from "./api";

export default async function OpenDashboard() {
  await closeMainWindow();
  await open(dashboardUrl());
}
