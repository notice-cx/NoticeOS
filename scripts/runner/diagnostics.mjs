import { captureWorkflowDiagnostic } from '../workflow-diagnostics.mjs';
import { runCommand } from '../run-command.mjs';
import { log } from './log.mjs';

/** Capture existing local command results without changing their return or verdict. */
export function localLaneDiagnostics(capture, job, { command = runCommand, emit = log, resultMetadata = () => ({}) } = {}) {
  if (!capture) return { runCommand: command, emit, finish() {} };
  const calls = [], errors = [];
  let omitted = 0;
  const telemetry = fn => { try { fn(); } catch { /* diagnostics cannot change a command result */ } };
  const diagnostic = value => { try { return captureWorkflowDiagnostic(value); } catch { return { text: '[Diagnostic unavailable]', truncated: true, redacted: false }; } };
  const flags = values => ({ redacted: values.some(value => value?.redacted === true), truncated: values.some(value => value?.truncated === true) });
  const commandFlags = () => flags(calls.flatMap(row => [row.output, row.error]));
  const observe = async (input, run) => {
    const row = { input };
    calls.push(row); if (calls.length > 20) { calls.shift(); omitted++; }
    telemetry(() => capture.input({ job, commands: calls.map(row => row.input), omittedCommands: omitted }));
    try {
      const result = await run();
      row.output = diagnostic(result);
      if (result?.error || result?.code !== undefined && result.code !== 0) {
        errors.push(diagnostic(result)); if (errors.length > 20) errors.shift();
        telemetry(() => capture.error(errors, flags(errors)));
      }
      return result;
    } catch (error) {
      row.error = diagnostic(error);
      errors.push(row.error); if (errors.length > 20) errors.shift();
      telemetry(() => capture.error(errors, flags(errors))); throw error;
    } finally { telemetry(() => capture.output({ commands: calls, omittedCommands: omitted }, commandFlags())); }
  };
  return {
    finish(result, error) {
      if (error) { errors.push(diagnostic(error)); telemetry(() => capture.error(errors, flags(errors))); }
      telemetry(() => capture.output({ result, commands: calls, omittedCommands: omitted }, flags([commandFlags(), resultMetadata(result)])));
    },
    runCommand: (name, args, options = {}) => observe({ command: name, args, cwd: options.cwd, timeoutMs: options.timeoutMs }, () => command(name, args, options)),
    emit(level, text) {
      emit(level, text);
      if (level === 'ERROR') { errors.push(diagnostic(text)); if (errors.length > 20) errors.shift(); telemetry(() => capture.error(errors, flags(errors))); }
    },
  };
}


export async function runLocalLaneWithDiagnostics(capture, job, run, adapters) {
  const observed = localLaneDiagnostics(capture, job, adapters);
  try { const result = await run(observed); observed.finish(result); return result; }
  catch (error) { observed.finish(undefined, error); throw error; }
}
