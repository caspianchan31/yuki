import { MuseApiClient } from "./api-client";
import { isAndroid } from "./platform-env";
import { AuthClient } from "./session-core";

export const API_URL = (
  process.env.EXPO_PUBLIC_API_URL || (isAndroid ? "http://10.0.2.2:8787" : "http://localhost:8787")
).replace(/\/$/, "");

// The client body lives in api-client.ts (no react-native, so tests can build it).
// A project id adds the X-OpenMuse-Project header to every request; none means the default project.
export class MuseApi extends MuseApiClient {
  constructor(token: string, projectId: string | null = null) {
    super(API_URL, token, projectId);
  }
}

// Status, setup, sign-in, sign-out and password change live in session-core.ts.
export const authClient = new AuthClient(API_URL);
