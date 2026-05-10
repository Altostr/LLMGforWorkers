"use client";

import { clearSession, getOrFetchProfile, type CachedProfile } from "@/lib/client-auth";

type DashboardRouter = {
  push(href: string): void;
};

export async function requireDashboardProfile(router: DashboardRouter): Promise<CachedProfile | null> {
  const profile = await getOrFetchProfile();
  if (!profile) {
    clearSession();
    router.push("/login");
    return null;
  }
  return profile;
}

export async function requireAdminDashboardProfile(router: DashboardRouter): Promise<CachedProfile | null> {
  const profile = await requireDashboardProfile(router);
  if (!profile) return null;

  if (profile.role !== "admin") {
    router.push("/dashboard/keys");
    return null;
  }

  return profile;
}
