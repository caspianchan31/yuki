import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  desktopForOpenMember,
  memberDesktopReady,
  shouldPinMemberDesktop,
} from "../packages/client/src/shell/chat/member-desktop.ts";

describe("desktopForOpenMember", () => {
  it("points the simple view at the open member", () => {
    assert.equal(desktopForOpenMember(false, "nova", null), "nova");
  });

  it("leaves the desktop alone in the pro view, with nobody open, or when already selected", () => {
    assert.equal(desktopForOpenMember(true, "nova", null), undefined);
    assert.equal(desktopForOpenMember(false, null, "nova"), undefined);
    assert.equal(desktopForOpenMember(false, "nova", "nova"), undefined);
  });
});

describe("memberDesktopReady", () => {
  const base = {
    memberId: "nova",
    environmentId: null as string | null,
    loading: false,
    unavailable: false,
    failed: false,
  };

  it("waits until her desktop is the one selected", () => {
    assert.equal(memberDesktopReady(base), false);
    assert.equal(memberDesktopReady({ ...base, loading: true }), false);
    assert.equal(memberDesktopReady({ ...base, environmentId: "nova" }), true);
  });

  it("does not trap the composer when there is no member desktop to select", () => {
    assert.equal(memberDesktopReady({ ...base, memberId: null }), true);
    assert.equal(memberDesktopReady({ ...base, unavailable: true }), true);
    assert.equal(memberDesktopReady({ ...base, failed: true }), true);
  });
});

describe("shouldPinMemberDesktop", () => {
  const base = {
    accountId: "nova",
    environmentId: "gone" as string | null,
    loading: false,
    unavailable: false,
    stale: false,
    tried: null as string | null,
  };

  it("selects her desktop once, including when the current one was deleted", () => {
    assert.equal(shouldPinMemberDesktop(base), true);
    assert.equal(shouldPinMemberDesktop({ ...base, stale: true }), true);
    assert.equal(shouldPinMemberDesktop({ ...base, tried: "nova" }), false);
    assert.equal(shouldPinMemberDesktop({ ...base, environmentId: "nova" }), false);
    assert.equal(shouldPinMemberDesktop({ ...base, environmentId: "nova", stale: true }), true);
  });
});
