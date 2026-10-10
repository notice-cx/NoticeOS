/** One rejected field, in the `{path, code, message}` shape every operator
 * write and ingest lane reports. `message` names the field, never the value. */
export interface ValidationIssue {
  path: string;
  code: string;
  message: string;
}
