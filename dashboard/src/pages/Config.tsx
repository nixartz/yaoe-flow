import { useCallback, useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { IconSettings, IconLoader2, IconRefreshAlert, IconShieldCheck } from "@tabler/icons-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PageError, PageSkeleton, EmptyState } from "@/components/PageStates";
import { SettingsField } from "@/components/settings/SettingsField";
import { StickySaveBar } from "@/components/StickySaveBar";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { useBeforeUnload } from "@/hooks/useBeforeUnload";
import { settingsApi, ApiError, type SettingEntry, type LinearValidationResult } from "@/lib/api";
import { UI_CATEGORIES, entriesByCategory, settingLabel } from "@/lib/settingsUi";
import { cn } from "@/lib/utils";

export function Config() {
  const qc = useQueryClient();
  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ["settings"],
    queryFn: settingsApi.get,
    staleTime: 30_000,
  });

  const [search, setSearch] = useState("");
  const [activeCat, setActiveCat] = useState("service");
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveOk, setSaveOk] = useState(false);
  const [validation, setValidation] = useState<Map<string, LinearValidationResult> | null>(null);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [resetKey, setResetKey] = useState<string | null>(null);

  const byCat = useMemo(() => (data ? entriesByCategory(data.groups) : new Map()), [data]);

  const allEntries = useMemo(() => {
    if (!data) return [] as SettingEntry[];
    return data.groups.flatMap((g) => g.entries);
  }, [data]);

  const entryByKey = useMemo(() => {
    const m = new Map<string, SettingEntry>();
    for (const e of allEntries) m.set(e.key, e);
    return m;
  }, [allEntries]);

  useEffect(() => {
    setDrafts((prev) => {
      const next = { ...prev };
      let changed = false;
      for (const [k, v] of Object.entries(prev)) {
        const e = entryByKey.get(k);
        if (!e) {
          delete next[k];
          changed = true;
          continue;
        }
        if (!e.secret && v === e.value) {
          delete next[k];
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [entryByKey]);

  const dirtyKeys = useMemo(() => Object.keys(drafts), [drafts]);
  const dirtyCount = dirtyKeys.length;
  const dirtyNeedsRestart = dirtyKeys.some((k) => entryByKey.get(k)?.requiresRestart);
  useBeforeUnload(dirtyCount > 0);

  const filteredCats = useMemo(() => {
    const q = search.trim().toLowerCase();
    return UI_CATEGORIES.map((cat) => {
      let entries: SettingEntry[] = byCat.get(cat.id) ?? [];
      if (q) {
        entries = entries.filter(
          (e: SettingEntry) =>
            e.key.toLowerCase().includes(q) ||
            e.description.toLowerCase().includes(q) ||
            settingLabel(e.key).toLowerCase().includes(q)
        );
      }
      return { ...cat, entries };
    }).filter((c) => c.entries.length > 0);
  }, [byCat, search]);

  useEffect(() => {
    if (filteredCats.length && !filteredCats.some((c) => c.id === activeCat)) {
      setActiveCat(filteredCats[0].id);
    }
  }, [filteredCats, activeCat]);

  const active = filteredCats.find((c) => c.id === activeCat) ?? filteredCats[0];

  const setDraft = useCallback(
    (key: string, value: string) => {
      setSaveOk(false);
      setSaveError(null);
      const entry = entryByKey.get(key);
      setDrafts((prev) => {
        const next = { ...prev };
        if (entry && !entry.secret && value === entry.value) {
          delete next[key];
        } else if (entry?.secret && value === "") {
          delete next[key];
        } else {
          next[key] = value;
        }
        return next;
      });
    },
    [entryByKey]
  );

  const discard = () => {
    setDrafts({});
    setSaveError(null);
    setSaveOk(false);
  };

  const save = useMutation({
    mutationFn: async () => {
      const keys = Object.keys(drafts);
      const errors: string[] = [];
      let lastGroups = data?.groups;
      for (const key of keys) {
        try {
          const res = await settingsApi.update(key, drafts[key]);
          lastGroups = res.groups;
          setDrafts((prev) => {
            const n = { ...prev };
            delete n[key];
            return n;
          });
        } catch (e) {
          errors.push(`${settingLabel(key)}: ${e instanceof ApiError ? e.message : "falha"}`);
        }
      }
      return { errors, groups: lastGroups };
    },
    onSuccess: (res) => {
      if (res.groups) qc.setQueryData(["settings"], { groups: res.groups });
      if (res.errors.length) {
        setSaveError(res.errors.join(" · "));
        setSaveOk(false);
      } else {
        setSaveError(null);
        setSaveOk(true);
      }
    },
    onError: (e) => {
      setSaveError(e instanceof ApiError ? e.message : "Falha ao salvar");
      setSaveOk(false);
    },
  });

  const resetOne = useMutation({
    mutationFn: (key: string) => settingsApi.reset(key),
    onSuccess: (res, key) => {
      qc.setQueryData(["settings"], { groups: res.groups });
      setDrafts((prev) => {
        const n = { ...prev };
        delete n[key];
        return n;
      });
      setResetKey(null);
    },
  });

  const validate = useMutation({
    mutationFn: settingsApi.validateLinear,
    onSuccess: (res) => {
      setValidationError(null);
      setValidation(new Map(res.results.map((r) => [r.key, r])));
    },
    onError: (e) => setValidationError(e instanceof ApiError ? e.message : "Falha ao validar contra o Linear"),
  });

  if (isLoading) return <PageSkeleton rows={8} />;
  if (isError || !data) {
    return <PageError message="Falha ao carregar a configuração." onRetry={() => refetch()} />;
  }

  return (
    <div className="flex min-h-full flex-col">
      <div className="flex flex-col gap-3 border-b px-6 py-4">
        <div className="flex flex-wrap items-center gap-2">
          <IconSettings className="size-5 text-muted-foreground" aria-hidden />
          <h1 className="text-xl font-semibold">Configuração</h1>
          <div className="ml-auto flex flex-wrap items-center gap-2">
            <label className="sr-only" htmlFor="config-search">
              Buscar configuração
            </label>
            <Input
              id="config-search"
              name="config-filter"
              placeholder="Buscar por nome ou descrição…"
              className="w-64"
              value={search}
              autoComplete="off"
              data-1p-ignore
              data-lpignore="true"
              data-form-type="other"
              onChange={(e) => setSearch(e.target.value)}
            />
            <Button variant="outline" size="sm" onClick={() => validate.mutate()} disabled={validate.isPending}>
              {validate.isPending ? <IconLoader2 className="size-4 animate-spin" /> : <IconShieldCheck className="size-4" />}
              Validar nomes no Linear
            </Button>
          </div>
        </div>
        <p className="text-sm text-muted-foreground">
          Opções com “Definido no ambiente” não podem ser editadas aqui — remova a variável de ambiente e reinicie o serviço.
          Segredos nunca são reexibidos.
        </p>
        {validationError && <p className="text-sm text-destructive">{validationError}</p>}
        {validation && !validationError && (
          <p className="text-sm text-muted-foreground">
            Validação concluída: {[...validation.values()].filter((v) => v.ok).length} ok,{" "}
            {[...validation.values()].filter((v) => !v.ok).length} divergente(s).
          </p>
        )}
        {dirtyNeedsRestart && (
          <p className="flex items-center gap-1 text-sm text-warning">
            <IconRefreshAlert className="size-4" aria-hidden />
            Há alterações que só valem após reiniciar o serviço.
          </p>
        )}
      </div>

      <div className="flex flex-1 flex-col gap-0 md:flex-row">
        <nav className="shrink-0 border-b p-3 md:w-56 md:border-b-0 md:border-r" aria-label="Categorias">
          <div className="md:hidden">
            <label htmlFor="config-cat" className="sr-only">
              Categoria
            </label>
            <select
              id="config-cat"
              className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
              value={active?.id}
              onChange={(e) => setActiveCat(e.target.value)}
            >
              {filteredCats.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label} ({c.entries.length})
                </option>
              ))}
            </select>
          </div>
          <ul className="hidden flex-col gap-0.5 md:flex">
            {filteredCats.map((c) => (
              <li key={c.id}>
                <button
                  type="button"
                  onClick={() => setActiveCat(c.id)}
                  className={cn(
                    "flex w-full items-center justify-between rounded-md px-3 py-2 text-left text-sm transition-colors",
                    active?.id === c.id
                      ? "bg-accent text-accent-foreground font-medium"
                      : "text-muted-foreground hover:bg-accent/50 hover:text-foreground"
                  )}
                >
                  <span className="truncate">{c.label}</span>
                  <span className="text-xs opacity-70">{c.entries.length}</span>
                </button>
              </li>
            ))}
          </ul>
        </nav>

        <div className={cn("flex-1 px-6 py-4", dirtyCount > 0 && "pb-24")}>
          {filteredCats.length === 0 ? (
            <EmptyState
              title={`Nenhuma opção corresponde a “${search}”`}
              action={
                <button type="button" className="text-sm text-primary underline-offset-2 hover:underline" onClick={() => setSearch("")}>
                  Limpar busca
                </button>
              }
            />
          ) : active ? (
            <>
              <div className="mb-4">
                <h2 className="text-base font-semibold">{active.label}</h2>
                {active.description && <p className="text-sm text-muted-foreground">{active.description}</p>}
              </div>
              <form autoComplete="off" onSubmit={(e) => e.preventDefault()}>
                {active.entries.map((e) => (
                  <SettingsField
                    key={e.key}
                    entry={e}
                    draft={drafts[e.key]}
                    onChange={(v) => setDraft(e.key, v)}
                    validation={validation?.get(e.key)}
                    onReset={e.editable && e.source === "db" ? () => setResetKey(e.key) : undefined}
                    resetPending={resetOne.isPending && resetOne.variables === e.key}
                  />
                ))}
              </form>
            </>
          ) : null}
        </div>
      </div>

      <StickySaveBar
        dirtyCount={dirtyCount}
        onDiscard={discard}
        onSave={() => save.mutate()}
        saving={save.isPending}
        error={saveError}
        success={saveOk}
      />

      <ConfirmDialog
        open={!!resetKey}
        onOpenChange={(o) => !o && setResetKey(null)}
        title="Restaurar valor padrão?"
        description={resetKey ? `“${settingLabel(resetKey)}” voltará ao padrão do serviço.` : ""}
        confirmLabel="Restaurar"
        variant="destructive"
        pending={resetOne.isPending}
        onConfirm={() => resetKey && resetOne.mutate(resetKey)}
      />
    </div>
  );
}
