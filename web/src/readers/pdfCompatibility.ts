import "core-js/actual/promise/with-resolvers";

// PDF.js consumes text streams with `for await`; older WebViews expose
// ReadableStream without its async iterator, even in PDF.js's legacy build.
if (!(Symbol.asyncIterator in ReadableStream.prototype)) {
  Object.defineProperty(ReadableStream.prototype, Symbol.asyncIterator, {
    configurable: true,
    writable: true,
    value: async function* (
      this: ReadableStream<unknown>,
      { preventCancel = false }: { preventCancel?: boolean } = {},
    ) {
      const reader = this.getReader();
      let done = false;
      try {
        while (true) {
          const result = await reader.read();
          if (result.done) {
            done = true;
            return;
          }
          yield result.value;
        }
      } finally {
        try {
          if (!done && !preventCancel) await reader.cancel();
        } finally {
          reader.releaseLock();
        }
      }
    },
  });
}
