import { captureWorkflowDiagnostic } from '../workflow-diagnostics.mjs';
import { runCommand } from '../run-command.mjs';
import { runBd } from './task-hub.mjs';
import { log } from './log.mjs';

/** Capture existing local command results without changing their return or verdict. */
export function localLaneDiagnostics(capture, job, { task = runBd, command = runCommand, emit = log } = {}) {
  if (!capture) return { runTask: task, runCommand: command, emit, finish() {} };
  const calls = [], errors = [];
  let omitted = 0;
  const telemetry = fn => { try { fn(); } catch { /* diagnostics cannot change a command result */ } };
  const diagnostic = value => { try { return captureWorkflowDiagnostic(value); } catch { return { text: '[Diagnostic unavailable]', truncated: true, redacted: false }; } };
  const observe = async (input, run) => {
    const row = { input };
    calls.push(row); if (calls.length > 20) { calls.shift(); omitted++; }
    telemetry(() => capture.input({ job, commands: calls.map(row => row.input), omittedCommands: omitted }));
    try {
      const result = await run();
      row.output = diagnostic(result);
      if (result?.error || result?.code !== undefined && result.code !== 0) {
        errors.push(diagnostic(result)); if (errors.length > 20) errors.shift();
        telemetry(() => capture.error(errors));
      }
      return result;
    } catch (error) {
      row.error = diagnostic(error);
      errors.push(row.error); if (errors.length > 20) errors.shift();
      telemetry(() => capture.error(errors)); throw error;
    } finally { telemetry(() => capture.output({ commands: calls, omittedCommands: omitted })); }
  };
  return {
    finish(result, error) {
      if (error) { errors.push(diagnostic(error)); telemetry(() => capture.error(errors)); }
      telemetry(() => capture.output({ result, commands: calls, omittedCommands: omitted }));
    },
    runTask: (args, timeoutMs) => observe({ command: 'task client', args, ...(timeoutMs !== undefined ? { timeoutMs } : {}) }, () => task(args, timeoutMs)),
    runCommand: (name, args, options = {}) => observe({ command: name, args, cwd: options.cwd, timeoutMs: options.timeoutMs }, () => command(name, args, options)),
    emit(level, text) {
      emit(level, text);
      if (level === 'ERROR') { errors.push(diagnostic(text)); if (errors.length > 20) errors.shift(); telemetry(() => capture.error(errors)); }
    },
  };
}


export async function runLocalLaneWithDiagnostics(capture, job, run, adapters) {
  const observed = localLaneDiagnostics(capture, job, adapters);
  try { const result = await run(observed); observed.finish(result); return result; }
  catch (error) { observed.finish(undefined, error); throw error; }
}
