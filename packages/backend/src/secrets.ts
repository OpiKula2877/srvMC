// Tokens and keys (DuckDNS, playit.gg) are stored sealed by the OS when the desktop app provides a
// SecretBox (Electron safeStorage → Windows DPAPI). Without one (development) they stay readable.

export interface SecretBox {
  encrypt(plain: string): string;
  decrypt(sealed: string): string;
}

export function seal(box: SecretBox | undefined, plain: string): string {
  return box ? `enc:${box.encrypt(plain)}` : `plain:${plain}`;
}

/** The stored value, or null when it was sealed by the desktop app and this process cannot open it. */
export function unseal(box: SecretBox | undefined, stored: string | undefined): string | null {
  if (!stored) return null;
  if (stored.startsWith('plain:')) return stored.slice(6);
  if (stored.startsWith('enc:') && box) {
    try {
      return box.decrypt(stored.slice(4));
    } catch {
      return null;
    }
  }
  return null;
}
