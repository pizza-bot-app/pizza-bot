export type Listener<T> = (value: T) => void;
export type Unsubscribe = () => void;

export class Emitter<T> {
  private readonly listeners = new Set<Listener<T>>();

  constructor(private readonly formatError: (err: unknown, value: T) => string) {}

  subscribe(listener: Listener<T>): Unsubscribe {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(value: T): void {
    for (const listener of this.listeners) {
      try {
        listener(value);
      } catch (err) {
        console.error(this.formatError(err, value), err);
      }
    }
  }
}
