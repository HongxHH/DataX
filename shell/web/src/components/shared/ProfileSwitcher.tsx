import type { ProfileInfo } from "../../protocol/events";

interface ProfileSwitcherProps {
  profiles: ProfileInfo[];
  currentId: string;
  onSwitch: (id: string) => Promise<void>;
}

export function ProfileSwitcher({
  profiles,
  currentId,
  onSwitch,
}: ProfileSwitcherProps) {
  return (
    <select
      className="profile-select"
      value={currentId}
      onChange={(e) => onSwitch(e.target.value)}
    >
      {profiles.map((p) => (
        <option key={p.id} value={p.id}>{p.title}</option>
      ))}
    </select>
  );
}
