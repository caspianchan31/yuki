const { getDefaultConfig } = require("expo/metro-config");
const config = getDefaultConfig(__dirname);
const path = require("node:path");
config.watchFolders = [path.resolve(__dirname, "../..")];
const defaultResolveRequest = config.resolver.resolveRequest;
// "lucide-react-native" is the app's own list of the icons it uses
// (src/lucide-icons.js, each icon from its own module), not the package's barrel of 3,090.
const lucideIcons = path.resolve(__dirname, "src/lucide-icons.js");
const webShims = {
  graphql: path.resolve(__dirname, "src/web-shims/graphql.js"),
  "@segment/analytics-node": path.resolve(__dirname, "src/web-shims/segment.js"),
  "text-encoding": path.resolve(__dirname, "src/web-shims/text-encoding.js"),
  "web-streams-polyfill": path.resolve(__dirname, "src/web-shims/web-streams.js"),
};
config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (moduleName === "lucide-react-native" && context.originModulePath !== lucideIcons) {
    return { type: "sourceFile", filePath: lucideIcons };
  }
  // What a browser never runs, swapped for tiny stand-ins on the web only.
  if (platform === "web" && webShims[moduleName]) {
    return { type: "sourceFile", filePath: webShims[moduleName] };
  }
  if (moduleName === "jose" || moduleName.startsWith("jose/")) {
    return context.resolveRequest(
      { ...context, unstable_conditionNames: ["browser", "require", "import"] },
      moduleName,
      platform,
    );
  }
  return defaultResolveRequest
    ? defaultResolveRequest(context, moduleName, platform)
    : context.resolveRequest(context, moduleName, platform);
};
module.exports = config;
