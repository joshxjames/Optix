import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles.css';

const root = document.getElementById('root');
if (!root) throw new Error('#root missing in widget/index.html');
createRoot(root).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
