import { useState, type FormEvent } from "react";
import { Navigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { IconRobot, IconLoader2, IconSparkles } from "@tabler/icons-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent } from "@/components/ui/card";
import { useAuth } from "@/lib/auth";
import { ApiError, authApi } from "@/lib/api";

// First-access (§5.3): enquanto a tabela users estiver vazia (sem seed por
// ENV), o "login" vira um formulário de setup do primeiro administrador. O
// backend garante a corrida (transação + unique) — aqui é só UI.
function FirstAccessForm() {
  const { setUser } = useAuth();
  const [form, setForm] = useState({ name: "", email: "", username: "", password: "", confirm: "" });
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (form.password !== form.confirm) {
      setError("a confirmação não confere com a senha");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const res = await authApi.setup({
        name: form.name,
        email: form.email || undefined,
        username: form.username,
        password: form.password,
      });
      setUser(res.user);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "falha ao criar o usuário inicial");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Card className="w-full max-w-sm">
      <CardContent className="pt-6">
        <div className="mb-6 flex flex-col items-center gap-2 text-center">
          <IconSparkles className="size-9 text-primary" />
          <h1 className="text-lg font-semibold">Primeiro acesso</h1>
          <p className="text-sm text-muted-foreground">
            Nenhum usuário cadastrado ainda — crie o administrador inicial da dashboard.
          </p>
        </div>
        <form onSubmit={onSubmit} className="flex flex-col gap-3">
          <Input placeholder="seu nome" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} autoFocus />
          <Input placeholder="e-mail (opcional)" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
          <Input placeholder="usuário" value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} />
          <Input placeholder="senha (mín. 10 caracteres)" type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
          <Input placeholder="confirmar senha" type="password" value={form.confirm} onChange={(e) => setForm({ ...form, confirm: e.target.value })} />
          {error && <p className="text-sm text-destructive">{error}</p>}
          <Button type="submit" disabled={submitting} className="mt-1">
            {submitting && <IconLoader2 className="size-4 animate-spin" />}
            Criar administrador
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

export function Login() {
  const { user, login, loading } = useAuth();
  const { data: setupStatus } = useQuery({ queryKey: ["setup-status"], queryFn: authApi.setupStatus, retry: false });
  const [u, setU] = useState("");
  const [p, setP] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  if (!loading && user) return <Navigate to="/" replace />;

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await login(u, p);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "falha ao entrar");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="flex h-screen items-center justify-center bg-background">
      {setupStatus?.needsSetup ? (
        <FirstAccessForm />
      ) : (
        <Card className="w-full max-w-sm">
          <CardContent className="pt-6">
            <div className="mb-6 flex flex-col items-center gap-2 text-center">
              <IconRobot className="size-9 text-primary" />
              <h1 className="text-lg font-semibold">Agents Dashboard</h1>
              <p className="text-sm text-muted-foreground">Entre para ver a execução dos agents</p>
            </div>
            <form onSubmit={onSubmit} className="flex flex-col gap-3">
              <Input placeholder="usuário" value={u} onChange={(e) => setU(e.target.value)} autoFocus />
              <Input placeholder="senha" type="password" value={p} onChange={(e) => setP(e.target.value)} />
              {error && <p className="text-sm text-destructive">{error}</p>}
              <Button type="submit" disabled={submitting} className="mt-1">
                {submitting && <IconLoader2 className="size-4 animate-spin" />}
                Entrar
              </Button>
            </form>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
