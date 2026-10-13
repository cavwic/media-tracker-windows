(() => {
  const allowed = new Set(["system", "light", "dark"]);
  const preference = allowed.has(localStorage.getItem("media-tracker-theme"))
    ? localStorage.getItem("media-tracker-theme")
    : "system";
  const systemDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  document.documentElement.dataset.themePreference = preference;
  document.documentElement.dataset.theme = preference === "system"
    ? (systemDark ? "dark" : "light")
    : preference;
})();
