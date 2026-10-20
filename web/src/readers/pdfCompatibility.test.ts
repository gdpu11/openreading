import { afterAll, beforeAll, expect, test, vi } from "vitest";

const descriptor = Object.getOwnPropertyDescriptor(
  ReadableStream.prototype,
  Symbol.asyncIterator,
)!;
beforeAll(async () => {
  Reflect.deleteProperty(ReadableStream.prototype, Symbol.asyncIterator);
  await import("./pdfCompatibility");
});
afterAll(() =>
  Object.defineProperty(
    ReadableStream.prototype,
    Symbol.asyncIterator,
    descriptor,
  ),
);

const iterate = (
  stream: ReadableStream,
  options?: { preventCancel?: boolean },
): AsyncIterableIterator<unknown> =>
  (stream as any)[Symbol.asyncIterator](options);

test("PDF text streams drain and release their reader", async () => {
  const cancel = vi.fn();
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue("text");
      controller.close();
    },
    cancel,
  });
  const values = [];
  for await (const value of iterate(stream)) values.push(value);
  expect(values).toEqual(["text"]);
  expect(stream.locked).toBe(false);
  expect(cancel).not.toHaveBeenCalled();
});

test.each([false, true])(
  "closing a PDF text iterator respects preventCancel=%s",
  async (preventCancel) => {
    const cancel = vi.fn();
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue("text");
      },
      cancel,
    });
    const iterator = iterate(stream, { preventCancel });
    await iterator.next();
    await iterator.return!();
    expect(stream.locked).toBe(false);
    expect(cancel).toHaveBeenCalledTimes(preventCancel ? 0 : 1);
  },
);
