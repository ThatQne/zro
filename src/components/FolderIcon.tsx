import {
  Folder, Rocket, Target, Zap, Flame, Gem,
  Waves, Palette, Brain, Star, Wrench, Gamepad2,
  type LucideIcon,
} from "lucide-react";
import { normalizeFolderIcon } from "../store/tabs";

// Folder icons are lucide SVGs keyed by name (see FOLDER_ICONS in the store).
const ICON_MAP: Record<string, LucideIcon> = {
  folder: Folder,
  rocket: Rocket,
  target: Target,
  zap: Zap,
  flame: Flame,
  gem: Gem,
  waves: Waves,
  palette: Palette,
  brain: Brain,
  star: Star,
  wrench: Wrench,
  gamepad: Gamepad2,
};

export default function FolderIcon({ name, size = 12, color }: {
  name: string; size?: number; color?: string;
}) {
  const Icon = ICON_MAP[normalizeFolderIcon(name)] ?? Folder;
  return <Icon size={size} color={color} strokeWidth={2.2} />;
}
