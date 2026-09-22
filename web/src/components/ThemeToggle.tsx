import { Moon, Sun } from "lucide-react";

import { useTheme } from "../theme/useTheme";

export function ThemeToggle() {
  const { theme, toggleTheme } = useTheme();
  const isDark = theme === "dark";

  return (
    <button
      aria-label={isDark ? "Enable light mode" : "Enable dark mode"}
      aria-pressed={isDark}
      className="theme-toggle"
      onClick={toggleTheme}
      title={isDark ? "Enable light mode" : "Enable dark mode"}
      type="button"
    >
      {isDark ? <Moon aria-hidden size={16} /> : <Sun aria-hidden size={16} />}
    </button>
  );
}
