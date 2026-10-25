// Browser adapters for pinned parser dependencies. Keep the app's CSP intact.
const namedFunction = `function createNamedFunction(name, body) {
  return Object.defineProperty(function() { return body.apply(this, arguments); },
    "name", { value: makeLegalFunctionName(name) });
}
`;
const invokerFunction = `function craftInvokerFunction(humanName, argTypes, classType, invoker, target) {
  if (argTypes.length < 2) throwBindingError("Invalid invoker types");
  var method = argTypes[1] !== null && classType !== null;
  var stackNeeded = argTypes.slice(1).some(function(type) {
    return type !== null && type.destructorFunction === undefined;
  });
  return createNamedFunction(humanName, function() {
    if (arguments.length !== argTypes.length - 2) throwBindingError("Invalid argument count for " + humanName);
    var destructors = stackNeeded ? [] : null;
    var self = method ? argTypes[1].toWireType(destructors, this) : undefined;
    var args = Array.from(arguments, function(value, i) { return argTypes[i + 2].toWireType(destructors, value); });
    var result = invoker.apply(null, [target].concat(method ? [self] : [], args));
    if (stackNeeded) runDestructors(destructors);
    else for (var i = method ? 1 : 2; i < argTypes.length; i++) {
      if (argTypes[i].destructorFunction !== null) argTypes[i].destructorFunction(i === 1 ? self : args[i - 2]);
    }
    return argTypes[0].name === "void" ? undefined : argTypes[0].fromWireType(result);
  });
}
`;

export function browserParsers() {
  return {
    name: "browser-book-parsers",
    enforce: "pre",
    resolveId(source, importer) {
      if (source === "./xmldom" && importer?.replaceAll("\\", "/").endsWith("/mammoth/lib/xml/reader.js"))
        return new URL("../web/src/readers/docxXml.ts", import.meta.url).pathname;
    },
    transform(source, id) {
      if (!id.replaceAll("\\", "/").endsWith("/node-unrar-js/esm/js/unrar.js")) return;
      // Emscripten's generic Embind adapters are equivalent to its generated
      // wrappers, without Function constructors (blocked by script-src 'self').
      for (const [name, next, replacement] of [
        ["createNamedFunction", "extendError", namedFunction],
        ["craftInvokerFunction", "__embind_register_class_function", invokerFunction],
      ]) {
        const pattern = new RegExp(`function ${name}\\([^)]*\\)\\s*\\{[\\s\\S]*?(?=function ${next}\\()`);
        if (!pattern.test(source)) throw Error(`unrar-js adapter needs updating: ${name}`);
        source = source.replace(pattern, () => replacement);
      }
      return { code: source, map: null };
    },
  };
}
