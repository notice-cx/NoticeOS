import { createRoot } from "react-dom/client";
import { StrictMode } from 'react';
import { BrowserEntry, createPageEntryFactory } from '@/BrowserEntry';
import "@/index.css";

const rootEl = document.getElementById("root");
if (!rootEl) throw new Error("#root not found");
const createEntry = createPageEntryFactory();

createRoot(rootEl).render(
  <StrictMode><BrowserEntry createEntry={createEntry} /></StrictMode>,
);
