import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ThemeProvider } from "@/lib/theme";
import { AuthProvider, useAuth } from "@/lib/auth";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Layout } from "@/components/layout/Layout";
import { Login } from "@/pages/Login";
import { Overview } from "@/pages/Overview";
import { Live } from "@/pages/Live";
import { History } from "@/pages/History";
import { Webhooks } from "@/pages/Webhooks";
import { Logs } from "@/pages/Logs";
import { Config } from "@/pages/Config";
import { Users } from "@/pages/Users";
import { Profile } from "@/pages/Profile";
import { Agents } from "@/pages/Agents";
import { AgentEditor } from "@/pages/AgentEditor";
import { Harness } from "@/pages/Harness";
import { Notifications } from "@/pages/Notifications";
import { LinearConnections } from "@/pages/LinearConnections";
import { Readiness } from "@/pages/Readiness";

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } },
});

function ProtectedRoutes() {
  const { user, loading } = useAuth();
  if (loading) return null;
  if (!user) return <Navigate to="/login" replace />;
  return <Layout />;
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <TooltipProvider>
          <BrowserRouter>
            <AuthProvider>
              <Routes>
                <Route path="/login" element={<Login />} />
                <Route element={<ProtectedRoutes />}>
                  <Route index element={<Overview />} />
                  <Route path="live" element={<Live />} />
                  <Route path="readiness" element={<Readiness />} />
                  <Route path="history" element={<History />} />
                  <Route path="webhooks" element={<Webhooks />} />
                  <Route path="logs" element={<Logs />} />
                  <Route path="config" element={<Config />} />
                  <Route path="users" element={<Users />} />
                  <Route path="profile" element={<Profile />} />
                  <Route path="agents" element={<Agents />} />
                  <Route path="agents/:id" element={<AgentEditor />} />
                  <Route path="harness" element={<Harness />} />
                  <Route path="notifications" element={<Notifications />} />
                  <Route path="linear-connections" element={<LinearConnections />} />
                </Route>
              </Routes>
            </AuthProvider>
          </BrowserRouter>
        </TooltipProvider>
      </ThemeProvider>
    </QueryClientProvider>
  );
}

export default App;
