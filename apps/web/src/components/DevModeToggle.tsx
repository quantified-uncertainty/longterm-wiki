"use client";

import { useEffect, useState } from "react";

const STORAGE_KEY = "pageStatusDevMode";
const CSS_CLASS = "page-status-dev-mode";

export function DevModeToggle() {
  const [active, setActive] = useState(false);

  useEffect(() => {
    // Sync initial state from DOM (set by inline script in layout)
    setActive(document.documentElement.classList.contains(CSS_CLASS));
  }, []);

  function toggle() {
    const next = !active;
    setActive(next);
    if (next) {
      document.documentElement.classList.add(CSS_CLASS);
      localStorage.setItem(STORAGE_KEY, "true");
    } else {
      document.documentElement.classList.remove(CSS_CLASS);
      localStorage.removeItem(STORAGE_KEY);
    }
  }

  return (
    <button
      type="button"
      onClick={toggle}
      aria-label="Toggle page status info"
      title="Toggle editorial info (dev mode)"
      className={`dev-mode-toggle ${active ? "dev-mode-toggle--active" : ""}`}
    >
      {active ? (
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
          <polyline points="14 2 14 8 20 8" />
          <line x1="16" y1="13" x2="8" y2="13" />
          <line x1="16" y1="17" x2="8" y2="17" />
          <polyline points="10 9 9 9 8 9" />
          <circle cx="17" cy="17" r="5" fill="currentColor" stroke="none" />
          <path d="M15 17l1.5 1.5 3-3" stroke="white" strokeWidth="2" fill="none" />
        </svg>
      ) : (
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
          <polyline points="14 2 14 8 20 8" />
          <line x1="16" y1="13" x2="8" y2="13" />
          <line x1="16" y1="17" x2="8" y2="17" />
          <polyline points="10 9 9 9 8 9" />
        </svg>
      )}
    </button>
  );
}
