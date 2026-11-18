import type { AdminContext } from "../../core/admin-context.ts";
import { bound, boundDropping } from "../admin-bound.ts";
import { settleForgets } from "./capture-forget.ts";
import * as lensActivity from "./lens-activity.ts";
import * as lens from "./lens-admin.ts";
import * as lensBrowsing from "./lens-browsing.ts";
import * as lensScope from "./lens-scope.ts";

// Lens: devices, capture scope, browsing rules and forgets (lens/*.ts), as `Admin.lens`.
export const lensAdmin = (context: AdminContext, dropNames: <T>(erasure: Promise<T>) => Promise<T>) => ({
  ...bound(context, {
    // Lens: a device's two clients, lens-admin.ts's; the owner's capture scope, lens-scope.ts's;
    // the forgets from a Mac, capture-forget.ts's.
    addDevice: lens.addOwnerDevice,
    setDeviceContacts: lens.setDeviceContacts,
    // The owner's one vouch for a device's first backfill.
    vouchBackfill: lens.vouchBackfill,
    revokeDevice: lens.revokeDevice,
    setDeviceTasks: lens.setDeviceTasks,
    deviceContacts: lens.deviceContacts,
    rotateDevice: lens.rotateDevice,
    devices: lens.devices,
    // The owner's time by activity category, a view over the block days.
    activity: lensActivity.activity,
    addScope: lensScope.addScope,
    scope: lensScope.scope,
    scopeValue: lensScope.scopeValue,
    removeScope: lensScope.removeScope,
    setBrowsing: lensBrowsing.setBrowsing,
    browsing: lensBrowsing.browsing,
    addExclude: lensBrowsing.addExclude,
    captureExcludes: lensBrowsing.excludes,
    excludeValue: lensBrowsing.excludeValue,
    removeExclude: lensBrowsing.removeExclude,
    addAccount: lensBrowsing.addAccount,
    captureAccounts: lensBrowsing.accounts,
    accountValue: lensBrowsing.accountValue,
    removeAccount: lensBrowsing.removeAccount,
  }),
  ...boundDropping(context, dropNames, { settleForgets: settleForgets }),
});
