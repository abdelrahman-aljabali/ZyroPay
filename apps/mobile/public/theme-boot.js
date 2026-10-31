// Runs before the app bundle (a same-origin file: the CSP allows no inline script). ZyroPay
// opens in light mode unless this browser stored Dark, or System with the OS set to dark,
// in Settings > Appearance (src/state/prefs.ts; v1 "system" was the old default and reads
// as light). Sets <html data-theme> so index.html paints the right background at once; the
// app (src/lib/color-scheme.web.ts) keeps it in step afterwards.
(function () {
  var scheme = "light";
  try {
    var raw = window.localStorage.getItem("zyropay.prefs.v1");
    var stored = raw ? JSON.parse(raw) : null;
    var theme = stored && stored.state ? stored.state.theme : null;
    if (stored && stored.version < 2 && theme === "system") theme = "light";
    if (theme === "dark") scheme = "dark";
    else if (theme === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches)
      scheme = "dark";
  } catch (e) {
    scheme = "light";
  }
  var root = document.documentElement;
  root.setAttribute("data-theme", scheme);
  root.style.colorScheme = scheme;
  var metas = document.querySelectorAll('meta[name="theme-color"]');
  for (var i = 0; i < metas.length; i++)
    metas[i].setAttribute("content", scheme === "dark" ? "#000000" : "#FFFFFF");
})();
