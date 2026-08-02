// Hook fino sobre EventSource — assina um endpoint SSE da dashboard e chama
// `onEvent` a cada mensagem (independente do `event:` nomeado, já que o backend
// usa vários — run_started/run_updated/run_event/run_finished/webhook_received/log).
//
// Conexões são COMPARTILHADAS por URL (refcount). Sem isso, a tela Ao vivo abria
// 2–3 EventSource no mesmo `/api/runs/stream` (+ webhooks), e o sheet de um run
// vivo abria mais uma — estourando o limite de ~6 conexões HTTP/1.1 por origem
// do browser. Requests seguintes (ex.: GET /api/runs/:id) ficavam Pending e
// travavam a UI até sair da página.
import { useEffect, useRef } from "react";

const NAMED_EVENTS = ["run_started", "run_updated", "run_event", "run_finished", "webhook_received", "log"];

type Fanout = (eventName: string, data: unknown) => void;

interface SharedSource {
  source: EventSource;
  subscribers: Set<Fanout>;
}

const shared = new Map<string, SharedSource>();

function acquire(url: string, subscriber: Fanout): () => void {
  let entry = shared.get(url);
  if (!entry) {
    const source = new EventSource(url);
    const subscribers = new Set<Fanout>();
    for (const name of NAMED_EVENTS) {
      source.addEventListener(name, (e: Event) => {
        const me = e as MessageEvent;
        let data: unknown;
        try {
          data = name === "log" ? me.data : JSON.parse(me.data as string);
        } catch {
          /* payload não-JSON (ex.: linha de log crua) — repassa como veio */
          data = me.data;
        }
        for (const sub of subscribers) sub(name, data);
      });
    }
    entry = { source, subscribers };
    shared.set(url, entry);
  }
  entry.subscribers.add(subscriber);
  return () => {
    entry!.subscribers.delete(subscriber);
    if (entry!.subscribers.size === 0) {
      entry!.source.close();
      shared.delete(url);
    }
  };
}

export function useSse<T = unknown>(url: string | null, onEvent: (eventName: string, data: T) => void): void {
  const handlerRef = useRef(onEvent);
  handlerRef.current = onEvent;

  useEffect(() => {
    if (!url) return;
    const fanout: Fanout = (eventName, data) => {
      handlerRef.current(eventName, data as T);
    };
    return acquire(url, fanout);
  }, [url]);
}
