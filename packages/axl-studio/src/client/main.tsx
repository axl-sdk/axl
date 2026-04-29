import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClientProvider } from '@tanstack/react-query';
import { queryClient } from './lib/query-client';
import { applyResolvedTheme, loadStoredMode, resolveTheme } from './lib/theme';
import { App } from './App';
import './index.css';

// Apply theme synchronously before React renders to avoid a light/dark flash.
applyResolvedTheme(resolveTheme(loadStoredMode()));

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
);
