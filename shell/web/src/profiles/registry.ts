import type { ComponentType } from "react";
import type { ProfileInfo } from "../protocol/events";
import DataWorkbench from "../layouts/data-workbench";
import ChatCopilot from "../layouts/chat-copilot";

export interface LayoutProps {
  profile: ProfileInfo;
  healthWarning: string | null;
  onProfileSwitch: (profileId: string) => Promise<void>;
  profiles: ProfileInfo[];
}

const LAYOUTS: Record<string, ComponentType<LayoutProps>> = {
  "data-workbench": DataWorkbench,
  "chat-copilot": ChatCopilot,
};

export function getLayoutComponent(layoutId: string): ComponentType<LayoutProps> {
  return LAYOUTS[layoutId] ?? DataWorkbench;
}
