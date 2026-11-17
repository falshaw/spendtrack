/**
 * The sunset title band every app page opens with (styles: src/app/app-hero.css).
 * `actions` sit on the right from 768 px (month picker, buttons); `children` go under the subtitle.
 */
export function PageHero({
  eyebrow,
  title,
  subtitle,
  actions,
  children,
}: {
  eyebrow?: string;
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  actions?: React.ReactNode;
  children?: React.ReactNode;
}) {
  return (
    <div className="app-hero">
      <div className="app-hero-row">
        <div className="min-w-0">
          {eyebrow && <p className="app-hero-eyebrow">{eyebrow}</p>}
          <h1>{title}</h1>
          {subtitle && <p className="app-hero-sub">{subtitle}</p>}
        </div>
        {actions && <div className="app-hero-actions">{actions}</div>}
      </div>
      {children}
    </div>
  );
}
