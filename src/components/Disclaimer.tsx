/** The one-line notice every page carries, signed in or not. */
export const DISCLAIMER_TEXT =
  "SpendTrack is a budgeting tool, not financial or tax advice. Its figures are estimates from the data you import.";

export function Disclaimer({ className = "" }: { className?: string }) {
  return (
    <footer className={`text-center text-xs text-ink-muted px-4 py-6 ${className}`.trim()} data-testid="disclaimer">
      {DISCLAIMER_TEXT}
    </footer>
  );
}
