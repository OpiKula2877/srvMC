import '@fontsource/inter/400.css';
import '@fontsource/inter/500.css';
import '@fontsource/inter/600.css';
import '@fontsource/inter/700.css';
import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/500.css';
import '@fontsource/space-grotesk/500.css';
import '@fontsource/space-grotesk/600.css';
import '@fontsource/space-grotesk/700.css';
import '@fontsource/vt323/400.css';
import './styles.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { isLang, setLang } from '@srvmc/shared';
import { startLive } from './live.ts';

// The language comes first: the pages read it while they load (their labels are translated then).
void (async () => {
  // Screenshot builds (vite build --mode demo) answer the API with made-up data; other builds leave this out.
  if (import.meta.env.MODE === 'demo') await import('./demo/demo.ts');
  try {
    const res = await fetch('/api/auth/language');
    const { lang } = (await res.json()) as { lang?: unknown };
    if (isLang(lang)) setLang(lang);
  } catch {
    // The core is unreachable; English it is, and the panel says so itself.
  }
  document.documentElement.lang = (await import('@srvmc/shared')).getLang();
  const { App } = await import('./App.tsx');
  startLive();
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
})();

// Lets a browser install the panel as an app. Browsers allow that only on https or localhost;
// the desktop window does not need it.
if ('serviceWorker' in navigator && window.isSecureContext && !navigator.userAgent.includes('Electron') && import.meta.env.MODE !== 'demo') {
  void navigator.serviceWorker.register('/sw.js').catch(() => undefined);
}
