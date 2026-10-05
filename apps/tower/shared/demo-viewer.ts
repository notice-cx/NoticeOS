export { DEMO_READ_ONLY, DEMO_MCP_READ_TOOLS, demoMcpRequestAllowed, demoRequestPolicy, demoViewerCapabilities, demoViewerReply, validateDemoViewer, viewerWritable } from '../../../scripts/demo-viewer-policy.mjs';
export type { DemoViewerDescriptor, DemoRequestPolicy } from '../../../scripts/demo-viewer-policy.mjs';
import { validateDemoViewer, type DemoViewerDescriptor } from '../../../scripts/demo-viewer-policy.mjs';

declare const __DEMO_VIEWER__: unknown;
/** Immutable build input produced only after the native launcher validates its installation. */
export function demoViewer(): Readonly<DemoViewerDescriptor> | null {
  return typeof __DEMO_VIEWER__ === 'undefined' || __DEMO_VIEWER__ === null
    ? null : validateDemoViewer(__DEMO_VIEWER__);
}
