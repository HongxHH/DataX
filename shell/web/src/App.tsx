import { useCallback, useEffect, useState } from "react";
import {
  fetchHealth,
  listProfiles,
  switchProfile,
} from "./api/rest";
import { getLayoutComponent } from "./profiles/registry";
import type { HealthResponse, ProfileInfo } from "./protocol/events";

function semanticHealthWarning(health: HealthResponse, profile: ProfileInfo): string | null {
  const semantic = health.semantic_layer as Record<string, unknown> | undefined;
  const semanticRequired = Boolean(
    health.semantic_required ?? profile.agent_type === "nl2sql",
  );
  if (semanticRequired && semantic && !semantic.reachable) {
    return "语义服务未就绪，请先启动 Semantic Service（:32000）";
  }
  return null;
}

export default function App() {
  const [profile, setProfile] = useState<ProfileInfo | null>(null);
  const [profiles, setProfiles] = useState<ProfileInfo[]>([]);
  const [healthWarning, setHealthWarning] = useState<string | null>(null);
  const [bootstrapError, setBootstrapError] = useState<string | null>(null);
  const [layoutKey, setLayoutKey] = useState(0);
  const [bootstrapped, setBootstrapped] = useState(false);

  const loadHealth = useCallback(async () => {
    const h = await fetchHealth();
    if (!h.profile) {
      throw new Error("后端未返回 profile");
    }
    setProfile(h.profile);
    setHealthWarning(semanticHealthWarning(h, h.profile));
  }, []);

  useEffect(() => {
    let cancelled = false;

    const bootstrap = async () => {
      setBootstrapError(null);
      try {
        const [health, profileList] = await Promise.all([
          fetchHealth(),
          listProfiles(),
        ]);
        if (cancelled) return;

        setProfiles(profileList.profiles ?? []);
        const current = profileList.current ?? health.profile;
        if (!current) {
          throw new Error("未能获取 Profile 配置");
        }
        setProfile(current);
        setHealthWarning(semanticHealthWarning(health, current));
      } catch (err) {
        if (!cancelled) {
          const msg = err instanceof Error ? err.message : String(err);
          setBootstrapError(
            `无法连接壳后端：${msg}。请在仓库根目录执行：uv run python shell/backend/main.py`,
          );
        }
      } finally {
        if (!cancelled) setBootstrapped(true);
      }
    };

    bootstrap();
    return () => {
      cancelled = true;
    };
  }, []);

  const handleProfileSwitch = async (profileId: string) => {
    const res = await switchProfile(profileId);
    if (res.profile) setProfile(res.profile);
    await loadHealth();
    setLayoutKey((k) => k + 1);
  };

  if (!profile) {
    return (
      <div className="app loading-screen">
        {!bootstrapped ? (
          <p>正在连接 DataAgent Shell…</p>
        ) : (
          <>
            <p className="bootstrap-error">{bootstrapError ?? "未能加载工作台。"}</p>
            <p className="bootstrap-hint">
              请确认后端已启动（http://127.0.0.1:8788），然后刷新页面。
            </p>
          </>
        )}
      </div>
    );
  }

  const Layout = getLayoutComponent(profile.layout);

  return (
    <div className="app">
      <Layout
        key={`${profile.id}-${layoutKey}`}
        profile={profile}
        healthWarning={healthWarning}
        profiles={profiles}
        onProfileSwitch={handleProfileSwitch}
      />
    </div>
  );
}
