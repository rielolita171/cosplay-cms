/**
 * Preload script — the ONLY channel between the Electron main process and the
 * renderer, and the reason the desktop token can exist at all.
 *
 * WHAT IT DOES
 *
 * Exposes exactly one function, `desktopToken()`, on `window.cosplayCms`. It is
 * synchronous and returns the token string. That is deliberate: the renderer's
 * single `api()` chokepoint needs the value before it can build a request, and an
 * async bridge would mean an await on the hot path of every single request in the
 * app. There is nothing to await — the value is already in memory in this process.
 *
 * WHY IT IS SAFE, AND WHY THE TOKEN IS NOT JUST PUT IN THE HTML
 *
 * `nodeIntegration` is false and `sandbox` is true on the window, so the page has
 * no Node, no `require`, and no `process.env`. It cannot read the token off disk
 * or out of the environment; the only way to obtain it is through this function.
 *
 * The obvious alternative — templating the token into index.html — is worse and was
 * rejected: it would put a live credential in the document, where it would be
 * visible in View Source, in any DOM dump, and to any code that can read the page.
 * A browser hitting the same server gets index.html with no token in it at all,
 * which is the entire point of the design.
 *
 * WHAT THIS DOES NOT PROTECT AGAINST
 *
 * A user who opens the app's own DevTools can call window.cosplayCms.desktopToken()
 * and read it. That is unavoidable and is not a flaw specific to this approach: the
 * renderer has to hold the token to use it, and the renderer is under the user's
 * control. What this stops is a website, a browser address bar, and other software
 * on the machine — not the person sitting at the keyboard, who can equally read
 * the SQLite file directly.
 *
 * CONTEXT ISOLATION is what makes the bridge a boundary rather than a suggestion:
 * page scripts cannot reach into this file's scope, and this file cannot reach into
 * the page. They meet only at the one function deliberately published here.
 */
const { contextBridge } = require('electron');

contextBridge.exposeInMainWorld('cosplayCms', {
  /**
   * The per-launch desktop token, or null when this is not the desktop build
   * (which is the case for `npm start`, where the guard is inert anyway).
   *
   * Returning null rather than throwing matters: the web build has no token and
   * must keep working, so the renderer treats "no token" as "send no header"
   * instead of failing.
   */
  desktopToken() {
    return process.env.CMS_DESKTOP_TOKEN || null;
  }
});
