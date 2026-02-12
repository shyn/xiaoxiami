import type { Formatter } from "../../im/formatter.js";

const HTML_ESCAPE_MAP: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
};

function escapeHtml(text: string): string {
  return text.replace(/[&<>]/g, (ch) => HTML_ESCAPE_MAP[ch] ?? ch);
}

export class TelegramFormatter implements Formatter {
  bold(text: string): string {
    return `<b>${escapeHtml(text)}</b>`;
  }

  italic(text: string): string {
    return `<i>${escapeHtml(text)}</i>`;
  }

  code(text: string): string {
    return `<code>${escapeHtml(text)}</code>`;
  }

  pre(text: string, language?: string): string {
    if (language) {
      return `<pre><code class="language-${escapeHtml(language)}">${escapeHtml(text)}</code></pre>`;
    }
    return `<pre>${escapeHtml(text)}</pre>`;
  }

  link(text: string, url: string): string {
    return `<a href="${escapeHtml(url)}">${escapeHtml(text)}</a>`;
  }

  escape(text: string): string {
    return escapeHtml(text);
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
