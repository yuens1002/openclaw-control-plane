/**
 * A fake of the wrapper's `/setup/api/config/raw` endpoint pair that behaves
 * like the real one: a successful POST changes what the next GET returns.
 *
 * Static `{ ok: true, content: "{}" }` stubs cannot model this. Any caller that
 * writes and then re-reads to confirm the write landed — which
 * `patchAllowedOrigins` now does — sees the pre-write state forever and treats
 * a perfectly good write as a failure. Shared here rather than re-declared per
 * test file so the write-then-read contract has one definition.
 *
 * `persistWrites: false` deliberately models the failure this verification
 * exists to catch: the endpoint answers `ok: true` while the value never lands.
 */
export interface FakeConfigStoreOptions {
  /** Config document the first GET returns. Defaults to an empty object. */
  initialContent?: string;
  /** When false, POSTs are recorded and acked but never change what GET returns. */
  persistWrites?: boolean;
  /** Called on each GET/POST, for tests asserting call ordering across steps. */
  onCall?: (call: "getConfigRaw" | "postConfigRaw") => void;
}

export function createFakeConfigStore(options: FakeConfigStoreOptions = {}) {
  const { initialContent = "{}", persistWrites = true, onCall } = options;
  let content = initialContent;
  const posted: string[] = [];
  let getCalls = 0;

  const getConfigRaw = async () => {
    getCalls += 1;
    onCall?.("getConfigRaw");
    return { ok: true, content };
  };

  const postConfigRaw = async (_baseUrl: string, _auth: unknown, next: string) => {
    posted.push(next);
    onCall?.("postConfigRaw");
    if (persistWrites) {
      content = next;
    }
    return { ok: true };
  };

  return {
    /** Every payload handed to POST, in order. */
    posted,
    get getCalls() {
      return getCalls;
    },
    /** Current stored document — what the next GET would return. */
    get content() {
      return content;
    },
    getConfigRaw,
    postConfigRaw,
    /**
     * Just the two injectable functions, for spreading into a dependencies
     * object. Both must come from the same store — injecting a GET from one
     * store and a POST from another silently reintroduces the static-stub bug
     * this fixture exists to remove.
     */
    deps: { getConfigRaw, postConfigRaw }
  };
}
