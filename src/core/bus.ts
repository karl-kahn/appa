// pattern: functional-core
// In-process pub/sub for cross-module coordination.
//
// The "no cross-module imports, no shared state" rule has no escape
// hatch without this — once a classroom feature needs assignments-emit-
// task-created or grades-listens-to-submissions, modules either reach
// across via storage keys (defeats the namespace) or import each other
// (defeats the rule). The bus is the sanctioned alternative.
//
// Single process, no persistence. Subscriber errors are caught and
// logged; one bad handler doesn't break siblings. /angel finding F12
// (Thousand-Foot Critical).

export type BusHandler = (payload: unknown) => void | Promise<void>;

export interface AppaBus {
  /** Fire-and-await: all handlers for this topic run; errors logged + swallowed. */
  emit(topic: string, payload: unknown): Promise<void>;
  /** Subscribe. Returns an unsubscribe function. */
  on(topic: string, handler: BusHandler): () => void;
  /** Subscribe once. */
  once(topic: string, handler: BusHandler): () => void;
  /** Drop all subscribers (test cleanup). */
  clear(): void;
}

export function createBus(): AppaBus {
  const subs = new Map<string, Set<BusHandler>>();

  function on(topic: string, handler: BusHandler): () => void {
    let set = subs.get(topic);
    if (!set) {
      set = new Set();
      subs.set(topic, set);
    }
    set.add(handler);
    return () => {
      set?.delete(handler);
      if (set && set.size === 0) subs.delete(topic);
    };
  }

  return {
    on,
    once(topic, handler) {
      const off = on(topic, async (payload) => {
        off();
        await handler(payload);
      });
      return off;
    },
    async emit(topic, payload) {
      const set = subs.get(topic);
      if (!set || set.size === 0) return;
      // Snapshot to allow handlers to (un)subscribe without mutating mid-iteration.
      const handlers = [...set];
      await Promise.all(
        handlers.map(async (h) => {
          try {
            await h(payload);
          } catch (err) {
            console.error(`appa/bus: handler for ${topic} threw —`, err);
          }
        }),
      );
    },
    clear() {
      subs.clear();
    },
  };
}
