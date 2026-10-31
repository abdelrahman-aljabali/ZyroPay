import { describe, expect, it, vi } from "vitest";
import {
  delegatedAccessHttp,
  removeStaleDelegatedAccess,
  staleDelegatedAccess,
  type DelegatedAccessHttp,
} from "./bridge-common";

const OLD = "bcbdc978-dd28-4c13-9b1b-f008c79263ea";
const NEW = "8223639d-66e8-450b-a43d-df97e98c453b";
const ROOT = "bdd6dace-e5f7-4417-8be5-e2c5ef4ec3fa";
const consensus = (id: string) => `approvers.any(user, user.id == '${id}')`;

const POLICIES = [
  { policyId: "p-old-evm", policyName: "zyropay-delegated-evm", consensus: consensus(OLD) },
  { policyId: "p-old-sol", policyName: "zyropay-delegated-solana", consensus: consensus(OLD) },
  { policyId: "p-new-evm", policyName: "zyropay-delegated-evm", consensus: consensus(NEW) },
  // Not ZyroPay's: a policy the user made themselves stays, whoever it names.
  { policyId: "p-user", policyName: "my own policy", consensus: consensus(OLD) },
];
const USERS = [
  { userId: OLD, userName: "zyropay-delegated", authenticators: [] },
  { userId: NEW, userName: "zyropay-delegated", authenticators: [] },
  { userId: ROOT, userName: "alice", authenticators: [{}] },
  // A passkey user that happens to carry the name is never touched.
  { userId: "u-odd", userName: "zyropay-delegated", authenticators: [{}] },
];

describe("stale delegated access (ADR-001 D8)", () => {
  it("picks only ZyroPay's leftovers that are not the current delegated user", () => {
    expect(staleDelegatedAccess(POLICIES, USERS, NEW)).toEqual({
      policyIds: ["p-old-evm", "p-old-sol"],
      userIds: [OLD],
    });
  });

  it("deletes policies before users and does nothing when nothing is stale", async () => {
    const calls: string[] = [];
    const http: DelegatedAccessHttp = {
      listPolicies: () => Promise.resolve(POLICIES),
      listUsers: () => Promise.resolve(USERS),
      deletePolicies: (_org, ids) => {
        calls.push(`policies:${ids.join(",")}`);
        return Promise.resolve();
      },
      deleteUsers: (_org, ids) => {
        calls.push(`users:${ids.join(",")}`);
        return Promise.resolve();
      },
    };
    await expect(
      removeStaleDelegatedAccess(http, { organizationId: "org", keepUserId: NEW }),
    ).resolves.toEqual({ policies: 2, users: 1 });
    expect(calls).toEqual(["policies:p-old-evm,p-old-sol", `users:${OLD}`]);

    calls.length = 0;
    const clean: DelegatedAccessHttp = {
      ...http,
      listPolicies: () => Promise.resolve(POLICIES.filter((p) => p.policyId === "p-new-evm")),
      listUsers: () => Promise.resolve(USERS.filter((u) => u.userId !== OLD)),
    };
    await expect(
      removeStaleDelegatedAccess(clean, { organizationId: "org", keepUserId: NEW }),
    ).resolves.toEqual({ policies: 0, users: 0 });
    expect(calls).toEqual([]);
  });

  it("reads with the default stamper and stamps deletions with the passkey", async () => {
    const sdk = {
      getPolicies: vi.fn(() => Promise.resolve({ policies: POLICIES })),
      getUsers: vi.fn(() => Promise.resolve({ users: USERS })),
      deletePolicies: vi.fn(() => Promise.resolve({})),
      deleteUsers: vi.fn(() => Promise.resolve({})),
    };
    const http = delegatedAccessHttp(sdk, "passkey");
    await removeStaleDelegatedAccess(http, { organizationId: "org", keepUserId: NEW });
    expect(sdk.getPolicies).toHaveBeenCalledWith({ organizationId: "org" });
    expect(sdk.deletePolicies).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: "org", policyIds: ["p-old-evm", "p-old-sol"] }),
      "passkey",
    );
    expect(sdk.deleteUsers).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: "org", userIds: [OLD] }),
      "passkey",
    );
  });
});
