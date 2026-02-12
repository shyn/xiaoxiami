import type { Formatter } from "../../im/formatter.js";

export class WxWorkFormatter implements Formatter {
  bold(text: string): string {
    return `**${text}**`;
  }

  italic(text: string): string {
    return `**${text}**`;
  }

  code(text: string): string {
    return `\`${text}\``;
  }

  pre(text: string, language?: string): string {
    return `\`\`\`${language ?? ""}\n${text}\n\`\`\``;
  }

  link(text: string, url: string): string {
    return `[${text}](${url})`;
  }

  escape(text: string): string {
    return text;
  }

  chunkText(text: string, maxLen: number): string[] {
    if (text.length <= maxLen) return [text];

    const chunks: string[] = [];
    let remaining = text;

    while (remaining.length > 0) {
      if (remaining.length <= maxLen) {
        chunks.push(remaining);
        break;
      }

      let splitAt = remaining.lastIndexOf("\n", maxLen);
      if (splitAt < maxLen * 0.3) {
        splitAt = remaining.lastIndexOf(" ", maxLen);
      }
      if (splitAt < maxLen * 0.3) {
        splitAt = maxLen;
      }

      chunks.push(remaining.slice(0, splitAt));
      remaining = remaining.slice(splitAt).replace(/^\n/, "");
    }

    return chunks;
  }
}
