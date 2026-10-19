export interface DiffLine {
  kind: string;
  old_line: number | null;
  new_line: number | null;
  text: string;
}
export function renderDiff(target: HTMLElement, lines: DiffLine[]): void;
