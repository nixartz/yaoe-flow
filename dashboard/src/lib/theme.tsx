// Tema light/dark: segue o SO por padrão (prefers-color-scheme), com override
// manual persistido em localStorage. Aplica a classe `.dark` no <html>.
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

type ThemePreference = "system" | "light" | "dark";
const STORAGE_KEY = "dashboard-theme";

function systemPrefersDark(): boolean {
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

function resolveIsDark(pref: ThemePreference): boolean {
  return pref === "system" ? systemPrefersDark() : pref === "dark";
}

interface ThemeCtx {
  preference: ThemePreference;
  isDark: boolean;
  setPreference: (p: ThemePreference) => void;
}

const Ctx = createContext<ThemeCtx | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [preference, setPreferenceState] = useState<ThemePreference>(
    () => (localStorage.getItem(STORAGE_KEY) as ThemePreference | null) ?? "system"
  );
  const [isDark, setIsDark] = useState(() => resolveIsDark(preference));

  useEffect(() => {
    document.documentElement.classList.toggle("dark", isDark);
  }, [isDark]);

  useEffect(() => {
    setIsDark(resolveIsDark(preference));
    if (preference !== "system") return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => setIsDark(systemPrefersDark());
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [preference]);

  const setPreference = (p: ThemePreference) => {
    localStorage.setItem(STORAGE_KEY, p);
    setPreferenceState(p);
  };

  const value = useMemo(() => ({ preference, isDark, setPreference }), [preference, isDark]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useTheme(): ThemeCtx {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useTheme must be used within ThemeProvider");
  return ctx;
}
