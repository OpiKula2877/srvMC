import { useEffect, useState } from 'react';
import type { SystemInfo } from '@srvmc/shared';
import { api } from './api.ts';
import { can, refreshAuth, useAuth } from './auth.ts';
import { Spinner } from './components/Icon.tsx';
import { ToastProvider } from './components/Overlays.tsx';
import { Sidebar } from './components/Sidebar.tsx';
import { Login } from './pages/Login.tsx';
import { NewServer } from './pages/NewServer.tsx';
import { Overview } from './pages/Overview.tsx';
import { ServerDetail } from './pages/ServerDetail.tsx';
import { Users } from './pages/Users.tsx';
import { useRoute } from './router.ts';

export function App() {
  const route = useRoute();
  const auth = useAuth();
  const [system, setSystem] = useState<SystemInfo | null>(null);

  const page = route.page === 'server' ? `server/${route.id}` : route.page;
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [page]);

  useEffect(() => {
    void refreshAuth().catch(() => undefined);
  }, []);

  const signedIn = !!auth?.user;
  useEffect(() => {
    if (!signedIn) return;
    const load = () => void api.system().then(setSystem).catch(() => undefined);
    load();
    const t = setInterval(load, 30_000);
    return () => clearInterval(t);
  }, [signedIn]);

  if (!auth) {
    return (
      <main style={{ minHeight: '100vh', display: 'grid', placeItems: 'center' }}>
        <Spinner />
      </main>
    );
  }
  if (!auth.user) {
    return (
      <ToastProvider>
        <Login />
      </ToastProvider>
    );
  }

  return (
    <ToastProvider>
      <div className="app">
        <Sidebar route={route} system={system} />
        {route.page === 'overview' && <Overview system={system} />}
        {route.page === 'new' && (can(auth, 'admin') ? <NewServer system={system} /> : <Overview system={system} />)}
        {route.page === 'users' && (can(auth, 'owner') ? <Users /> : <Overview system={system} />)}
        {route.page === 'server' && <ServerDetail key={route.id} id={route.id} tab={route.tab} file={route.file} system={system} />}
      </div>
    </ToastProvider>
  );
}
