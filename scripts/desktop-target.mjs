export function desktopTarget(
  args,
  host = process.platform,
  hostArch = process.arch,
) {
  const platforms = args.filter((arg) => ["--mac", "--win"].includes(arg));
  const arches = args.filter((arg) => ["--x64", "--arm64"].includes(arg));
  if (
    platforms.length > 1 ||
    arches.length > 1 ||
    args.some(
      (arg) =>
        /^(--(universal|ia32|armv7l|linux|platform|arch)|-[mw])(?:=|$)/.test(
          arg,
        ) || /^--(mac|win|x64|arm64)=/.test(arg),
    )
  )
    throw Error(
      "Build one platform and architecture at a time: --mac/--win and --x64/--arm64.",
    );
  const platform =
    platforms[0] === "--mac"
      ? "darwin"
      : platforms[0] === "--win"
        ? "win32"
        : host;
  const arch = arches[0]?.slice(2) || (platform === "win32" ? "x64" : hostArch);
  if (
    !["darwin", "win32"].includes(platform) ||
    !["x64", "arm64"].includes(arch)
  )
    throw Error("Choose --mac/--win and --x64/--arm64.");
  return {
    platform,
    arch,
    goos: platform === "win32" ? "windows" : "darwin",
    goarch: arch === "x64" ? "amd64" : "arm64",
    builderArgs: [
      platform === "win32" ? "--win" : "--mac",
      "--" + arch,
      ...args.filter(
        (arg) => !platforms.includes(arg) && !arches.includes(arg),
      ),
    ],
  };
}
