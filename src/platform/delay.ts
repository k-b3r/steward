// The only place allowed to sleep. Callers take `sleep` by injection.
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
