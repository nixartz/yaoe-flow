import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { IconUsers, IconUserPlus, IconLoader2, IconPencil, IconCheck, IconX, IconKey } from "@tabler/icons-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { usersApi, ApiError, type SafeUser } from "@/lib/api";
import { useAuth } from "@/lib/auth";

// Tela Users (§5.3/D7): listar/criar/editar/ativar-inativar. Sem hard-delete —
// inativar derruba o acesso no próximo request. O serviço recusa inativar o
// último administrador ativo.

function fmtDate(ts: number | null): string {
  if (!ts) return "–";
  return new Date(ts).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" });
}

function CreateUserCard({ onDone }: { onDone: () => void }) {
  const qc = useQueryClient();
  const [form, setForm] = useState({ name: "", email: "", username: "", password: "" });
  const [error, setError] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: () => usersApi.create({ ...form, email: form.email || null }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["users"] });
      onDone();
    },
    onError: (e) => setError(e instanceof ApiError ? e.message : "falha ao criar usuário"),
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    create.mutate();
  };

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm">Novo usuário</CardTitle>
      </CardHeader>
      <CardContent>
        <form onSubmit={submit} className="flex flex-wrap items-end gap-2">
          <Input className="w-48" placeholder="nome" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          <Input className="w-56" placeholder="e-mail (opcional)" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
          <Input className="w-40" placeholder="usuário" value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} />
          <Input className="w-48" placeholder="senha (mín. 10)" type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
          <Button type="submit" size="sm" disabled={create.isPending}>
            {create.isPending ? <IconLoader2 className="size-4 animate-spin" /> : <IconCheck className="size-4" />} Criar
          </Button>
          <Button type="button" size="sm" variant="ghost" onClick={onDone}>
            <IconX className="size-4" /> Cancelar
          </Button>
        </form>
        {error && <p className="mt-2 text-sm text-destructive">{error}</p>}
      </CardContent>
    </Card>
  );
}

function UserRow({ user, isSelf }: { user: SafeUser; isSelf: boolean }) {
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({ name: user.name, email: user.email ?? "", password: "" });
  const [error, setError] = useState<string | null>(null);

  const update = useMutation({
    mutationFn: (input: Parameters<typeof usersApi.update>[1]) => usersApi.update(user.id, input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["users"] });
      setEditing(false);
      setError(null);
    },
    onError: (e) => setError(e instanceof ApiError ? e.message : "falha ao atualizar"),
  });

  return (
    <>
      <TableRow>
        <TableCell className="font-medium">
          {editing ? (
            <Input className="h-8 w-40" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          ) : (
            <>
              {user.name}
              {isSelf && <span className="ml-1 text-xs text-muted-foreground">(você)</span>}
            </>
          )}
        </TableCell>
        <TableCell className="font-mono text-xs">{user.username}</TableCell>
        <TableCell className="text-muted-foreground">
          {editing ? (
            <Input className="h-8 w-52" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
          ) : (
            (user.email ?? "–")
          )}
        </TableCell>
        <TableCell>
          <Badge variant={user.status === "active" ? "secondary" : "destructive"} className="text-[10px]">
            {user.status === "active" ? "ativo" : "inativo"}
          </Badge>
        </TableCell>
        <TableCell className="text-xs text-muted-foreground">{user.type}</TableCell>
        <TableCell className="text-xs text-muted-foreground">{fmtDate(user.lastLoginAt)}</TableCell>
        <TableCell>
          <div className="flex items-center justify-end gap-1">
            {editing ? (
              <>
                <Input
                  className="h-8 w-40"
                  type="password"
                  placeholder="nova senha (opcional)"
                  value={form.password}
                  onChange={(e) => setForm({ ...form, password: e.target.value })}
                />
                <Button
                  size="sm"
                  className="h-8 px-2"
                  disabled={update.isPending}
                  onClick={() =>
                    update.mutate({
                      name: form.name,
                      email: form.email || null,
                      ...(form.password ? { password: form.password } : {}),
                    })
                  }
                >
                  {update.isPending ? <IconLoader2 className="size-3.5 animate-spin" /> : <IconCheck className="size-3.5" />}
                </Button>
                <Button size="sm" variant="ghost" className="h-8 px-2" onClick={() => setEditing(false)}>
                  <IconX className="size-3.5" />
                </Button>
              </>
            ) : (
              <>
                <Button size="sm" variant="ghost" className="h-8 px-2 text-muted-foreground" title="Editar" onClick={() => setEditing(true)}>
                  <IconPencil className="size-3.5" />
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-8 px-2 text-muted-foreground"
                  disabled={update.isPending}
                  title={user.status === "active" ? "Inativar (derruba o acesso no próximo request)" : "Reativar"}
                  onClick={() => update.mutate({ status: user.status === "active" ? "inactive" : "active" })}
                >
                  {user.status === "active" ? "inativar" : "reativar"}
                </Button>
              </>
            )}
          </div>
        </TableCell>
      </TableRow>
      {error && (
        <TableRow>
          <TableCell colSpan={7} className="py-1 text-xs text-destructive">
            {error}
          </TableCell>
        </TableRow>
      )}
    </>
  );
}

export function Users() {
  const { user: me } = useAuth();
  const { data, isLoading, isError } = useQuery({ queryKey: ["users"], queryFn: usersApi.list });
  const [creating, setCreating] = useState(false);

  if (isLoading) return <div className="p-6 text-sm text-muted-foreground">Carregando usuários…</div>;
  if (isError || !data) return <div className="p-6 text-sm text-destructive">Falha ao carregar usuários.</div>;

  return (
    <div className="flex flex-col gap-4 p-6">
      <div className="flex items-center gap-2">
        <IconUsers className="size-5 text-muted-foreground" />
        <h1 className="text-xl font-semibold">Usuários</h1>
        <Button size="sm" variant="outline" className="ml-auto" onClick={() => setCreating(true)}>
          <IconUserPlus className="size-4" /> Novo usuário
        </Button>
      </div>
      <p className="-mt-2 text-sm text-muted-foreground">
        Sem exclusão definitiva: usuários são <em>inativados</em> (o acesso cai no próximo request). O último
        administrador ativo não pode ser inativado. Troque a própria senha em <IconKey className="inline size-3.5" /> Meu perfil.
      </p>

      {creating && <CreateUserCard onDone={() => setCreating(false)} />}

      <div className="rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Nome</TableHead>
              <TableHead>Usuário</TableHead>
              <TableHead>E-mail</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Tipo</TableHead>
              <TableHead>Último login</TableHead>
              <TableHead className="text-right">Ações</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.users.map((u) => (
              <UserRow key={u.id} user={u} isSelf={u.id === me?.id} />
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
