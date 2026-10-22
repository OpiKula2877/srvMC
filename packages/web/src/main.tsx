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
import { App } from './App.tsx';
import { startLive } from './live.ts';

startLive();
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// Lets a browser install the panel as an app. Browsers allow that only on https or localhost;
// the desktop window does not need it.
if ('serviceWorker' in navigator && window.isSecureContext && !navigator.userAgent.includes('Electron')) {
  void navigator.serviceWorker.register('/sw.js').catch(() => undefined);
}
