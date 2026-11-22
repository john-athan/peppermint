// Owned by oss-kit (templates/shared/accounts). Change it there and run `oss sync-tooling`, never in a copy.
//
// The shapes the accounts API sends, for the server module and the client alike. Times are epoch milliseconds.

export type AccountRole = "admin" | "member";
/** What a one-time link does. "setup" is the first run's token from the server's environment. */
export type LinkPurpose = "setup" | "join" | "recover" | "add";

export type AccountMe = { id: number; name: string; role: AccountRole };
export type AccountState = { setupOpen: boolean; loggedIn: boolean; device: boolean; hasCredential: boolean; me: AccountMe | null };

/** active: has a passkey. invited: no passkey yet, an open link. none: no passkey and no link (access was taken away). */
export type AccountMember = {
  id: number; name: string; role: AccountRole; you: boolean; status: "active" | "invited" | "none";
  passkeys: number; createdAt: number; lastSeenAt: number | null;
  /** The open link, shown to admins only. */
  link: { purpose: Exclude<LinkPurpose, "setup">; expiresAt: number } | null;
};
export type AccountLink = { purpose: Exclude<LinkPurpose, "setup">; link: string; expiresAt: number; member: number };
/** What a link will do, before the passkey prompt. `name` is whose account it opens (null for setup). */
export type AccountLinkPreview = { purpose: LinkPurpose; name: string | null; expiresAt: number | null };

export type AccountPasskey = { id: string; name: string; createdAt: number; lastUsedAt: number | null };
export type AccountSession = { id: string; kind: "browser" | "device"; device: string | null; createdAt: number; lastSeenAt: number; userAgent: string | null; current: boolean };
/** Plus whatever the app adds per device (Monet: uploads, lastUpload). */
export type AccountDevice = { id: number; name: string; kind: string; scopes: string[]; createdAt: number; lastSeenAt: number | null; revokedAt: number | null } & Record<string, unknown>;
export type AccountPairing = { code: string; expiresAt: number };
