// Minecraft formatting codes (§ in server.properties, & while typing in the panel).

export const MC_COLORS: Record<string, string> = {
  '0': '#000000',
  '1': '#0000AA',
  '2': '#00AA00',
  '3': '#00AAAA',
  '4': '#AA0000',
  '5': '#AA00AA',
  '6': '#FFAA00',
  '7': '#AAAAAA',
  '8': '#555555',
  '9': '#5555FF',
  a: '#55FF55',
  b: '#55FFFF',
  c: '#FF5555',
  d: '#FF55FF',
  e: '#FFFF55',
  f: '#FFFFFF',
};

const FORMAT_CODES = 'klmnor';

export interface MotdSegment {
  text: string;
  color: string;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strike: boolean;
  obfuscated: boolean;
}

/** Splits text with &/§ codes into styled segments. The default color is the server list gray. */
export function parseMotd(text: string): MotdSegment[] {
  const out: MotdSegment[] = [];
  let style: Omit<MotdSegment, 'text'> = { color: MC_COLORS['7']!, bold: false, italic: false, underline: false, strike: false, obfuscated: false };
  let buf = '';
  const push = () => {
    if (buf) out.push({ text: buf, ...style });
    buf = '';
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    const code = text[i + 1]?.toLowerCase();
    if ((ch === '&' || ch === '§') && code && (MC_COLORS[code] || FORMAT_CODES.includes(code))) {
      push();
      if (MC_COLORS[code]) style = { color: MC_COLORS[code]!, bold: false, italic: false, underline: false, strike: false, obfuscated: false };
      else if (code === 'l') style = { ...style, bold: true };
      else if (code === 'o') style = { ...style, italic: true };
      else if (code === 'n') style = { ...style, underline: true };
      else if (code === 'm') style = { ...style, strike: true };
      else if (code === 'k') style = { ...style, obfuscated: true };
      else if (code === 'r') style = { color: MC_COLORS['7']!, bold: false, italic: false, underline: false, strike: false, obfuscated: false };
      i++;
      continue;
    }
    buf += ch;
  }
  push();
  return out;
}

/** Converts &-codes typed in the panel to the §-codes Minecraft expects. A lone & stays. */
export function ampToSection(text: string): string {
  return text.replace(/&([0-9a-fk-or])/gi, '§$1');
}

export function sectionToAmp(text: string): string {
  return text.replace(/§([0-9a-fk-or])/gi, '&$1');
}

/** Removes all formatting codes, for plain-text displays. */
export function stripMotd(text: string): string {
  return text.replace(/[&§][0-9a-fk-or]/gi, '');
}
