import { NavLink, Outlet } from "react-router-dom";
import {
  IconLayoutDashboard,
  IconActivity,
  IconHistory,
  IconWebhook,
  IconFileText,
  IconRobot,
  IconSettings,
  IconUsers,
  IconServer2,
  IconBell,
  IconPlug,
  IconListCheck,
  IconSun,
  IconMoon,
  IconDeviceDesktop,
  IconLogout,
} from "@tabler/icons-react";
import { cn } from "@/lib/utils";
import { useTheme } from "@/lib/theme";
import { useAuth } from "@/lib/auth";
import { Button } from "@/components/ui/button";

const NAV = [
  { to: "/", label: "Visão geral", icon: IconLayoutDashboard, end: true },
  { to: "/live", label: "Ao vivo", icon: IconActivity },
  { to: "/readiness", label: "Prontidão", icon: IconListCheck },
  { to: "/history", label: "Histórico", icon: IconHistory },
  { to: "/webhooks", label: "Eventos Linear", icon: IconWebhook },
  { to: "/logs", label: "Logs", icon: IconFileText },
  { to: "/agents", label: "Agents", icon: IconRobot },
  { to: "/harness", label: "Harness", icon: IconServer2 },
  { to: "/notifications", label: "Notificações", icon: IconBell },
  { to: "/linear-connections", label: "Conexões Linear", icon: IconPlug },
  { to: "/config", label: "Config", icon: IconSettings },
  { to: "/users", label: "Usuários", icon: IconUsers },
];

function ThemeToggle() {
  const { preference, setPreference } = useTheme();
  const options: { value: "light" | "dark" | "system"; icon: typeof IconSun }[] = [
    { value: "light", icon: IconSun },
    { value: "system", icon: IconDeviceDesktop },
    { value: "dark", icon: IconMoon },
  ];
  return (
    <div className="flex items-center rounded-full border p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          onClick={() => setPreference(o.value)}
          className={cn(
            "flex size-7 items-center justify-center rounded-full transition-colors",
            preference === o.value ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"
          )}
          title={o.value}
        >
          <o.icon className="size-4" />
        </button>
      ))}
    </div>
  );
}

export function Layout() {
  const { user, logout } = useAuth();
  return (
    <div className="flex h-full max-h-full w-full overflow-hidden bg-background text-foreground">
      <aside className="flex w-56 shrink-0 flex-col overflow-y-auto border-r bg-card">
        <div className="flex items-center gap-2 px-4 py-4">
          <IconRobot className="size-6 text-primary" />
          <div>
            <div className="text-sm font-semibold leading-none">Agents</div>
            <div className="text-xs text-muted-foreground">observabilidade</div>
          </div>
        </div>
        <nav className="flex flex-1 flex-col gap-1 px-2">
          {NAV.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              className={({ isActive }) =>
                cn(
                  "flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition-colors",
                  isActive ? "bg-accent text-accent-foreground" : "text-muted-foreground hover:bg-accent/50 hover:text-foreground"
                )
              }
            >
              <item.icon className="size-4" />
              {item.label}
            </NavLink>
          ))}
        </nav>
        <div className="flex flex-col gap-2 border-t p-3">
          <div className="flex items-center justify-between">
            <NavLink to="/profile" className="truncate text-xs text-muted-foreground hover:text-foreground" title="Meu perfil">
              {user?.name ?? user?.username}
            </NavLink>
            <ThemeToggle />
          </div>
          <Button variant="ghost" size="sm" className="justify-start gap-2 text-muted-foreground" onClick={() => logout()}>
            <IconLogout className="size-4" />
            Sair
          </Button>
        </div>
      </aside>
      {/* min-h-0 é o que impede o flex filho de forçar scroll fantasma no pai */}
      <main className="min-h-0 min-w-0 flex-1 overflow-y-auto overflow-x-hidden">
        <Outlet />
      </main>
    </div>
  );
}
