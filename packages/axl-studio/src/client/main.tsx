import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClientProvider } from '@tanstack/react-query';
import { queryClient } from './lib/query-client';
import { applyResolvedTheme, loadStoredMode, resolveTheme, startThemeAutoApply } from './lib/theme';
import { App } from './App';
import './index.css';

// Defense-in-depth: the inline script in index.html already applied the
// theme to <html> before this bundle parsed, but if it threw silently we
// still want a sane class on <html> by render time. Idempotent — a no-op
// in the happy path.
applyResolvedTheme(resolveTheme(loadStoredMode()));

// Subscribe globally (not from a UI component) so OS preference changes
// and cross-tab toggles keep flipping the theme even in embed scenarios
// where the Studio chrome isn't rendered.
startThemeAutoApply();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
);
