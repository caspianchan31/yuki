import { useCallback, useEffect, useState } from "react";
import { Linking, Platform, Pressable, Text } from "react-native";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import { WebView } from "react-native-webview";
import { API_URL } from "../../packages/client/src/api";
import { t } from "../../packages/client/src/shell/strings";

// v1.2: the phone uses the same website as the computer. This app no longer draws its own screens.
if (Platform.OS === "web" && typeof document !== "undefined")
  document.documentElement.lang = t.app.lang;

const phoneWebUrl = (process.env.EXPO_PUBLIC_WEB_URL || API_URL).replace(/\/$/, "");

function alreadyThere() {
  if (Platform.OS !== "web" || typeof window === "undefined") return false;
  try {
    return new URL(phoneWebUrl).origin === window.location.origin;
  } catch {
    return false;
  }
}

function OpenSite({ replace }: { replace: boolean }) {
  const open = useCallback(() => {
    if (replace && Platform.OS === "web" && typeof window !== "undefined" && !alreadyThere()) {
      window.location.replace(phoneWebUrl);
      return;
    }
    void Linking.openURL(phoneWebUrl);
  }, [replace]);
  useEffect(() => {
    open();
  }, [open]);
  return (
    <SafeAreaProvider>
      <SafeAreaView
        style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: 24, gap: 16 }}
      >
        <Text style={{ fontSize: 18, fontWeight: "600", textAlign: "center" }}>
          手机和电脑用同一套网页
        </Text>
        <Text style={{ fontSize: 15, textAlign: "center", color: "#3A3A3C" }}>{phoneWebUrl}</Text>
        <Pressable
          onPress={open}
          style={{
            backgroundColor: "#111",
            borderRadius: 10,
            paddingVertical: 10,
            paddingHorizontal: 18,
          }}
        >
          <Text style={{ color: "#fff", fontSize: 16 }}>打开网页</Text>
        </Pressable>
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

function Site() {
  const [failed, setFailed] = useState(false);
  if (failed) return <OpenSite replace={false} />;
  return (
    <SafeAreaProvider>
      <SafeAreaView style={{ flex: 1 }}>
        <WebView
          source={{ uri: phoneWebUrl }}
          style={{ flex: 1 }}
          onError={() => setFailed(true)}
        />
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

export default function App() {
  if (Platform.OS === "web") return <OpenSite replace />;
  return <Site />;
}
