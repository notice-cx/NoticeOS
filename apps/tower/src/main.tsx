import { createRoot } from "react-dom/client";
import { BrowserEntry, createPageEntryFactory } from '@/BrowserEntry';
import "@/index.css";

const rootEl = document.getElementById("root");
if (!rootEl) throw new Error("#root not found");
const createEntry = createPageEntryFactory();

// No StrictMode: every installation serves this entry through Vite, in React's
// development build, where StrictMode mounts each page twice and so sends every
// read twice. The tests that need its rehearsal render with it themselves.
createRoot(rootEl).render(<BrowserEntry createEntry={createEntry} />);
