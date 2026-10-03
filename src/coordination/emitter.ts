// A minimal typed event source. A listener that throws must never take a socket handler (or the
// election) down with it, so every call is isolated and the error goes to the log.

export interface Disposable {
  dispose(): void;
}

export class Emitter<T> {
  private readonly listeners = new Set<(value: T) => void>();
  private readonly onListenerError: (error: unknown) => void;

  constructor(onListenerError: (error: unknown) => void) {
    this.onListenerError = onListenerError;
  }

  on(listener: (value: T) => void): Disposable {
    this.listeners.add(listener);
    return { dispose: () => void this.listeners.delete(listener) };
  }

  emit(value: T): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(value);
      } catch (error) {
        this.onListenerError(error);
      }
    }
  }
}
