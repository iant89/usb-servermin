import * as React from 'react';
import * as ReactDOM from 'react-dom';
import * as ReactDOMClient from 'react-dom/client';
import * as JsxRuntime from 'react/jsx-runtime';
import * as EnterpriseUI from '@enterprise-ui/react';
import * as Client from '@servermin/client';
import '@enterprise-ui/react/styles.css';
import './shell.css';
import { App } from './App';

declare global {
  interface Window {
    __SERVERMIN_SHARED__: Record<string, unknown>;
    servermin: { register: typeof Client.registerFrontend; version: string };
  }
}

// Module frontends are built against these shared instances (one React, one ENTERPRISE-UI,
// one client runtime), so their UI shares the shell's theme, contexts and router (§14).
window.__SERVERMIN_SHARED__ = {
  react: React,
  'react-dom': ReactDOM,
  'react-dom/client': ReactDOMClient,
  'react/jsx-runtime': JsxRuntime,
  '@enterprise-ui/react': EnterpriseUI,
  '@servermin/client': Client,
};
window.servermin = { register: Client.registerFrontend, version: '1.0.0' };

ReactDOMClient.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
