/** Client composition root. OWNER: lead. */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import { createAssistantController } from './session/AssistantController.js';

const controller = createAssistantController();
const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('#root missing');
createRoot(rootEl).render(
  <StrictMode>
    <App controller={controller} />
  </StrictMode>,
);

// Release camera/mic/socket if the page is torn down.
window.addEventListener('pagehide', (e) => {
  if (!e.persisted) controller.end();
});
