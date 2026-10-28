// The only place the dashboard sleeps, so tests can swap it out.
export const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
