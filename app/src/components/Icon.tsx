import { iconPaths, type IconName } from './icons';

interface IconProps {
  name: IconName;
  small?: boolean;
  className?: string;
}

/** Decorative stroke icon. Give the surrounding button an aria-label when it has no text. */
export function Icon({ name, small, className }: IconProps) {
  const cls = ['i', small && 'sm', className].filter(Boolean).join(' ');
  return (
    <svg
      className={cls}
      viewBox="0 0 24 24"
      aria-hidden="true"
      dangerouslySetInnerHTML={{ __html: iconPaths[name] }}
    />
  );
}
