(function () {
  function setThemeClasses(isDark) {
    const html = document.documentElement;
    const body = document.body;

    html.classList.toggle("dark", isDark);
    html.classList.toggle("light", !isDark);

    if (body) {
      body.classList.toggle("dark", isDark);
      body.classList.toggle("light", !isDark);
    }
  }

  function getSavedTheme() {
    return localStorage.getItem("appTheme") || "default";
  }

  function initTheme() {
    const isDark = getSavedTheme() === "dark";
    setThemeClasses(isDark);
  }

  function applyTheme(theme) {
    const finalTheme = theme === "dark" ? "dark" : "default";
    const isDark = finalTheme === "dark";

    localStorage.setItem("appTheme", finalTheme);
    setThemeClasses(isDark);

    if (typeof window.renderGarageProfitChart === "function") {
      setTimeout(() => {
        window.renderGarageProfitChart();
      }, 120);
    }

    window.dispatchEvent(
      new CustomEvent("themechange", {
        detail: { theme: finalTheme, isDark }
      })
    );
  }

  function toggleTheme() {
    const isDark = document.documentElement.classList.contains("dark");
    applyTheme(isDark ? "default" : "dark");
  }

  // Early apply for first paint
  const earlyIsDark = getSavedTheme() === "dark";
  document.documentElement.classList.toggle("dark", earlyIsDark);
  document.documentElement.classList.toggle("light", !earlyIsDark);

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initTheme);
  } else {
    initTheme();
  }

  window.applyTheme = applyTheme;
  window.toggleTheme = toggleTheme;
})();