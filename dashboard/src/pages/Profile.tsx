import { useState, type FormEvent } from "react";
import { useMutation } from "@tanstack/react-query";
import { IconKey, IconLoader2, IconCheck } from "@tabler/icons-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { usersApi, ApiError } from "@/lib/api";
import { useAuth } from "@/lib/auth";

// Meu perfil (§5.3): trocar a própria senha — exige a senha atual.
export function Profile() {
  const { user } = useAuth();
  const [form, setForm] = useState({ current: "", next: "", confirm: "" });
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const change = useMutation({
    mutationFn: () => usersApi.changeOwnPassword(form.current, form.next),
    onSuccess: () => {
      setDone(true);
      setError(null);
      setForm({ current: "", next: "", confirm: "" });
    },
    onError: (e) => {
      setDone(false);
      setError(e instanceof ApiError ? e.message : "falha ao trocar a senha");
    },
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (form.next !== form.confirm) {
      setError("a confirmação não confere com a nova senha");
      return;
    }
    change.mutate();
  };

  return (
    <div className="flex flex-col gap-4 p-6">
      <div className="flex items-center gap-2">
        <IconKey className="size-5 text-muted-foreground" />
        <h1 className="text-xl font-semibold">Meu perfil</h1>
      </div>
      <Card className="max-w-md">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">
            {user?.name} <span className="font-mono text-xs font-normal text-muted-foreground">@{user?.username}</span>
          </CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={submit} className="flex flex-col gap-3">
            <Input
              type="password"
              placeholder="senha atual"
              value={form.current}
              onChange={(e) => setForm({ ...form, current: e.target.value })}
            />
            <Input
              type="password"
              placeholder="nova senha (mín. 10 caracteres)"
              value={form.next}
              onChange={(e) => setForm({ ...form, next: e.target.value })}
            />
            <Input
              type="password"
              placeholder="confirmar nova senha"
              value={form.confirm}
              onChange={(e) => setForm({ ...form, confirm: e.target.value })}
            />
            {error && <p className="text-sm text-destructive">{error}</p>}
            {done && (
              <p className="flex items-center gap-1 text-sm text-muted-foreground">
                <IconCheck className="size-4" /> senha alterada
              </p>
            )}
            <Button type="submit" disabled={change.isPending} className="mt-1 w-fit">
              {change.isPending && <IconLoader2 className="size-4 animate-spin" />}
              Trocar senha
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
