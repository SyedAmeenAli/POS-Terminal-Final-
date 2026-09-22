// Length of the non-secret token fragment stored alongside the bcrypt hash so a
// presented token can be found with an indexed lookup. 12 base64url chars is
// ~72 bits of the token: wide enough that collisions between a handful of
// terminals are vanishingly unlikely, while leaving the remaining ~184 bits
// plus the bcrypt hash doing the actual authentication work.
export const TERMINAL_TOKEN_PREFIX_LENGTH = 12;

export const terminalTokenPrefix = (token: string): string =>
  token.slice(0, TERMINAL_TOKEN_PREFIX_LENGTH);
