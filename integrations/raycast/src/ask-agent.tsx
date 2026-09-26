import { Action, ActionPanel, Detail, Form, useNavigation } from "@raycast/api";
import { showFailureToast, usePromise } from "@raycast/utils";
import { askAgent, fetchAgents } from "./api";

interface Values {
  agent: string;
  message: string;
}

export default function AskAgent() {
  const { push } = useNavigation();
  const agents = usePromise(fetchAgents, [], {
    onError: (e) => {
      showFailureToast(e, { title: "Couldn't load agents" });
    },
  });

  return (
    <Form
      isLoading={agents.isLoading}
      actions={
        <ActionPanel>
          <Action.SubmitForm
            title="Ask"
            onSubmit={(v: Values) => {
              if (v.agent && v.message.trim()) push(<Reply agentId={v.agent} message={v.message.trim()} />);
            }}
          />
        </ActionPanel>
      }
    >
      <Form.Dropdown id="agent" title="Agent" storeValue>
        {(agents.data ?? []).map((a) => (
          <Form.Dropdown.Item key={a.id} value={a.id} title={a.name || a.id} />
        ))}
      </Form.Dropdown>
      <Form.TextArea id="message" title="Message" placeholder="What should the agent do?" autoFocus />
    </Form>
  );
}

function Reply({ agentId, message }: { agentId: string; message: string }) {
  const { isLoading, data, error } = usePromise(askAgent, [agentId, message], {
    onError: (e) => {
      showFailureToast(e, { title: `${agentId} couldn't answer` });
    },
  });
  const markdown = isLoading
    ? `_Waiting for **${agentId}**…_`
    : error
      ? `**Error:** ${error.message}`
      : data || "_Empty reply._";

  return (
    <Detail
      isLoading={isLoading}
      navigationTitle={agentId}
      markdown={markdown}
      actions={
        data ? (
          <ActionPanel>
            <Action.CopyToClipboard title="Copy Reply" content={data} />
          </ActionPanel>
        ) : undefined
      }
    />
  );
}
