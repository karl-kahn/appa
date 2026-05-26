import { describe, expect, it, vi } from "vitest";
import { createBus } from "./bus.js";

describe("createBus", () => {
  it("delivers payloads to subscribers", async () => {
    const bus = createBus();
    const seen: unknown[] = [];
    bus.on("hello", (p) => {
      seen.push(p);
    });
    await bus.emit("hello", { v: 1 });
    expect(seen).toEqual([{ v: 1 }]);
  });

  it("ignores topics with no subscribers", async () => {
    const bus = createBus();
    await expect(bus.emit("ghost", {})).resolves.toBeUndefined();
  });

  it("calls all subscribers of a topic", async () => {
    const bus = createBus();
    const a = vi.fn();
    const b = vi.fn();
    bus.on("topic", a);
    bus.on("topic", b);
    await bus.emit("topic", "x");
    expect(a).toHaveBeenCalledWith("x");
    expect(b).toHaveBeenCalledWith("x");
  });

  it("does not propagate handler errors to siblings", async () => {
    const bus = createBus();
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const good = vi.fn();
    bus.on("topic", () => {
      throw new Error("nope");
    });
    bus.on("topic", good);
    await bus.emit("topic", "x");
    expect(good).toHaveBeenCalled();
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it("unsubscribes via the returned function", async () => {
    const bus = createBus();
    const fn = vi.fn();
    const off = bus.on("topic", fn);
    off();
    await bus.emit("topic", "x");
    expect(fn).not.toHaveBeenCalled();
  });

  it("once fires only the first emit then unsubscribes", async () => {
    const bus = createBus();
    const fn = vi.fn();
    bus.once("topic", fn);
    await bus.emit("topic", 1);
    await bus.emit("topic", 2);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith(1);
  });

  it("snapshot semantics: a handler subscribing during emit doesn't fire in the same emit", async () => {
    const bus = createBus();
    const late = vi.fn();
    bus.on("topic", () => {
      bus.on("topic", late);
    });
    await bus.emit("topic", "x");
    expect(late).not.toHaveBeenCalled();
    await bus.emit("topic", "y");
    expect(late).toHaveBeenCalledWith("y");
  });

  it("clear() removes all subscribers", async () => {
    const bus = createBus();
    const fn = vi.fn();
    bus.on("a", fn);
    bus.on("b", fn);
    bus.clear();
    await bus.emit("a", 1);
    await bus.emit("b", 2);
    expect(fn).not.toHaveBeenCalled();
  });
});
