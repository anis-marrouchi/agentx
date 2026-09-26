import { Action, ActionPanel, Color, Icon, List } from "@raycast/api";
import { showFailureToast, usePromise } from "@raycast/utils";
import { dashboardUrl, fetchAgents } from "./api";

export default function ListAgents() {
  const { isLoading, data, revalidate } = usePromise(fetchAgents, [], {
    onError: (e) => {
      showFailureToast(e, { title: "Couldn't load agents" });
    },
  });

  return (
    <List isLoading={isLoading}>
      {(data ?? []).map((a) => (
        <List.Item
          key={a.id}
          icon={Icon.Person}
          title={a.name || a.id}
          subtitle={a.model || a.tier}
          accessories={[
            a.errors > 0 ? { tag: { value: `${a.errors} failed`, color: Color.Red } } : {},
            a.active > 0
              ? { tag: { value: `working (${a.active})`, color: Color.Green } }
              : { tag: { value: "idle", color: Color.SecondaryText } },
            a.lastActive ? { date: new Date(a.lastActive), tooltip: "Last active" } : {},
          ]}
          actions={
            <ActionPanel>
              <Action.CopyToClipboard title="Copy Agent ID" content={a.id} />
              <Action.OpenInBrowser title="Open Dashboard" url={dashboardUrl()} />
              <Action title="Refresh" icon={Icon.ArrowClockwise} onAction={revalidate} />
            </ActionPanel>
          }
        />
      ))}
    </List>
  );
}
