/**
 * The desktop's picture at the
 * moment the AI could not go on, as a small thumbnail labelled 「当时的画面」; tapping it opens it
 * full size in a modal. The picture is read with the session (the route checks the space, or the
 * operator): on the web through fetch into an object URL (as the account's 最近截图 does), on a
 * phone with the request headers. A picture that cannot be read (gone after 30 days) says so.
 */
import { X } from "lucide-react-native";
import { useEffect, useState } from "react";
import {
  ActivityIndicator,
  Image,
  Modal,
  Platform,
  Pressable,
  Text,
  useWindowDimensions,
  View,
} from "react-native";
import { useWorkspace } from "../../workspace";
import { t } from "../strings";
import { color, radius } from "../theme";
import { ui } from "./primitives";

type Picture =
  | { kind: "loading" }
  | { kind: "image"; uri: string; headers?: Record<string, string> }
  | { kind: "none" };

const s = t.incidentShots;

/** Reads the picture at `path` with the session; revoked when the component goes. */
function usePicture(path: string): [Picture, () => void] {
  const { api } = useWorkspace();
  const [picture, setPicture] = useState<Picture>({ kind: "loading" });
  useEffect(() => {
    if (Platform.OS !== "web" || typeof fetch !== "function" || typeof URL === "undefined") {
      setPicture({ kind: "image", uri: api.url(path), headers: api.headers() });
      return;
    }
    let active = true;
    let objectUrl: string | null = null;
    setPicture({ kind: "loading" });
    fetch(api.url(path), { headers: api.headers(), cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) throw new Error(String(response.status));
        const blob = await response.blob();
        if (!active) return;
        objectUrl = URL.createObjectURL(blob);
        setPicture({ kind: "image", uri: objectUrl });
      })
      .catch(() => {
        if (active) setPicture({ kind: "none" });
      });
    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [api, path]);
  return [picture, () => setPicture({ kind: "none" })];
}

/** 「当时的画面」: a thumbnail of the incident's picture at `path`; tap → full size. `label` names
 * the picture instead (a report card's 「亲眼确认时的画面 · 14:05」). */
export function IncidentShot({
  path,
  site,
  label: given,
}: {
  path: string;
  site?: string | null;
  label?: string;
}) {
  const [picture, failed] = usePicture(path);
  const [open, setOpen] = useState(false);
  const { width, height } = useWindowDimensions();
  const label = given ?? (site ? s.thumbAlt(site) : s.thumb);
  const caption = given ?? (site ? `${s.thumb} · ${site}` : s.thumb);
  if (picture.kind === "none") return <Text style={ui.small}>{s.missing}</Text>;
  return (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${label}${t.common.colon}${s.open}`}
        disabled={picture.kind !== "image"}
        onPress={() => setOpen(true)}
        style={({ pressed }) => [ui.row, { gap: 8, opacity: pressed ? 0.7 : 1 }]}
      >
        <View
          style={{
            width: 72,
            height: 45,
            borderRadius: radius.sm,
            borderWidth: 1,
            borderColor: color.line,
            backgroundColor: color.surface2,
            overflow: "hidden",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          {picture.kind === "image" ? (
            <Image
              accessibilityLabel={label}
              source={{ uri: picture.uri, headers: picture.headers }}
              onError={failed}
              resizeMode="cover"
              style={{ width: "100%", height: "100%" }}
            />
          ) : (
            <ActivityIndicator size="small" color={color.muted} accessibilityLabel={s.loading} />
          )}
        </View>
        <Text style={ui.small}>{caption}</Text>
      </Pressable>
      {open && picture.kind === "image" ? (
        <Modal transparent animationType="fade" visible onRequestClose={() => setOpen(false)}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t.common.close}
            onPress={() => setOpen(false)}
            style={{
              flex: 1,
              backgroundColor: "rgba(0,0,0,0.82)",
              alignItems: "center",
              justifyContent: "center",
              padding: 16,
            }}
          >
            <View accessibilityViewIsModal style={{ gap: 8, alignItems: "flex-end" }}>
              <View style={[ui.row, { gap: 8 }]}>
                <Text style={{ color: "#fff", fontSize: 13 }}>{label}</Text>
                <X size={18} color="#fff" />
              </View>
              <Image
                accessibilityLabel={label}
                source={{ uri: picture.uri, headers: picture.headers }}
                resizeMode="contain"
                style={{
                  width: Math.min(width - 32, 1280),
                  height: Math.min(height - 96, (Math.min(width - 32, 1280) * 10) / 16),
                }}
              />
            </View>
          </Pressable>
        </Modal>
      ) : null}
    </>
  );
}
