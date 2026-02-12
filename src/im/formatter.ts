export interface Formatter {
  bold(text: string): string;
  italic(text: string): string;
  code(text: string): string;
  pre(text: string, language?: string): string;
  link(text: string, url: string): string;
  escape(text: string): string;
  chunkText(text: string, maxLen: number): string[];
}
