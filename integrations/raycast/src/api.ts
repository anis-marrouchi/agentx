import { getPreferenceValues } from "@raycast/api";

// Talks to the local AgentX daemon the same way the TUI does
// (src/tui/client.ts): GET /agents and POST /task.

interface Preferences {
  daemonUrl?: string;
  token?: string;
  dashboardUrl?: string;
}

export interface Agent {
  id: string;
  name: string;
  tier: string;
  model?: string;
  active: number;
  total: number;
  errors: number;
  lastActive?: string;
}

function prefs(): Required<Pick<Preferences, "daemonUrl" | "dashboardUrl">> & Preferences {
  const p = getPreferenceValues<Preferences>();
  return {
    ...p,
    daemonUrl: (p.daemonUrl || "http://127.0.0.1:18800").replace(/\/+$/, ""),
    dashboardUrl: p.dashboardUrl || "http://127.0.0.1:4202/live",
  };
}

export function dashboardUrl(): string {
  return prefs().dashboardUrl;
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const { daemonUrl, token } = prefs();
  const headers: Record<string, string> = { Accept: "application/json" };
  if (init.body) headers["Content-Type"] = "application/json";
  if (token) headers["Authorization"] = `Bearer ${token}`;
  let res: Response;
  try {
    res = await fetch(`${daemonUrl}${path}`, { ...init, headers });
  } catch {
    throw new Error(`Can't reach the AgentX daemon at ${daemonUrl}. Is it running?`);
  }
  const text = await res.text();
  let body: { error?: string } | undefined;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    body = undefined;
  }
  if (!res.ok) throw new Error(body?.error || `${path} → HTTP ${res.status}`);
  return body as T;
}

export function fetchAgents(): Promise<Agent[]> {
  return request<Agent[]>("/agents");
}

/** Sends one message and waits for the full reply. Reuses one chat per agent,
 *  so follow-up questions keep the conversation. */
export async function askAgent(agentId: string, message: string): Promise<string> {
  const r = await request<{ content?: string; error?: string }>("/task", {
    method: "POST",
    body: JSON.stringify({
      agent: agentId,
      message,
      context: { channel: "raycast", chatId: "raycast:operator" },
    }),
  });
  if (r.error) throw new Error(r.error);
  return r.content ?? "";
}
