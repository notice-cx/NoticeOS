// Local Docker metadata only. Runtime backup and approved first-start setup
// share this check without importing either one's write operations.
export async function localDockerEndpoint(run, { env = process.env, cwd } = {}) {
  try {
    const context = await run('docker', ['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}', ...(env.DOCKER_CONTEXT ? ['--', env.DOCKER_CONTEXT] : [])], {
      env, cwd, timeoutMs: 30_000,
    });
    const endpoint = env.DOCKER_CONTEXT ? context.stdout.trim() : env.DOCKER_HOST || context.stdout.trim();
    return context.code === 0 && /^(unix|npipe):\/\/[^\r\n]+$/u.test(endpoint) ? endpoint : null;
  } catch {
    return null;
  }
}

export async function localDocker(run, options = {}) {
  return await localDockerEndpoint(run, options) !== null;
}
