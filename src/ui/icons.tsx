// One icon set for the whole shell: Lucide at 16px with a 1.5px stroke, colored by currentColor so every state comes
// from CSS. Components import from here so the set can be swapped in one place.
import type { LucideProps } from "lucide-react";
import {
  ArrowRight,
  ArrowUp,
  Circle,
  Command,
  CornerDownLeft,
  Diamond,
  Download,
  Eraser,
  Hand,
  Image,
  Maximize,
  MessageSquareText,
  Mic,
  MicOff,
  Minus,
  Monitor,
  Moon,
  MousePointer2,
  MoveUpRight,
  Pencil,
  Plus,
  Redo2,
  Search,
  Sparkles,
  Square,
  Sun,
  Trash2,
  TriangleAlert,
  Type,
  Undo2,
  X,
} from "lucide-react";
import type { ComponentType } from "react";

type IconProps = Omit<LucideProps, "ref">;

function icon(Base: ComponentType<LucideProps>) {
  return function ShellIcon({ size = 16, strokeWidth = 1.5, ...rest }: IconProps) {
    return <Base size={size} strokeWidth={strokeWidth} aria-hidden="true" focusable="false" {...rest} />;
  };
}

export const MicIcon = icon(Mic);
export const MicOffIcon = icon(MicOff);
export const AlertIcon = icon(TriangleAlert);
export const SendIcon = icon(ArrowUp);
export const TranscriptIcon = icon(MessageSquareText);
export const CloseIcon = icon(X);
export const PencilIcon = icon(Pencil);
export const ArrowRightIcon = icon(ArrowRight);
export const SparkleIcon = icon(Sparkles);
export const SunIcon = icon(Sun);
export const MoonIcon = icon(Moon);
export const MonitorIcon = icon(Monitor);
export const CommandIcon = icon(Command);
export const SearchIcon = icon(Search);
export const EnterIcon = icon(CornerDownLeft);
export const UndoIcon = icon(Undo2);
export const RedoIcon = icon(Redo2);
export const PlusIcon = icon(Plus);
export const MinusIcon = icon(Minus);
export const FitIcon = icon(Maximize);
export const TrashIcon = icon(Trash2);
export const DownloadIcon = icon(Download);

export const SelectToolIcon = icon(MousePointer2);
export const HandToolIcon = icon(Hand);
export const RectangleToolIcon = icon(Square);
export const DiamondToolIcon = icon(Diamond);
export const EllipseToolIcon = icon(Circle);
export const ArrowToolIcon = icon(MoveUpRight);
export const LineToolIcon = icon(Minus);
export const PenToolIcon = icon(Pencil);
export const TextToolIcon = icon(Type);
export const ImageToolIcon = icon(Image);
export const EraserToolIcon = icon(Eraser);

/** Brand mark: a rounded tile in the accent with a spoken-line squiggle, the board's voice drawn as a stroke. */
export const Mark = ({ size = 20 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 20 20" fill="none" aria-hidden="true" focusable="false">
    <rect width="20" height="20" rx="5" fill="var(--accent)" />
    <path d="M4.5 11.5c1.2-3 2.4-3 3.4 0s2.2 3 3.4 0 2.3-3 4.2-1" stroke="var(--on-accent)" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);
