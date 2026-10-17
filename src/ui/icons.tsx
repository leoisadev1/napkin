// Inline icon set: 24px grid, round caps, stroke from currentColor so state comes from CSS.
import type { SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement> & { size?: number };

function Icon({ size = 20, children, strokeWidth = 1.75, ...rest }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      {children}
    </svg>
  );
}

export const MicIcon = (p: IconProps) => (
  <Icon {...p}>
    <rect x="9" y="3" width="6" height="11" rx="3" />
    <path d="M5.5 11a6.5 6.5 0 0 0 13 0" />
    <path d="M12 17.5V21" />
  </Icon>
);

export const MicOffIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M15 9.5V6a3 3 0 0 0-5.7-1.3" />
    <path d="M9 9v2a3 3 0 0 0 4.6 2.5" />
    <path d="M18.5 11a6.5 6.5 0 0 1-1 3.4M5.5 11a6.5 6.5 0 0 0 10 5.5" />
    <path d="M12 17.5V21" />
    <path d="M4 4l16 16" />
  </Icon>
);

export const StopIcon = (p: IconProps) => (
  <Icon {...p}>
    <rect x="7" y="7" width="10" height="10" rx="2.5" fill="currentColor" stroke="none" />
  </Icon>
);

export const AlertIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M12 8v5" />
    <path d="M12 16.5v.01" />
    <path d="M10.3 3.9 2.6 17.5A2 2 0 0 0 4.3 20.5h15.4a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" />
  </Icon>
);

export const SendIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M12 19V5" />
    <path d="m6 11 6-6 6 6" />
  </Icon>
);

export const TranscriptIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M4 6.5A2.5 2.5 0 0 1 6.5 4h11A2.5 2.5 0 0 1 20 6.5v8a2.5 2.5 0 0 1-2.5 2.5H10l-4.5 3.5V17A2.5 2.5 0 0 1 4 14.5Z" />
    <path d="M8.5 9h7M8.5 12.5h4.5" />
  </Icon>
);

export const CloseIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M6 6l12 12M18 6 6 18" />
  </Icon>
);

/** Brand mark: a hand-drawn loop with the partner's ember dot. */
export const Mark = ({ size = 22 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false">
    <path
      d="M5.2 14.6c-1.4-3.9.9-8.4 5.3-9.4 4.3-1 8.6 1.5 9.2 5.4.6 3.6-2 7.3-6.3 8.2-2.7.6-5.5-.1-7.1-1.8"
      stroke="currentColor"
      strokeWidth="1.9"
      strokeLinecap="round"
    />
    <circle cx="6.2" cy="18.4" r="2.3" fill="var(--ember)" />
  </svg>
);

export const PhoneSketchIcon = (p: IconProps) => (
  <Icon {...p}>
    <rect x="7" y="2.8" width="10" height="18.4" rx="2.6" />
    <path d="M10.5 5.6h3M9.5 10h5M9.5 13h3.5" />
  </Icon>
);

export const FlowSketchIcon = (p: IconProps) => (
  <Icon {...p}>
    <rect x="2.8" y="9" width="6" height="6" rx="1.5" />
    <rect x="15.2" y="3.5" width="6" height="6" rx="1.5" />
    <rect x="15.2" y="14.5" width="6" height="6" rx="1.5" />
    <path d="M8.8 12h2.4a2 2 0 0 0 2-2V8.5a2 2 0 0 1 2-2M11.2 12a2 2 0 0 1 2 2v1.5a2 2 0 0 0 2 2" />
  </Icon>
);

export const CalendarSketchIcon = (p: IconProps) => (
  <Icon {...p}>
    <rect x="3.5" y="5" width="17" height="15" rx="2.5" />
    <path d="M3.5 9.5h17M8 3v4M16 3v4" />
    <path d="m9 14.5 2 2 4-4" />
  </Icon>
);
