/**
 * Removes URL userinfo before Git persists an origin in a workspace or cache.
 * Authentication remains the responsibility of Git's configured credential
 * helpers (including `gh auth`), rather than durable repository config.
 */
export function sanitizeRepositoryCloneUrl(cloneUrl: string): string {
  try {
    const url = new URL(cloneUrl);
    if (url.protocol === "ssh:") {
      return cloneUrl;
    }
    return `${url.protocol}//${url.host}${url.pathname}${url.search}${url.hash}`;
  } catch {
    // Git accepts a few URL forms (notably file URLs with userinfo) that the
    // WHATWG parser rejects. Remove only leading URL userinfo in that case;
    // SCP-like SSH remotes remain untouched.
    return cloneUrl.replace(/^([a-z][a-z\d+.-]*:\/\/)[^/@]*@/i, "$1");
  }
}
