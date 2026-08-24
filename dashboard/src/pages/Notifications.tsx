import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { IconBell, IconPlus, IconCheck, IconTrash, IconSend, IconLoader2 } from "@tabler/icons-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@/components/ui/table";
import { notificationsApi, ApiError, type NotificationChannel, type NotificationEventType } from "@/lib/api";

// Tela Notificações (Fase 3, §8.1) — "bem simples, sem muito segredo": lista
// de canais + matriz canal×evento de toggles + botão testar canal.

const EVENT_LABEL: Record<NotificationEventType, string> = {
  issue_blocked: "Issue → Blocked",
  issue_pending_merge: "Issue → Pending Merge",
  run_failed: "Run falhou",
  circuit_breaker: "Circuit breaker",
  budget_exceeded: "Budget estourado",
  reclaim_timeout: "Timeout / reclaim de seat",
  harness_quota_exceeded: "Quota do provider esgotada",
};

function CreateChannelForm({ onDone }: { onDone: () => void }) {
  const qc = useQueryClient();
  const [type, setType] = useState<NotificationChannel["type"]>("webhook");
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [botToken, setBotToken] = useState("");
  const [chatId, setChatId] = useState("");
  const [error, setError] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: () =>
      notificationsApi.create({
        type,
        name,
        config: type === "telegram" ? { botToken, chatId } : { url },
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["notifications"] });
      onDone();
    },
    onError: (e) => setError(e instanceof ApiError ? e.message : "falha ao criar canal"),
  });

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm">Novo canal</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-wrap items-end gap-2">
        <Select value={type} onValueChange={(v) => setType(v as NotificationChannel["type"])}>
          <SelectTrigger className="h-9 w-32"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="webhook">Webhook</SelectItem>
            <SelectItem value="slack">Slack</SelectItem>
            <SelectItem value="telegram">Telegram</SelectItem>
          </SelectContent>
        </Select>
        <Input className="w-40" placeholder="nome" value={name} onChange={(e) => setName(e.target.value)} />
        {type === "telegram" ? (
          <>
            <Input className="w-52" placeholder="bot token" value={botToken} onChange={(e) => setBotToken(e.target.value)} />
            <Input className="w-32" placeholder="chat id" value={chatId} onChange={(e) => setChatId(e.target.value)} />
          </>
        ) : (
          <Input
            className="w-72"
            placeholder={type === "slack" ? "incoming webhook URL" : "URL (POST JSON)"}
            value={url}
            onChange={(e) => setUrl(e.target.value)}
          />
        )}
        <Button size="sm" disabled={create.isPending || !name} onClick={() => create.mutate()}>
          {create.isPending ? <IconLoader2 className="size-4 animate-spin" /> : <IconCheck className="size-4" />} Criar
        </Button>
        <Button size="sm" variant="ghost" onClick={onDone}>Cancelar</Button>
        {error && <p className="w-full text-sm text-destructive">{error}</p>}
      </CardContent>
    </Card>
  );
}

function ChannelRow({ channel }: { channel: NotificationChannel }) {
  const qc = useQueryClient();
  const [testResult, setTestResult] = useState<"ok" | "fail" | null>(null);

  const toggleRule = useMutation({
    mutationFn: ({ event, enabled }: { event: NotificationEventType; enabled: boolean }) =>
      notificationsApi.setRule(channel.id, event, enabled),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["notifications"] }),
  });
  const remove = useMutation({
    mutationFn: () => notificationsApi.remove(channel.id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["notifications"] }),
  });
  const test = useMutation({
    mutationFn: () => notificationsApi.test(channel.id),
    onSuccess: (res) => setTestResult(res.ok ? "ok" : "fail"),
  });

  return (
    <TableRow>
      <TableCell className="font-medium">
        {channel.name}
        <div className="text-xs text-muted-foreground">{Object.values(channel.config)[0] as string}</div>
      </TableCell>
      <TableCell>
        <Badge variant="outline" className="uppercase">{channel.type}</Badge>
      </TableCell>
      {Object.keys(EVENT_LABEL).map((event) => {
        const rule = channel.events.find((e) => e.event === event);
        return (
          <TableCell key={event} className="text-center">
            <Switch
              checked={rule?.enabled ?? false}
              onCheckedChange={(checked) => toggleRule.mutate({ event: event as NotificationEventType, enabled: checked })}
            />
          </TableCell>
        );
      })}
      <TableCell>
        <div className="flex items-center justify-end gap-1">
          <Button size="sm" variant="ghost" className="h-7 gap-1 px-2 text-xs" disabled={test.isPending} onClick={() => test.mutate()}>
            {test.isPending ? <IconLoader2 className="size-3.5 animate-spin" /> : <IconSend className="size-3.5" />} testar
          </Button>
          {testResult && (
            <Badge variant={testResult === "ok" ? "secondary" : "destructive"} className="text-[10px]">
              {testResult === "ok" ? "entregue" : "falhou"}
            </Badge>
          )}
          <Button size="sm" variant="ghost" className="h-7 px-2 text-destructive" onClick={() => remove.mutate()}>
            <IconTrash className="size-3.5" />
          </Button>
        </div>
      </TableCell>
    </TableRow>
  );
}

export function Notifications() {
  const { data, isLoading, isError } = useQuery({ queryKey: ["notifications"], queryFn: notificationsApi.list });
  const [creating, setCreating] = useState(false);

  if (isLoading) return <div className="p-6 text-sm text-muted-foreground">Carregando notificações…</div>;
  if (isError || !data) return <div className="p-6 text-sm text-destructive">Falha ao carregar notificações.</div>;

  return (
    <div className="flex flex-col gap-4 p-6">
      <div className="flex items-center gap-2">
        <IconBell className="size-5 text-muted-foreground" />
        <h1 className="text-xl font-semibold">Notificações</h1>
        <Button size="sm" variant="outline" className="ml-auto gap-1" onClick={() => setCreating(true)}>
          <IconPlus className="size-4" /> Novo canal
        </Button>
      </div>

      {creating && <CreateChannelForm onDone={() => setCreating(false)} />}

      <div className="overflow-x-auto rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Canal</TableHead>
              <TableHead>Tipo</TableHead>
              {Object.entries(EVENT_LABEL).map(([event, label]) => (
                <TableHead key={event} className="text-center text-xs">{label}</TableHead>
              ))}
              <TableHead className="text-right">Ações</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.channels.map((c) => <ChannelRow key={c.id} channel={c} />)}
            {data.channels.length === 0 && (
              <TableRow>
                <TableCell colSpan={9} className="text-center text-muted-foreground">Nenhum canal configurado.</TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
