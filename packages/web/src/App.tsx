import { useEffect, useState } from 'react';
import type { SystemInfo } from '@srvmc/shared';
import { api } from './api.ts';
import { ToastProvider } from './components/Overlays.tsx';
import { Sidebar } from './components/Sidebar.tsx';
import { NewServer } from './pages/NewServer.tsx';
import { Overview } from './pages/Overview.tsx';
import { ServerDetail } from './pages/ServerDetail.tsx';
import { useRoute } from './router.ts';

export function App() {
  const route = useRoute();
  const [system, setSystem] = useState<SystemInfo | null>(null);

  const page = route.page === 'server' ? `server/${route.id}` : route.page;
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [page]);

  useEffect(() => {
    const load = () => void api.system().then(setSystem).catch(() => undefined);
    load();
    const t = setInterval(load, 30_000);
    return () => clearInterval(t);
  }, []);

  return (
    <ToastProvider>
      <div className="app">
        <Sidebar route={route} system={system} />
        {route.page === 'overview' && <Overview system={system} />}
        {route.page === 'new' && <NewServer system={system} />}
        {route.page === 'server' && <ServerDetail key={route.id} id={route.id} tab={route.tab} file={route.file} system={system} />}
      </div>
    </ToastProvider>
  );
}
