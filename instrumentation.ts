export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') {
    return;
  }

  const { initOtel } = await import('./lib/otel');
  initOtel();
}
