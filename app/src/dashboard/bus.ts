// Event bus em memória — ponte entre as escritas do store.ts (runs/events/webhooks)
// e os endpoints SSE da dashboard. Um processo só, sem pub/sub externo.
import { EventEmitter } from "node:events";

export type RunEventTopic = {
  type: "run_started" | "run_updated" | "run_finished" | "run_event";
  runId: string;
  [key: string]: unknown;
};

export type WebhookTopic = {
  type: "webhook_received";
  id: number;
  [key: string]: unknown;
};

class DashboardBus extends EventEmitter {}

export const bus = new DashboardBus();
bus.setMaxListeners(100);

export function emitRun(payload: RunEventTopic): void {
  bus.emit("run", payload);
}

export function emitWebhook(payload: WebhookTopic): void {
  bus.emit("webhook", payload);
}
