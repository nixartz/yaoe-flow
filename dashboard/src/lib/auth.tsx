import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { authApi, type SafeUser } from "./api";

interface AuthCtx {
  loading: boolean;
  user: SafeUser | null;
  login: (username: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  /** Usado pelo first-access: a sessão já vem setada pelo POST /auth/setup. */
  setUser: (user: SafeUser) => void;
}

const Ctx = createContext<AuthCtx | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [loading, setLoading] = useState(true);
  const [user, setUserState] = useState<SafeUser | null>(null);

  useEffect(() => {
    authApi
      .me()
      .then((me) => setUserState(me.authenticated ? (me.user ?? null) : null))
      .finally(() => setLoading(false));
  }, []);

  const login = async (u: string, p: string) => {
    const res = await authApi.login(u, p);
    setUserState(res.user);
  };
  const logout = async () => {
    await authApi.logout();
    setUserState(null);
  };

  return <Ctx.Provider value={{ loading, user, login, logout, setUser: setUserState }}>{children}</Ctx.Provider>;
}

export function useAuth(): AuthCtx {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
