import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { AuthProvider } from "@/components/providers/auth-provider";
import { getServerProfileFromCookieStore } from "@/lib/auth";
import { type DbUser } from "@/lib/db";
import { getEffectiveLimits } from "@/lib/effective-limits";

export const dynamic = "force-dynamic";

export default async function DashboardLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const cookieStore = await cookies();
  const profile = await getServerProfileFromCookieStore(cookieStore);

  if (!profile) {
    redirect("/login");
  }

  const effective = await getEffectiveLimits(profile as DbUser);
  const enrichedProfile = {
    ...profile,
    rpm: effective.rpm,
    qps: effective.qps,
    tpm: effective.tpm,
    quota_tokens: effective.quota_tokens,
    quota_requests: effective.quota_requests,
  };

  return (
    <AuthProvider initialProfile={enrichedProfile}>
      {children}
    </AuthProvider>
  );
}
