type AxLogoProps = {
  /** Mark size in CSS px. Wordmark scales with it. */
  size?: number;
  showWordmark?: boolean;
  /** Plays the authentication pulse (brief activation) instead of idle rest. */
  active?: boolean;
};

/**
 * The AxInventory mark: a rounded tile with a bolt symbol, matching the
 * brand favicon. Idle rest, a small hover lift/rotate, and an "active"
 * pulse for the authentication moment - see index.html for the same mark
 * used as the browser-tab favicon.
 */
export function AxLogo({ active = false, showWordmark = true, size = 32 }: AxLogoProps) {
  return (
    <span className="ax-logo" data-active={active || undefined}>
      <svg
        aria-hidden
        className="ax-logo-mark"
        height={size}
        style={{ height: size, width: size }}
        viewBox="0 0 32 32"
        width={size}
      >
        <rect className="ax-logo-tile" height="32" rx="8" width="32" />
        <path className="ax-logo-bolt" d="M17.5 4 8 18h6.2l-1 10L24 14h-6.2l1-10Z" />
      </svg>
      {showWordmark ? (
        <span className="ax-wordmark">
          <strong>Ax</strong>Inventory
        </span>
      ) : null}
    </span>
  );
}
