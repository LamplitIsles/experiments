import { defineDoc, defineDocFamily } from "@earendil-works/pi-durable";

export const PiMetadata = defineDoc<{
  id: string;
  agentId: string;
  role: string;
  ownerId: string;
  cwd: string;
  title: string;
}>({
  kind: "grove.session",
  version: 1,
  scope: "session",
  initial: () => ({
    id: "",
    agentId: "",
    role: "",
    ownerId: "",
    cwd: "",
    title: "",
  }),
});
/** One immutable admission fingerprint per operation; no transcript or credential copy. */
export const PiOperation = defineDocFamily<{ fingerprint: string }, string>({
  kind: "grove.operation",
  version: 1,
  scope: "session",
  family: true,
  initial: (fingerprint) => ({ fingerprint }),
});

/** Deduplicates display-only captures of queued inputs at the observed Stop boundary. */
export const PiWithdrawal = defineDocFamily<{ entryId: number }, null>({
  kind: "grove.withdrawal",
  version: 1,
  scope: "session",
  family: true,
  initial: () => ({ entryId: 0 }),
});
